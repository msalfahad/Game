import type { Engine } from '../core/engine';
import type { Player } from './player';

// End-of-match parade: everyone lines up in FINISHING ORDER (winner leading)
// and walks together across the front of the arena, medal + score floating
// above each head, before the results screen appears.

const MEDALS = ['🥇', '🥈', '🥉', '4.'];

export function victoryWalk(
  engine: Engine,
  ranked: Player[],
  labels: string[],
  opts: { z?: number; follow?: boolean },
  done: () => void,
) {
  const z = opts.z ?? 12;
  ranked.forEach((p, i) => {
    p.dead = false;
    p.group.visible = true;
    p.freezeT = 0;
    p.zapped = false;
    p.flinchT = 0;
    p.held = false;
    p.y = 0;
    p.vx = 6; // heading right — matches the sheets' facing
    p.vz = 0;
    p.x = 2 - i * 8; // winner in front, the rest trailing in order
    p.z = z;
    p.group.scale.setScalar(1);
    p.setStatusIcon(`${MEDALS[i] ?? i + 1 + '.'} ${labels[i] ?? ''}`.trim(), 5);
  });
  let t = 0;
  engine.start((dt, elapsed) => {
    t += dt;
    for (const p of ranked) {
      p.x += 5.5 * dt; // stroll right together
      p.group.position.set(p.x, 0, p.z);
      p.bob(elapsed, p.index);
      p.tickEffects(dt);
    }
    if (opts.follow) engine.camera.follow(z, -1000, 1000);
    if (t > 3) {
      engine.stop();
      done();
    }
  });
}
