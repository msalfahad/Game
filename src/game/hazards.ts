import * as THREE from 'three';
import type { MapDef, HazardKind } from '../data/maps';
import type { Player } from './player';
import type { Fx } from './context';
import { HITBOX_RADIUS } from './player';
import { SFX } from '../core/audio';

// Frostbite hazard set (SPEC section 1), ramping across the family's 4 maps:
//   blizzard - a slowly-rotating wind vector that shoves everything downwind
//   icicles  - fall from above; a hit briefly stuns (freezes control)
//   boulders - slide across the ice and knock players back on contact
// Hazards escalate over the match ("escalation every ~45s", SPEC section 8):
// spawn cadence tightens as time runs down.

interface Icicle { m: THREE.Mesh; x: number; z: number; y: number; vy: number; warned: boolean; }
interface Boulder { m: THREE.Mesh; x: number; z: number; vx: number; vz: number; }

export class Hazards {
  private scene: THREE.Scene;
  private half: number;
  private fx: Fx;

  windAngle = 0;
  wind = { x: 0, z: 0 };
  private windStrength = 0;

  private icicles: Icicle[] = [];
  private boulders: Boulder[] = [];
  private iceTimer = 0;
  private boulderTimer = 0;
  private escalation = 1; // grows over time, tightening spawn cadence

  readonly has: Record<HazardKind, boolean>;

  constructor(scene: THREE.Scene, map: MapDef, half: number, fx: Fx) {
    this.scene = scene;
    this.half = half;
    this.fx = fx;
    this.has = {
      blizzard: map.hazards.includes('blizzard'),
      icicles: map.hazards.includes('icicles'),
      boulders: map.hazards.includes('boulders'),
      cracks: map.hazards.includes('cracks'),
    };
    if (this.has.blizzard) this.windStrength = 7;
  }

  /** Wind force to fold into player velocity (blizzard). */
  windForce(): { x: number; z: number } {
    return this.wind;
  }

  /** Ramp hazard intensity as the match escalates (0..1 progress). */
  setProgress(p: number) {
    this.escalation = 1 + p * 1.6;
  }

  tick(dt: number, players: Player[]) {
    // Blizzard: rotate the wind vector slowly for an unpredictable shove.
    if (this.has.blizzard) {
      this.windAngle += dt * 0.5;
      const gust = 0.6 + 0.4 * Math.sin(this.windAngle * 1.7);
      this.wind.x = Math.cos(this.windAngle) * this.windStrength * gust;
      this.wind.z = Math.sin(this.windAngle) * this.windStrength * gust;
    }

    if (this.has.icicles) this.tickIcicles(dt, players);
    if (this.has.boulders) this.tickBoulders(dt, players);
  }

  private tickIcicles(dt: number, players: Player[]) {
    this.iceTimer -= dt;
    if (this.iceTimer <= 0) {
      this.iceTimer = (1.8 + Math.random() * 1.6) / this.escalation;
      this.spawnIcicle();
    }
    this.icicles = this.icicles.filter((ic) => {
      ic.y += ic.vy * dt;
      ic.vy -= 42 * dt;
      ic.m.position.set(ic.x, Math.max(ic.y, 0), ic.z);
      if (ic.y <= 0) {
        this.fx.burst(ic.x, ic.z, '#BFE8FF', 10);
        SFX.crack();
        this.fx.shake(1.2);
        for (const p of players) {
          if (p.dead) continue;
          if (Math.hypot(p.x - ic.x, p.z - ic.z) < HITBOX_RADIUS + 2) {
            // Brief stun: freeze control for ~0.5s via diveT recovery reuse.
            p.diveT = Math.max(p.diveT, 0.5);
            p.vx *= 0.2; p.vz *= 0.2;
            this.fx.banner(p.you ? 'ICED!' : '', p.hero.col);
          }
        }
        this.scene.remove(ic.m);
        return false;
      }
      return true;
    });
  }

  private spawnIcicle() {
    const x = (Math.random() - 0.5) * this.half * 1.7;
    const z = (Math.random() - 0.5) * this.half * 1.7;
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0xcfeeff, roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.9, emissive: 0x2a5a8a }),
    );
    m.rotation.x = Math.PI; // point down
    m.position.set(x, 48, z);
    m.castShadow = true;
    this.scene.add(m);
    this.icicles.push({ m, x, z, y: 48, vy: 0, warned: false });
  }

  private tickBoulders(dt: number, players: Player[]) {
    this.boulderTimer -= dt;
    if (this.boulderTimer <= 0) {
      this.boulderTimer = (4 + Math.random() * 3) / this.escalation;
      this.spawnBoulder();
    }
    this.boulders = this.boulders.filter((b) => {
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.m.position.set(b.x, 2.2, b.z);
      b.m.rotation.x += dt * 2;
      b.m.rotation.z += dt * 1.5;
      for (const p of players) {
        if (p.dead) continue;
        if (Math.hypot(p.x - b.x, p.z - b.z) < HITBOX_RADIUS + 2.4) {
          const L = Math.hypot(b.vx, b.vz) || 1;
          p.vx += (b.vx / L) * 30;
          p.vz += (b.vz / L) * 30;
          this.fx.burst(p.x, p.z, '#9AD8FF', 10);
          this.fx.shake(1.5);
          SFX.bump();
        }
      }
      const off = this.half + 8;
      if (Math.abs(b.x) > off || Math.abs(b.z) > off) {
        this.scene.remove(b.m);
        return false;
      }
      return true;
    });
  }

  private spawnBoulder() {
    // Enter from a random edge, roll across the rink.
    const edge = Math.floor(Math.random() * 4);
    let x = 0, z = 0, vx = 0, vz = 0;
    const speed = 18 + Math.random() * 8;
    const off = this.half + 4;
    const t = (Math.random() - 0.5) * this.half * 1.4;
    if (edge === 0) { x = -off; z = t; vx = speed; }
    else if (edge === 1) { x = off; z = t; vx = -speed; }
    else if (edge === 2) { z = -off; x = t; vz = speed; }
    else { z = off; x = t; vz = -speed; }
    const m = new THREE.Mesh(
      new THREE.DodecahedronGeometry(2.6),
      new THREE.MeshStandardMaterial({ color: 0x8fb0c8, roughness: 0.8, metalness: 0.1 }),
    );
    m.position.set(x, 2.2, z);
    m.castShadow = true;
    this.scene.add(m);
    this.boulders.push({ m, x, z, vx, vz });
    this.fx.banner('BOULDER!', '#9AD8FF');
  }
}
