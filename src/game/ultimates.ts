import type * as THREE from 'three';
import type { MatchContext } from './context';
import type { Player } from './player';
import { makeDecoySprite, HITBOX_RADIUS } from './player';
import { strengthMult } from '../data/characters';
import { SFX } from '../core/audio';

// Hero ultimates (SPEC section 3) for free-roam mechanics. Each is a short,
// readable burst of advantage on a shared cooldown; strength stat scales the
// knockback flavors within the 15% cap.

export const ULT_CD = 14;

export function ultReady(p: Player): boolean {
  return p.cd <= 0 && !p.dead && p.freezeT <= 0;
}

/** Fire p's ultimate. Returns true if it fired (starts the cooldown). */
export function fireUltimate(ctx: MatchContext, p: Player): boolean {
  if (!ultReady(p)) return false;
  p.cd = ULT_CD;
  const rivals = ctx.players.filter((q) => q !== p && !q.dead);
  const near = (r: number) => rivals.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < r);
  const knock = (targets: Player[], impulse: number) => {
    const str = strengthMult(p.hero);
    for (const q of targets) {
      const d = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const damp = q.shieldT > 0 ? 0.5 : 1;
      q.vx += ((q.x - p.x) / d) * impulse * str * damp;
      q.vz += ((q.z - p.z) / d) * impulse * str * damp;
    }
  };

  switch (p.hero.ultimate) {
    case 'blink': { // Volt — Lightning Blink: teleport ahead
      const dist = 14;
      p.x += p.face.x * dist;
      p.z += p.face.z * dist;
      const m = ctx.halfSize - 1.5;
      p.x = Math.max(-m, Math.min(m, p.x));
      p.z = Math.max(-m, Math.min(m, p.z));
      p.speedT = Math.max(p.speedT, 1.2);
      break;
    }
    case 'spin': // Ember — Fire Spin: close-range knockback whirl
      knock(near(9), 34);
      break;
    case 'clone': { // Mirage — Phantom Clone: decoy bots chase; you slip away
      const sprite = makeDecoySprite(p.hero);
      sprite.position.set(p.x, HITBOX_RADIUS * 1.05 + 0.6, p.z);
      ctx.scene.add(sprite);
      ctx.decoys.push({ x: p.x, z: p.z, t: 4, sprite });
      p.speedT = Math.max(p.speedT, 2);
      break;
    }
    case 'burst': // Nova — Stellar Burst: big radial shockwave
      knock(near(12), 40);
      break;
    case 'root': // Timber — Root Cage: freeze nearby rivals
      for (const q of near(10)) q.freezeT = Math.max(q.freezeT, 1.3);
      break;
    case 'heal': // Moss — Healing Grove: restore + brief shield
      p.hp = Math.min(100, p.hp + 25);
      p.lives = Math.min(3, p.lives); // lives games benefit from the shield instead
      p.shieldT = Math.max(p.shieldT, 3);
      break;
    case 'slam': // Glacier — Frozen Ground Slam: freeze + shove
      for (const q of near(9)) q.freezeT = Math.max(q.freezeT, 0.8);
      knock(near(9), 24);
      break;
    case 'fortress': // Boulder — Rolling Fortress: unstoppable shove-through
      p.shieldT = Math.max(p.shieldT, 3);
      knock(near(8), 26);
      break;
  }

  SFX.power();
  ctx.fx.burst(p.x, p.z, p.hero.col, 18);
  ctx.fx.shake(1.5);
  ctx.fx.banner(p.you ? p.hero.ultName.toUpperCase() + '!' : '', p.hero.col);
  return true;
}

/** Bots occasionally fire their ultimate when rivals are near (skill-gated). */
export function botMaybeUltimate(ctx: MatchContext, p: Player, dt: number) {
  if (!ultReady(p)) return;
  const anyNear = ctx.players.some((q) => q !== p && !q.dead && Math.hypot(q.x - p.x, q.z - p.z) < 11);
  const chance = ctx.diff.cap * 0.25;
  if (anyNear && Math.random() < dt * chance) fireUltimate(ctx, p);
}

/** Tick decoys down and drop their sprites when expired. */
export function tickDecoys(ctx: MatchContext, dt: number) {
  ctx.decoys = ctx.decoys.filter((d) => {
    d.t -= dt;
    if (d.t <= 0) {
      ctx.scene.remove(d.sprite);
      return false;
    }
    (d.sprite.material as THREE.SpriteMaterial).opacity = Math.min(0.7, d.t);
    return true;
  });
}
