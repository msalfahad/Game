import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, rankBy } from '../freeroam';
import { SFX } from '../../core/audio';
import { markDead } from '../../ui/hud';

// MUSICAL CHAIRS (Dune Clash · "Musical Chairs"). Everyone circles a ring of
// chairs while a song plays (shown as an animated 🎵 for deaf players). When the
// song STOPS, a red SIT! appears — tap SIT to claim the nearest free seat. One
// seat short each round, so the slowest player is out. 4→3 chairs, 3→2, 2→1,
// last seated wins. Pickups: STUN (freeze the nearest rival 2s) and STOP SONG
// (a 5s window to cut the music yourself for a head start). A HIT button shoves
// rivals. No per-player power buttons.

type Phase = 'walk' | 'sit' | 'gap' | 'done';

interface Chair {
  x: number;
  z: number;
  group: THREE.Group;
  occupant: number | null; // player index seated here
}

interface Box {
  x: number;
  z: number;
  kind: 'stun' | 'stop';
  group: THREE.Group;
}

const CHAIR_R = 8.5; // radius of the chair ring
const SEAT_Y = 2.4;
const SIT_WINDOW = 4.0; // seconds to grab a seat after the song stops
const ROUND_CAP = 25; // hard cap per round (spec)

export class MusicalChairsGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Musical Chairs';
  objective = 'Circle the chairs — grab a seat when the song stops!';

  private ctx!: MatchContext;
  private innerR = 12;
  private outerR = 27;

  private phase: Phase = 'walk';
  private roundT = ROUND_CAP;
  private musicOnT = 0;
  private musicStopAt = 8;
  private sitT = 0;
  private resolved = false;
  private finished = false;
  private outCount = 0; // elimination order (later out = better placing)

  private chairs: Chair[] = [];
  private seatOf: (number | null)[] = []; // per player index → chair index
  private botReact: number[] = []; // per player index → seconds until a bot sits

  private boxes: Box[] = [];
  private boxT = 4;
  private stopHolder: number | null = null;
  private stopHolderT = 0;

  // DOM overlay.
  private ui!: HTMLElement;
  private noteEl!: HTMLElement;
  private sitTextEl!: HTMLElement;
  private hitBtn!: HTMLButtonElement;
  private sitBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.outerR = ctx.halfSize - HITBOX_RADIUS - 0.5;
    this.innerR = CHAIR_R + HITBOX_RADIUS + 2;

    setupRoster(ctx, '', 0.6);
    this.buildUI();

    // Everyone starts spaced around the outer ring.
    const alive = ctx.players.length;
    ctx.players.forEach((p, i) => {
      p.sitting = false;
      const a = (i / alive) * Math.PI * 2;
      const r = (this.innerR + this.outerR) / 2;
      p.x = Math.cos(a) * r;
      p.z = Math.sin(a) * r;
      p.retarget = 0;
    });

    this.startRound(true);
  }

  // --- round lifecycle -------------------------------------------------------
  private startRound(first = false) {
    const ctx = this.ctx;
    const alive = ctx.players.filter((p) => !p.dead);
    if (alive.length <= 1) return this.doFinish();

    this.buildChairs(alive.length - 1);
    this.seatOf = ctx.players.map(() => null);
    this.phase = 'walk';
    this.resolved = false;
    this.roundT = ROUND_CAP;
    this.musicOnT = 0;
    this.musicStopAt = 5 + Math.random() * 8; // song cuts out somewhere in here
    this.stopHolder = null;
    this.stopHolderT = 0;
    this.clearBoxes();
    this.boxT = 3 + Math.random() * 2;

    for (const p of alive) { p.sitting = false; p.freezeT = 0; }
    SFX.playMusic(ctx.family.id);
    this.setMusicVisible(true);
    this.sitTextEl.style.opacity = '0';
    this.updateButtons();
    if (!first) ctx.fx.banner(`${alive.length} left · ${this.chairs.length} chairs`, '#FFD23F');
  }

  private stopSong() {
    if (this.phase !== 'walk') return;
    this.phase = 'sit';
    this.sitT = SIT_WINDOW;
    SFX.stopMusic();
    SFX.out();
    this.setMusicVisible(false);
    this.sitTextEl.style.opacity = '1';
    this.stopHolder = null;
    this.stopHolderT = 0;
    // Bot reaction times — harder bots react faster. Keep them ALL within the
    // actual sit window so every bot commits and exactly one player (the slowest
    // bot, or you if you don't tap SIT) is left seatless each round.
    const win = this.sitT;
    const react = Math.min(0.2 + (1 - this.ctx.diff.cap) * 0.9, win * 0.45);
    this.botReact = this.ctx.players.map((_, i) => (i === 0 ? Infinity : react + Math.random() * Math.max(0.15, win - react - 0.35)));
    this.ctx.fx.banner('SIT!', '#FF4D4D');
    this.ctx.fx.shake(1.5);
    this.updateButtons();
  }

  // --- 3D content ------------------------------------------------------------
  private buildChairs(count: number) {
    for (const c of this.chairs) this.ctx.scene.remove(c.group);
    this.chairs = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * CHAIR_R;
      const z = Math.sin(a) * CHAIR_R;
      const group = this.makeChairMesh();
      group.position.set(x, 0, z);
      group.rotation.y = -a + Math.PI / 2; // seat faces outward toward the players
      this.ctx.scene.add(group);
      this.chairs.push({ x, z, group, occupant: null });
    }
  }

  private makeChairMesh(): THREE.Group {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0xb9762f, roughness: 0.7, emissive: 0x2a1608 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 3.4), wood);
    seat.position.y = 2.1;
    seat.castShadow = true;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 0.5), wood);
    back.position.set(0, 3.6, -1.5);
    back.castShadow = true;
    g.add(back);
    for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 0.5), wood);
      leg.position.set(lx, 1.05, lz);
      g.add(leg);
    }
    // Glowing seat cushion so free seats read at a glance.
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.3, 3.0),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb020, emissiveIntensity: 0.6, roughness: 0.5 }),
    );
    cushion.position.y = 2.5;
    (g as any).__cushion = cushion;
    g.add(cushion);
    return g;
  }

  private spawnBox() {
    const kind: Box['kind'] = Math.random() < 0.5 ? 'stun' : 'stop';
    const a = Math.random() * Math.PI * 2;
    const r = this.innerR + Math.random() * (this.outerR - this.innerR);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const group = new THREE.Group();
    const col = kind === 'stun' ? 0x4da6ff : 0xff3d9e;
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.4, 2.4),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.3 }),
    );
    cube.position.y = 2.4;
    group.add(cube);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    this.boxes.push({ x, z, kind, group });
  }

  private clearBoxes() {
    for (const b of this.boxes) this.ctx.scene.remove(b.group);
    this.boxes = [];
  }

  // --- main tick -------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;

    if (this.phase === 'walk') this.tickWalk(dt);
    else if (this.phase === 'sit') this.tickSit(dt);

    // Chairs spin their free-seat glow; hide the glow once taken.
    for (const c of this.chairs) {
      const cushion = (c.group as any).__cushion as THREE.Mesh;
      if (cushion) {
        cushion.visible = c.occupant === null;
        (cushion.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + Math.sin(elapsed * 5) * 0.2;
      }
    }
    for (const b of this.boxes) b.group.rotation.y += dt * 2;

    collidePlayers(ctx);
    // Keep everyone in the ring (seated players are exempt — they're on a seat).
    for (const p of ctx.players) if (!p.dead && !p.sitting) this.clampRing(p);
    tickRoster(ctx, dt, elapsed);
    // Pin seated players onto their seat (tickRoster moved them by physics).
    for (const p of ctx.players) {
      if (p.sitting && this.seatOf[p.index] != null) {
        const c = this.chairs[this.seatOf[p.index]!];
        p.x = c.x; p.z = c.z; p.vx = 0; p.vz = 0;
        p.group.position.set(c.x, SEAT_Y, c.z);
      }
    }
  }

  private tickWalk(dt: number) {
    const ctx = this.ctx;
    this.roundT -= dt;
    ctx.setClock(this.roundT);
    this.musicOnT += dt;
    this.pulseNote();

    // Local movement (free within the ring).
    localMove(ctx, dt, { noClamp: true });

    // Bots circle clockwise and drift toward boxes.
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = 0.35 + Math.random() * 0.4;
        const box = this.nearestBox(p);
        if (box && Math.hypot(box.x - p.x, box.z - p.z) < this.outerR * 0.9) {
          p.tx = box.x; p.tz = box.z;
        } else {
          const ang = Math.atan2(p.z, p.x) - 0.7; // step clockwise
          const r = (this.innerR + this.outerR) / 2 + (Math.random() - 0.5) * 4;
          p.tx = Math.cos(ang) * r; p.tz = Math.sin(ang) * r;
        }
      }
      botMove(ctx, p, p.tx, p.tz, dt, { noClamp: true });
    }

    // Box spawns + pickups.
    this.boxT -= dt;
    if (this.boxT <= 0 && this.boxes.length < 2) {
      this.boxT = 4 + Math.random() * 3;
      this.spawnBox();
    }
    this.checkBoxPickups();

    // Stop-song pickup countdown (a bot holder cuts the music after a beat).
    if (this.stopHolder != null) {
      this.stopHolderT -= dt;
      if (this.stopHolder !== 0 && this.stopHolderT < 3.4) return this.stopSong();
      if (this.stopHolderT <= 0) { this.stopHolder = null; this.updateButtons(); }
    }

    // Song ends on its own, or the round times out.
    if (this.musicOnT >= this.musicStopAt || this.roundT <= 0.5) this.stopSong();
  }

  private tickSit(dt: number) {
    const ctx = this.ctx;
    this.sitT -= dt;

    // Bots commit to the nearest free seat when their reaction time elapses.
    for (const p of ctx.players.slice(1)) {
      if (p.dead || p.sitting || this.seatOf[p.index] != null || p.freezeT > 0) continue;
      this.botReact[p.index] -= dt;
      if (this.botReact[p.index] <= 0) this.claimSeat(p);
    }

    // Slide committed-but-not-yet-seated players onto their seat.
    for (const p of ctx.players) {
      const ci = this.seatOf[p.index];
      if (ci == null || p.dead || p.sitting) continue;
      const c = this.chairs[ci];
      const dx = c.x - p.x, dz = c.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6) { p.sitting = true; p.x = c.x; p.z = c.z; }
      else { const step = Math.min(d, dt * 34); p.x += (dx / d) * step; p.z += (dz / d) * step; }
      p.vx = 0; p.vz = 0;
    }

    const seated = ctx.players.filter((p) => this.seatOf[p.index] != null).length;
    if (this.sitT <= 0 || seated >= this.chairs.length) this.resolveRound();
  }

  // --- actions ---------------------------------------------------------------
  private claimSeat(p: Player): boolean {
    if (this.seatOf[p.index] != null || p.dead || p.freezeT > 0) return false; // stunned can't sit
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.chairs.length; i++) {
      if (this.chairs[i].occupant != null) continue;
      const d = Math.hypot(this.chairs[i].x - p.x, this.chairs[i].z - p.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return false; // no free seat — this player is out
    this.chairs[best].occupant = p.index;
    this.seatOf[p.index] = best;
    SFX.tick();
    this.ctx.fx.burst(this.chairs[best].x, this.chairs[best].z, p.hero.col, 10);
    if (p.you) this.ctx.fx.banner('SAFE!', '#7ED321');
    return true;
  }

  private resolveRound() {
    if (this.resolved) return;
    this.resolved = true;
    const ctx = this.ctx;
    this.sitTextEl.style.opacity = '0';
    this.updateButtons();

    // Anyone alive without a seat is eliminated.
    const out: Player[] = [];
    for (const p of ctx.players) {
      if (p.dead) continue;
      if (this.seatOf[p.index] == null) out.push(p);
    }
    for (const p of out) {
      p.dead = true;
      p.sitting = false;
      (p as any)._outAt = ++this.outCount;
      markDead(p);
      SFX.fall();
      ctx.fx.burst(p.x, p.z, p.hero.col, 18);
      ctx.fx.banner(p.you ? 'YOU ARE OUT!' : `${p.hero.name} — OUT!`, '#FF4D4D');
    }

    const alive = ctx.players.filter((p) => !p.dead);
    this.phase = 'gap';
    if (alive.length <= 1) {
      setTimeout(() => this.doFinish(), 1100);
      return;
    }
    // Stand survivors back up and go again after a short beat.
    setTimeout(() => {
      for (const p of alive) {
        p.sitting = false;
        this.seatOf[p.index] = null;
      }
      // Reposition survivors around the outer ring.
      alive.forEach((p, i) => {
        const a = (i / alive.length) * Math.PI * 2;
        const r = (this.innerR + this.outerR) / 2;
        p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.vx = 0; p.vz = 0;
        p.group.position.set(p.x, 0, p.z);
      });
      this.startRound(false);
    }, 1400);
  }

  /** HIT: shove the nearest rival within reach. */
  private hit() {
    if (this.phase !== 'walk') return;
    const you = this.ctx.players[0];
    if (you.dead || you.freezeT > 0) return;
    let target: Player | null = null, bestD = HITBOX_RADIUS * 2 + 3;
    for (const p of this.ctx.players.slice(1)) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - you.x, p.z - you.z);
      if (d < bestD) { bestD = d; target = p; }
    }
    if (!target) return;
    const dx = target.x - you.x, dz = target.z - you.z, d = Math.hypot(dx, dz) || 1;
    target.vx += (dx / d) * 34;
    target.vz += (dz / d) * 34;
    target.freezeT = Math.max(target.freezeT, 0.3);
    SFX.bump();
    this.ctx.fx.burst(target.x, target.z, '#FFD23F', 8);
    this.ctx.fx.shake(1);
  }

  private checkBoxPickups() {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      let taker: Player | null = null;
      for (const p of this.ctx.players) {
        if (p.dead) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < HITBOX_RADIUS + 1.6) { taker = p; break; }
      }
      if (!taker) continue;
      this.ctx.scene.remove(b.group);
      this.boxes.splice(i, 1);
      if (b.kind === 'stun') this.applyStun(taker);
      else this.applyStop(taker);
    }
  }

  private applyStun(by: Player) {
    // Freeze the nearest rival for 2s — a clean gap for the collector.
    let victim: Player | null = null, bestD = Infinity;
    for (const p of this.ctx.players) {
      if (p === by || p.dead) continue;
      const d = Math.hypot(p.x - by.x, p.z - by.z);
      if (d < bestD) { bestD = d; victim = p; }
    }
    if (!victim) return;
    victim.freezeT = Math.max(victim.freezeT, 2);
    victim.zapped = true;
    SFX.zap();
    this.ctx.fx.burst(victim.x, victim.z, '#4DA6FF', 12);
    this.ctx.fx.banner(by.you ? 'STUN!' : victim.you ? 'STUNNED!' : '', '#4DA6FF');
  }

  private applyStop(by: Player) {
    this.stopHolder = by.index;
    this.stopHolderT = 5;
    SFX.power();
    this.ctx.fx.banner(by.you ? 'STOP-SONG! tap to cut the music' : '', '#FF3D9E');
    this.updateButtons();
  }

  // --- helpers ---------------------------------------------------------------
  private nearestBox(p: Player): Box | null {
    let best: Box | null = null, bestD = Infinity;
    for (const b of this.boxes) {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private clampRing(p: Player) {
    const r = Math.hypot(p.x, p.z) || 0.0001;
    const nx = p.x / r, nz = p.z / r;
    if (r < this.innerR) {
      p.x = nx * this.innerR; p.z = nz * this.innerR;
      const inward = p.vx * nx + p.vz * nz;
      if (inward < 0) { p.vx -= inward * nx; p.vz -= inward * nz; }
    } else if (r > this.outerR) {
      p.x = nx * this.outerR; p.z = nz * this.outerR;
      const outward = p.vx * nx + p.vz * nz;
      if (outward > 0) { p.vx -= outward * nx; p.vz -= outward * nz; }
    }
  }

  // Input hooks (match wires ability/jump; DOM buttons call the same).
  ability() { if (this.phase === 'sit') this.claimSeat(this.ctx.players[0]); else this.hit(); }
  jump() { if (this.stopHolder === 0) this.stopSong(); }

  // --- DOM overlay -----------------------------------------------------------
  private buildUI() {
    document.getElementById('mcUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'mcUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;';
    ui.innerHTML = `
      <div id="mcNote" style="position:fixed;top:118px;left:50%;transform:translateX(-50%);font-size:34px;
        background:rgba(13,16,38,.6);border-radius:16px;padding:4px 16px;white-space:nowrap;">🎵 ♪ ♫ ♪</div>
      <div id="mcSit" style="position:fixed;top:112px;left:50%;transform:translateX(-50%);font-family:Bungee,cursive;
        font-size:46px;color:#FF4D4D;text-shadow:0 4px 0 rgba(0,0,0,.5);opacity:0;transition:opacity .1s;">SIT!</div>
      <div style="position:fixed;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:14px;">
        <button id="mcHit" style="pointer-events:auto;">👊 HIT</button>
        <button id="mcStop" style="pointer-events:auto;display:none;">⏹ STOP SONG</button>
        <button id="mcSitBtn" style="pointer-events:auto;display:none;">🪑 SIT</button>
      </div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,cursive;font-size:18px;border:none;border-radius:14px;padding:14px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);';
    this.ui = ui;
    this.noteEl = ui.querySelector('#mcNote')!;
    this.sitTextEl = ui.querySelector('#mcSit')!;
    this.hitBtn = ui.querySelector('#mcHit')!;
    this.sitBtn = ui.querySelector('#mcSitBtn')!;
    this.stopBtn = ui.querySelector('#mcStop')!;
    this.hitBtn.style.cssText += btnCss + 'background:#FFD23F;';
    this.sitBtn.style.cssText += btnCss + 'background:#7ED321;';
    this.stopBtn.style.cssText += btnCss + 'background:#FF3D9E;color:#fff;';
    const tap = (el: HTMLElement, fn: () => void) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    };
    tap(this.hitBtn, () => this.hit());
    tap(this.sitBtn, () => this.claimSeat(this.ctx.players[0]));
    tap(this.stopBtn, () => { if (this.stopHolder === 0) this.stopSong(); });
  }

  private updateButtons() {
    if (!this.ui) return;
    this.hitBtn.style.display = this.phase === 'walk' ? 'inline-block' : 'none';
    this.sitBtn.style.display = this.phase === 'sit' ? 'inline-block' : 'none';
    this.stopBtn.style.display = this.phase === 'walk' && this.stopHolder === 0 ? 'inline-block' : 'none';
  }

  private setMusicVisible(on: boolean) {
    if (this.noteEl) this.noteEl.style.opacity = on ? '1' : '0';
  }
  private pulseNote() {
    if (!this.noteEl) return;
    const s = 1 + Math.sin(performance.now() / 140) * 0.12;
    this.noteEl.style.transform = `translateX(-50%) scale(${s.toFixed(3)})`;
    if (this.stopHolder === 0) { this.stopHolderT; this.updateButtons(); }
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    this.phase = 'done';
    SFX.playMusic(this.ctx.family.id);
    document.getElementById('mcUI')?.remove();
    for (const c of this.chairs) this.ctx.scene.remove(c.group);
    this.chairs = [];
    this.clearBoxes();
    const ctx = this.ctx;
    // Rank: last one seated/standing first, earlier eliminations last. Survivors
    // (never eliminated) rank above the eliminated; among equals keep order.
    ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : '🪑 SEATED'));
    // Winner (never eliminated) ranks best; among the eliminated, later out ranks higher.
    ctx.finish(rankBy(ctx, (p) => (p.dead ? ((p as any)._outAt ?? 0) : Infinity)), 'Last one seated wins!');
  }
}
