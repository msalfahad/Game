import * as THREE from 'three';
import type { FamilyDef, GameDef, HazardKind } from '../data/maps';
import type { Player } from './player';
import type { Fx } from './context';
import { HITBOX_RADIUS } from './player';
import { SFX } from '../core/audio';
import { TUNING } from '../core/tuning';

// Generalized ambient hazards, flavored per family (SPEC sections 5-6):
//   wind    — rotating shove vector (blizzard / sandstorm / gusts)
//   falling — objects crash from above (icicles / meteors / branches / cannonballs)
//   rollers — objects sweep across (ice boulders / lava rocks / logs / barrels)
//   geysers — warning circle, then an eruption that launches players
//   lasers  — a beam rotating around the arena center
// Intensity ramps with match progress ("escalation", SPEC section 8) and the
// tuning panel's hazard slider.

interface Faller { m: THREE.Mesh; x: number; z: number; y: number; vy: number; }
interface Roller { m: THREE.Mesh; x: number; z: number; vx: number; vz: number; }
interface Geyser { warn: THREE.Mesh; x: number; z: number; t: number; }

export class Hazards {
  private scene: THREE.Scene;
  private half: number;
  private fx: Fx;
  private style: string;
  private trim: number;

  wind = { x: 0, z: 0 };
  private windAngle = Math.random() * 7;
  private windStrength = 0;

  private fallers: Faller[] = [];
  private rollers: Roller[] = [];
  private geysers: Geyser[] = [];
  private laser: THREE.Mesh | null = null;
  private laserAngle = 0;

  private fallT = 2;
  private rollT = 4;
  private geyserT = 3;
  private escalation = 1;

  readonly has: Record<HazardKind, boolean>;

  constructor(scene: THREE.Scene, game: GameDef, family: FamilyDef, half: number, fx: Fx) {
    this.scene = scene;
    this.half = half;
    this.fx = fx;
    this.style = family.style;
    this.trim = family.theme.trim;
    const set = new Set(game.hazards);
    this.has = {
      wind: set.has('wind'),
      falling: set.has('falling'),
      rollers: set.has('rollers'),
      geysers: set.has('geysers'),
      lasers: set.has('lasers'),
    };
    if (this.has.wind) this.windStrength = 7;
    if (this.has.lasers) this.buildLaser();
  }

  windForce() {
    return this.wind;
  }

  /** 0..1 match progress -> escalating cadence, scaled by the tuning panel. */
  setProgress(p: number) {
    this.escalation = (1 + p * 1.6) * TUNING.hazardScale;
  }

  tick(dt: number, players: Player[]) {
    if (this.escalation <= 0) return;
    if (this.has.wind) {
      this.windAngle += dt * 0.5;
      const gust = 0.6 + 0.4 * Math.sin(this.windAngle * 1.7);
      this.wind.x = Math.cos(this.windAngle) * this.windStrength * gust;
      this.wind.z = Math.sin(this.windAngle) * this.windStrength * gust;
    }
    if (this.has.falling) this.tickFalling(dt, players);
    if (this.has.rollers) this.tickRollers(dt, players);
    if (this.has.geysers) this.tickGeysers(dt, players);
    if (this.has.lasers) this.tickLaser(dt, players);
  }

  // --- falling --------------------------------------------------------------
  private tickFalling(dt: number, players: Player[]) {
    this.fallT -= dt;
    if (this.fallT <= 0) {
      this.fallT = (1.8 + Math.random() * 1.6) / this.escalation;
      this.spawnFaller();
    }
    this.fallers = this.fallers.filter((f) => {
      f.y += f.vy * dt;
      f.vy -= 42 * dt;
      f.m.position.set(f.x, Math.max(f.y, 0), f.z);
      if (f.y <= 0) {
        this.fx.burst(f.x, f.z, '#' + this.trim.toString(16).padStart(6, '0'), 10);
        SFX.crack();
        this.fx.shake(1.2);
        for (const p of players) {
          if (p.dead) continue;
          if (Math.hypot(p.x - f.x, p.z - f.z) < HITBOX_RADIUS + 2) {
            p.freezeT = Math.max(p.freezeT, 0.5);
            p.vx *= 0.2;
            p.vz *= 0.2;
            if (p.you) this.fx.banner('HIT!', p.hero.col);
          }
        }
        this.scene.remove(f.m);
        return false;
      }
      return true;
    });
  }

  private spawnFaller() {
    const x = (Math.random() - 0.5) * this.half * 1.7;
    const z = (Math.random() - 0.5) * this.half * 1.7;
    // Flavor: icicle cone (ice), meteor sphere (lava), branch box (forest),
    // cannonball (pirate), debris box (else).
    let m: THREE.Mesh;
    if (this.style === 'ice') {
      m = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4, 6),
        new THREE.MeshStandardMaterial({ color: 0xcfeeff, roughness: 0.2, transparent: true, opacity: 0.9, emissive: 0x2a5a8a }));
      m.rotation.x = Math.PI;
    } else if (this.style === 'lava') {
      m = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x3a1e14, emissive: 0xff5e2e, emissiveIntensity: 0.7, roughness: 0.7 }));
    } else if (this.style === 'pirate') {
      m = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.4, metalness: 0.7 }));
    } else if (this.style === 'forest') {
      m = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 5, 6),
        new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 }));
      m.rotation.z = Math.random();
    } else {
      m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ color: 0x8a8f9a, roughness: 0.8 }));
    }
    m.position.set(x, 48, z);
    m.castShadow = true;
    this.scene.add(m);
    this.fallers.push({ m, x, z, y: 48, vy: 0 });
  }

  // --- rollers ----------------------------------------------------------------
  private tickRollers(dt: number, players: Player[]) {
    this.rollT -= dt;
    if (this.rollT <= 0) {
      this.rollT = (4 + Math.random() * 3) / this.escalation;
      this.spawnRoller();
    }
    this.rollers = this.rollers.filter((b) => {
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

  private spawnRoller() {
    const edge = Math.floor(Math.random() * 4);
    let x = 0, z = 0, vx = 0, vz = 0;
    const speed = 18 + Math.random() * 8;
    const off = this.half + 4;
    const t = (Math.random() - 0.5) * this.half * 1.4;
    if (edge === 0) { x = -off; z = t; vx = speed; }
    else if (edge === 1) { x = off; z = t; vx = -speed; }
    else if (edge === 2) { z = -off; x = t; vz = speed; }
    else { z = off; x = t; vz = -speed; }
    // Flavor: barrel cylinder (pirate/forest), rock (else).
    const barrel = this.style === 'pirate' || this.style === 'forest';
    const m = barrel
      ? new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 3.6, 10),
          new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: 0.9 }))
      : new THREE.Mesh(new THREE.DodecahedronGeometry(2.6),
          new THREE.MeshStandardMaterial({ color: this.style === 'lava' ? 0x4a2418 : 0x8fb0c8, roughness: 0.8, emissive: this.style === 'lava' ? 0x903010 : 0x000000 }));
    if (barrel) m.rotation.z = Math.PI / 2;
    m.position.set(x, 2.2, z);
    m.castShadow = true;
    this.scene.add(m);
    this.rollers.push({ m, x, z, vx, vz });
    this.fx.banner('INCOMING!', '#9AD8FF');
  }

  // --- geysers ----------------------------------------------------------------
  private tickGeysers(dt: number, players: Player[]) {
    this.geyserT -= dt;
    if (this.geyserT <= 0) {
      this.geyserT = (3 + Math.random() * 2.5) / this.escalation;
      const x = (Math.random() - 0.5) * this.half * 1.6;
      const z = (Math.random() - 0.5) * this.half * 1.6;
      const warn = new THREE.Mesh(
        new THREE.RingGeometry(2.4, 3.4, 24),
        new THREE.MeshBasicMaterial({ color: this.trim, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      warn.rotation.x = -Math.PI / 2;
      warn.position.set(x, 0.35, z);
      this.scene.add(warn);
      this.geysers.push({ warn, x, z, t: 1.0 });
    }
    this.geysers = this.geysers.filter((gy) => {
      gy.t -= dt;
      gy.warn.scale.setScalar(1 + Math.sin(gy.t * 20) * 0.12);
      if (gy.t <= 0) {
        this.scene.remove(gy.warn);
        this.fx.burst(gy.x, gy.z, '#' + this.trim.toString(16).padStart(6, '0'), 20);
        this.fx.shake(2);
        SFX.crack();
        for (const p of players) {
          if (p.dead) continue;
          const d = Math.hypot(p.x - gy.x, p.z - gy.z);
          if (d < 6) {
            const nx = (p.x - gy.x) / (d || 1), nz = (p.z - gy.z) / (d || 1);
            p.vx += nx * 26;
            p.vz += nz * 26;
            p.vy = 20;
            p.grounded = false;
            if (p.you) this.fx.banner('ERUPTION!', '#FF5E2E');
          }
        }
        return false;
      }
      return true;
    });
  }

  // --- laser ------------------------------------------------------------------
  private buildLaser() {
    this.laser = new THREE.Mesh(
      new THREE.BoxGeometry(this.half * 1.9, 0.5, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff3040 }),
    );
    this.laser.position.set(this.half * 0.95, 1.4, 0);
    const pivot = new THREE.Group();
    pivot.add(this.laser);
    this.laser.position.set(this.half * 0.95, 1.4, 0);
    this.scene.add(pivot);
    (this.laser as any)._pivot = pivot;
  }

  private tickLaser(dt: number, players: Player[]) {
    if (!this.laser) return;
    this.laserAngle += dt * 0.7 * this.escalation * 0.7;
    const pivot = (this.laser as any)._pivot as THREE.Group;
    pivot.rotation.y = this.laserAngle;
    for (const p of players) {
      if (p.dead || p.y > 2.5) continue; // jump over it
      const pa = Math.atan2(p.z, p.x);
      const r = Math.hypot(p.x, p.z);
      if (r > this.half * 1.9 || r < 1) continue;
      // Perpendicular distance from the beam line (beam points along -angle).
      let diff = pa - -this.laserAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > Math.PI / 2) continue; // beam is a half-line
      const perp = Math.abs(Math.sin(diff)) * r;
      const now = performance.now() / 1000;
      if (perp < 1.6 && now - ((p as any)._laserHit ?? 0) > 1) {
        (p as any)._laserHit = now;
        p.freezeT = Math.max(p.freezeT, 0.35);
        const nx = p.x / (r || 1), nz = p.z / (r || 1);
        p.vx += nx * 22;
        p.vz += nz * 22;
        this.fx.burst(p.x, p.z, '#FF3040', 10);
        SFX.hit();
        if (p.you) this.fx.banner('ZAPPED!', '#FF3040');
      }
    }
  }
}
