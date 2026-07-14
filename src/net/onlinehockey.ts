import * as THREE from 'three';
import type { Engine } from '../core/engine';
import type { Input } from '../core/input';
import { SFX } from '../core/audio';
import { Player, HITBOX_RADIUS } from '../game/player';
import { buildWorld, type World } from '../game/world';
import { victoryWalk } from '../game/victorywalk';
import { decorateRink, sealStrip, type RinkDeco } from '../game/rinkdeco';
import { gameById, familyById } from '../data/maps';
import { heroByKey, speedMult } from '../data/characters';
import * as HUD from '../ui/hud';
import { net } from './client';
import { INPUT_RATE, type MatchEndMsg, type MatchStartMsg, type StateMsg } from './protocol';

// Online hockey (Ice Hockey Brawl / Lava Hockey). The local paddle is driven
// 1:1 by drag/keys and sent as an absolute wall position; the server rate-
// limits it and owns pucks, deflections and points. Remote paddles and pucks
// are interpolated between snapshots.

const HALF = 30 * 0.48;

interface Snap {
  at: number;
  pos: number[];
  balls: [number, number, number, number][];
}

export class OnlineHockey {
  private engine: Engine;
  private input: Input;
  private world!: World;
  private players: Player[] = [];
  private youSlot = 0;
  private localPos = 0.5;
  private snaps: Snap[] = [];
  private ballMeshes: THREE.Mesh[] = [];
  private seq = 0;
  private ultQueued = false;
  private inputTimer = 0;
  private running = false;
  private parts: { m: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = [];
  private deco!: RinkDeco;
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
    this.localPos = 0.5;
    this.snaps = [];
    this.seq = 0;
    this.parts = [];
    this.ballMeshes = [];

    this.engine.clearScene();
    this.world = buildWorld(this.engine.scene, family, game, HALF);
    // Extra pull-back on portrait phones so the whole rink + paddles fit.
    this.engine.camera.frame(HALF, innerWidth < innerHeight ? 1.62 : 1.28);

    const sides = ['bottom', 'top', 'left', 'right'] as const;
    this.players = msg.players.map((pi) => {
      const p = new Player(heroByKey(pi.heroKey), pi.slot === msg.youSlot, pi.slot, 0);
      p.side = sides[pi.slot];
      p.pos = 0.5;
      p.pts = 10;
      p.buildRider(this.engine.scene);
      return p;
    });
    this.placePaddles();
    // Corner posts, corner serve pads and per-player goal strips.
    this.deco = decorateRink(this.engine.scene, HALF, this.players.map((p) => p.hero.col));

    HUD.makeHeads(this.players, 10);
    HUD.showHud(true);
    HUD.setObjective(`${game.name} · ONLINE · guard your wall · 10 pts · 0 = OUT`);
    this.input.setEnabled(true);
    this.input.setMode('hidden');

    net.cb.onState = (m) => this.onState(m);
    net.cb.onMatchEnd = (m) => this.end(m);

    this.running = true;
    (window as any).__ONLINE_DEBUG = () =>
      this.players.map((p) => ({ slot: p.index, pos: Math.round(p.pos * 100) / 100, pts: p.pts, dead: p.dead }));
    SFX.unlock();
    SFX.start();
    HUD.banner(game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());
    this.engine.start((dt, elapsed) => this.tick(dt, elapsed));
  }

  private edgePos(p: Player): [number, number] {
    const P = (p.pos - 0.5) * 2 * HALF;
    if (p.side === 'bottom') return [P, HALF];
    if (p.side === 'top') return [P, -HALF];
    if (p.side === 'left') return [-HALF, P];
    return [HALF, P];
  }

  private placePaddles() {
    for (const p of this.players) {
      if (p.dead) {
        p.group.visible = false;
        continue;
      }
      const [x, z] = this.edgePos(p);
      // Keep p.x/p.z in sync so the walk-frame animation sees the movement.
      p.x = x; p.z = z;
      p.group.position.set(x, 0, z);
      p.setArmedGlow(p.armed);
    }
  }

  private onState(m: StateMsg) {
    if (!m.hockey) return;
    this.snaps.push({ at: performance.now(), pos: m.hockey.pos, balls: m.hockey.balls });
    if (this.snaps.length > 30) this.snaps.shift();
    HUD.setClock(m.timeLeft);

    m.hockey.pts.forEach((pts, slot) => {
      const p = this.players[slot];
      if (!p) return;
      if (p.pts !== pts) {
        p.pts = pts;
        HUD.setScore(p, Math.max(pts, 0));
      }
      if (!p.dead && pts <= 0) {
        p.dead = true;
        HUD.markDead(p);
        sealStrip(this.deco, slot);
      }
    });

    // Reconcile own paddle softly.
    const serverPos = m.hockey.pos[this.youSlot];
    if (typeof serverPos === 'number') {
      const err = Math.abs(serverPos - this.localPos);
      if (err > 0.2) this.localPos = serverPos;
      else this.localPos += (serverPos - this.localPos) * 0.15;
    }

    for (const ev of m.events) {
      const p = this.players[ev.slot];
      if (!p) continue;
      const [x, z] = this.edgePos(p);
      if (ev.t === 'goal') {
        SFX.goal();
        this.burst(x, z, p.hero.col, 22);
        this.engine.camera.shake(2.5);
        HUD.banner(p.you ? 'YOU GOT SCORED ON!' : 'GOAL ON ' + p.hero.name + '!', p.hero.col);
      } else if (ev.t === 'out') {
        SFX.out();
        HUD.banner(p.you ? 'YOU ARE OUT!' : p.hero.name + ' IS OUT!', '#FF4D4D');
      } else if (ev.t === 'power') {
        p.armed = true;
        if (p.you) {
          SFX.power();
          HUD.banner(p.hero.ultName.toUpperCase() + ' ARMED!', p.hero.col);
        }
      } else if (ev.t === 'ult') {
        p.armed = false;
        SFX.power();
        this.engine.camera.shake(3);
        HUD.banner('POWER SHOT!', '#FF4D4D');
      }
    }
  }

  private tick(dt: number, elapsed: number) {
    if (!this.running) return;
    this.input.pollGamepad();
    if (this.input.takeAbility()) this.ultQueued = true;

    // Local paddle: 1:1 drag plus keys, clamped like the server does.
    const you = this.players[this.youSlot];
    if (!you.dead) {
      if (this.input.hockeyDX !== 0) {
        this.localPos += this.input.hockeyDX / (innerWidth * 0.75);
        this.input.hockeyDX = 0;
      } else {
        const axis = you.side === 'left' || you.side === 'right' ? this.input.ay : this.input.ax;
        this.localPos += axis * (0.85 + speedMult(you.hero) * 1.1) * dt;
      }
      const R = HITBOX_RADIUS / HALF / 2 + 0.02;
      this.localPos = Math.max(R, Math.min(1 - R, this.localPos));
      you.pos = this.localPos;
    }

    this.inputTimer -= dt;
    if (this.inputTimer <= 0) {
      this.inputTimer = 1 / INPUT_RATE;
      this.seq++;
      net.sendInput({ seq: this.seq, ax: 0, ay: 0, pos: this.localPos, ult: this.ultQueued || undefined });
      this.ultQueued = false;
    }

    this.interpolate();
    this.placePaddles();
    this.players.forEach((p, i) => {
      if (!p.dead) p.bob(elapsed, i + p.pos * 6);
    });
    HUD.setAbilityHint(you.armed ? 'armed' : you.dead ? '' : 'ready');
    this.world.tick(dt);
    this.tickParts(dt);
  }

  /** Remote paddles + pucks rendered ~120ms behind, lerped between snapshots. */
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

    this.players.forEach((p, slot) => {
      if (slot === this.youSlot || p.dead) return;
      const pa = a.pos[slot] ?? 0.5;
      const pb = b.pos[slot] ?? 0.5;
      p.pos = pa + (pb - pa) * t;
    });

    // Pucks: match mesh count to snapshot, then lerp.
    const n = b.balls.length;
    while (this.ballMeshes.length < n) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xff8a2e, emissive: 0x7a3000, roughness: 0.3, metalness: 0.3 }),
      );
      m.castShadow = true;
      this.engine.scene.add(m);
      this.ballMeshes.push(m);
    }
    while (this.ballMeshes.length > n) {
      const m = this.ballMeshes.pop()!;
      this.engine.scene.remove(m);
    }
    for (let i = 0; i < n; i++) {
      const ba = a.balls[i] ?? b.balls[i];
      const bb = b.balls[i];
      const mesh = this.ballMeshes[i];
      mesh.position.set(
        ba[0] + (bb[0] - ba[0]) * t,
        Math.max(ba[2] + (bb[2] - ba[2]) * t, 1.4),
        ba[1] + (bb[1] - ba[1]) * t,
      );
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(bb[3] ? 0xff2020 : 0x7a3000);
      mat.color.setHex(bb[3] ? 0xff4d4d : 0xff8a2e);
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
    victoryWalk(this.engine, ranked, labels, { z: HALF * 0.3 }, () => this.onFinish(m, this.youSlot));
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
