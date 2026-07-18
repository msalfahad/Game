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
  _opts: { z?: number; follow?: boolean; kart?: boolean; laneZ?: number },
  done: () => void,
) {
  const kart = !!_opts.kart;
  if (kart) return kartVictory(engine, ranked, labels, _opts.laneZ ?? 19, done);
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
    p.sitting = false;       // stand up for the parade (e.g. Musical Chairs)
    p.fallen = false;
    p.standFacing = null;
    p.group.scale.setScalar(1);
    p.setStatusIcon(`${MEDALS[i] ?? i + 1 + '.'} ${labels[i] ?? ''}`.trim(), 6);
  });
  // Camera: frame the WHOLE line-up (4 heroes span ~22 units) with headroom
  // for the medals + the winner's jump — not a tight zoom on the middle two.
  engine.camera.frame(30, 1);

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
          // WINNER DANCE: the 3D hero does a full skeletal celebration dance
          // (arms overhead, hips sway) on top of a bouncy hop + shimmy.
          p.celebrate = true;
          const dtT = t - 1.15;
          p.y = Math.abs(Math.sin(dtT * 5)) * 2.0;
          p.group.rotation.y = Math.sin(dtT * 2.5) * 0.5;
          p.x = s.x + Math.sin(dtT * 5) * 0.7;
        }
      }
      p.group.position.set(p.x, p.y, p.z);
      p.bob(elapsed, p.index);
      p.tickEffects(dt);
    });
    // Run to the line (~1.15s) then celebrate for a full 5s before results.
    if (t > 6.2) {
      ranked[0].group.rotation.y = 0;
      ranked[0].celebrate = false;
      engine.stop();
      done();
    }
  });
}

// Kart victory: the drivers STAY in their karts, line up ON THE ROAD in
// finishing order facing the camera, and do a hands-only seated dance.
function kartVictory(engine: Engine, ranked: Player[], labels: string[], laneZ: number, done: () => void) {
  const spots = ranked.map((_, i) => ({ x: (i - (ranked.length - 1) / 2) * 6.5, z: laneZ }));
  ranked.forEach((p, i) => {
    p.dead = false;
    p.group.visible = true;
    p.freezeT = 0; p.zapped = false; p.flinchT = 0; p.held = false;
    p.y = 0.55; p.vy = 0; p.vx = 0; p.vz = 0;
    p.sitting = true;              // stay in the kart
    p.standFacing = 0;             // face the camera (+z)
    p.celebrate = true;            // hands-only seated cheer
    p.group.scale.setScalar(1);
    p.setStatusIcon(`${MEDALS[i] ?? i + 1 + '.'} ${labels[i] ?? ''}`.trim(), 6);
  });
  engine.camera.frame(30, 1);
  let t = 0;
  engine.start((dt, elapsed) => {
    t += dt;
    ranked.forEach((p, i) => {
      const s = spots[i];
      // Ease the kart + driver into the road line-up.
      p.x += (s.x - p.x) * Math.min(1, dt * 4);
      p.z += (s.z - p.z) * Math.min(1, dt * 4);
      p.vx = 0; p.vz = 0;
      p.group.position.set(p.x, p.y, p.z);
      const k = (p as any).kart as { position: { set: (x: number, y: number, z: number) => void }; rotation: { y: number } } | undefined;
      if (k) { k.position.set(p.x, 0, p.z); k.rotation.y = 0; }
      p.bob(elapsed, p.index);
      p.tickEffects(dt);
    });
    if (t > 6.2) {
      ranked.forEach((p) => (p.celebrate = false));
      engine.stop();
      done();
    }
  });
}
