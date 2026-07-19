import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { tryJump } from '../physics';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, markDead } from '../../ui/hud';

// DODGE — survive the arena itself (Rolling Logs, Laser Dodge, Wind Gauntlet,
// Conveyor Chaos). Four flavors of core threat; 3 lives; survive the clock or
// be the last basher standing. Jump over logs/lasers; fight the wind/belts.

type Hz = 'logs' | 'lasers' | 'wind' | 'conveyor';

interface Log { m: THREE.Mesh; x: number; z: number; vx: number; vz: number; }

export class DodgeGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Dodge';
  objective = 'Survive the arena · 3 lives';

  private ctx!: MatchContext;
  private hz: Hz = 'logs';
  private logs: Log[] = [];
  private logT = 1.5;
  private beams: THREE.Mesh[] = [];
  private beamPivots: THREE.Group[] = [];
  private beamAngles = [0, Math.PI];
  private windAngle = 0;
  private beltDir = 1;
  private beltT = 8;
  private timeLeft = 75;
  private duration = 75;
  private powerups!: Powerups;
  private finished = false;
  private jumpBtn?: HTMLButtonElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.hz = (ctx.game.mods?.hz as Hz) ?? 'logs';
    this.duration = this.timeLeft = matchTime(75);
    this.logs = [];
    this.logT = 1.5;
    this.beams = [];
    this.beamPivots = [];
    this.beamAngles = [Math.random() * 6, Math.random() * 6 + Math.PI];
    this.beltDir = 1;
    this.beltT = 8;

    setupRoster(ctx, 3, 0.45);

    if (this.hz === 'lasers') {
      for (let i = 0; i < 2; i++) {
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry(ctx.halfSize * 0.95, 0.45, 0.45),
          new THREE.MeshBasicMaterial({ color: 0xff3040 }),
        );
        beam.position.x = ctx.halfSize * 0.5;
        const pivot = new THREE.Group();
        pivot.position.y = 1.3;
        pivot.add(beam);
        ctx.scene.add(pivot);
        this.beams.push(beam);
        this.beamPivots.push(pivot);
      }
    }
    if (this.hz === 'conveyor') {
      // Crusher walls on ±x.
      for (const sx of [-1, 1]) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(2.5, 6, ctx.halfSize * 2),
          new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.6, emissive: 0x501010 }),
        );
        wall.position.set(sx * (ctx.halfSize - 1.2), 3, 0);
        ctx.scene.add(wall);
      }
    }

    this.powerups = new Powerups(ctx, ['speed', 'shield'], () => this.leader());

    // Touch JUMP button — the ability corner-tap owns the bottom-right 150px,
    // so hop over logs/lasers with a dedicated button stacked ABOVE it (kept
    // clear of that zone) and marked data-nostick so it never spawns a stick.
    document.getElementById('dodgeUI')?.remove();
    this.jumpBtn = undefined;
    if (this.hz === 'logs' || this.hz === 'lasers') {
      const ui = document.createElement('div');
      ui.id = 'dodgeUI';
      ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
      ui.innerHTML = `
        <button id="djJump" data-nostick style="position:fixed;right:20px;bottom:150px;pointer-events:auto;
          width:88px;height:88px;border-radius:50%;border:none;font-size:15px;font-weight:900;letter-spacing:1px;
          color:#12142e;background:#7CF07C;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);
          touch-action:none;user-select:none;">⤴<br>JUMP</button>`;
      document.body.appendChild(ui);
      this.jumpBtn = ui.querySelector('#djJump')!;
      const hop = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        localJump(this.ctx);
        this.jumpBtn!.style.filter = 'brightness(1.25)';
        setTimeout(() => this.jumpBtn && (this.jumpBtn.style.filter = ''), 120);
      };
      this.jumpBtn.addEventListener('pointerdown', hop);
    }
  }

  private leader(): Player | null {
    const alive = this.ctx.players.filter((p) => !p.dead);
    return alive.sort((a, b) => b.lives - a.lives)[0] ?? null;
  }

  private openEdges(): boolean {
    return this.hz === 'logs' || this.hz === 'wind';
  }

  ability() {
    fireUltimate(this.ctx, this.ctx.players[0]);
  }
  jump() {
    localJump(this.ctx);
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) return this.doFinish('Survived the clock!');
    const prog = 1 - this.timeLeft / this.duration;
    ctx.hazards.setProgress(prog);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);

    const open = this.openEdges();
    localMove(ctx, dt, { noClamp: open });
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse * 1.5 + Math.random() * ctx.diff.lapse;
        // Dodge bots drift toward center with a random offset; better bots
        // stay more central where they can react.
        const spread = (1.1 - ctx.diff.cap) * ctx.halfSize;
        p.tx = (Math.random() - 0.5) * spread;
        p.tz = (Math.random() - 0.5) * spread;
      }
      botMove(ctx, p, p.tx, p.tz, dt, { noClamp: open });
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);

    this.tickThreat(dt, prog, elapsed);
    this.checkDeaths();

    // Survival time doubles as the tiebreaker score.
    for (const p of ctx.players) if (!p.dead) p.score += dt;

    tickRoster(ctx, dt, elapsed);
  }

  private tickThreat(dt: number, prog: number, _elapsed: number) {
    const ctx = this.ctx;
    if (this.hz === 'logs') {
      this.logT -= dt;
      if (this.logT <= 0) {
        this.logT = Math.max(0.8, 2.2 - prog * 1.4);
        const axis = Math.random() < 0.5;
        const off = ctx.halfSize + 5;
        const t = (Math.random() - 0.5) * ctx.halfSize * 1.5;
        const sp = 20 + prog * 10;
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(1.6, 1.6, ctx.halfSize * 1.1, 10),
          new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 }),
        );
        m.rotation.z = axis ? 0 : Math.PI / 2;
        m.rotation.x = axis ? Math.PI / 2 : 0;
        m.castShadow = true;
        ctx.scene.add(m);
        const dir = Math.random() < 0.5 ? 1 : -1;
        this.logs.push(
          axis
            ? { m, x: -off * dir, z: t, vx: sp * dir, vz: 0 }
            : { m, x: t, z: -off * dir, vx: 0, vz: sp * dir },
        );
      }
      this.logs = this.logs.filter((l) => {
        l.x += l.vx * dt;
        l.z += l.vz * dt;
        l.m.position.set(l.x, 1.6, l.z);
        l.m.rotateOnWorldAxis(new THREE.Vector3(l.vz !== 0 ? 1 : 0, 0, l.vx !== 0 ? -1 : 0), dt * 4);
        for (const p of ctx.players) {
          if (p.dead || p.invulnT > 0 || p.y > 2.6) continue;
          const along = l.vx !== 0 ? Math.abs(p.z - l.z) : Math.abs(p.x - l.x);
          const across = l.vx !== 0 ? Math.abs(p.x - l.x) : Math.abs(p.z - l.z);
          // Bots hop imminent logs — commit a per-log dodge roll (skill scales
          // with difficulty) once, then leap while still grounded and in range.
          if (!p.you && p.grounded && p.freezeT <= 0 && along < ctx.halfSize * 0.55) {
            const toward = l.vx !== 0 ? (p.x - l.x) * l.vx : (p.z - l.z) * l.vz;
            if (toward > 0 && across < 7) {
              const dec = ((l as any)._dec ??= {}) as Record<number, boolean>;
              if (dec[p.index] === undefined) dec[p.index] = Math.random() < 0.35 + ctx.diff.cap * 0.5;
              if (dec[p.index] && across < 6) tryJump(p);
            }
          }
          if (across < HITBOX_RADIUS + 1.6 && along < ctx.halfSize * 0.55) {
            const L = Math.hypot(l.vx, l.vz) || 1;
            p.vx += (l.vx / L) * 34;
            p.vz += (l.vz / L) * 34;
            p.freezeT = Math.max(p.freezeT, 0.25);
            SFX.bump();
            ctx.fx.burst(p.x, p.z, '#C98A3F', 8);
          }
        }
        if (Math.abs(l.x) > ctx.halfSize + 8 || Math.abs(l.z) > ctx.halfSize + 8) {
          ctx.scene.remove(l.m);
          return false;
        }
        return true;
      });
    } else if (this.hz === 'lasers') {
      this.beamPivots.forEach((pivot, i) => {
        this.beamAngles[i] += dt * (0.7 + prog * 0.8) * (i === 0 ? 1 : -0.8);
        pivot.rotation.y = this.beamAngles[i];
        for (const p of ctx.players) {
          if (p.dead || p.invulnT > 0 || p.y > 2.4) continue;
          const r = Math.hypot(p.x, p.z);
          if (r > ctx.halfSize || r < 1) continue;
          let diff = Math.atan2(p.z, p.x) - -this.beamAngles[i];
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          if (Math.abs(diff) > Math.PI / 2) continue;
          const perp = Math.abs(Math.sin(diff)) * r;
          const now = performance.now() / 1000;
          if (perp < 1.5 && now - ((p as any)._lz ?? 0) > 0.8) {
            (p as any)._lz = now;
            this.hurt(p, 'ZAPPED!');
          }
        }
      });
    } else if (this.hz === 'wind') {
      // Gale rotates slowly; strength ramps. Fight it or be blown off.
      this.windAngle += dt * 0.25;
      const strength = 10 + prog * 14;
      const gust = 0.7 + 0.3 * Math.sin(this.windAngle * 3.1);
      for (const p of ctx.players) {
        if (p.dead) continue;
        p.vx += Math.cos(this.windAngle) * strength * gust * dt;
        p.vz += Math.sin(this.windAngle) * strength * gust * dt;
      }
    } else if (this.hz === 'conveyor') {
      this.beltT -= dt;
      if (this.beltT <= 0) {
        this.beltT = 8;
        this.beltDir *= -1;
        ctx.fx.banner('BELTS REVERSED!', '#2EF2FF');
        SFX.crack();
      }
      const push = (8 + prog * 8) * this.beltDir;
      for (const p of ctx.players) {
        if (p.dead) continue;
        p.vx += push * dt * 2.4;
        // Crusher strike zone.
        if (Math.abs(p.x) > ctx.halfSize - 3.4 && p.invulnT <= 0) {
          this.hurt(p, 'CRUSHED!');
          p.x = 0;
          p.z = 0;
          p.vx = 0;
          p.vz = 0;
          p.invulnT = 1;
        }
      }
    }
  }

  private hurt(p: Player, msg: string) {
    if (p.shieldT > 0) {
      p.shieldT = 0;
      this.ctx.fx.banner(p.you ? 'SHIELD BROKE!' : '', p.hero.col);
      return;
    }
    p.lives--;
    setScore(p, Math.max(p.lives, 0));
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 16);
    this.ctx.fx.shake(2);
    SFX.fall();
    if (p.you) this.ctx.fx.banner(msg, '#FF4D4D');
    if (p.lives <= 0) this.eliminate(p);
    else p.invulnT = 1;
  }

  private eliminate(p: Player) {
    p.dead = true;
    markDead(p);
    SFX.out();
    this.ctx.fx.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
    const alive = this.ctx.players.filter((q) => !q.dead);
    if (p.you || alive.length <= 1) setTimeout(() => this.doFinish('Last basher standing wins.'), 900);
  }

  private checkDeaths() {
    if (!this.openEdges()) return;
    const ctx = this.ctx;
    for (const p of ctx.players) {
      if (p.dead || p.invulnT > 0) continue;
      if (Math.abs(p.x) > ctx.halfSize + 1 || Math.abs(p.z) > ctx.halfSize + 1) {
        p.lives--;
        setScore(p, Math.max(p.lives, 0));
        SFX.fall();
        ctx.fx.burst(p.x, p.z, p.hero.col, 18);
        ctx.fx.banner(p.you ? 'YOU FELL!' : p.hero.name + ' FELL!', p.hero.col);
        if (p.lives <= 0) this.eliminate(p);
        else {
          p.x = (Math.random() - 0.5) * ctx.halfSize * 0.4;
          p.z = (Math.random() - 0.5) * ctx.halfSize * 0.4;
          p.vx = 0;
          p.vz = 0;
          p.invulnT = 1;
        }
      }
    }
  }

  private doFinish(sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('dodgeUI')?.remove();
    this.jumpBtn = undefined;
    this.ctx.players.forEach((p) => ((p as any)._res = p.dead ? 'OUT' : `${Math.max(p.lives, 0)} lives · ${Math.round(p.score)}s`));
    this.ctx.finish(rankBy(this.ctx, (p) => (p.dead ? p.score * 0.001 - 10 : p.lives * 1000 + p.score)), sub);
  }
}
