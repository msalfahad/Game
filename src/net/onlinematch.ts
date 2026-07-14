import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { SFX } from '../core/audio';
import { Player } from '../game/player';
import { buildWorld, type World } from '../game/world';
import { victoryWalk } from '../game/victorywalk';
import { gameById, familyById } from '../data/maps';
import { heroByKey, speedMult } from '../data/characters';
import * as HUD from '../ui/hud';
import { net } from './client';
import { INPUT_RATE, type MatchEndMsg, type MatchStartMsg, type StateMsg } from './protocol';

// Online pushout match: the server is authoritative; this controller
//  - sends the local input at 30Hz,
//  - PREDICTS the local hero with the same movement math (mirrors
//    server/src/sim.ts), gently reconciled toward server positions,
//  - INTERPOLATES remote heroes ~120ms behind the newest snapshot,
//  - plays events (ults / falls / outs) and the ring shrink.

const BASE_SPEED = 14;
const JUMP_V = 22;
const GRAVITY = 60;

interface Snap {
  at: number; // client receive time (ms)
  msg: StateMsg;
}

export class OnlineMatch {
  private engine: Engine;
  private input: Input;
  private world!: World;
  private players: Player[] = [];
  private youSlot = 0;
  private ring = 30;
  private half = 30;
  private snaps: Snap[] = [];
  private seq = 0;
  private jumpQueued = false;
  private ultQueued = false;
  private inputTimer = 0;
  private running = false;
  private parts: { m: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = [];
  private onFinish: (end: MatchEndMsg, youSlot: number) => void;

  constructor(engine: Engine, input: Input, onFinish: (end: MatchEndMsg, youSlot: number) => void) {
    this.engine = engine;
    this.input = input;
    this.onFinish = onFinish;
  }

  start(msg: MatchStartMsg) {
    const game = gameById(msg.gameId);
    const family = familyById(game.familyId);
    this.youSlot = msg.youSlot;
    this.half = 30;
    this.ring = 30;
    this.snaps = [];
    this.seq = 0;
    this.parts = [];

    this.engine.clearScene();
    this.world = buildWorld(this.engine.scene, family, game, this.half);
    this.engine.camera.frame(this.half, 1.0);

    const is2v2 = msg.mode === '2v2';
    const TEAM_COLS = [0x4dc3ff, 0xff4d4d];
    this.players = msg.players.map((pi) => {
      const p = new Player(heroByKey(pi.heroKey), pi.slot === msg.youSlot, pi.slot, (pi.team % 2) as 0 | 1);
      const a = is2v2
        ? (pi.team === 0 ? Math.PI * 0.75 : -Math.PI * 0.25) + (pi.slot % 2) * (Math.PI / 5)
        : (pi.slot * Math.PI) / 2 + Math.PI / 4;
      p.x = Math.cos(a) * this.half * 0.5;
      p.z = Math.sin(a) * this.half * 0.5;
      p.lives = 3;
      p.buildRider(this.engine.scene);
      if (is2v2) {
        // Team colors on the ring + glow so sides read instantly.
        (p.ring.material as THREE.MeshBasicMaterial).color.setHex(TEAM_COLS[pi.team]);
        (p.glow.material as THREE.MeshBasicMaterial).color.setHex(TEAM_COLS[pi.team]);
      }
      return p;
    });

    HUD.makeHeads(this.players, 3);
    if (is2v2) {
      for (const p of this.players) {
        if (p.headEl) p.headEl.style.borderColor = '#' + TEAM_COLS[p.team].toString(16).padStart(6, '0');
      }
    }
    HUD.showHud(true);
    HUD.setObjective(is2v2 ? `${game.name} · 2 VS 2 · knock the other team off!` : `${game.name} · ONLINE · shove them off!`);
    this.input.setEnabled(true);
    this.input.setMode('float');

    net.cb.onState = (m) => this.onState(m);
    net.cb.onMatchEnd = (m) => this.end(m);

    this.running = true;
    // Debug/testing hook: current player positions as plain data.
    (window as any).__ONLINE_DEBUG = () =>
      this.players.map((p) => ({ slot: p.index, team: p.team, x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, dead: p.dead }));
    SFX.unlock();
    SFX.start();
    HUD.banner(game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());
    this.engine.start((dt, elapsed) => this.tick(dt, elapsed));
  }

  private onState(m: StateMsg) {
    this.snaps.push({ at: performance.now(), msg: m });
    if (this.snaps.length > 30) this.snaps.shift();
    this.ring = m.ring;
    HUD.setClock(m.timeLeft);

    for (const ps of m.players) {
      const [slot, x, z, , , , lives, dead, freezeT, shieldT, cd] = ps;
      const p = this.players[slot];
      if (!p) continue;
      if (p.lives !== lives) {
        p.lives = lives;
        HUD.setScore(p, Math.max(lives, 0));
      }
      if (!p.dead && dead === 1) {
        p.dead = true;
        HUD.markDead(p);
        SFX.out();
        HUD.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
      }
      p.freezeT = freezeT;
      p.shieldT = shieldT;
      if (p.you) {
        p.cd = cd;
        // Soft reconciliation: correct prediction error; snap when far off
        // (respawns, big knockbacks the prediction missed).
        const err = Math.hypot(x - p.x, z - p.z);
        if (err > 5) {
          p.x = x;
          p.z = z;
          p.vx = ps[3];
          p.vz = ps[4];
        } else {
          p.x += (x - p.x) * 0.2;
          p.z += (z - p.z) * 0.2;
        }
      }
    }

    for (const ev of m.events) {
      const p = this.players[ev.slot];
      if (!p) continue;
      if (ev.t === 'ult') {
        SFX.power();
        this.burst(p.x, p.z, p.hero.col, 16);
        this.engine.camera.shake(1.5);
        if (p.you) HUD.banner(p.hero.ultName.toUpperCase() + '!', p.hero.col);
      } else if (ev.t === 'fall') {
        SFX.fall();
        this.burst(p.x, p.z, p.hero.col, 18);
        this.engine.camera.shake(2);
        HUD.banner(p.you ? 'YOU FELL!' : p.hero.name + ' FELL!', p.hero.col);
      }
    }
  }

  private tick(dt: number, elapsed: number) {
    if (!this.running) return;
    this.input.pollGamepad();
    if (this.input.takeJump()) this.jumpQueued = true;
    if (this.input.takeAbility()) this.ultQueued = true;

    // Send input at 30Hz.
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
    this.interpolateRemotes();

    // Ring shrink visual.
    const s = this.ring / this.half;
    this.world.floorMesh.scale.setScalar(s);
    if (this.world.ringMesh) this.world.ringMesh.scale.set(s, s, 1);

    for (const p of this.players) {
      p.tickEffects(dt);
      p.group.visible = !p.dead;
      if (!p.dead) {
        p.group.position.set(p.x, p.y, p.z);
        p.bob(elapsed, p.index + p.x * 0.1);
      }
    }
    const you = this.players[this.youSlot];
    HUD.setAbilityHint(you.dead ? '' : you.cd <= 0 ? 'ready' : '');

    this.world.tick(dt);
    this.tickParts(dt);
  }

  /** Mirror of the server's movement step for the local hero. */
  private predictLocal(dt: number) {
    const p = this.players[this.youSlot];
    if (p.dead) return;
    const top = BASE_SPEED * speedMult(p.hero);
    const accel = top * 2.6;
    if (p.freezeT <= 0) {
      p.vx += this.input.ax * accel * dt;
      p.vz += this.input.ay * accel * dt;
    }
    const retain = Math.pow(0.02, dt);
    p.vx *= retain;
    p.vz *= retain;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > top) {
      p.vx *= top / sp;
      p.vz *= top / sp;
    }
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    if (p.y > 0 || p.vy !== 0) {
      p.y += p.vy * dt;
      p.vy -= GRAVITY * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; }
    }
    if (this.jumpQueued && p.y <= 0 && p.freezeT <= 0) p.vy = JUMP_V;
  }

  /** Render remote heroes ~120ms in the past, between two snapshots. */
  private interpolateRemotes() {
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
    const span = Math.max(1, b.at - a.at);
    const t = Math.max(0, Math.min(1, (renderAt - a.at) / span));
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
    const won = m.ranking[0]?.slot === this.youSlot;
    if (won) SFX.win();
    else SFX.lose();
    // Finishing-order parade before the results screen.
    const ranked = m.ranking.map((r) => this.players[r.slot]).filter(Boolean);
    const labels = m.ranking.map((r) => `${r.lives} ${m.scoreLabel}`);
    victoryWalk(this.engine, ranked, labels, { z: 8 }, () => this.onFinish(m, this.youSlot));
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
