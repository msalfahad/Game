import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump } from '../freeroam';
import { fireUltimate, botMaybeUltimate, tickDecoys } from '../ultimates';
import { Powerups } from '../powerups';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// RACE — pass through 8 glowing gates in order, around the arena, for N laps
// (Avalanche Run, Volcano Rush, Oasis Dash, Jungle Race, Sky Race, Pirate
// Race). Boost pads on the infield; family hazards batter the course. First
// to finish wins; otherwise furthest progress when time expires.

const WPS = 8;

export class RaceGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Race';
  objective = 'Pass the glowing gates in order · first to finish';

  private ctx!: MatchContext;
  private gates: THREE.Mesh[] = [];
  private pads: THREE.Mesh[] = [];
  private laps = 2;
  private timeLeft = 90;
  private duration = 90;
  private powerups!: Powerups;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.laps = Number(ctx.game.mods?.laps ?? 2);
    this.duration = this.timeLeft = matchTime(90);
    this.gates = [];
    this.pads = [];

    setupRoster(ctx, '0/' + WPS * this.laps, 0.5);
    // Grid start near gate 0.
    const g0 = this.wpPos(0);
    ctx.players.forEach((p, i) => {
      p.x = g0.x - 6 - (i % 2) * 5;
      p.z = g0.z + (i - 1.5) * 5;
    });

    const trim = ctx.family.theme.trim;
    for (let i = 0; i < WPS; i++) {
      const { x, z } = this.wpPos(i);
      const gate = new THREE.Mesh(
        new THREE.TorusGeometry(4.2, 0.5, 8, 32),
        new THREE.MeshBasicMaterial({ color: trim, transparent: true, opacity: 0.5 }),
      );
      gate.position.set(x, 4.4, z);
      gate.lookAt(0, 4.4, 0);
      ctx.scene.add(gate);
      this.gates.push(gate);
    }

    // Boost pads on the infield diagonals.
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(2.6, 20),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.65 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(Math.cos(a) * ctx.halfSize * 0.4, 0.15, Math.sin(a) * ctx.halfSize * 0.4);
      ctx.scene.add(pad);
      this.pads.push(pad);
    }

    this.powerups = new Powerups(ctx, ['speed', 'shield'], () => this.leaderP());
  }

  private wpPos(i: number): { x: number; z: number } {
    const a = (i / WPS) * Math.PI * 2 + Math.PI / 2; // start at bottom (near camera)
    const r = this.ctx.halfSize * 0.72;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  private progress(p: Player): number {
    const next = this.wpPos(p.wp);
    const d = Math.hypot(next.x - p.x, next.z - p.z);
    return p.lap * WPS + p.wp + Math.max(0, 1 - d / (this.ctx.halfSize * 4));
  }

  private leaderP(): Player | null {
    return [...this.ctx.players].sort((a, b) => this.progress(b) - this.progress(a))[0] ?? null;
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
    if (this.timeLeft <= 0) return this.doFinish('Time! Furthest along wins.');
    ctx.hazards.setProgress(1 - this.timeLeft / this.duration);
    ctx.hazards.tick(dt, ctx.players);
    this.powerups.tick(dt);
    tickDecoys(ctx, dt);

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      if (p.dead) continue;
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse + Math.random() * ctx.diff.lapse;
        const t = this.wpPos(p.wp);
        p.tx = t.x + (Math.random() - 0.5) * ctx.diff.err * 26;
        p.tz = t.z + (Math.random() - 0.5) * ctx.diff.err * 26;
      }
      botMove(ctx, p, p.tx, p.tz, dt);
      botMaybeUltimate(ctx, p, dt);
    }
    collidePlayers(ctx);

    // Gate passes + boost pads.
    for (const p of ctx.players) {
      if (p.dead) continue;
      const t = this.wpPos(p.wp);
      if (Math.hypot(p.x - t.x, p.z - t.z) < 5) {
        p.wp++;
        p.score++;
        setScore(p, `${p.score}/${WPS * this.laps}`);
        if (p.you) SFX.gem();
        if (p.wp >= WPS) {
          p.wp = 0;
          p.lap++;
          ctx.fx.banner(p.you ? `LAP ${p.lap + 1}!` : '', p.hero.col);
          if (p.lap >= this.laps) {
            ctx.fx.banner(p.you ? 'FINISH!' : p.hero.name + ' FINISHES!', p.hero.col);
            return this.doFinish(p.you ? 'You crossed the line!' : p.hero.name + ' took it.');
          }
        }
      }
      for (const pad of this.pads) {
        if (Math.hypot(p.x - pad.position.x, p.z - pad.position.z) < 3) {
          if (p.speedT < 1.2) {
            p.speedT = Math.max(p.speedT, 1.6);
            p.vx += p.face.x * 18;
            p.vz += p.face.z * 18;
            if (p.you) SFX.power();
          }
        }
      }
    }

    // Gate highlight: local player's next gate pulses gold.
    const youNext = ctx.players[0].wp;
    this.gates.forEach((g, i) => {
      const mat = g.material as THREE.MeshBasicMaterial;
      const isNext = i === youNext;
      mat.color.setHex(isNext ? 0xffd23f : ctx.family.theme.trim);
      mat.opacity = isNext ? 0.9 : 0.35;
      g.scale.setScalar(isNext ? 1 + Math.sin(elapsed * 6) * 0.08 : 1);
    });

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish(sub: string) {
    if (this.finished) return;
    this.finished = true;
    const ranked = [...this.ctx.players].sort((a, b) => this.progress(b) - this.progress(a));
    this.ctx.players.forEach((p) => ((p as any)._res = `${p.lap * WPS + p.wp} gates`));
    this.ctx.finish(ranked, sub);
  }
}
