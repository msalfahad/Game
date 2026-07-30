import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { SFX } from '../core/audio';
import { characterVoice } from '../core/voice-barks';
import { Player } from '../game/player';
import { buildWorld, type World } from '../game/world';
import { gameById, familyById, type GameDef } from '../data/maps';
import { heroByKey, speedMult, HEROES } from '../data/characters';
import * as HUD from '../ui/hud';
import { net } from './client';
import { MOVE, roamSurface, sprintMul } from '../shared/roammove';
import { FROST } from '../shared/frostspec';
import { tryJump } from '../game/physics';
import { ET, INPUT_RATE, type MatchEndMsg, type MatchStartMsg, type StateMsg } from './protocol';
import { spawnBolt, tickBolts, type Bolt } from '../game/boltfx';
import { victoryWalk } from '../game/victorywalk';
import { FAMILY_GRADE } from '../core/postfx';

// Universal online controller for the free-roam mechanics (collect, mash,
// paint, breaktiles, throwfight, race, dodge). The server owns all game
// state; this renders players (predicted/interpolated), synced entities,
// tile grids, laser beams and race gates.

const GRAVITY = 60;
const WPS = 8;
const PAINT_N = 9;
const BREAK_N = 11;
const CLIMB_W = 12;
const CLIMB_L = 62; // KEEP IN SYNC with climb.ts + server freesim.ts
const CLIMB_PACE = 0.7;
// Rolling-log axles: a log rolls around its own long axis. extra 0 = moves in
// x (long axis Z → roll around Z); extra 1 = moves in z (long axis X → roll around X).
const LOG_AXLE_VX = new THREE.Vector3(0, 0, -1);
const LOG_AXLE_VZ = new THREE.Vector3(1, 0, 0);
// Snowball Smash "SLIPPERY" sign cover. KEEP IN SYNC with throwfight + server.
const SIGN_HW = 4.6;
const SIGN_HD = 1.1;

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
  private laserPrevA0: number | null = null; // for detecting sudden laser reversals
  private laserDirSeen = 0;
  // Hot potato (Watermelon Bomb): the passed melon + its count-up.
  private melon: THREE.Group | null = null;
  private melonSpark: THREE.Mesh | null = null;
  private hpCountEl: HTMLElement | null = null;
  private hpArmT = 0;
  private hpHolder = 0;
  private passTarget: number | null = null;
  private hpOnDown: ((e: PointerEvent) => void) | null = null;
  // Musical chairs UI.
  private mcRunBtn: HTMLButtonElement | null = null;
  private mcSitBtn: HTMLButtonElement | null = null;
  private mcHitBtn: HTMLButtonElement | null = null;
  private mcSitText: HTMLElement | null = null;
  private mcPhase = 0;
  private mcHitLit = false;
  private mcChairs: { x: number; z: number; occ: number }[] = [];
  private chaseGuard = -1;
  private _chaseCrates: { x: number; z: number; hw: number; hd: number }[] | null = null;
  // Race Kart.
  private kartMeshes: (THREE.Group | null)[] = [null, null, null, null];
  private kartHead: number[] = [0, 0, 0, 0];
  private kartHeld: number[] = [0, 0, 0, 0];
  private kartItemBtn: HTMLButtonElement | null = null;
  private kartSpeedBtn: HTMLButtonElement | null = null;
  private kartBoostHeld = false;
  private kartItemQueued = false;
  // Night Heist (maze).
  private mazeCop = -1;
  private mazeFace: number[] = [0, 0, 0, 0];
  private mazeBattery: number[] = [9, 9, 9, 9];
  private mazeTorchOn: boolean[] = [false, false, false, false];
  private mazeExposure = 0;
  private _mazeWalls: { x: number; z: number; hw: number; hd: number }[] | null = null;
  private mazeSpots: (THREE.SpotLight | null)[] = [null, null, null, null];
  private mazeSpotTargets: (THREE.Object3D | null)[] = [null, null, null, null];
  private mazeGlows: (THREE.PointLight | null)[] = [null, null, null, null];
  private mazeLabels: (THREE.Sprite | null)[] = [null, null, null, null];
  private mazeSelfLantern: THREE.PointLight | null = null;
  private mazeReveal: THREE.AmbientLight | null = null;
  private mazeRevealT = 4;
  private mazeFlashes: number[] = [];
  private mazeFlashed: boolean[] = [];
  private mazeTorchBtn: HTMLButtonElement | null = null;
  private mazeExposeFill: HTMLElement | null = null;
  private mazeBars: HTMLElement[] = [];
  private mazeTorchQueued = false;
  // Foot Brawl (foosball).
  private fbRailX: number[] = [];
  private fbBall: THREE.Mesh | null = null;
  private fbGoalGroups: THREE.Group[] = [];
  private fbScore = [0, 0];
  private fbSmashCd = 0;
  private fbWidenCd = 0;
  private fbSmashQueued = false;
  private fbWidenQueued = false;
  private fbSmashBtn: HTMLButtonElement | null = null;
  private fbWidenBtn: HTMLButtonElement | null = null;
  private fbBlueEl: HTMLElement | null = null;
  private fbRedEl: HTMLElement | null = null;
  private fbBallPrev = { x: 0, z: 0 };
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
  // Volcano Rush dressing: crater guardian bot + embers.
  private guardian: Player | null = null;
  private guardianTX = 0;
  private embers: THREE.Sprite[] = [];
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
    this.guardian = null;
    this.embers = [];
    this.youScoreShown = -1;

    this.engine.clearScene();
    this.world = buildWorld(
      this.engine.scene, family, this.game,
      isClimb ? CLIMB_L : this.half,
      isClimb ? { w: CLIMB_W, l: CLIMB_L } : undefined,
    );
    // Ice push pulls back a touch so the FULL circular rink fits on phones.
    // Hot potato: frame the ring a bit tighter, from a steeper (more top-down)
    // angle so the characters spread out and are easy to tap.
    if (this.game.mechanic === 'hotpotato') {
      this.engine.camera.frame(18, 1.0, 55);
    } else if (this.game.mechanic === 'musicalchairs') {
      this.engine.camera.frame(19, 1.0, 52); // top-down-ish so the ring + chairs read clearly
    } else if (this.game.mechanic === 'chase') {
      this.engine.camera.frame(this.half + 5, 1.0, 54); // zoomed out so the FULL yard fits
    } else if (this.game.mechanic === 'maze') {
      this.engine.camera.frame(this.half, 1.0, 60); // top-down so the dark maze reads
    } else if (this.game.mechanic === 'kart') {
      this.engine.camera.frame(this.half + 2, 1.0, 46); // a touch wider + lower for the ring
    } else if (this.game.mechanic === 'foosball') {
      this.engine.camera.frameAngled(this.half * 0.52 + 4, this.half * 0.42 + 5); // 3/4 stadium view
    } else {
      this.engine.camera.frame(isClimb ? 17 : this.half, this.game.mechanic === 'icepush' ? 1.18 : 1.0);
    }
    this.engine.post.setGrade(FAMILY_GRADE[family.id] ?? {});

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
      p.grounded = true; p.airJumps = 0; // for jump / double-jump prediction
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
    // Dodge (logs / lasers): a dedicated bottom-right JUMP button — hop the
    // hazard (double-tap to double-jump), matching offline.
    if (this.game.mechanic === 'dodge' && (this.game.mods?.hz === 'logs' || this.game.mods?.hz === 'lasers')) {
      this.buildJumpButton();
    }
    if (this.game.mechanic === 'hotpotato') this.buildHotPotato();
    if (this.game.mechanic === 'musicalchairs') this.buildMusicChairs();
    if (this.game.mechanic === 'kart') this.buildKartUI();
    if (this.game.mechanic === 'maze') this.buildMazeUI();
    if (this.game.mechanic === 'foosball') this.buildFoosballUI();
    this.input.setEnabled(true);
    // Hot potato / musical chairs are button-driven — no movement stick.
    const noStick = this.game.mechanic === 'hotpotato' || this.game.mechanic === 'musicalchairs';
    this.input.setMode(noStick ? 'hidden' : 'float');

    net.cb.onState = (m) => this.onState(m);
    net.cb.onMatchEnd = (m) => this.end(m);

    this.running = true;
    (window as any).__ONLINE_DEBUG = () =>
      this.players.map((p) => ({ slot: p.index, team: p.team, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, y: Math.round(p.y * 100) / 100, score: p.score, lives: p.lives, dead: p.dead }));
    SFX.unlock();
    SFX.start();
    characterVoice.spawn(this.players[this.youSlot].hero.key).catch(() => {});
    HUD.banner(this.game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());
    this.engine.start((dt, elapsed) => this.tick(dt, elapsed));
  }

  private buildMechanicScenery() {
    const mech = this.game.mechanic;
    const trim = familyById(this.game.familyId).theme.trim;
    if (mech === 'climb' && this.game.mods?.volcano) {
      // Crater cone + glowing rim beyond the summit.
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(30, 22, 24, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x241008, roughness: 0.95, side: THREE.DoubleSide }),
      );
      cone.position.set(0, 4, -(CLIMB_L + 22));
      this.engine.scene.add(cone);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(11, 24), new THREE.MeshBasicMaterial({ color: 0xff7a2e }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(0, 15.2, -(CLIMB_L + 22));
      this.engine.scene.add(glow);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(11.5, 1.2, 10, 30),
        new THREE.MeshStandardMaterial({ color: 0x3a1408, emissive: 0xff5e2e, emissiveIntensity: 0.9 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(0, 15.4, -(CLIMB_L + 22));
      this.engine.scene.add(rim);
      for (let i = 0; i < 8; i++) {
        const crack = new THREE.Mesh(
          new THREE.PlaneGeometry(0.9 + Math.random() * 1.4, 7 + Math.random() * 12),
          new THREE.MeshBasicMaterial({ color: 0xff6a2e, transparent: true, opacity: 0.55 }),
        );
        crack.rotation.x = -Math.PI / 2;
        crack.rotation.z = (Math.random() - 0.5) * 0.9;
        crack.position.set((Math.random() - 0.5) * (CLIMB_W * 2 - 5), 0.12, (Math.random() - 0.5) * 2 * (CLIMB_L - 8));
        this.engine.scene.add(crack);
      }
      for (let i = 0; i < 16; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffa64d, transparent: true, opacity: 0.85, depthWrite: false }));
        sp.scale.setScalar(0.5 + Math.random() * 0.6);
        sp.position.set((Math.random() - 0.5) * CLIMB_W * 2, Math.random() * 14, (Math.random() - 0.5) * 2 * CLIMB_L);
        this.engine.scene.add(sp);
        this.embers.push(sp);
      }
      // The crater GUARDIAN: a hero who is NOT one of the four in the match.
      const used = new Set(this.players.map((p) => p.hero.key));
      const hero = HEROES.find((h) => !used.has(h.key)) ?? HEROES[0];
      const bot = new Player(hero, false, 5, 0);
      bot.buildRider(this.engine.scene);
      bot.x = 0;
      bot.z = -(CLIMB_L + 5.5);
      bot.group.position.set(bot.x, 0, bot.z);
      this.guardian = bot;
    }
    if (mech === 'throwfight' && this.game.mods?.proj === 'snowball') {
      // "SLIPPERY" A-frame sign — solid cover in the bottom middle.
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.55 });
      for (const [tilt, zo] of [[-0.16, 0.55], [0.16, -0.55]] as const) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(9, 5.4, 0.35), mat);
        panel.rotation.x = tilt;
        panel.position.set(0, 2.7, zo);
        panel.castShadow = true;
        grp.add(panel);
      }
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const x2 = c.getContext('2d')!;
      x2.fillStyle = '#1a2033';
      x2.font = 'bold 46px Nunito, sans-serif';
      x2.textAlign = 'center';
      x2.fillText('\u26A0 SLIPPERY', 128, 58);
      x2.font = '44px serif';
      x2.fillText('\u2744', 128, 108);
      const t2 = new THREE.CanvasTexture(c);
      t2.colorSpace = THREE.SRGBColorSpace;
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(8.4, 4.4),
        new THREE.MeshBasicMaterial({ map: t2, transparent: true, depthWrite: false }),
      );
      face.rotation.x = -0.16;
      face.position.set(0, 2.9, 0.78);
      grp.add(face);
      grp.position.set(0, 0, this.half * 0.55);
      this.engine.scene.add(grp);
    }
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
      // Summit flag poles (match offline climb.ts).
      const flagMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
      for (const fx of [-CLIMB_W + 1.5, CLIMB_W - 1.5]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 8), flagMat);
        pole.position.set(fx, 4, -(CLIMB_L - 2.5));
        this.engine.scene.add(pole);
      }
    } else if (mech === 'dodge' && this.game.mods?.hz === 'conveyor') {
      for (const sx of [-1, 1]) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(2.5, 6, this.half * 2),
          new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.6, emissive: 0x501010 }),
        );
        wall.position.set(sx * (this.half - 1.2), 3, 0);
        this.engine.scene.add(wall);
      }
    } else if (mech === 'chase') {
      // Sandstone yard: inner square with a centred gap on each side + boulders
      // (matches server/src/chasesim.ts collision layout).
      const inner = this.half * 0.5, gap = 5.5, thick = 1.5, height = 4.4, seg = (inner - gap) / 2;
      const wallMat = new THREE.MeshStandardMaterial({ color: 0xcaa25c, roughness: 1, flatShading: true, emissive: 0x2a1c0a });
      const wall = (cx: number, cz: number, hw: number, hd: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, height, hd * 2), wallMat);
        m.position.set(cx, height / 2, cz); m.castShadow = true; this.engine.scene.add(m);
      };
      for (const sz of [-inner, inner]) { wall(-(gap + seg), sz, seg, thick); wall(gap + seg, sz, seg, thick); }
      for (const sx of [-inner, inner]) { wall(sx, -(gap + seg), thick, seg); wall(sx, gap + seg, thick, seg); }
      const rockMat = new THREE.MeshStandardMaterial({ color: 0xb08050, roughness: 1, flatShading: true, emissive: 0x241206 });
      for (const [x, z, s] of [[8, 8, 1.9], [-8, -8, 1.9], [9, -7, 1.8], [-7, 9, 1.8]] as const) {
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(s * 1.15, 0), rockMat);
        r.position.set(x, s * 0.7, z); r.scale.y = 0.9; r.castShadow = true; this.engine.scene.add(r);
      }
      this.buildDesert();
    } else if (mech === 'kart') {
      this.buildKartTrack();
    } else if (mech === 'maze') {
      this.buildMaze();
      // Torch/lantern lighting is set up once the cop slot arrives (onState).
    } else if (mech === 'foosball') {
      this.buildFoosball();
    }
  }

  // --- Foot Brawl (foosball) ---------------------------------------------------
  private buildFoosball() {
    const scene = this.engine.scene;
    const X = this.half * 0.52, Z = this.half * 0.42, goalHalf = Z * 0.44;
    this.fbRailX = [-X * 0.34, -X * 0.80, X * 0.34, X * 0.80];
    scene.fog = null;
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    scene.add(new THREE.HemisphereLight(0xffe8c8, 0x3a5a3a, 0.5));
    scene.background = this.fbSky();
    // Striped pitch.
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      const w = (X * 2) / stripes;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Z * 2), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x3f8a3a : 0x357a32, roughness: 1 }));
      m.rotation.x = -Math.PI / 2; m.position.set(-X + w * (i + 0.5), 0.02, 0); m.receiveShadow = true; scene.add(m);
    }
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      m.position.set(x, 0.1, z); scene.add(m);
    };
    line(0, 0, 0.5, Z * 2);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Z * 0.34, 0.22, 6, 40), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1; scene.add(ring);
    // Side boards + goal-end coloured boards.
    const board = (x: number, z: number, w: number, d: number, col: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: (col & 0xfefefe) >> 1, emissiveIntensity: 0.15 }));
      m.position.set(x, 1.1, z); m.castShadow = true; scene.add(m);
    };
    board(0, Z + 0.6, X * 2 + 2, 1.2, 0xece8d8); board(0, -Z - 0.6, X * 2 + 2, 1.2, 0xece8d8);
    const seg = (Z - goalHalf) / 2;
    for (const [sx, col] of [[-1, 0x2f6bd8], [1, 0xd8452f]] as const) {
      board(sx * (X + 0.6), (goalHalf + seg), 1.2, seg * 2, col);
      board(sx * (X + 0.6), -(goalHalf + seg), 1.2, seg * 2, col);
      this.buildFoosGoal(sx, col, X, goalHalf);
    }
    // Coloured rails.
    [-1, -1, 1, 1].forEach((s, i) => {
      const col = s < 0 ? 0x2f6bd8 : 0xd8452f;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, Z * 2 - 2), new THREE.MeshStandardMaterial({ color: col, emissive: s < 0 ? 0x123a7a : 0x7a1a12, emissiveIntensity: 0.5, roughness: 0.5 }));
      rail.position.set(this.fbRailX[i], 0.12, 0); scene.add(rail);
    });
    // Stadium riser + fans on the two long sides + corner flags.
    const spanX = X * 2 + 8, oz = Z + 1.4;
    for (const sz of [-1, 1]) {
      const riser = new THREE.Mesh(new THREE.BoxGeometry(spanX, 1.4, 4.5), new THREE.MeshStandardMaterial({ color: 0x394055, roughness: 1 }));
      riser.position.set(0, 0.7, sz * (oz + 2.6)); scene.add(riser);
      this.buildFoosFans(sz, spanX, oz);
    }
    const back = new THREE.Mesh(new THREE.PlaneGeometry(340, 130), new THREE.MeshBasicMaterial({ map: this.fbBackdrop(), depthWrite: false }));
    back.position.set(0, 30, -(Z + 30)); scene.add(back);
    // Team dots + ball + seat riders facing the camera.
    this.players.forEach((p) => {
      p.z = (p.index % 2 === 0 ? -1 : 1) * Z * 0.28;
      p.x = this.fbRailX[p.index];
      p.standFacing = p.index < 2 ? 0.5 : -0.5;
      if (p.ring) p.ring.visible = false;
      if (p.glow) p.glow.visible = false;
      const col = p.index < 2 ? 0x2f6bd8 : 0xd8452f;
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.3, 16), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.5 }));
      dot.position.set(this.fbRailX[p.index], 0.14, p.z); p.group.add(dot); dot.position.set(0, -0.4, 0);
    });
    this.fbBall = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    const spot = new THREE.Mesh(new THREE.SphereGeometry(0.46, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    spot.position.set(0.4, 0.4, 0.3); this.fbBall.add(spot); this.fbBall.castShadow = true;
    scene.add(this.fbBall);
  }

  private buildFoosGoal(sx: number, col: number, X: number, gh: number) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.2, emissive: (col & 0xfefefe) >> 2, emissiveIntensity: 0.5 });
    const depth = 4.5, postR = 0.45, H = 3.6;
    for (const sz of [-gh, gh]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); post.position.set(sx * (X + 0.2), H / 2, sz); g.add(post); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, gh * 2, 10), mat); bar.rotation.x = Math.PI / 2; bar.position.set(sx * (X + 0.2), H, 0); g.add(bar);
    for (const sz of [-gh, gh]) { const bp = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); bp.position.set(sx * (X + depth), H / 2, sz); g.add(bp); }
    const netMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    const backNet = new THREE.Mesh(new THREE.PlaneGeometry(gh * 2, H, 6, 4), netMat); backNet.rotation.y = Math.PI / 2; backNet.position.set(sx * (X + depth), H / 2, 0); g.add(backNet);
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(3.0, gh * 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    mouth.rotation.x = -Math.PI / 2; mouth.position.set(sx * (X - 1.5), 0.13, 0); g.add(mouth);
    this.engine.scene.add(g);
    this.fbGoalGroups[sx < 0 ? 0 : 1] = g;
  }

  private buildFoosFans(sz: number, spanX: number, innerZ: number) {
    const scene = this.engine.scene;
    const rows = 2, cols = Math.max(12, Math.round(spanX / 2.2)), n = rows * cols;
    const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.55, 1.1, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.46, 6, 6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    const cloth = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#b06bff', '#ff7a3a', '#ffffff', '#2f6bd8'];
    const skin = ['#f2cda2', '#d9a06a', '#a06a40', '#ffe0b8', '#8a5a34'];
    const m = new THREE.Matrix4(), col = new THREE.Color();
    let k = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = -spanX / 2 + (c + 0.5) * (spanX / cols) + (Math.random() - 0.5) * 0.6;
      const z = sz * (innerZ + 1.6 + r * 2.4), y = 1.4 + r * 1.2, s = 0.9 + Math.random() * 0.35;
      m.makeScale(s, s, s); m.setPosition(x, y, z); bodies.setMatrixAt(k, m); bodies.setColorAt(k, col.set(cloth[(Math.random() * cloth.length) | 0]));
      m.setPosition(x, y + 1.15 * s, z); heads.setMatrixAt(k, m); heads.setColorAt(k, col.set(skin[(Math.random() * skin.length) | 0]));
      k++;
    }
    bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    scene.add(bodies); scene.add(heads);
  }

  private fbSky(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 16; c.height = 256;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.0, '#243a7a'); g.addColorStop(0.45, '#5a6bb0'); g.addColorStop(0.72, '#d98a6a'); g.addColorStop(1.0, '#f0b070');
    x.fillStyle = g; x.fillRect(0, 0, 16, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }
  private fbBackdrop(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 384;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, 0, 384);
    g.addColorStop(0.0, '#213a80'); g.addColorStop(0.4, '#5a6bb4'); g.addColorStop(0.68, '#e0906a'); g.addColorStop(0.82, '#ffb56a');
    x.fillStyle = g; x.fillRect(0, 0, 1024, 384);
    const standTop = 286; x.fillStyle = '#2a3350'; x.fillRect(0, standTop, 1024, 384 - standTop);
    for (let row = 0; row < 3; row++) {
      const y = standTop + 14 + row * 24;
      x.fillStyle = row % 2 ? '#333c5c' : '#2c3452'; x.fillRect(0, y - 8, 1024, 18);
      for (let i = 0; i < 150; i++) { x.fillStyle = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#ffffff', '#ff7a3a', '#b06bff'][(Math.random() * 7) | 0]; x.beginPath(); x.arc(Math.random() * 1024, y + (Math.random() - 0.5) * 8, 2.4, 0, Math.PI * 2); x.fill(); }
    }
    for (const px of [120, 380, 640, 900]) { x.strokeStyle = '#20263a'; x.lineWidth = 6; x.beginPath(); x.moveTo(px, standTop); x.lineTo(px, 70); x.stroke(); x.fillStyle = '#fff6d8'; x.fillRect(px - 34, 48, 68, 26); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }

  // --- Race Kart ---------------------------------------------------------------
  private buildKartTrack() {
    const scene = this.engine.scene;
    const outerR = this.half - 3, innerR = this.half * 0.42, midR = (innerR + outerR) / 2;
    const asphalt = new THREE.Mesh(
      new THREE.RingGeometry(innerR, outerR, 72),
      new THREE.MeshStandardMaterial({ color: 0x8b8e94, roughness: 0.92, emissive: 0x1a1c20, emissiveIntensity: 0.6 }),
    );
    asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = 0.04; asphalt.receiveShadow = true; scene.add(asphalt);
    // Dashed centre line.
    for (let i = 0; i < 40; i++) {
      if (i % 2) continue;
      const a = (i / 40) * Math.PI * 2;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 1.6),
        new THREE.MeshStandardMaterial({ color: 0xf2e9c0, emissive: 0x3a3520, roughness: 0.8 }));
      dash.position.set(Math.cos(a) * midR, 0.09, Math.sin(a) * midR); dash.rotation.y = -a; scene.add(dash);
    }
    // Kerb rings just off each road edge.
    const kerb = (edgeR: number, dir: 1 | -1) => {
      const bandW = 1.6, h = 0.9, radius = edgeR + dir * (bandW / 2 + 0.05);
      const n = Math.max(16, Math.round((Math.PI * 2 * radius) / 1.8));
      const arcLen = ((Math.PI * 2 * radius) / n) * 1.04;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, yellow = i % 2 === 0;
        const block = new THREE.Mesh(new THREE.BoxGeometry(arcLen, h, bandW),
          new THREE.MeshStandardMaterial({ color: yellow ? 0xf2c200 : 0x111111, roughness: 0.7, emissive: yellow ? 0x3a2c00 : 0x000000 }));
        block.position.set(Math.cos(a) * radius, h / 2, Math.sin(a) * radius); block.rotation.y = Math.PI / 2 - a; scene.add(block);
      }
    };
    kerb(outerR, +1); kerb(innerR, -1);
    // Centre hub.
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(innerR - 2.1, innerR - 1.6, 2, 40),
      new THREE.MeshStandardMaterial({ color: 0x8a7550, roughness: 1, flatShading: true }));
    hub.position.y = 1; scene.add(hub);
    const hubTop = new THREE.Mesh(new THREE.CylinderGeometry(innerR - 2.7, innerR - 2.1, 0.6, 40),
      new THREE.MeshStandardMaterial({ color: 0xc9a25b, roughness: 1 }));
    hubTop.position.y = 2.2; scene.add(hubTop);
    // A cactus + rock on the hub.
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 0.9 });
    const cg = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 6, 8), cactusMat); trunk.position.y = 3; cg.add(trunk);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 1.7, 7), cactusMat); arm.rotation.z = Math.PI / 2; arm.position.set(1.1, 3.5, 0); cg.add(arm);
    const armUp = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 1.9, 7), cactusMat); armUp.position.set(1.9, 4.4, 0); cg.add(armUp);
    cg.position.set(0, 2.5, 0); scene.add(cg);
    // Checkered finish line at +x.
    const rows = 10, w = (outerR - innerR) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < 3; c++) {
      const rad = innerR + (r + 0.5) * w, dz = (c - 1) * 1.4, col = (r + c) % 2 === 0 ? 0xffffff : 0x111111;
      const tile = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, 1.4), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7 }));
      tile.position.set(rad, 0.11, dz); scene.add(tile);
    }
    // Desert dressing outside the ring.
    this.buildDesert();
    // Karts, one per player, with the rider seated.
    this.players.forEach((p) => {
      const kart = this.makeKart(p.hero.col);
      this.engine.scene.add(kart);
      this.kartMeshes[p.index] = kart;
      p.sitting = true; p.y = 0.55;
    });
  }

  private makeKart(col: number | string): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.7 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.7, 4.2), body); chassis.position.y = 0.7; chassis.castShadow = true; g.add(chassis);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 1.2, 1.6, 8), body); nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.7, 2.6); g.add(nose);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 0.5), dark); seat.position.set(0, 1.5, -1.5); g.add(seat);
    for (const [wx, wz] of [[-1.6, 1.4], [1.6, 1.4], [-1.6, -1.4], [1.6, -1.4]] as const) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.7, 12), dark); wheel.rotation.z = Math.PI / 2; wheel.position.set(wx, 0.6, wz); wheel.castShadow = true; g.add(wheel);
    }
    return g;
  }

  // Kart item models (0 ball, 1 banana, 2 boost, 3 zap, 4 rocket).
  private kartItemModel(kind: number): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 0) {
      g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })));
      const spot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), new THREE.MeshStandardMaterial({ color: 0x111111 }));
      spot.position.set(0, 0.7, 0.7); g.add(spot);
    } else if (kind === 1) {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.4, 4, 8), new THREE.MeshStandardMaterial({ color: 0xffe23a, roughness: 0.5, emissive: 0x3a3000 }));
      m.rotation.z = 0.7; m.scale.set(1, 1, 0.7); g.add(m);
    } else if (kind === 2) {
      for (let i = 0; i < 2; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.2, 4), new THREE.MeshStandardMaterial({ color: 0x2fe04a, emissive: 0x0d5a1a, emissiveIntensity: 0.6, roughness: 0.4 }));
        c.rotation.x = -Math.PI / 2; c.position.z = -0.6 + i * 1.0; g.add(c);
      }
    } else if (kind === 3) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0), new THREE.MeshStandardMaterial({ color: 0xffe23a, emissive: 0xffd000, emissiveIntensity: 0.8, roughness: 0.3, flatShading: true }));
      m.scale.set(0.6, 1.5, 0.6); g.add(m);
    } else {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 10), new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.4, metalness: 0.3 }));
      b.rotation.x = Math.PI / 2; g.add(b);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 10), new THREE.MeshStandardMaterial({ color: 0xeeeeee }));
      tip.rotation.x = Math.PI / 2; tip.position.z = 1.3; g.add(tip);
    }
    return g;
  }

  private emojiSprite(txt: string, scale: number, y: number): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d')!;
    x.font = '90px serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 64, 70);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(scale, scale, 1); sp.position.y = y;
    return sp;
  }

  // --- Night Heist (maze) ------------------------------------------------------
  private mazeWalls() {
    if (this._mazeWalls) return this._mazeWalls;
    const T = 1.0;
    this._mazeWalls = ([
      [0, -13, 3.5, T], [0, 13, 3.5, T], [-13, 0, T, 3.5], [13, 0, T, 3.5],
      [-9, -9, 1.4, 1.4], [9, -9, 1.4, 1.4], [-9, 9, 1.4, 1.4], [9, 9, 1.4, 1.4],
      [0, -21, 3.5, T], [0, 21, 3.5, T], [-21, 0, T, 3.5], [21, 0, T, 3.5],
    ] as const).map(([x, z, hw, hd]) => ({ x, z, hw, hd }));
    return this._mazeWalls;
  }
  private buildMaze() {
    const scene = this.engine.scene;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x39415a, roughness: 1, flatShading: true, emissive: 0x0a0e1a });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x4a5474, roughness: 1, flatShading: true });
    const height = 5;
    for (const c of this.mazeWalls()) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(c.hw * 2, height, c.hd * 2), wallMat);
      m.position.set(c.x, height / 2, c.z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(c.hw * 2 + 0.4, 0.6, c.hd * 2 + 0.4), capMat);
      cap.position.set(c.x, height + 0.05, c.z); scene.add(cap);
    }
  }
  private setupMazeLighting() {
    const scene = this.engine.scene;
    const youCop = this.youSlot === this.mazeCop;
    scene.add(new THREE.AmbientLight(0x28324c, youCop ? 0.42 : 0.34));
    this.mazeSelfLantern = youCop
      ? new THREE.PointLight(0xdfeaff, 26, 15, 0)
      : new THREE.PointLight(0xffe8b0, 16, 14, 0);
    scene.add(this.mazeSelfLantern);
    this.mazeReveal = new THREE.AmbientLight(0xdce6ff, 4.0); // bright opening reveal
    scene.add(this.mazeReveal);
    // A torch spotlight + glow for every robber.
    for (const p of this.players) {
      if (p.index === this.mazeCop) continue;
      const isLocal = p.index === this.youSlot;
      const s = new THREE.SpotLight(0xfff3d0, 0, 22, 0.6, 0.35, 0);
      s.castShadow = isLocal;
      if (isLocal) { s.shadow.mapSize.set(512, 512); s.shadow.camera.near = 1; s.shadow.camera.far = 30; }
      const tgt = new THREE.Object3D(); scene.add(tgt); s.target = tgt; scene.add(s);
      this.mazeSpots[p.index] = s; this.mazeSpotTargets[p.index] = tgt;
      const glow = new THREE.PointLight(0xffdf9a, 0, 9, 0); scene.add(glow); this.mazeGlows[p.index] = glow;
    }
    // Role labels.
    for (const p of this.players) {
      const cop = p.index === this.mazeCop;
      const sp = this.makeMazeLabel(cop ? 'FIND THEM' : 'ESCAPE', cop ? '#ff3b3b' : '#5cf07a');
      sp.position.y = 7.2; p.group.add(sp); this.mazeLabels[p.index] = sp;
    }
    // Reveal timing: 4s opening + two random 2s flashes.
    this.mazeRevealT = 4;
    const T = 60, a = 12 + Math.random() * (T - 26); let bt = 12 + Math.random() * (T - 26);
    while (Math.abs(bt - a) < 9) bt = 12 + Math.random() * (T - 26);
    this.mazeFlashes = [Math.max(a, bt), Math.min(a, bt)]; this.mazeFlashed = [false, false];
  }
  private makeMazeLabel(text: string, color: string): THREE.Sprite {
    const c = document.createElement('canvas'); c.width = 320; c.height = 72;
    const x = c.getContext('2d')!;
    x.font = '900 46px Bungee, Nunito, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 9; x.strokeStyle = 'rgba(0,0,0,0.9)'; x.strokeText(text, 160, 40);
    x.fillStyle = color; x.fillText(text, 160, 40);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    sp.scale.set(11, 2.5, 1); return sp;
  }

  /** Desert surroundings for The Great Escape — ported from offline chase.ts:
   *  one continuous sand floor, red-rock mountains/buttes, saguaro cacti,
   *  low dunes and scattered rocks, so online reads the same as offline. */
  private buildDesert() {
    const H = this.half;
    const scene = this.engine.scene;

    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(360, 360),
      new THREE.MeshStandardMaterial({ color: 0xc9a25b, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = -0.06;
    sand.receiveShadow = true;
    scene.add(sand);

    const mesaMats = [
      new THREE.MeshStandardMaterial({ color: 0xb5651d, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x9c4f1a, roughness: 1, flatShading: true }),
    ];
    const duneMat = new THREE.MeshStandardMaterial({ color: 0xd7ad64, roughness: 1 });
    const cactusMat = new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 0.9 });

    const butte = (x: number, z: number, rad: number, hgt: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.78, rad, hgt, 7), mesaMats[0]);
      m.position.set(x, hgt / 2 - 4, z); scene.add(m);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.42, rad * 0.6, hgt * 0.5, 7), mesaMats[1]);
      top.position.set(x, hgt + hgt * 0.25 - 4, z); scene.add(top);
    };
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      butte(Math.cos(a) * H * 2.7, Math.sin(a) * H * 2.7, 20 + Math.random() * 14, 34 + Math.random() * 26);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.9;
      butte(Math.cos(a) * H * 1.65, Math.sin(a) * H * 1.65, 7 + Math.random() * 5, 10 + Math.random() * 8);
    }

    const saguaro = (x: number, z: number, sc: number) => {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9 * sc, 1.1 * sc, 10 * sc, 8), cactusMat);
      trunk.position.y = 5 * sc; trunk.castShadow = true; grp.add(trunk);
      const arm = (side: number, y: number) => {
        const horiz = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * sc, 0.55 * sc, 2.4 * sc, 7), cactusMat);
        horiz.rotation.z = Math.PI / 2; horiz.position.set(side * 1.5 * sc, y, 0); grp.add(horiz);
        const up = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * sc, 0.55 * sc, 3 * sc, 7), cactusMat);
        up.position.set(side * 2.6 * sc, y + 1.5 * sc, 0); grp.add(up);
      };
      arm(1, 6 * sc); arm(-1, 7.5 * sc);
      grp.position.set(x, 0, z); grp.rotation.y = Math.random() * 6;
      scene.add(grp);
    };
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.1;
      const r = H * (1.14 + Math.random() * 0.55);
      saguaro(Math.cos(a) * r, Math.sin(a) * r, 0.7 + Math.random() * 0.6);
    }

    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, r = H * (1.25 + Math.random() * 1.1);
      const dune = new THREE.Mesh(new THREE.SphereGeometry(9 + Math.random() * 10, 12, 6), duneMat);
      dune.scale.set(1, 0.14, 1);
      dune.position.set(Math.cos(a) * r, -0.5, Math.sin(a) * r);
      scene.add(dune);
    }
    const desertRockMat = new THREE.MeshStandardMaterial({ color: 0xa8794c, roughness: 1, flatShading: true });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, r = H * (1.1 + Math.random() * 0.9);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1.2 + Math.random() * 2, 0), desertRockMat);
      rock.position.set(Math.cos(a) * r, 0.4, Math.sin(a) * r);
      scene.add(rock);
    }
  }

  // --- entity rendering --------------------------------------------------------
  private makeEntMesh(type: number, extra: number): THREE.Object3D {
    if (this.game.mechanic === 'kart') {
      if (type === ET.MISSILE) return this.kartItemModel(extra === 1 ? 4 : 0); // shot: ball / rocket
      if (type === ET.ITEM) { const b = this.kartItemModel(1); b.position.y = 0.6; const g = new THREE.Group(); g.add(b); return g; } // banana
      // ET.LOOT: item pickup (extra = kind 0..4) with an emoji + glow ring.
      const g = new THREE.Group();
      const model = this.kartItemModel(extra); model.position.y = 1.8; g.add(model);
      const emoji = ['⚽', '\u{1F34C}', '\u{1F45F}', '⚡', '\u{1F680}'][extra] ?? '❓';
      g.add(this.emojiSprite(emoji, 3, 4.2));
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 20),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
      return g;
    }
    if (type === ET.LOOT && this.game.mechanic === 'chase') {
      // 👟 SHOES pickup: a green shoe on a glowing ring.
      const g = new THREE.Group();
      const sole = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.5, 1.25), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      sole.position.y = 2.4; g.add(sole);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 1.15),
        new THREE.MeshStandardMaterial({ color: 0x2fbf4a, roughness: 0.5, emissive: 0x0d3a12, emissiveIntensity: 0.4 }));
      upper.position.set(-0.35, 3.1, 0); g.add(upper);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 20),
        new THREE.MeshBasicMaterial({ color: 0x7ed321, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.2; g.add(ring);
      return g;
    }
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
      // extra: 1 = big boulder (unjumpable), 0 = small (a jump clears it).
      return new THREE.Mesh(
        new THREE.DodecahedronGeometry(extra === 1 ? FROST.climb.bigRockR : FROST.climb.smallRockR),
        this.game.mods?.volcano
          ? new THREE.MeshStandardMaterial({ color: 0x35180c, emissive: 0xb03a10, emissiveIntensity: 0.55, roughness: 0.85 })
          : new THREE.MeshStandardMaterial({ color: 0x9db8cc, roughness: 0.8 }),
      );
    }
    if (type === ET.TARGET && this.game.mechanic === 'musicalchairs') {
      const g = new THREE.Group();
      const wood = new THREE.MeshStandardMaterial({ color: 0xb9762f, roughness: 0.7, emissive: 0x2a1608 });
      const seat = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.6, 3.4), wood); seat.position.y = 2.1; g.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 0.5), wood); back.position.set(0, 3.6, -1.5); g.add(back);
      for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]] as const) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.1, 0.5), wood); leg.position.set(lx, 1.05, lz); g.add(leg);
      }
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.3, 3.0),
        new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb020, emissiveIntensity: 0.6, roughness: 0.5 }));
      cushion.position.y = 2.5; g.add(cushion);
      return g;
    }
    if (type === ET.MISSILE && this.game.mechanic === 'climb') {
      // Guardian fireball; extra&4 = the BIG one (1.5x).
      const big = (extra & 4) !== 0;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(big ? 4.5 : 3, 14, 14),
        new THREE.MeshStandardMaterial({ color: 0x2a1008, emissive: big ? 0xff3a10 : 0xff5e2e, emissiveIntensity: 1, roughness: 0.7 }),
      );
      // Guardian visibly tracks its throws.
      this.guardianTX = 0; // recomputed below from the entity x on spawn
      return m;
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

    // Lasers suddenly reverse — announce it when the spin direction flips.
    if (m.beams && m.beams.length) {
      const a0 = m.beams[0];
      if (this.laserPrevA0 != null) {
        const d = a0 - this.laserPrevA0;
        const dir = d > 0.001 ? 1 : d < -0.001 ? -1 : this.laserDirSeen;
        if (this.laserDirSeen !== 0 && dir !== 0 && dir !== this.laserDirSeen) {
          HUD.banner('🔄 LASERS REVERSED!', '#FF3040');
          SFX.crack();
        }
        if (dir !== 0) this.laserDirSeen = dir;
      }
      this.laserPrevA0 = a0;
    }

    const mech = this.game.mechanic;
    if (mech === 'hotpotato') this.hpArmT = m.aux ?? 0;
    if (mech === 'musicalchairs') {
      this.mcSetPhase(m.aux ?? 0);
      this.mcChairs = (m.entities ?? []).map((e) => ({ x: e[2], z: e[3], occ: e[5] }));
    }
    if (mech === 'chase' && (m.aux ?? 0) !== this.chaseGuard) {
      this.chaseGuard = m.aux ?? 0;
      this.players.forEach((p, i) => p.setStatusIcon(i === this.chaseGuard ? '🥢' : '🏃', 9999));
      HUD.setObjective(this.youSlot === this.chaseGuard ? '🥢 You are the GUARD — catch all 3!' : '🏃 RUN! Escape the guard!');
    }
    if (mech === 'foosball') {
      const aux = m.aux ?? 0;
      this.fbScore = [Math.floor(aux / 100), aux % 100];
    }
    if (mech === 'maze') {
      this.mazeExposure = m.ring ?? 0;
      if ((m.aux ?? -1) >= 0 && this.mazeCop < 0) {
        this.mazeCop = m.aux ?? 0;
        this.setupMazeLighting(); // now that we know who the cop is
        const youCop = this.youSlot === this.mazeCop;
        HUD.setObjective(youCop ? '🚔 Survive the night — stun torchers from behind!' : '🔦 Torch the cop together for 6s — mind your back!');
        // The cop has no torch: hide the robber battery + TORCH button for them.
        const robberRow = document.getElementById('mzRobber');
        if (robberRow) robberRow.style.display = youCop ? 'none' : 'flex';
        HUD.banner(youCop ? 'COP 🚔 — memorise the map!' : 'ROBBER 🔦 — memorise the map!', youCop ? '#4DA6FF' : '#FFD23F');
      }
    }
    for (const ps of m.players) {
      const [slot, x, z, , , , lives, dead, freezeT, shieldT, cd, score, flags] = ps;
      const p = this.players[slot];
      if (!p) continue;
      // Kart: cd = heading, score = laps, flags = held item (0 none, 1..5).
      if (mech === 'kart') {
        this.kartHead[slot] = cd;
        this.kartHeld[slot] = flags;
        if (slot === this.youSlot && p.score !== score && score > 0) { SFX.gem(); HUD.banner(`LAP ${score + 1}!`, p.hero.col); }
      }
      // Foosball: cd = smash cd, shieldT = widen cd, freezeT = stun.
      if (mech === 'foosball') {
        if (slot === this.youSlot) { this.fbSmashCd = cd; this.fbWidenCd = shieldT; }
        p.standFacing = slot < 2 ? 0.5 : -0.5;
        p.zapped = freezeT > 0;
      }
      // Maze: cd = facing, score = battery, flags bit0 = torch on.
      if (mech === 'maze') {
        this.mazeFace[slot] = cd;
        this.mazeBattery[slot] = score;
        this.mazeTorchOn[slot] = (flags & 1) === 1;
        p.standFacing = cd; // face torch/heading direction
        p.zapped = freezeT > 0; // stunned look
      }
      // Hot potato: players are static in the ring; take positions + holder from the server.
      if (mech === 'hotpotato') { p.x = x; p.z = z; if ((flags & 1) === 1) this.hpHolder = slot; }
      // Musical chairs: interpolate handles positions; reflect sit/fallen + punch-lit.
      if (mech === 'musicalchairs') {
        p.sitting = (flags & 1) === 1;
        p.fallen = (flags & 4) === 4;
        p.standFacing = p.sitting ? Math.atan2(-p.x, -p.z) : null; // seated: face the centre
        if (slot === this.youSlot) this.mcHitLit = (flags & 2) === 2;
      }
      // HUD value per mechanic.
      const shown = mech === 'throwfight' ? (this.game.mods?.proj === 'snowball' ? score : Math.max(lives, 0))
        : mech === 'breaktiles' || mech === 'dodge' || mech === 'icepush' ? Math.max(lives, 0)
        : mech === 'race' ? `${score}/${WPS * Number(this.game.mods?.laps ?? 2)}`
        : mech === 'climb' ? `${score}m`
        : mech === 'kart' ? `Lap ${score + 1}`
        : mech === 'maze' ? (slot === this.mazeCop ? '🚔' : '🔦')
        : mech === 'foosball' ? (slot < 2 ? '🔵' : '🔴')
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
        const me = this.players[this.youSlot];
        if (!p.you && me && !me.dead) characterVoice.trash(me.hero.key).catch(() => {});
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
      // Foot Brawl has its own SMASH / WIDEN / stun / goal cues.
      if (mech === 'foosball') {
        if (ev.t === 'hit') { SFX.hit(); this.engine.camera.shake(1.6); this.burst(p.x, p.z, '#FFD23F', 14); if (p.you) HUD.banner('⚡ SMASH!', '#FFD23F'); }
        else if (ev.t === 'power' && ev.k === 9) { p.setStatusIcon('💫', 1.2); this.burst(p.x, p.z, '#FFE23A', 12); if (p.you) HUD.banner('😵 DIZZY!', '#FFD23F'); }
        else if (ev.t === 'power' && ev.k === 8) { SFX.power(); if (p.you) HUD.banner('🥅 GOAL WIDE OPEN — shoot!', '#7CF07C'); }
        else if (ev.t === 'goal') { SFX.win(); this.engine.camera.shake(2.4); HUD.banner(ev.slot === 0 ? '🔵 BLUE GOAL!' : '🔴 RED GOAL!', ev.slot === 0 ? '#4DC3FF' : '#ff4da6'); }
        continue;
      }
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
        p.flinchT = 0.5; // visible stagger on the one who got smacked
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
          // Freeze box (climb): every rival gets a blue frost burst, like offline.
          if (freeze) for (const q of this.players) { if (q !== p && !q.dead) this.burst(q.x, q.z, '#9ADFFF', 12); }
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
    // Jump: apply to the local player IMMEDIATELY (responsive prediction) and
    // flag it for the server. In climb the ability button is the jump (there's
    // no ult), matching offline. Other games keep ability = ult.
    const jumpPressed = this.input.takeJump();
    const abilityPressed = this.input.takeAbility();
    const isClimb = this.game.mechanic === 'climb';
    const mechIn = this.game.mechanic;
    if (mechIn === 'musicalchairs') {
      if (jumpPressed) this.jumpQueued = true;   // PUNCH
      if (abilityPressed) this.ultQueued = true; // RUN / SIT
    } else if (mechIn === 'kart') {
      if (jumpPressed || abilityPressed) this.kartItemQueued = true; // ITEM (or ability)
    } else if (mechIn === 'maze') {
      if (jumpPressed || abilityPressed) this.mazeTorchQueued = true; // TORCH toggle
    } else if (mechIn === 'foosball') {
      if (jumpPressed) this.fbSmashQueued = true;   // SMASH (or button)
      if (abilityPressed) this.fbWidenQueued = true; // WIDEN
    } else {
      if (jumpPressed || (isClimb && abilityPressed)) this.doJump();
      if (!isClimb && abilityPressed) this.ultQueued = true;
    }

    this.inputTimer -= dt;
    if (this.inputTimer <= 0) {
      this.inputTimer = 1 / INPUT_RATE;
      this.seq++;
      // ult is a held boost for kart, an edge-triggered toggle for maze, else the ult.
      const ultVal = mechIn === 'kart' ? (this.kartBoostHeld || undefined)
        : mechIn === 'maze' ? (this.mazeTorchQueued || undefined)
        : mechIn === 'foosball' ? (this.fbWidenQueued || undefined)
        : (this.ultQueued || undefined);
      const jumpVal = mechIn === 'kart' ? (this.kartItemQueued || undefined)
        : mechIn === 'foosball' ? (this.fbSmashQueued || undefined)
        : (this.jumpQueued || undefined);
      net.sendInput({
        seq: this.seq,
        ax: this.input.ax,
        ay: this.input.ay,
        jump: jumpVal,
        ult: ultVal,
        target: this.ultQueued ? (this.passTarget ?? undefined) : undefined,
      });
      this.jumpQueued = false;
      this.ultQueued = false;
      this.kartItemQueued = false;
      this.mazeTorchQueued = false;
      this.fbSmashQueued = false;
      this.fbWidenQueued = false;
      this.passTarget = null;
    }

    this.predictLocal(dt);
    this.interpolate();

    // Kart: seat riders + point the karts along their heading before bob().
    if (this.game.mechanic === 'kart') {
      for (const p of this.players) {
        p.sitting = true; p.y = 0.55;
        p.standFacing = this.kartHead[p.index];
        const k = this.kartMeshes[p.index];
        if (k) { k.position.set(p.x, 0, p.z); k.rotation.y = this.kartHead[p.index]; k.visible = !p.dead; }
      }
    }

    for (const p of this.players) {
      p.tickEffects(dt);
      p.group.visible = !p.dead;
      if (!p.dead) {
        p.group.position.set(p.x, p.y, p.z);
        p.bob(elapsed, p.index + p.x * 0.1);
      }
    }

    if (this.game.mechanic === 'maze') this.updateMaze(dt);
    if (this.game.mechanic === 'foosball') this.updateFoosballUI();

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
    if (this.guardian) {
      const g = this.guardian;
      g.x += (this.guardianTX - g.x) * 0.03;
      if (Math.abs(this.guardianTX - g.x) < 1) this.guardianTX = Math.sin(elapsed * 0.5) * (CLIMB_W - 5);
      g.group.position.set(g.x, 0, g.z);
      g.bob(elapsed, 7);
      g.tickEffects(dt);
      for (const e of this.embers) {
        e.position.y += dt * (1.5 + (e.scale.x - 0.5) * 2);
        if (e.position.y > 16) e.position.y = 0.5;
      }
    }
    if (this.game.mechanic === 'climb') {
      this.engine.camera.follow(you.z, -(CLIMB_L - 13), CLIMB_L - 13);
      const total = CLIMB_L - 4 + (CLIMB_L - 3.5);
      HUD.updateClimbMap(
        this.players.map((p) => (CLIMB_L - 4 - p.z) / total),
        this.players.map((p) => p.dead),
      );
    }
    if (this.game.mechanic === 'hotpotato' && this.melon) {
      const h = this.players[this.hpHolder];
      if (h) this.melon.position.set(h.x, 7.2 + Math.sin(elapsed * 3) * 0.25, h.z);
      this.melon.rotation.y += dt * 2;
      const danger = Math.min(1, this.hpArmT / 8);
      this.melon.scale.setScalar(1 + Math.sin(elapsed * (6 + danger * 20)) * 0.15 * (0.4 + danger));
      if (this.melonSpark) {
        (this.melonSpark.material as THREE.MeshBasicMaterial).color.setHex(this.hpArmT > 8 ? 0xff5a3c : 0xfff2a0);
        this.melonSpark.visible = Math.sin(elapsed * (10 + danger * 30)) > -0.3;
      }
      if (this.hpCountEl) {
        this.hpCountEl.textContent = String(Math.floor(this.hpArmT));
        const dz = this.hpArmT >= 8;
        this.hpCountEl.style.color = dz ? '#ff4d4d' : '#ffffff';
        const j = dz ? (Math.random() - 0.5) * 6 : 0;
        this.hpCountEl.style.transform = `translateX(-50%) translate(${j}px,${j}px) scale(${dz ? 1.25 : 1})`;
      }
    }
    if (this.game.mechanic === 'musicalchairs') this.mcUpdateButtons();
    HUD.setAbilityHint(you.dead ? '' : you.cd <= 0 ? 'ready' : '');
    this.world.tick(dt);
    this.tickParts(dt);
    this.bolts = tickBolts(this.engine.scene, this.bolts, dt);
  }

  /** Bottom-right touch JUMP button for dodge games (matches offline dodge.ts). */
  private buildJumpButton() {
    document.getElementById('dodgeUI')?.remove();
    document.getElementById('hpUI')?.remove();
    document.getElementById('mcUI')?.remove();
    document.getElementById('kartUI')?.remove();
    document.getElementById('mzUI')?.remove();
    document.getElementById('fbUI')?.remove();
    if (this.hpOnDown) { document.removeEventListener('pointerdown', this.hpOnDown); this.hpOnDown = null; }
    const ui = document.createElement('div');
    ui.id = 'dodgeUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <button id="djJump" data-nostick style="position:fixed;right:20px;bottom:150px;pointer-events:auto;
        width:88px;height:88px;border-radius:50%;border:none;font-size:15px;font-weight:900;letter-spacing:1px;
        color:#12142e;background:#7CF07C;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);
        touch-action:none;user-select:none;">⤴<br>JUMP</button>`;
    document.body.appendChild(ui);
    const btn = ui.querySelector('#djJump') as HTMLButtonElement;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.doJump();
      btn.style.filter = 'brightness(1.25)';
      setTimeout(() => (btn.style.filter = ''), 120);
    });
  }

  /** Watermelon Bomb: build the passed melon + the big count-up / PASS button. */
  private buildHotPotato() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0x2f9e34, roughness: 0.6, emissive: 0x0d3a12 }),
    );
    body.scale.y = 1.12;
    g.add(body);
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x165a1e, roughness: 0.7 });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.13, 6, 24), stripeMat);
      s.rotation.z = Math.PI / 2; s.rotation.y = (i / 6) * Math.PI; s.scale.set(1, 1.12, 1);
      g.add(s);
    }
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a1e }));
    stem.position.y = 2.0; g.add(stem);
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
    spark.position.y = 2.7; g.add(spark);
    this.engine.scene.add(g);
    this.melon = g; this.melonSpark = spark;

    document.getElementById('hpUI')?.remove();
    document.getElementById('mcUI')?.remove();
    document.getElementById('kartUI')?.remove();
    document.getElementById('mzUI')?.remove();
    document.getElementById('fbUI')?.remove();
    if (this.hpOnDown) { document.removeEventListener('pointerdown', this.hpOnDown); this.hpOnDown = null; }
    const ui = document.createElement('div');
    ui.id = 'hpUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <div id="hpCount" style="position:fixed;top:120px;left:50%;transform:translateX(-50%);font-size:74px;
        color:#fff;text-shadow:0 4px 0 rgba(0,0,0,.5);line-height:1;">0</div>
      <div style="position:fixed;left:0;right:0;bottom:26px;display:flex;justify-content:center;">
        <button id="hpPass" style="pointer-events:auto;font-family:Bungee,system-ui,sans-serif;font-size:20px;border:none;
          border-radius:16px;padding:15px 30px;background:#7ED321;color:#12331a;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);">🍉 PASS</button>
      </div>`;
    document.body.appendChild(ui);
    this.hpCountEl = ui.querySelector('#hpCount');
    ui.querySelector('#hpPass')!.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.hpPass(); });

    // Tap directly ON a rival to throw the melon to THAT rival (like offline).
    this.hpOnDown = (e: PointerEvent) => {
      if (!this.running) return;
      if ((e.target as HTMLElement)?.closest('#hpUI')) return; // the PASS button handles itself
      if (this.hpHolder !== this.youSlot || this.players[this.youSlot]?.dead) return;
      const cam = this.engine.camera.cam;
      let best: number | null = null, bd = Infinity;
      for (const p of this.players) {
        if (p.index === this.youSlot || p.dead) continue;
        const v = new THREE.Vector3(p.x, 3, p.z).project(cam);
        const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
        const d = Math.hypot(sx - e.clientX, sy - e.clientY);
        if (d < bd) { bd = d; best = p.index; }
      }
      if (best != null && bd < Math.min(innerWidth, innerHeight) * 0.4) this.hpPass(best);
    };
    document.addEventListener('pointerdown', this.hpOnDown);
  }

  /** Musical Chairs: RUN (walk) / SIT (music stopped) buttons + the SIT! cue. */
  private buildMusicChairs() {
    document.getElementById('mcUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'mcUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <div id="mcSit" style="position:fixed;top:108px;left:50%;transform:translateX(-50%);font-size:48px;color:#FF4D4D;
        text-shadow:0 4px 0 rgba(0,0,0,.5);opacity:0;transition:opacity .08s;">SIT!</div>
      <div style="position:fixed;left:0;right:0;bottom:24px;display:flex;justify-content:center;gap:14px;">
        <button id="mcRun" style="pointer-events:auto;font-size:18px;border:none;border-radius:14px;padding:14px 24px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);background:#4DC3FF;">🏃 RUN</button>
        <button id="mcHit" style="pointer-events:auto;display:none;font-size:18px;border:none;border-radius:14px;padding:14px 24px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);background:#FFD23F;">👊 PUNCH</button>
        <button id="mcSitBtn" style="pointer-events:auto;display:none;font-size:18px;border:none;border-radius:14px;padding:14px 24px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);background:#7ED321;">🪑 SIT</button>
      </div>`;
    document.body.appendChild(ui);
    this.mcSitText = ui.querySelector('#mcSit');
    this.mcRunBtn = ui.querySelector('#mcRun');
    this.mcHitBtn = ui.querySelector('#mcHit');
    this.mcSitBtn = ui.querySelector('#mcSitBtn');
    const tap = (el: HTMLElement, fn: () => void) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    tap(this.mcRunBtn!, () => { this.ultQueued = true; }); // RUN
    tap(this.mcSitBtn!, () => { this.ultQueued = true; }); // SIT
    tap(this.mcHitBtn!, () => { this.jumpQueued = true; }); // PUNCH
  }

  private mcSetPhase(phase: number) {
    if (phase === this.mcPhase) return;
    this.mcPhase = phase;
    const sit = phase === 1;
    if (this.mcSitText) this.mcSitText.style.opacity = sit ? '1' : '0';
    if (sit) { SFX.out(); HUD.banner('SIT!', '#FF4D4D'); this.engine.camera.shake(1.5); }
  }

  /** Per-frame RUN / PUNCH / SIT button visibility. SIT enables only when a free
   *  chair is within reach (you must be near one) — the sit radius. */
  private mcUpdateButtons() {
    const me = this.players[this.youSlot];
    const walk = this.mcPhase === 0, sit = this.mcPhase === 1;
    if (this.mcRunBtn) this.mcRunBtn.style.display = walk && me && !me.dead ? 'inline-block' : 'none';
    if (this.mcHitBtn) this.mcHitBtn.style.display = walk && this.mcHitLit && me && !me.dead ? 'inline-block' : 'none';
    if (this.mcSitBtn) {
      const show = sit && me && !me.dead && !me.sitting;
      this.mcSitBtn.style.display = show ? 'inline-block' : 'none';
      if (show) {
        const near = this.mcChairs.some((c) => c.occ === 0 && Math.hypot(c.x - me.x, c.z - me.z) <= 10);
        this.mcSitBtn.style.opacity = near ? '1' : '0.4';
        this.mcSitBtn.style.filter = near ? '' : 'grayscale(1)';
      }
    }
  }

  /** Throw the melon (only matters while you hold it — the server enforces that). */
  private hpPass(target?: number) {
    this.ultQueued = true; // sent as `ult`
    if (typeof target === 'number') this.passTarget = target; // a specific rival (else nearest/random)
  }

  /** Jump the local player (ground jump + one air/double jump), predict now, and flag it for the server. */
  private doJump() {
    const me = this.players[this.youSlot];
    if (me && !me.dead && me.freezeT <= 0 && tryJump(me)) {
      this.jumpQueued = true; // server re-simulates the same jump
      SFX.tick();
    }
  }

  private predictLocal(dt: number) {
    // Hot potato / musical chairs are server-authoritative for position
    // (static ring or server-driven march) — no local predict.
    const m = this.game.mechanic;
    // Kart is heading-based + server-authoritative (interpolated); hot potato /
    // musical chairs are static/server-driven — no roam predict for these.
    if (m === 'hotpotato' || m === 'musicalchairs' || m === 'kart') return;
    if (m === 'chase') { this.predictChase(dt); return; }
    if (m === 'maze') { this.predictMaze(dt); return; }
    if (m === 'foosball') {
      // Rail movement: slide along z only, x pinned to the rail.
      const p = this.players[this.youSlot];
      if (!p || p.freezeT > 0) return;
      const Z = this.half * 0.42;
      p.z += this.input.ay * 22 * dt;
      p.z = Math.max(-Z + 3, Math.min(Z - 3, p.z));
      p.x = this.fbRailX[this.youSlot];
      return;
    }
    const p = this.players[this.youSlot];
    if (p.dead) return;
    // Mirror the server + offline movement exactly (src/shared/roammove.ts).
    const surf = roamSurface(this.game.familyId, this.game.mods?.proj === 'snowball');
    const sprint = sprintMul(this.input.ax, this.input.ay);
    const top = MOVE.baseSpeed * speedMult(p.hero) * sprint *
      (p.speedT > 0 ? MOVE.speedBoost : 1) * (p.shoesT > 0 ? MOVE.shoesBoost : 1) *
      (this.game.mechanic === 'climb' ? CLIMB_PACE : 1);
    const accel = top * MOVE.accelMul * surf.accel;
    if (p.freezeT <= 0) {
      p.vx += this.input.ax * accel * dt;
      p.vz += this.input.ay * accel * dt;
    }
    const retain = Math.pow(surf.grip, dt);
    p.vx *= retain;
    p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    if (this.game.mechanic === 'climb' && this.game.mods?.volcano) p.x += p.vx * dt * 0.45; // sideways ~normal
    if (p.y > 0 || p.vy !== 0) {
      p.y += p.vy * dt;
      p.vy -= GRAVITY * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; p.grounded = true; p.airJumps = 0; }
    }
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
    if (this.game.mechanic === 'throwfight' && this.game.mods?.proj === 'snowball') {
      // Solid SLIPPERY-sign cover, mirrored from the server.
      const HW = SIGN_HW + 2.4;
      const HD = SIGN_HD + 2.4;
      const signZ = this.half * 0.55;
      const dz = p.z - signZ;
      if (Math.abs(p.x) < HW && Math.abs(dz) < HD) {
        const penX = HW - Math.abs(p.x);
        const penZ = HD - Math.abs(dz);
        if (penX < penZ) p.x = Math.sign(p.x || 1) * HW;
        else p.z = signZ + Math.sign(dz || 1) * HD;
      }
    }
  }

  // Wall + boulder rects for The Great Escape, mirroring server buildWalls().
  private chaseCrates(): { x: number; z: number; hw: number; hd: number }[] {
    if (this._chaseCrates) return this._chaseCrates;
    const inner = this.half * 0.5, gap = 5.5, thick = 1.5, seg = (inner - gap) / 2;
    const c: { x: number; z: number; hw: number; hd: number }[] = [];
    for (const sz of [-inner, inner]) { c.push({ x: -(gap + seg), z: sz, hw: seg, hd: thick }, { x: gap + seg, z: sz, hw: seg, hd: thick }); }
    for (const sx of [-inner, inner]) { c.push({ x: sx, z: -(gap + seg), hw: thick, hd: seg }, { x: sx, z: gap + seg, hw: thick, hd: seg }); }
    for (const [x, z, s] of [[8, 8, 1.9], [-8, -8, 1.9], [9, -7, 1.8], [-7, 9, 1.8]] as const) c.push({ x, z, hw: s, hd: s });
    this._chaseCrates = c;
    return c;
  }

  /** Client-side prediction for The Great Escape: mirror server applyMove +
   *  resolveCrates + clampWalls so the local runner responds instantly; the
   *  soft reconcile in onState() pulls it back to the authoritative position. */
  private predictChase(dt: number) {
    const p = this.players[this.youSlot];
    if (!p || p.dead || p.freezeT > 0) return;
    const HITBOX = 3.0, HALF = this.half; // arena matches server HALF=30
    // Chase speed multiplier (mirrors ChaseSim.speedMul).
    let mul = 1;
    if (this.youSlot === this.chaseGuard) {
      let d = Infinity;
      this.players.forEach((q, i) => { if (i !== this.chaseGuard && !q.dead) d = Math.min(d, Math.hypot(q.x - p.x, q.z - p.z)); });
      const boost = d > 22 ? 1.16 : d > 13 ? 1.08 : 1;
      mul = 1.18 * boost;
    } else if (p.shoesT > 0) {
      mul = 1.45;
    }
    const grip = 0.02, accelF = 1.0; // crisp metal grip — matches server (no drift)
    const top = MOVE.baseSpeed * speedMult(p.hero) * sprintMul(this.input.ax, this.input.ay) * mul;
    const accel = top * MOVE.accelMul * accelF;
    p.vx += this.input.ax * accel * dt;
    p.vz += this.input.ay * accel * dt;
    const retain = Math.pow(grip, dt);
    p.vx *= retain; p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt; p.z += p.vz * dt;
    // Boulder / wall collision.
    for (const c of this.chaseCrates()) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const nx = c.x + Math.max(-c.hw, Math.min(c.hw, dx)), nz = c.z + Math.max(-c.hd, Math.min(c.hd, dz));
      let ox = p.x - nx, oz = p.z - nz; let d = Math.hypot(ox, oz);
      if (d >= HITBOX) continue;
      if (d < 0.0001) { const px = c.hw - Math.abs(dx), pz = c.hd - Math.abs(dz); if (px < pz) { ox = Math.sign(dx) || 1; oz = 0; } else { ox = 0; oz = Math.sign(dz) || 1; } d = 1; }
      const push = HITBOX - d, ux = ox / d, uz = oz / d;
      p.x += ux * push; p.z += uz * push;
      const into = p.vx * ux + p.vz * uz;
      if (into < 0) { p.vx -= into * ux; p.vz -= into * uz; }
    }
    const mrg = HALF - HITBOX;
    if (p.x < -mrg) { p.x = -mrg; if (p.vx < 0) p.vx = 0; }
    if (p.x > mrg) { p.x = mrg; if (p.vx > 0) p.vx = 0; }
    if (p.z < -mrg) { p.z = -mrg; if (p.vz < 0) p.vz = 0; }
    if (p.z > mrg) { p.z = mrg; if (p.vz > 0) p.vz = 0; }
  }

  /** Client-side prediction for Night Heist: mirror server metal-grip movement +
   *  maze wall collision + cop speed, so the local player responds instantly. */
  private predictMaze(dt: number) {
    const p = this.players[this.youSlot];
    if (!p || p.dead || p.freezeT > 0) return;
    const HITBOX = 3.0, HALF = this.half;
    const mul = this.youSlot === this.mazeCop ? 1.5 : 1;
    const grip = 0.02, accelF = 1.0; // metal surface
    const top = MOVE.baseSpeed * speedMult(p.hero) * sprintMul(this.input.ax, this.input.ay) * mul;
    const accel = top * MOVE.accelMul * accelF;
    p.vx += this.input.ax * accel * dt;
    p.vz += this.input.ay * accel * dt;
    const retain = Math.pow(grip, dt);
    p.vx *= retain; p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) { p.vx *= top / sp; p.vz *= top / sp; }
    p.x += p.vx * dt; p.z += p.vz * dt;
    for (const c of this.mazeWalls()) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const nx = c.x + Math.max(-c.hw, Math.min(c.hw, dx)), nz = c.z + Math.max(-c.hd, Math.min(c.hd, dz));
      let ox = p.x - nx, oz = p.z - nz; let d = Math.hypot(ox, oz);
      if (d >= HITBOX) continue;
      if (d < 0.0001) { const px = c.hw - Math.abs(dx), pz = c.hd - Math.abs(dz); if (px < pz) { ox = Math.sign(dx) || 1; oz = 0; } else { ox = 0; oz = Math.sign(dz) || 1; } d = 1; }
      const push = HITBOX - d, ux = ox / d, uz = oz / d;
      p.x += ux * push; p.z += uz * push;
      const into = p.vx * ux + p.vz * uz;
      if (into < 0) { p.vx -= into * ux; p.vz -= into * uz; }
    }
    const mrg = HALF - HITBOX;
    if (p.x < -mrg) { p.x = -mrg; if (p.vx < 0) p.vx = 0; }
    if (p.x > mrg) { p.x = mrg; if (p.vx > 0) p.vx = 0; }
    if (p.z < -mrg) { p.z = -mrg; if (p.vz < 0) p.vz = 0; }
    if (p.z > mrg) { p.z = mrg; if (p.vz > 0) p.vz = 0; }
  }

  // --- Night Heist per-frame ---------------------------------------------------
  private readonly MZ_RANGE = [0, 11, 16, 22];
  private readonly MZ_CONE = [0, 0.42, 0.5, 0.6];
  private mazeBarCount(slot: number): number { return Math.min(3, Math.ceil(this.mazeBattery[slot] / 3 - 1e-6)); }
  private mazeSegClear(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / 1.4));
    for (let s = 1; s < steps; s++) {
      const t = s / steps, x = x0 + dx * t, z = z0 + dz * t;
      for (const c of this.mazeWalls()) if (Math.abs(x - c.x) < c.hw && Math.abs(z - c.z) < c.hd) return false;
    }
    return true;
  }
  private mazeEmitting(slot: number): boolean { return this.mazeTorchOn[slot] && this.mazeBattery[slot] > 0.001; }
  private mazeLitForLocal(p: Player): boolean {
    const you = this.players[this.youSlot];
    if (this.mazeRevealT > 0) return true;
    if (p.index !== this.mazeCop && p.freezeT > 0) return true;   // stunned robber visible
    if (p.index !== this.mazeCop && this.mazeEmitting(p.index)) return true; // lit-up ally
    const youCop = this.youSlot === this.mazeCop;
    const d = Math.hypot(p.x - you.x, p.z - you.z);
    if (d < (youCop ? 13 : 7)) return true;
    if (this.mazeEmitting(this.youSlot) && !youCop) {
      const b = this.mazeBarCount(this.youSlot);
      if (d < this.MZ_RANGE[b] && d > 0.001) {
        const fx = Math.sin(this.mazeFace[this.youSlot]), fz = Math.cos(this.mazeFace[this.youSlot]);
        const cosang = ((p.x - you.x) / d) * fx + ((p.z - you.z) / d) * fz;
        if (cosang > Math.cos(this.MZ_CONE[b]) && this.mazeSegClear(you.x, you.z, p.x, p.z)) return true;
      }
    }
    return false;
  }
  private updateMaze(dt: number) {
    // Reveal (4s opening) + two 2s flashes keyed off the clock.
    if (this.mazeRevealT > 0) this.mazeRevealT -= dt;
    const tl = this.snaps.length ? this.snaps[this.snaps.length - 1].msg.timeLeft : 60;
    for (let k = 0; k < this.mazeFlashes.length; k++) {
      if (!this.mazeFlashed[k] && tl <= this.mazeFlashes[k] && tl > 0) {
        this.mazeFlashed[k] = true; this.mazeRevealT = Math.max(this.mazeRevealT, 2);
        HUD.banner('⚡ LIGHTS!', '#ffe66d');
      }
    }
    if (this.mazeReveal) this.mazeReveal.intensity = this.mazeRevealT > 0 ? 4.0 : 0;

    // Torch spotlights + glows.
    for (const p of this.players) {
      const s = this.mazeSpots[p.index], tgt = this.mazeSpotTargets[p.index];
      if (!s || !tgt) continue;
      const on = this.mazeEmitting(p.index) && !p.dead;
      const b = this.mazeBarCount(p.index);
      s.intensity = on ? (p.index === this.youSlot ? 55 : 32) : 0;
      s.distance = this.MZ_RANGE[b] || 1;
      s.angle = this.MZ_CONE[b] || 0.3;
      const fx = Math.sin(this.mazeFace[p.index]), fz = Math.cos(this.mazeFace[p.index]);
      s.position.set(p.x, 3.2, p.z);
      tgt.position.set(p.x + fx * 10, 1.2, p.z + fz * 10);
      const glow = this.mazeGlows[p.index];
      if (glow) { glow.intensity = on ? 7 : 0; glow.position.set(p.x, 3, p.z); }
    }
    if (this.mazeSelfLantern) {
      const you = this.players[this.youSlot];
      this.mazeSelfLantern.position.set(you.x, 4, you.z);
      this.mazeSelfLantern.visible = !you.dead;
    }
    // Stealth visibility: hide players you can't currently see.
    for (const p of this.players) {
      const vis = !p.dead && (p.index === this.youSlot || this.mazeLitForLocal(p));
      p.group.visible = vis;
      const lbl = this.mazeLabels[p.index]; if (lbl) lbl.visible = vis;
      if (p.ring) p.ring.visible = vis;
      if (p.glow) p.glow.visible = vis;
    }
    // UI.
    if (this.mazeExposeFill) this.mazeExposeFill.style.width = `${(this.mazeExposure / 6) * 100}%`;
    if (this.youSlot !== this.mazeCop && this.mazeBars.length) {
      const b = this.mazeBarCount(this.youSlot), on = this.mazeEmitting(this.youSlot);
      this.mazeBars.forEach((bar, k) => {
        const lit = k < b;
        bar.style.background = lit ? (on ? '#ffd23f' : '#2fe04a') : 'rgba(255,255,255,.15)';
      });
      if (this.mazeTorchBtn) { this.mazeTorchBtn.style.opacity = this.mazeBattery[this.youSlot] > 0.1 ? '1' : '0.4'; this.mazeTorchBtn.textContent = on ? '🔦 ON' : '🔦 TORCH'; }
    }
  }

  // --- kart + maze UI ----------------------------------------------------------
  private buildKartUI() {
    document.getElementById('kartUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'kartUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;';
    ui.innerHTML = `<div data-nostick style="position:fixed;right:20px;bottom:26px;display:flex;flex-direction:column;gap:14px;align-items:center;">
      <button id="kItem" style="pointer-events:auto;">🎁 ITEM</button>
      <button id="kSpeed" style="pointer-events:auto;">🏁 SPEED</button></div>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:18px;border:none;border-radius:16px;padding:16px 22px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.kartItemBtn = ui.querySelector('#kItem')!;
    this.kartSpeedBtn = ui.querySelector('#kSpeed')!;
    this.kartItemBtn.style.cssText += btnCss + 'background:#FFD23F;opacity:0.45;';
    this.kartSpeedBtn.style.cssText += btnCss + 'background:#4DC3FF;';
    this.kartItemBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.kartItemQueued = true; SFX.tick(); });
    const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.kartBoostHeld = true; this.kartSpeedBtn!.style.filter = 'brightness(1.25)'; };
    const up = (e: Event) => { e.preventDefault(); this.kartBoostHeld = false; this.kartSpeedBtn!.style.filter = ''; };
    this.kartSpeedBtn.addEventListener('pointerdown', down);
    this.kartSpeedBtn.addEventListener('pointerup', up);
    this.kartSpeedBtn.addEventListener('pointerleave', up);
    this.kartSpeedBtn.addEventListener('pointercancel', up);
  }

  private buildMazeUI() {
    document.getElementById('mzUI')?.remove();
    document.getElementById('fbUI')?.remove();
    const youCop = this.youSlot === this.mazeCop; // may be -1 (unknown) → treat as robber for now
    const ui = document.createElement('div');
    ui.id = 'mzUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Nunito,system-ui,sans-serif;color:#fff;';
    ui.innerHTML = `
      <div style="position:fixed;top:160px;left:50%;transform:translateX(-50%);text-align:center;">
        <div style="font-family:Bungee,system-ui,sans-serif;font-size:13px;letter-spacing:1px;text-shadow:0 2px 0 rgba(0,0,0,.6);">🔦 COP BLINDED</div>
        <div style="width:200px;height:14px;background:rgba(0,0,0,.5);border-radius:8px;overflow:hidden;margin-top:3px;border:2px solid rgba(255,255,255,.25);">
          <div id="mzExpose" style="height:100%;width:0%;background:linear-gradient(90deg,#ffe66d,#ff9f1c);transition:width .1s;"></div>
        </div>
      </div>
      <div id="mzRobber" style="position:fixed;left:0;right:0;bottom:24px;display:flex;flex-direction:column;align-items:center;gap:10px;">
        <div style="display:flex;gap:6px;"><span class="mzBar"></span><span class="mzBar"></span><span class="mzBar"></span></div>
        <button id="mzLight" style="pointer-events:auto;">🔦 TORCH</button>
      </div>`;
    document.body.appendChild(ui);
    this.mazeExposeFill = ui.querySelector('#mzExpose')!;
    this.mazeBars = Array.from(ui.querySelectorAll('.mzBar')) as HTMLElement[];
    for (const bar of this.mazeBars) bar.style.cssText = 'width:34px;height:12px;border-radius:4px;background:#2fe04a;';
    this.mazeTorchBtn = ui.querySelector('#mzLight')!;
    this.mazeTorchBtn.style.cssText += 'font-family:Bungee,system-ui,sans-serif;font-size:18px;border:none;border-radius:14px;padding:14px 26px;color:#12142e;background:#FFD23F;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);';
    this.mazeTorchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.mazeTorchQueued = true; SFX.tick(); });
    // The cop has no torch controls; hide the robber row if we already know.
    if (youCop) (ui.querySelector('#mzRobber') as HTMLElement).style.display = 'none';
    void youCop;
  }

  private buildFoosballUI() {
    document.getElementById('fbUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'fbUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    const bar = (side: string, col: string, label: string) =>
      `<div id="fb${side}" style="position:fixed;top:66px;${side === 'Blue' ? 'left:16px' : 'right:16px'};background:${col};color:#fff;padding:6px 12px;border-radius:12px;font-size:14px;box-shadow:0 3px 0 rgba(0,0,0,.4);display:flex;gap:6px;align-items:center;">${side === 'Blue' ? label + ' ' : ''}<span class="balls"></span>${side === 'Red' ? ' ' + label : ''}</div>`;
    ui.innerHTML = `${bar('Blue', '#2f6bd8', 'BLUE')}${bar('Red', '#d8452f', 'RED')}
      <button id="fbWiden" data-nostick style="pointer-events:auto;position:fixed;right:158px;bottom:30px;">🥅<br>WIDEN</button>
      <button id="fbSmash" data-nostick style="pointer-events:auto;position:fixed;right:18px;bottom:22px;">⚡<br>SMASH</button>`;
    document.body.appendChild(ui);
    const round = 'font-family:Bungee,system-ui,sans-serif;border:none;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;text-align:center;line-height:1.05;border-radius:50%;';
    this.fbSmashBtn = ui.querySelector('#fbSmash')!;
    this.fbWidenBtn = ui.querySelector('#fbWiden')!;
    this.fbSmashBtn.style.cssText += round + 'width:118px;height:118px;font-size:19px;color:#12142e;background:#FFD23F;';
    this.fbWidenBtn.style.cssText += round + 'width:100px;height:100px;font-size:15px;color:#08320f;background:#3bd45a;';
    this.fbSmashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.fbSmashQueued = true; });
    this.fbWidenBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.fbWidenQueued = true; });
    this.fbBlueEl = ui.querySelector('#fbBlue .balls')!;
    this.fbRedEl = ui.querySelector('#fbRed .balls')!;
  }

  private updateFoosballUI() {
    const balls = (n: number) => '⚽'.repeat(n) + '·'.repeat(Math.max(0, 3 - n));
    if (this.fbBlueEl) this.fbBlueEl.textContent = balls(this.fbScore[0]);
    if (this.fbRedEl) this.fbRedEl.textContent = balls(this.fbScore[1]);
    if (this.fbSmashBtn) { this.fbSmashBtn.style.opacity = this.fbSmashCd > 0 ? '0.5' : '1'; this.fbSmashBtn.innerHTML = this.fbSmashCd > 0 ? `⚡<br>${Math.ceil(this.fbSmashCd)}s` : '⚡<br>SMASH'; }
    if (this.fbWidenBtn) { this.fbWidenBtn.style.opacity = this.fbWidenCd > 0 ? '0.5' : '1'; this.fbWidenBtn.innerHTML = this.fbWidenCd > 0 ? `🥅<br>${Math.ceil(this.fbWidenCd)}s` : '🥅<br>WIDEN'; }
  }

  private interpolate() {
    if (this.snaps.length < 2) return;
    const renderAt = performance.now() - 100; // 2-snapshot buffer at 20Hz; fresher remote players
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
      // Musical chairs + kart are server-authoritative, so interpolate everyone
      // (including you); other games (incl. chase, maze) predict the local player.
      if (slot === this.youSlot && this.game.mechanic !== 'musicalchairs' && this.game.mechanic !== 'kart') continue;
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
      // Foosball ball: routed to the pre-built fbBall + drives goal widen scale.
      if (this.game.mechanic === 'foosball') {
        const ea = aById.get(id) ?? e;
        const bxp = ea[2] + (x - ea[2]) * t, bzp = ea[3] + (z - ea[3]) * t;
        if (this.fbBall) {
          this.fbBall.position.set(bxp, 1.2, bzp);
          this.fbBall.rotation.z -= (bxp - this.fbBallPrev.x) * 0.4;
          this.fbBall.rotation.x += (bzp - this.fbBallPrev.z) * 0.4;
          this.fbBallPrev = { x: bxp, z: bzp };
        }
        // extra bit0/bit1 = goal widened (left/right).
        const gh = this.half * 0.42 * 0.44;
        for (const side of [0, 1]) {
          const g = this.fbGoalGroups[side];
          if (g) { const target = (extra & (side === 0 ? 1 : 2)) ? 1.8 : 1; g.scale.z += (target - g.scale.z) * 0.2; }
        }
        void gh;
        continue;
      }
      let mesh = this.entMeshes.get(id);
      if (!mesh) {
        mesh = this.makeEntMesh(type, extra);
        mesh.traverse((o) => ((o as THREE.Mesh).castShadow = true));
        this.engine.scene.add(mesh);
        this.entMeshes.set(id, mesh);
      }
      const ea = aById.get(id) ?? e;
      mesh.position.set(ea[2] + (x - ea[2]) * t, Math.max(ea[4] + (y - ea[4]) * t, type === ET.LOG ? 1.6 : 0.2), ea[3] + (z - ea[3]) * t);
      // Climb boulders + volcano fireballs TUMBLE on x; rolling logs spin around
      // their own axle (so they actually ROLL, not tumble randomly); loot spins on y.
      if (type === ET.LOG) {
        if (this.game.mechanic === 'climb') mesh.rotation.x += 0.12;
        else mesh.rotateOnWorldAxis(extra === 0 ? LOG_AXLE_VX : LOG_AXLE_VZ, 0.3);
      } else if (type === ET.MISSILE && this.game.mechanic === 'climb') mesh.rotation.x += 0.14;
      else if (type === ET.TARGET && this.game.mechanic === 'musicalchairs') mesh.rotation.y = -Math.atan2(mesh.position.z, mesh.position.x) + Math.PI / 2;
      else if (type === ET.LOOT || type === ET.MISSILE) mesh.rotation.y += 0.08;
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
    document.getElementById('dodgeUI')?.remove();
    document.getElementById('hpUI')?.remove();
    document.getElementById('mcUI')?.remove();
    document.getElementById('kartUI')?.remove();
    document.getElementById('mzUI')?.remove();
    document.getElementById('fbUI')?.remove();
    if (this.hpOnDown) { document.removeEventListener('pointerdown', this.hpOnDown); this.hpOnDown = null; }
    const won = m.mode === '2v2'
      ? m.ranking.find((r) => r.slot === this.youSlot)?.team === m.winnerTeam
      : m.ranking[0]?.slot === this.youSlot;
    const meHero = this.players[this.youSlot]?.hero.key;
    if (won) { SFX.win(); if (meHero) characterVoice.victory(meHero).catch(() => {}); }
    else { SFX.lose(); if (meHero) characterVoice.losing(meHero).catch(() => {}); }
    // Finishing-order parade before the results screen.
    const ranked = m.ranking.map((r) => this.players[r.slot]).filter(Boolean);
    const labels = m.ranking.map((r) => `${r.lives} ${m.scoreLabel}`);
    victoryWalk(
      this.engine, ranked, labels,
      { z: this.half * 0.24, follow: this.game.mechanic === 'climb' },
      () => this.onFinish(m, this.youSlot),
    );
  }

  stop() {
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    document.getElementById('dodgeUI')?.remove();
    document.getElementById('hpUI')?.remove();
    document.getElementById('mcUI')?.remove();
    document.getElementById('kartUI')?.remove();
    document.getElementById('mzUI')?.remove();
    document.getElementById('fbUI')?.remove();
    if (this.hpOnDown) { document.removeEventListener('pointerdown', this.hpOnDown); this.hpOnDown = null; }
    net.cb.onState = undefined;
    net.cb.onMatchEnd = undefined;
  }
}
