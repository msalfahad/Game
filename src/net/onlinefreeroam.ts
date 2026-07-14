import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { SFX } from '../core/audio';
import { Player } from '../game/player';
import { buildWorld, type World } from '../game/world';
import { gameById, familyById, type GameDef } from '../data/maps';
import { heroByKey, speedMult } from '../data/characters';
import * as HUD from '../ui/hud';
import { net } from './client';
import { ET, INPUT_RATE, type MatchEndMsg, type MatchStartMsg, type StateMsg } from './protocol';
import { spawnBolt, tickBolts, type Bolt } from '../game/boltfx';

// Universal online controller for the free-roam mechanics (collect, mash,
// paint, breaktiles, throwfight, race, dodge). The server owns all game
// state; this renders players (predicted/interpolated), synced entities,
// tile grids, laser beams and race gates.

const BASE_SPEED = 14;
const JUMP_V = 22;
const GRAVITY = 60;
const WPS = 8;
const PAINT_N = 9;
const BREAK_N = 11;
const CLIMB_W = 12;
const CLIMB_L = 62; // KEEP IN SYNC with climb.ts + server freesim.ts
const CLIMB_PACE = 0.7;

interface Snap { at: number; msg: StateMsg; }

const TEAM_COLS = [0x4dc3ff, 0xff4d4d];

export class OnlineFreeRoam {
  private engine: Engine;
  private input: Input;
  private world!: World;
  private game!: GameDef;
  private players: Player[] = [];
  private youSlot = 0;
  private half = 30;
  private snaps: Snap[] = [];
  private entMeshes = new Map<number, THREE.Object3D>();
  private tileMeshes: THREE.Mesh[] = [];
  private beamMeshes: THREE.Group[] = [];
  private gateMeshes: THREE.Mesh[] = [];
  private heldMeshes: (THREE.Mesh | null)[] = [null, null, null, null];
  private seq = 0;
  private jumpQueued = false;
  private ultQueued = false;
  private inputTimer = 0;
  private running = false;
  private youScoreShown = -1;
  private parts: { m: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = [];
  private bolts: Bolt[] = [];
  private onFinish: (end: MatchEndMsg, youSlot: number) => void;

  constructor(engine: Engine, input: Input, onFinish: (end: MatchEndMsg, youSlot: number) => void) {
    this.engine = engine;
    this.input = input;
    this.onFinish = onFinish;
  }

  start(msg: MatchStartMsg) {
    this.game = gameById(msg.gameId);
    const family = familyById(this.game.familyId);
    this.youSlot = msg.youSlot;
    this.half = this.game.mechanic === 'icepush' ? 21 : 30; // ice push = small round rink
    const isClimb = this.game.mechanic === 'climb';
    this.snaps = [];
    this.seq = 0;
    this.parts = [];
    this.entMeshes.clear();
    this.tileMeshes = [];
    this.beamMeshes = [];
    this.gateMeshes = [];
    this.bolts = [];
    this.youScoreShown = -1;

    this.engine.clearScene();
    this.world = buildWorld(
      this.engine.scene, family, this.game,
      isClimb ? CLIMB_L : this.half,
      isClimb ? { w: CLIMB_W, l: CLIMB_L } : undefined,
    );
    // Ice push pulls back a touch so the FULL circular rink fits on phones.
    this.engine.camera.frame(isClimb ? 17 : this.half, this.game.mechanic === 'icepush' ? 1.18 : 1.0);

    const is2v2 = msg.mode === '2v2';
    this.players = msg.players.map((pi) => {
      const p = new Player(heroByKey(pi.heroKey), pi.slot === msg.youSlot, pi.slot, (pi.team % 2) as 0 | 1);
      if (this.game.mechanic === 'climb') {
        p.x = (pi.slot - 1.5) * 5.5;
        p.z = CLIMB_L - 4;
      } else {
        const spots = [[-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [0.5, 0.5]];
        p.x = spots[pi.slot][0] * this.half;
        p.z = spots[pi.slot][1] * this.half;
      }
      p.buildRider(this.engine.scene);
      if (is2v2) {
        (p.ring.material as THREE.MeshBasicMaterial).color.setHex(TEAM_COLS[pi.team]);
        (p.glow.material as THREE.MeshBasicMaterial).color.setHex(TEAM_COLS[pi.team]);
      }
      return p;
    });

    this.buildMechanicScenery();

    const mech = this.game.mechanic;
    const snow = this.game.mods?.proj === 'snowball';
    const init = mech === 'throwfight' ? (snow ? 0 : 100)
      : mech === 'breaktiles' || mech === 'dodge' || mech === 'icepush' ? 3
      : mech === 'race' ? `0/${WPS * Number(this.game.mods?.laps ?? 2)}`
      : mech === 'climb' ? '0m' : 0;
    HUD.makeHeads(this.players, init);
    if (is2v2) {
      for (const p of this.players) {
        if (p.headEl) p.headEl.style.borderColor = '#' + TEAM_COLS[p.team].toString(16).padStart(6, '0');
      }
    }
    HUD.showHud(true);
    HUD.setObjective(`${this.game.name} · ONLINE${is2v2 ? ' · 2 VS 2' : ''} — ${this.game.blurb}`);
    if (isClimb) HUD.showClimbMap(this.players.map((p) => p.hero.col), this.players.findIndex((p) => p.you));
    this.input.setEnabled(true);
    this.input.setMode('float');

    net.cb.onState = (m) => this.onState(m);
    net.cb.onMatchEnd = (m) => this.end(m);

    this.running = true;
    (window as any).__ONLINE_DEBUG = () =>
      this.players.map((p) => ({ slot: p.index, team: p.team, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, score: p.score, lives: p.lives, dead: p.dead }));
    SFX.unlock();
    SFX.start();
    HUD.banner(this.game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());
    this.engine.start((dt, elapsed) => this.tick(dt, elapsed));
  }

  private buildMechanicScenery() {
    const mech = this.game.mechanic;
    const trim = familyById(this.game.familyId).theme.trim;
    if (mech === 'paint' || mech === 'breaktiles') {
      const n = mech === 'paint' ? PAINT_N : BREAK_N;
      const step = (this.half * 2) / n;
      this.world.floorMesh.visible = false;
      for (let gy = 0; gy < n; gy++) {
        for (let gx = 0; gx < n; gx++) {
          const m = new THREE.Mesh(
            new THREE.BoxGeometry(step * 0.94, mech === 'paint' ? 0.6 : 1.2, step * 0.94),
            new THREE.MeshStandardMaterial({
              color: mech === 'paint' ? 0x333a5c : 0x556080 + ((gx + gy) % 2) * 0x0a0a14,
              roughness: 0.8,
            }),
          );
          m.position.set(-this.half + step * (gx + 0.5), mech === 'paint' ? 0.3 : -0.6, -this.half + step * (gy + 0.5));
          m.receiveShadow = true;
          this.engine.scene.add(m);
          this.tileMeshes.push(m);
        }
      }
    } else if (mech === 'race') {
      for (let i = 0; i < WPS; i++) {
        const a = (i / WPS) * Math.PI * 2 + Math.PI / 2;
        const r = this.half * 0.72;
        const gate = new THREE.Mesh(
          new THREE.TorusGeometry(4.2, 0.5, 8, 32),
          new THREE.MeshBasicMaterial({ color: trim, transparent: true, opacity: 0.5 }),
        );
        gate.position.set(Math.cos(a) * r, 4.4, Math.sin(a) * r);
        gate.lookAt(0, 4.4, 0);
        this.engine.scene.add(gate);
        this.gateMeshes.push(gate);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const pad = new THREE.Mesh(
          new THREE.CircleGeometry(2.6, 20),
          new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.65 }),
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(Math.cos(a) * this.half * 0.4, 0.15, Math.sin(a) * this.half * 0.4);
        this.engine.scene.add(pad);
      }
    } else if (mech === 'dodge' && this.game.mods?.hz === 'lasers') {
      for (let i = 0; i < 2; i++) {
        const beam = new THREE.Mesh(
          new THREE.BoxGeometry(this.half * 0.95, 0.45, 0.45),
          new THREE.MeshBasicMaterial({ color: 0xff3040 }),
        );
        beam.position.x = this.half * 0.5;
        const pivot = new THREE.Group();
        pivot.position.y = 1.3;
        pivot.add(beam);
        this.engine.scene.add(pivot);
        this.beamMeshes.push(pivot);
      }
    } else if (mech === 'icepush') {
      // 16 breakable arc segments around the round rink; indexes match the server.
      const R = this.half;
      const segArc = (2 * Math.PI) / 16;
      const segLen = 2 * R * Math.sin(segArc / 2) * 1.04;
      for (let i = 0; i < 16; i++) {
        const a = (i + 0.5) * segArc;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(segLen, 3.4, 1.6),
          new THREE.MeshStandardMaterial({
            color: 0x9adfff, roughness: 0.15, metalness: 0.2,
            transparent: true, opacity: 0.65, emissive: 0x1a4a7a,
          }),
        );
        m.position.set(Math.cos(a) * R, 1.7, Math.sin(a) * R);
        m.rotation.y = -a + Math.PI / 2;
        this.engine.scene.add(m);
        this.tileMeshes.push(m);
      }
    } else if (mech === 'climb') {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(CLIMB_W * 2, 0.5, 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      line.position.set(0, 0.3, -(CLIMB_L - 2.5));
      this.engine.scene.add(line);
    } else if (mech === 'dodge' && this.game.mods?.hz === 'conveyor') {
      for (const sx of [-1, 1]) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(2.5, 6, this.half * 2),
          new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.6, emissive: 0x501010 }),
        );
        wall.position.set(sx * (this.half - 1.2), 3, 0);
        this.engine.scene.add(wall);
      }
    }
  }

  // --- entity rendering --------------------------------------------------------
  private makeEntMesh(type: number, extra: number): THREE.Object3D {
    if (type === ET.LOOT && extra >= 4 && this.game.mechanic === 'throwfight') {
      // Snowball Smash perks: 4 = shoes, 5 = zap, 6 = shield.
      const emoji = extra === 4 ? '\u{1F45F}' : extra === 5 ? '\u26A1' : '\u{1F6E1}\uFE0F';
      const grp = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5, 1.7, 0.5, 16),
        new THREE.MeshStandardMaterial({ color: 0x9adfff, emissive: 0x2a6a9a, emissiveIntensity: 0.5 }),
      );
      grp.add(base);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x2 = c.getContext('2d')!;
      x2.font = '50px serif';
      x2.textAlign = 'center';
      x2.textBaseline = 'middle';
      x2.fillText(emoji, 32, 36);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
      sp.scale.set(3.2, 3.2, 1);
      sp.position.y = 2.6;
      grp.add(sp);
      return grp;
    }
    if (type === ET.LOOT && extra >= 2) {
      // Power boxes: 2 = freeze (climb), 3 = thunder (icepush).
      const freeze = extra === 2;
      const grp = new THREE.Group();
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 2.5, 2.5),
        new THREE.MeshStandardMaterial({
          color: freeze ? 0x9adfff : 0xffd23f,
          emissive: freeze ? 0x2a6a9a : 0xaa7700,
          emissiveIntensity: 0.55, roughness: 0.35,
        }),
      );
      grp.add(crate);
      if (!freeze) {
        const bolt = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.2, 4), new THREE.MeshBasicMaterial({ color: 0xfff7aa }));
        bolt.position.y = 2.5;
        grp.add(bolt);
      }
      return grp;
    }
    if (type === ET.LOG && this.game.mechanic === 'climb') {
      return new THREE.Mesh(
        new THREE.DodecahedronGeometry(2.3),
        new THREE.MeshStandardMaterial({ color: 0x9db8cc, roughness: 0.8 }),
      );
    }
    if (type === ET.LOOT) {
      if (extra === 1) {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(1.3, 1.3, 0.4, 14),
          new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x8a6a10, roughness: 0.3, metalness: 0.8 }),
        );
        m.rotation.x = Math.PI / 2;
        return m;
      }
      const cols = [0x2ef2ff, 0xffd23f, 0xff3d9e, 0xb6ff2e];
      const col = cols[extra % 4] ?? cols[0];
      return new THREE.Mesh(
        new THREE.OctahedronGeometry(1.4),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.2, metalness: 0.6 }),
      );
    }
    if (type === ET.TARGET) {
      const gold = extra === 1;
      if (this.game.mods?.robots) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(gold ? 3 : 2.4, gold ? 3 : 2.4, gold ? 3 : 2.4),
          new THREE.MeshStandardMaterial({
            color: gold ? 0xffd23f : 0x8a929e, roughness: 0.4, metalness: 0.7,
            emissive: gold ? 0xffd23f : 0x2ef2ff, emissiveIntensity: gold ? 0.4 : 0.25,
          }),
        );
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff3040 }));
        eye.position.set(0, 0.5, 1.3);
        m.add(eye);
        return m;
      }
      return new THREE.Mesh(
        new THREE.SphereGeometry(gold ? 2.2 : 1.8, 12, 12),
        new THREE.MeshStandardMaterial({
          color: gold ? 0xffd23f : 0xe86ac8, emissive: gold ? 0xffd23f : 0x000000,
          emissiveIntensity: gold ? 0.4 : 0, roughness: 0.5,
        }),
      );
    }
    if (type === ET.ITEM || type === ET.MISSILE) {
      const m = this.makeProjMesh(extra & 3);
      if (extra & 4) m.scale.setScalar(1.5); // big snowball
      return m;
    }
    if (type === ET.LOG) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.6, this.half * 1.1, 10),
        new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 }),
      );
      m.rotation.z = extra === 0 ? 0 : Math.PI / 2;
      m.rotation.x = extra === 0 ? Math.PI / 2 : 0;
      return m;
    }
    return new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  }

  private makeProjMesh(kind: number): THREE.Mesh {
    if (kind === 3) {
      return new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.6),
        new THREE.MeshStandardMaterial({ color: 0xc98a3f, roughness: 0.9 }));
    }
    if (kind === 1) {
      return new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 12),
        new THREE.MeshStandardMaterial({ color: 0x2a2a34, roughness: 0.4, metalness: 0.5, emissive: 0xff5e2e, emissiveIntensity: 0.4 }));
    }
    if (kind === 2) {
      return new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12),
        new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.35, metalness: 0.75 }));
    }
    return new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xf0f8ff, roughness: 0.9 }));
  }

  // --- state ---------------------------------------------------------------------
  private onState(m: StateMsg) {
    this.snaps.push({ at: performance.now(), msg: m });
    if (this.snaps.length > 30) this.snaps.shift();
    HUD.setClock(m.timeLeft);

    const mech = this.game.mechanic;
    for (const ps of m.players) {
      const [slot, x, z, , , , lives, dead, freezeT, shieldT, cd, score, flags] = ps;
      const p = this.players[slot];
      if (!p) continue;
      // HUD value per mechanic.
      const shown = mech === 'throwfight' ? (this.game.mods?.proj === 'snowball' ? score : Math.max(lives, 0))
        : mech === 'breaktiles' || mech === 'dodge' || mech === 'icepush' ? Math.max(lives, 0)
        : mech === 'race' ? `${score}/${WPS * Number(this.game.mods?.laps ?? 2)}`
        : mech === 'climb' ? `${score}m`
        : score;
      if (p.lives !== lives || p.score !== score) {
        p.lives = lives;
        p.score = score;
        HUD.setScore(p, shown);
      }
      if (!p.dead && dead === 1) {
        p.dead = true;
        HUD.markDead(p);
        SFX.out();
        HUD.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
      }
      p.freezeT = freezeT;
      if (mech === 'icepush' && freezeT > 0) p.zapped = true;
      p.shieldT = shieldT;
      if (((flags as number) & 2) !== 0) p.shoesT = Math.max(p.shoesT, 0.4); // refreshed by every state while active
      // Held item display.
      const held = (flags & 1) === 1;
      if (held && !this.heldMeshes[slot]) {
        const hm = this.makeProjMesh(Number(this.game.mods?.proj === 'snowball' ? 0 : this.game.mods?.proj === 'bomb' ? 1 : this.game.mods?.proj === 'cannon' ? 2 : 3));
        hm.scale.setScalar(0.75);
        hm.position.set(1.6, 3.6, 1.0); // carried in hand, not overhead
        p.group.add(hm);
        this.heldMeshes[slot] = hm;
      } else if (!held && this.heldMeshes[slot]) {
        p.group.remove(this.heldMeshes[slot]!);
        this.heldMeshes[slot] = null;
      }
      if (p.you) {
        p.cd = cd;
        const err = Math.hypot(x - p.x, z - p.z);
        if (err > 5) {
          p.x = x; p.z = z;
          p.vx = ps[3]; p.vz = ps[4];
        } else {
          p.x += (x - p.x) * 0.2;
          p.z += (z - p.z) * 0.2;
        }
      }
    }

    // Tiles.
    if (m.tiles && this.tileMeshes.length === m.tiles.length) {
      for (let i = 0; i < m.tiles.length; i++) {
        const mesh = this.tileMeshes[i];
        const v = m.tiles[i];
        if (mech === 'icepush') {
          if (mesh.visible && v === 0) {
            mesh.visible = false;
            SFX.crack();
            this.burst(mesh.position.x, mesh.position.z, '#9ADFFF', 12);
          }
        } else if (mech === 'paint') {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (v === 0) mat.color.setHex(0x333a5c);
          else {
            const owner = this.players[v - 1];
            if (owner) {
              mat.color.setStyle(owner.hero.col);
              mat.emissive.setStyle(owner.hero.col);
              mat.emissiveIntensity = 0.25;
            }
          }
        } else {
          // breaktiles: 1 alive, 2 cracking (shake), 0 gone (sink)
          if (v === 1) {
            mesh.visible = true;
            mesh.position.y = -0.6;
            (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
          } else if (v === 2) {
            mesh.position.y = -0.6 + Math.sin(performance.now() / 25) * 0.12;
            (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x552200);
          } else if (mesh.visible) {
            mesh.position.y -= 0.9;
            if (mesh.position.y < -26) mesh.visible = false;
          }
        }
      }
    }

    // Events.
    for (const ev of m.events) {
      const p = this.players[ev.slot];
      if (!p) continue;
      if (ev.t === 'ult') {
        SFX.power();
        this.burst(p.x, p.z, p.hero.col, 16);
        this.engine.camera.shake(1.5);
        if (p.you) HUD.banner(mech === 'paint' ? 'PAINT BOMB!' : p.hero.ultName.toUpperCase() + '!', p.hero.col);
      } else if (ev.t === 'fall') {
        SFX.fall();
        this.burst(p.x, p.z, p.hero.col, 18);
        this.engine.camera.shake(2);
        HUD.banner(p.you ? 'YOU FELL!' : p.hero.name + ' FELL!', p.hero.col);
      } else if (ev.t === 'pick') {
        if (p.you) SFX.gem();
      } else if (ev.t === 'hit') {
        SFX.hit();
        this.burst(p.x, p.z, '#FF4D4D', 12);
        this.engine.camera.shake(1.2);
      } else if (ev.t === 'power') {
        const isZap = this.game.mechanic === 'icepush';
        if (ev.k === 4) {
          // Snowball perk: speed shoes.
          SFX.power();
          p.setStatusIcon('👟', 5);
          HUD.banner(p.you ? '👟 SPEED x2!' : `👟 ${p.hero.name} IS FAST!`, '#7ED321');
        } else if (ev.k === 6) {
          // Snowball perk: shield.
          SFX.power();
          p.setStatusIcon('🛡️', 5);
          HUD.banner(p.you ? '🛡️ SHIELD! Hits on you do not count' : `🛡️ ${p.hero.name} IS SHIELDED!`, '#9ADFFF');
        } else if (ev.k === 5 || isZap) {
          // Zap: everyone else goes black + stunned.
          SFX.zap();
          if (ev.k === 5) p.setStatusIcon('⚡', 3);
          for (const q of this.players) {
            if (q === p || q.dead) continue;
            q.zapped = true;
            this.bolts.push(spawnBolt(this.engine.scene, q.x, q.z));
          }
          this.engine.camera.shake(2);
          HUD.banner(p.you ? '⚡ ZAP THEM ALL!' : `⚡ ${p.hero.name} ZAPPED YOU!`, '#FFD23F');
        } else {
          SFX.power();
          this.engine.camera.shake(2);
          const freeze = this.game.mechanic === 'climb';
          HUD.banner(
            p.you ? (freeze ? '❄ FREEZE! GO GO GO!' : '⚡ ZAP THEM ALL!') : `${freeze ? '❄' : '⚡'} ${p.hero.name} GOT THE BOX!`,
            freeze ? '#9ADFFF' : '#FFD23F',
          );
        }
      } else if (ev.t === 'goal') {
        // reused as bomb-explosion cue
        SFX.goal();
        this.engine.camera.shake(2.2);
      }
    }
  }

  // --- frame ---------------------------------------------------------------------
  private tick(dt: number, elapsed: number) {
    if (!this.running) return;
    this.input.pollGamepad();
    if (this.input.takeJump()) this.jumpQueued = true;
    if (this.input.takeAbility()) this.ultQueued = true;

    this.inputTimer -= dt;
    if (this.inputTimer <= 0) {
      this.inputTimer = 1 / INPUT_RATE;
      this.seq++;
      net.sendInput({
        seq: this.seq,
        ax: this.input.ax,
        ay: this.input.ay,
        jump: this.jumpQueued || undefined,
        ult: this.ultQueued || undefined,
      });
      this.jumpQueued = false;
      this.ultQueued = false;
    }

    this.predictLocal(dt);
    this.interpolate();

    for (const p of this.players) {
      p.tickEffects(dt);
      p.group.visible = !p.dead;
      if (!p.dead) {
        p.group.position.set(p.x, p.y, p.z);
        p.bob(elapsed, p.index + p.x * 0.1);
      }
    }

    // Race gate highlight for your own next gate.
    if (this.game.mechanic === 'race') {
      const you = this.players[this.youSlot];
      const next = Math.max(0, Math.round(you.score)) % WPS;
      const trim = familyById(this.game.familyId).theme.trim;
      this.gateMeshes.forEach((g, i) => {
        const mat = g.material as THREE.MeshBasicMaterial;
        const isNext = i === next;
        mat.color.setHex(isNext ? 0xffd23f : trim);
        mat.opacity = isNext ? 0.9 : 0.35;
        g.scale.setScalar(isNext ? 1 + Math.sin(elapsed * 6) * 0.08 : 1);
      });
      void this.youScoreShown;
    }

    const you = this.players[this.youSlot];
    if (this.game.mechanic === 'climb') {
      this.engine.camera.follow(you.z, -(CLIMB_L - 13), CLIMB_L - 13);
      const total = CLIMB_L - 4 + (CLIMB_L - 3.5);
      HUD.updateClimbMap(
        this.players.map((p) => (CLIMB_L - 4 - p.z) / total),
        this.players.map((p) => p.dead),
      );
    }
    HUD.setAbilityHint(you.dead ? '' : you.cd <= 0 ? 'ready' : '');
    this.world.tick(dt);
    this.tickParts(dt);
    this.bolts = tickBolts(this.engine.scene, this.bolts, dt);
  }

  private predictLocal(dt: number) {
    const p = this.players[this.youSlot];
    if (p.dead) return;
    const top = BASE_SPEED * speedMult(p.hero) * (p.shoesT > 0 ? 2 : 1) * (this.game.mechanic === 'climb' ? CLIMB_PACE : 1);
    const accel = top * 2.6;
    if (p.freezeT <= 0) {
      p.vx += this.input.ax * accel * dt;
      p.vz += this.input.ay * accel * dt;
    }
    const retain = Math.pow(this.game.mechanic === 'icepush' ? 0.55 : 0.02, dt);
    p.vx *= retain;
    p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    if (p.y > 0 || p.vy !== 0) {
      p.y += p.vy * dt;
      p.vy -= GRAVITY * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
    }
    if (this.jumpQueued && p.y <= 0 && p.freezeT <= 0) p.vy = JUMP_V;
    if (this.game.mechanic === 'climb') {
      const w = CLIMB_W - 1;
      p.x = Math.max(-w, Math.min(w, p.x));
      p.z = Math.max(-(CLIMB_L - 1), Math.min(CLIMB_L - 1, p.z));
    } else {
      const open = this.game.mechanic === 'icepush' ||
        (this.game.mechanic === 'dodge' && (this.game.mods?.hz === 'logs' || this.game.mods?.hz === 'wind'));
      if (!open) {
        const m = this.half - 1;
        p.x = Math.max(-m, Math.min(m, p.x));
        p.z = Math.max(-m, Math.min(m, p.z));
      }
    }
  }

  private interpolate() {
    if (this.snaps.length < 2) return;
    const renderAt = performance.now() - 120;
    let a = this.snaps[0], b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].at <= renderAt && this.snaps[i + 1].at >= renderAt) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    const t = Math.max(0, Math.min(1, (renderAt - a.at) / Math.max(1, b.at - a.at)));

    for (const psB of b.msg.players) {
      const slot = psB[0];
      if (slot === this.youSlot) continue;
      const p = this.players[slot];
      if (!p || p.dead) continue;
      const psA = a.msg.players.find((q) => q[0] === slot) ?? psB;
      p.x = psA[1] + (psB[1] - psA[1]) * t;
      p.z = psA[2] + (psB[2] - psA[2]) * t;
      p.y = psA[5] + (psB[5] - psA[5]) * t;
    }

    // Entities: sync mesh set to snapshot b, lerp positions from a.
    const bEnts = b.msg.entities ?? [];
    const aById = new Map((a.msg.entities ?? []).map((e) => [e[0], e]));
    const seen = new Set<number>();
    for (const e of bEnts) {
      const [id, type, x, z, y, extra] = e;
      seen.add(id);
      let mesh = this.entMeshes.get(id);
      if (!mesh) {
        mesh = this.makeEntMesh(type, extra);
        mesh.traverse((o) => ((o as THREE.Mesh).castShadow = true));
        this.engine.scene.add(mesh);
        this.entMeshes.set(id, mesh);
      }
      const ea = aById.get(id) ?? e;
      mesh.position.set(ea[2] + (x - ea[2]) * t, Math.max(ea[4] + (y - ea[4]) * t, type === ET.LOG ? 1.6 : 0.2), ea[3] + (z - ea[3]) * t);
      if (type === ET.LOOT || type === ET.MISSILE) mesh.rotation.y += 0.08;
    }
    for (const [id, mesh] of this.entMeshes) {
      if (!seen.has(id)) {
        this.engine.scene.remove(mesh);
        this.entMeshes.delete(id);
      }
    }

    // Beams.
    const beams = b.msg.beams;
    if (beams && this.beamMeshes.length) {
      this.beamMeshes.forEach((pivot, i) => {
        if (typeof beams[i] === 'number') pivot.rotation.y = beams[i];
      });
    }
  }

  private burst(x: number, z: number, col: string, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = Math.random() * 18 + 6;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(col).getHex() }),
      );
      m.position.set(x, 2, z);
      this.engine.scene.add(m);
      this.parts.push({ m, vx: Math.cos(a) * sp, vy: Math.random() * 14 + 6, vz: Math.sin(a) * sp, life: 1 });
    }
  }

  private tickParts(dt: number) {
    this.parts = this.parts.filter((p) => {
      p.life -= dt * 1.6;
      if (p.life <= 0) {
        this.engine.scene.remove(p.m);
        return false;
      }
      p.m.position.x += p.vx * dt;
      p.m.position.y += p.vy * dt;
      p.m.position.z += p.vz * dt;
      p.vy -= 40 * dt;
      const sc = Math.max(p.life, 0.01);
      p.m.scale.set(sc, sc, sc);
      return true;
    });
  }

  private end(m: MatchEndMsg) {
    if (!this.running) return;
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    const won = m.mode === '2v2'
      ? m.ranking.find((r) => r.slot === this.youSlot)?.team === m.winnerTeam
      : m.ranking[0]?.slot === this.youSlot;
    if (won) SFX.win();
    else SFX.lose();
    this.onFinish(m, this.youSlot);
  }

  stop() {
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    net.cb.onState = undefined;
    net.cb.onMatchEnd = undefined;
  }
}
