import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead } from '../../ui/hud';

// WATERMELON BOMB (Wildwood · hot potato). A watermelon with a firecracker gets
// passed around. Tap a rival to throw it to them. It explodes at a RANDOM time
// from 8s onward — whoever's holding it then gets splatted (soaked) and knocked
// out. A big count-up shows how long the current melon has been live. Last one
// dry wins. Whole game is capped at 60s.

const GAME_TIME = 60;
const THROW_CD = 0.35; // a fresh holder can't instantly re-throw

export class HotPotatoGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Watermelon Bomb';
  objective = 'Pass the watermelon — don\'t be holding it when it blows!';

  private ctx!: MatchContext;
  private timeLeft = GAME_TIME;
  private finished = false;
  private elapsed = 0;

  private holder = 0;
  private armT = 0; // seconds the current melon has been live
  private fuse = 10; // hidden explosion time (>= 8)
  private canThrowAt = 0; // elapsed time the holder may throw again
  private outCount = 0;
  private botThrowAt = 0; // this bot-holder's nervous pass time

  private melon!: THREE.Group;
  private spark!: THREE.Mesh;
  private throwT = 0;
  private throwFrom = new THREE.Vector3();

  // DOM overlay: big count-up + PASS button.
  private countEl!: HTMLElement;
  private onDown!: (e: PointerEvent) => void;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(GAME_TIME);
    this.elapsed = 0;
    this.outCount = 0;

    setupRoster(ctx, '', 0.55);
    this.buildMelon();
    this.buildUI();
    this.arm(Math.floor(Math.random() * ctx.players.length));
    ctx.fx.banner('🍉 HOT POTATO!', '#7ED321');
  }

  private alive(): Player[] { return this.ctx.players.filter((p) => !p.dead); }
  private others(of: number): Player[] { return this.alive().filter((p) => p.index !== of); }

  /** Hand the melon to `idx`, reset the count-up, roll a fresh hidden fuse. */
  private arm(idx: number) {
    this.holder = idx;
    this.armT = 0;
    this.fuse = 8 + Math.random() * 7; // explodes somewhere from 8s on
    this.canThrowAt = this.elapsed + 0.6;
    this.botThrowAt = 2.5 + Math.random() * 4;
  }

  private pass(toIdx: number) {
    if (this.finished || this.elapsed < this.canThrowAt) return;
    const to = this.ctx.players[toIdx];
    if (!to || to.dead || toIdx === this.holder) return;
    this.throwFrom.copy(this.melon.position);
    this.throwT = 0.3;
    this.holder = toIdx;
    this.canThrowAt = this.elapsed + THROW_CD;
    this.botThrowAt = 2 + Math.random() * 3.5;
    SFX.tick();
    this.ctx.fx.burst(to.x, to.z, '#7ED321', 6);
  }

  private nearestTo(p: Player): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (const q of this.others(p.index)) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) { bd = d; best = q; } }
    return best;
  }

  ability() { // keyboard/gamepad + ⚡ tap: throw to the nearest rival
    const h = this.ctx.players[this.holder];
    if (h.you && !h.dead) { const t = this.nearestTo(h); if (t) this.pass(t.index); }
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.elapsed += dt;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    this.armT += dt;
    this.throwT = Math.max(0, this.throwT - dt);

    // Movement (everyone roams freely).
    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = 0.4 + Math.random() * 0.4;
        // The holder wanders; everyone else drifts AWAY from the holder.
        if (p.index === this.holder) { p.tx = (Math.random() - 0.5) * ctx.halfSize; p.tz = (Math.random() - 0.5) * ctx.halfSize; }
        else { const h = ctx.players[this.holder]; const ax = p.x - h.x, az = p.z - h.z, L = Math.hypot(ax, az) || 1;
          p.tx = p.x + (ax / L) * 20 + (Math.random() - 0.5) * 14; p.tz = p.z + (az / L) * 20 + (Math.random() - 0.5) * 14; }
      }
      botMove(ctx, p, p.tx, p.tz, dt);
    }
    collidePlayers(ctx);

    // Bot holder gets nervous and passes — instantly once things feel hot.
    const holderP = ctx.players[this.holder];
    if (!holderP.you && this.elapsed >= this.canThrowAt && (this.armT > this.botThrowAt || this.armT > 7)) {
      const t = this.nearestTo(holderP) ?? this.others(this.holder)[0];
      if (t) this.pass(t.index);
    }

    tickRoster(ctx, dt, elapsed);
    this.updateMelon(dt);
    this.updateCount();

    // Boom! Whoever holds it when the fuse blows gets splatted.
    if (this.armT >= this.fuse) this.explode();
    else if (this.timeLeft <= 0) this.explode(); // 60s cap: the holder eats it

    if (this.alive().length <= 1) this.doFinish();
  }

  private explode() {
    const victim = this.ctx.players[this.holder];
    if (!victim || victim.dead) return;
    // Splat! Juicy pink + green burst, a good shake, and a soaked banner.
    for (let k = 0; k < 3; k++) {
      this.ctx.fx.burst(victim.x, victim.z, k % 2 ? '#ff4d8d' : '#7ED321', 22);
    }
    this.ctx.fx.shake(3.5);
    this.ctx.fx.hitstop(0.12);
    SFX.lose();
    this.ctx.fx.banner(victim.you ? '💦 YOU GOT SPLATTED!' : `💦 ${victim.hero.name} splatted!`, '#ff4d8d');
    victim.dead = true;
    victim.zapped = true; // darkened/soaked look via tickEffects tint
    victim.freezeT = 0.6;
    (victim as any)._outAt = ++this.outCount;
    markDead(victim);

    const left = this.alive();
    if (left.length >= 2) this.arm(left[Math.floor(Math.random() * left.length)].index);
    else this.melon.visible = false;
  }

  // --- watermelon 3D ---------------------------------------------------------
  private buildMelon() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0x2f9e34, roughness: 0.6, emissive: 0x0d3a12 }),
    );
    body.scale.y = 1.12;
    g.add(body);
    // Dark rind stripes.
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x165a1e, roughness: 0.7 });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.13, 6, 24), stripeMat);
      s.rotation.z = Math.PI / 2;
      s.rotation.y = (i / 6) * Math.PI;
      s.scale.set(1, 1.12, 1);
      g.add(s);
    }
    // Stem + a bright sparking fuse.
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a1e }));
    stem.position.y = 2.0;
    g.add(stem);
    this.spark = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
    this.spark.position.y = 2.7;
    g.add(this.spark);
    this.melon = g;
    this.ctx.scene.add(g);
  }

  private updateMelon(dt: number) {
    const h = this.ctx.players[this.holder];
    const tx = h.x, tz = h.z, ty = 7.2 + Math.sin(this.elapsed * 3) * 0.25;
    if (this.throwT > 0) {
      // Arc from the thrower toward the new holder.
      const k = 1 - this.throwT / 0.3;
      this.melon.position.lerpVectors(this.throwFrom, new THREE.Vector3(tx, ty, tz), k);
      this.melon.position.y += Math.sin(k * Math.PI) * 4; // arc height
    } else {
      this.melon.position.set(tx, ty, tz);
    }
    this.melon.rotation.y += dt * 2;
    // Sparking fuse + danger pulse: faster/redder the longer it's been live.
    const danger = Math.min(1, this.armT / 8);
    const pulse = 1 + Math.sin(this.elapsed * (6 + danger * 20)) * 0.15 * (0.4 + danger);
    this.melon.scale.setScalar(pulse);
    (this.spark.material as THREE.MeshBasicMaterial).color.setHex(this.armT > 8 ? 0xff5a3c : 0xfff2a0);
    this.spark.visible = Math.sin(this.elapsed * (10 + danger * 30)) > -0.3;
  }

  // --- DOM overlay -----------------------------------------------------------
  private buildUI() {
    document.getElementById('hpUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'hpUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,cursive;';
    ui.innerHTML = `
      <div id="hpCount" style="position:fixed;top:120px;left:50%;transform:translateX(-50%);font-size:74px;
        color:#fff;text-shadow:0 4px 0 rgba(0,0,0,.5);line-height:1;">0</div>
      <div style="position:fixed;left:0;right:0;bottom:26px;display:flex;justify-content:center;">
        <button id="hpPass" style="pointer-events:auto;font-family:Bungee,cursive;font-size:20px;border:none;
          border-radius:16px;padding:15px 30px;background:#7ED321;color:#12331a;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);">🍉 PASS</button>
      </div>`;
    document.body.appendChild(ui);
    this.countEl = ui.querySelector('#hpCount')!;
    ui.querySelector('#hpPass')!.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.ability(); });

    // Tap directly ON a rival to throw the melon to THAT rival.
    this.onDown = (e: PointerEvent) => {
      if (this.finished) return;
      if ((e.target as HTMLElement)?.closest('#hpUI')) return; // the PASS button handles itself
      const h = this.ctx.players[this.holder];
      if (!h.you || h.dead || this.elapsed < this.canThrowAt) return;
      const cam = this.ctx.camera.cam;
      let best: Player | null = null, bd = Infinity;
      for (const p of this.others(this.holder)) {
        const v = new THREE.Vector3(p.x, 3, p.z).project(cam);
        const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
        const d = Math.hypot(sx - e.clientX, sy - e.clientY);
        if (d < bd) { bd = d; best = p; }
      }
      if (best && bd < Math.min(innerWidth, innerHeight) * 0.3) this.pass(best.index);
    };
    document.addEventListener('pointerdown', this.onDown);
  }

  private updateCount() {
    if (!this.countEl) return;
    this.countEl.textContent = String(Math.floor(this.armT));
    // Neutral until the danger zone (>=8s), then flash red and jitter.
    const danger = this.armT >= 8;
    this.countEl.style.color = danger ? '#ff4d4d' : '#ffffff';
    const j = danger ? (Math.random() - 0.5) * 6 : 0;
    this.countEl.style.transform = `translateX(-50%) translate(${j}px,${j}px) scale(${danger ? 1.25 : 1})`;
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('hpUI')?.remove();
    document.removeEventListener('pointerdown', this.onDown);
    this.ctx.scene.remove(this.melon);
    const ctx = this.ctx;
    ctx.players.forEach((p) => ((p as any)._res = p.dead ? '💦 SPLATTED' : '🍉 DRY — WINNER'));
    ctx.finish(rankBy(ctx, (p) => (p.dead ? ((p as any)._outAt ?? 0) : 1e5)), 'Last one dry wins!');
  }
}
