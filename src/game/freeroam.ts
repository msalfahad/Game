import type { MatchContext } from './context';
import type { Player } from './player';
import { HITBOX_RADIUS } from './player';
import { surface } from '../data/surfaces';
import { strengthMult, defenseMult } from '../data/characters';
import { moveFreeRoam, tryJump, tryDash } from './physics';
import { makeHeads } from '../ui/hud';
import { SFX } from '../core/audio';
import { TUNING } from '../core/tuning';

// Shared helpers for every free-roam mechanic: roster spawn, local + bot
// movement (with hazard wind folded in), pairwise shove collisions, effect
// ticking, and common jump handling.

export interface RoamOpts {
  noClamp?: boolean;
  speedMul?: number;
}

/** Reset + spawn the four players at diagonal-ish spots and build HUD heads. */
export function setupRoster(ctx: MatchContext, initScore: string | number, spread = 0.55) {
  const spots = [
    [-spread, spread], [spread, -spread], [-spread, -spread], [spread, spread],
  ];
  ctx.players.forEach((p, i) => {
    p.x = spots[i][0] * ctx.halfSize;
    p.z = spots[i][1] * ctx.halfSize;
    p.vx = 0; p.vz = 0; p.y = 0; p.vy = 0;
    p.grounded = true; p.airJumps = 0; p.dashCd = 0; p.diveT = 0;
    p.freezeT = 0; p.speedT = 0; p.giantT = 0; p.shieldT = 0; p.invulnT = 0;
    p.dead = false; p.cd = 0; p.armed = false; p.held = false;
    p.score = 0; p.hp = 100; p.lives = 3; p.retarget = 0; p.wp = 0; p.lap = 0;
    p.group.scale.setScalar(1);
    p.buildRider(ctx.scene);
  });
  makeHeads(ctx.players, initScore);
}

/** Move the local player from input; folds in hazard wind. */
export function localMove(ctx: MatchContext, dt: number, opts: RoamOpts = {}) {
  const you = ctx.players[0];
  if (you.dead) return;
  const ax = ctx.input.ax, ay = ctx.input.ay;
  const sprint = Math.hypot(ax, ay) > 0.9;
  const wind = ctx.hazards.windForce();
  you.vx += wind.x * dt;
  you.vz += wind.z * dt;
  const surf = surface(ctx.world.surfaceAt(you.x, you.z));
  moveFreeRoam(you, ax, ay, surf, dt, { halfSize: ctx.halfSize, sprint, noClamp: opts.noClamp, speedMul: opts.speedMul });
}

/**
 * Move a bot toward (tx, tz), speed-capped by difficulty x tuning. Prefers a
 * live decoy (Phantom Clone) over its chosen target when one exists.
 */
export function botMove(ctx: MatchContext, p: Player, tx: number, tz: number, dt: number, opts: RoamOpts = {}) {
  if (p.dead) return;
  if (ctx.decoys.length && !p.you) {
    const d = ctx.decoys[0];
    tx = d.x;
    tz = d.z;
  }
  const wind = ctx.hazards.windForce();
  p.vx += wind.x * dt;
  p.vz += wind.z * dt;
  const dx = tx - p.x, dz = tz - p.z;
  const L = Math.hypot(dx, dz) || 1;
  const cap = Math.min(1, ctx.diff.cap * TUNING.botScale);
  const surf = surface(ctx.world.surfaceAt(p.x, p.z));
  moveFreeRoam(p, (dx / L) * cap, (dz / L) * cap, surf, dt, {
    halfSize: ctx.halfSize,
    sprint: cap > 0.85,
    noClamp: opts.noClamp,
    speedMul: opts.speedMul,
  });
  // Confident bots occasionally dash toward far targets.
  if (cap > 0.7 && p.dashCd <= 0 && L > ctx.halfSize * 0.6 && Math.random() < dt * 0.3) {
    tryDash(p, dx / L, dz / L);
  }
}

/** Pairwise shove collisions. Strength shoves harder, defense resists; giant amplifies both. */
export function collidePlayers(ctx: MatchContext, onBump?: (a: Player, b: Player) => void) {
  const ps = ctx.players;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.dead || b.dead || a.invulnT > 0 || b.invulnT > 0) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      const ra = HITBOX_RADIUS * (a.giantT > 0 ? 1.35 : 1);
      const rb = HITBOX_RADIUS * (b.giantT > 0 ? 1.35 : 1);
      const min = ra + rb;
      if (dist >= min || dist <= 0) continue;
      const nx = dx / dist, nz = dz / dist, ov = min - dist;
      a.x -= (nx * ov) / 2; a.z -= (nz * ov) / 2;
      b.x += (nx * ov) / 2; b.z += (nz * ov) / 2;
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const powA = strengthMult(a.hero) * (a.giantT > 0 ? 1.45 : 1);
        const powB = strengthMult(b.hero) * (b.giantT > 0 ? 1.45 : 1);
        const massA = defenseMult(a.hero) * (a.giantT > 0 ? 1.5 : 1);
        const massB = defenseMult(b.hero) * (b.giantT > 0 ? 1.5 : 1);
        const imp = -rel * 1.5;
        const dampA = a.shieldT > 0 ? 0.5 : 1;
        const dampB = b.shieldT > 0 ? 0.5 : 1;
        a.vx -= (nx * imp * powB * dampA) / massA;
        a.vz -= (nz * imp * powB * dampA) / massA;
        b.vx += (nx * imp * powA * dampB) / massB;
        b.vz += (nz * imp * powA * dampB) / massB;
        SFX.bump();
        ctx.fx.burst((a.x + b.x) / 2, (a.z + b.z) / 2, '#FFD23F', 8);
        ctx.fx.shake(1.2);
        onBump?.(a, b);
      }
    }
  }
}

/** Per-frame effect/timer upkeep + hover bob + mesh position sync. */
export function tickRoster(ctx: MatchContext, dt: number, elapsed: number) {
  for (const p of ctx.players) {
    p.tickEffects(dt);
    if (!p.dead) {
      p.group.position.set(p.x, p.y, p.z);
      p.bob(elapsed, p.index + p.x * 0.1);
    }
    p.group.visible = !p.dead;
  }
}

/** Shared jump handler for the local player. */
export function localJump(ctx: MatchContext) {
  const you = ctx.players[0];
  if (!you.dead && you.freezeT <= 0 && tryJump(you)) SFX.tick();
}

/** Rank helper: sort a copy of players by a score function, best first. */
export function rankBy(ctx: MatchContext, fn: (p: Player) => number): Player[] {
  return [...ctx.players].sort((a, b) => fn(b) - fn(a));
}
