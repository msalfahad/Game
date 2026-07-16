import * as THREE from 'three';
import type { MatchContext } from './context';
import type { Player } from './player';
import { HITBOX_RADIUS } from './player';
import { SFX } from '../core/audio';
import { TUNING } from '../core/tuning';

// Power-up economy (SPEC section 7, subset): timed pickups spawning roughly
// every 20s with ANTI-SNOWBALL placement — items never spawn nearest the
// leader; we pick the candidate spot farthest from whoever is winning.

export type PowerupKind = 'speed' | 'shield' | 'giant' | 'magnet' | 'heal';

interface Item {
  m: THREE.Group;
  x: number;
  z: number;
  kind: PowerupKind;
}

const COLORS: Record<PowerupKind, number> = {
  speed: 0x2ef2ff,
  shield: 0xbfe8ff,
  giant: 0xff9c3f,
  magnet: 0xb06bff,
  heal: 0x7ed321,
};
const LABEL: Record<PowerupKind, string> = {
  speed: 'SPEED BOOST', shield: 'SHIELD', giant: 'GIANT FORM', magnet: 'MAGNET', heal: 'HEALING ORB',
};

export class Powerups {
  private ctx: MatchContext;
  private kinds: PowerupKind[];
  private leaderOf: () => Player | null;
  private items: Item[] = [];
  private t: number;

  /** magnet pull is exposed for collect-mechanics; seconds remaining per player index. */
  magnetT: number[] = [0, 0, 0, 0];

  constructor(ctx: MatchContext, kinds: PowerupKind[], leaderOf: () => Player | null) {
    this.ctx = ctx;
    this.kinds = kinds;
    this.leaderOf = leaderOf;
    this.t = this.interval() * 0.6; // first spawn arrives a bit early
  }

  private interval(): number {
    const s = TUNING.powerupScale;
    return s <= 0 ? Infinity : 20 / s;
  }

  tick(dt: number) {
    this.t -= dt;
    if (this.t <= 0) {
      this.t = this.interval() * (0.8 + Math.random() * 0.4);
      this.spawn();
    }
    for (let i = 0; i < this.magnetT.length; i++) this.magnetT[i] = Math.max(0, this.magnetT[i] - dt);

    const now = performance.now() / 1000;
    this.items = this.items.filter((it) => {
      it.m.rotation.y += dt * 2;
      it.m.position.y = 2.2 + Math.sin(now * 3 + it.x) * 0.5;
      for (const p of this.ctx.players) {
        if (p.dead) continue;
        if (Math.hypot(p.x - it.x, p.z - it.z) < HITBOX_RADIUS + 1.8) {
          this.apply(p, it.kind);
          this.ctx.scene.remove(it.m);
          return false;
        }
      }
      return true;
    });
  }

  private apply(p: Player, kind: PowerupKind) {
    switch (kind) {
      case 'speed': p.speedT = Math.max(p.speedT, 6); break;
      case 'shield': p.shieldT = Math.max(p.shieldT, 6); break;
      case 'giant': p.giantT = Math.max(p.giantT, 6); break;
      case 'magnet': this.magnetT[p.index] = 6; break;
      case 'heal': p.hp = Math.min(100, p.hp + 20); break;
    }
    SFX.power();
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 12);
    this.ctx.fx.banner(p.you ? LABEL[kind] + '!' : '', p.hero.col);
    if (p.you && kind === 'heal') this.ctx.setScore(p, Math.round(p.hp));
  }

  private spawn() {
    const kind = this.kinds[Math.floor(Math.random() * this.kinds.length)];
    // Anti-snowball: sample 8 candidate spots, take the farthest from the leader.
    const leader = this.leaderOf();
    let bx = 0, bz = 0, best = -1;
    for (let i = 0; i < 8; i++) {
      const x = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
      const z = (Math.random() - 0.5) * this.ctx.halfSize * 1.6;
      const d = leader ? Math.hypot(x - leader.x, z - leader.z) : Math.random();
      if (d > best) { best = d; bx = x; bz = z; }
    }
    const grp = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.3),
      new THREE.MeshStandardMaterial({ color: COLORS[kind], emissive: COLORS[kind], emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.4 }),
    );
    // No cast shadow: a small floating orb throws a hard, blocky shadow blob
    // onto the ground (the "black square in the middle of the map"). It glows
    // and has a halo, so it reads fine without one.
    core.castShadow = false;
    grp.add(core);
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(2, 0.14, 6, 24),
      new THREE.MeshBasicMaterial({ color: COLORS[kind], transparent: true, opacity: 0.6 }),
    );
    halo.rotation.x = Math.PI / 2;
    grp.add(halo);
    grp.position.set(bx, 2.2, bz);
    this.ctx.scene.add(grp);
    this.items.push({ m: grp, x: bx, z: bz, kind });
  }
}
