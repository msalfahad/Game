import type { Engine } from '../core/engine';
import type { Player } from './player';

// End-of-match ceremony: everyone RUNS to a line-up in finishing order
// (best on the left), the camera zooms in, medals + scores float above
// heads, and the WINNER dances — jumping and spinning — before the results
// screen appears.

const MEDALS = ['🥇', '🥈', '🥉', '4.'];

export function victoryWalk(
  engine: Engine,
  ranked: Player[],
  labels: string[],
  _opts: { z?: number; follow?: boolean },
  done: () => void,
) {
  const spots = ranked.map((_, i) => ({ x: (i - (ranked.length - 1) / 2) * 7.5, z: 5 }));
  ranked.forEach((p, i) => {
    p.dead = false;
    p.group.visible = true;
    p.freezeT = 0;
    p.zapped = false;
    p.flinchT = 0;
    p.held = false;
    p.y = 0;
    p.vy = 0;
    p.group.scale.setScalar(1);
    p.setStatusIcon(`${MEDALS[i] ?? i + 1 + '.'} ${labels[i] ?? ''}`.trim(), 6);
  });
  // Camera: zoom IN on the line-up (also resets any climb follow offset).
  engine.camera.frame(13, 1);

  let t = 0;
  engine.start((dt, elapsed) => {
    t += dt;
    ranked.forEach((p, i) => {
      const s = spots[i];
      if (t < 1.15) {
        // Run to your place in line.
        const dx = s.x - p.x, dz = s.z - p.z;
        const L = Math.hypot(dx, dz);
        const step = Math.min(L, dt * Math.max(14, L * 3));
        if (L > 0.1) {
          p.vx = (dx / L) * 14; // facing follows velocity
          p.x += (dx / L) * step;
          p.z += (dz / L) * step;
        }
      } else {
        // In line: settle, face front.
        p.x += (s.x - p.x) * 0.2;
        p.z += (s.z - p.z) * 0.2;
        p.vx = 0;
        p.vz = 0;
        if (i === 0) {
          // WINNER DANCE: bouncy jumps with a little spin and shimmy.
          const dtT = t - 1.15;
          p.y = Math.abs(Math.sin(dtT * 5)) * 2.6;
          p.group.rotation.y = Math.sin(dtT * 2.5) * 0.5;
          p.x = s.x + Math.sin(dtT * 5) * 0.7;
        }
      }
      p.group.position.set(p.x, p.y, p.z);
      p.bob(elapsed, p.index);
      p.tickEffects(dt);
    });
    if (t > 4.4) {
      ranked[0].group.rotation.y = 0;
      engine.stop();
      done();
    }
  });
}
