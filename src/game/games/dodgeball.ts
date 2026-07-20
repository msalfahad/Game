import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { markDead, setScore, setObjective } from '../../ui/hud';

// DODGE BRAWL (Sky tier 2). A 2v2 dodgeball court above the clouds, split by a
// centre line NOBODY can cross — LEFT team vs RIGHT team. Two balls start on the
// line; rush to grab them, then peg the enemy team across the divide.
//
// RULES (organised):
//  • 3 LIVES each. A clean hit costs the target a life; at 0 lives they're OUT.
//  • Wipe out BOTH enemies to win. If the 75s clock runs out, the team with more
//    total lives wins (tiebreak: more players still standing).
//  • THROW auto-aims at the nearest standing rival and leads their movement.
//    HOLD to charge a red POWER throw — faster, way harder to dodge or catch.
//  • CATCH (tap as a ball nears you) snatches it clean: no life lost, and it
//    either REVIVES a knocked-out teammate or costs the THROWER a life.
//  • The ball you're HOLDING is a shield — an incoming throw that hits it is
//    blocked. You can only hold one ball at a time; grabbing is automatic.
//  • A ball that flies out of bounds is replaced on the centre line, so there
//    are always two balls live.

interface Ball {
  g: THREE.Group; x: number; z: number; vx: number; vz: number;
  state: 'loose' | 'held' | 'thrown'; holder: number; thrower: number; power: boolean; life: number;
}

const LINE_BUF = 0.6;              // closest you can get to the centre line
const GRAB_R = 2.8;
const HIT_R = HITBOX_RADIUS + 0.9;
const CATCH_R = HITBOX_RADIUS + 1.9;
const BALL_N = 34, BALL_P = 52;    // normal / power throw speed
const INVULN = 1.4, STUN = 0.5;
const CATCH_WINDOW = 0.42;
const BALL_Y = 1.5;

export class DodgeBrawlGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Dodge Brawl';
  objective = '🏐 2v2! Peg the enemy team — 3 lives each.';

  private ctx!: MatchContext;
  private timeLeft = 75;
  private finished = false;
  private H = 30;

  private balls: Ball[] = [];
  private catchT: number[] = [];
  private hits: number[] = [];
  private botAct: number[] = [];  // bot decision timer
  private charging = false; private chargeT = 0;
  private startGrace = 2;

  private throwBtn!: HTMLButtonElement;
  private catchBtn!: HTMLButtonElement;
  private scoreEl!: HTMLElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(75);
    this.H = ctx.halfSize;
    this.balls = [];
    this.charging = false; this.chargeT = 0;
    this.startGrace = 2;

    setupRoster(ctx, '❤❤❤', 0.5);
    this.catchT = ctx.players.map(() => 0);
    this.hits = ctx.players.map(() => 0);
    this.botAct = ctx.players.map(() => 0);

    // Teams: 0,1 = LEFT (−x), 2,3 = RIGHT (+x). You are index 0 (left).
    const H = this.H;
    ctx.players.forEach((p) => {
      p.team = (p.index < 2 ? 0 : 1) as 0 | 1;
      const sign = this.sign(p.team);
      p.x = sign * H * 0.55;
      p.z = (p.index % 2 === 0 ? -1 : 1) * H * 0.32;
      p.vx = 0; p.vz = 0; p.dead = false; p.lives = 3; p.invulnT = 0; p.freezeT = 0;
      p.standFacing = sign < 0 ? Math.PI / 2 : -Math.PI / 2; // face across the court
      setScore(p, '❤❤❤');
    });

    this.buildCourt();
    this.buildUI();

    // Two balls on the centre line.
    this.spawnBall(0, -H * 0.3);
    this.spawnBall(0, H * 0.3);

    setObjective(this.objective);
    ctx.fx.banner('DODGE BRAWL! 🏐', '#4DC3FF');
  }

  private sign(team: number): number { return team === 0 ? -1 : 1; }
  private teamOf(p: Player): number { return p.index < 2 ? 0 : 1; }
  private alive(team: number): Player[] { return this.ctx.players.filter((p) => this.teamOf(p) === team && !p.dead); }

  // --- court ------------------------------------------------------------------
  private buildCourt() {
    const scene = this.ctx.scene, H = this.H;
    // Cloud-court floor with two tinted halves + a bright centre line.
    const half = (sign: number, col: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(H, H * 2),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, transparent: true, opacity: 0.5 }));
      m.rotation.x = -Math.PI / 2; m.position.set(sign * H / 2, 0.05, 0); m.receiveShadow = true; scene.add(m);
    };
    half(-1, 0x2f6bd8); half(1, 0xd8452f); // blue (left) vs red (right)
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, H * 2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe66d, emissiveIntensity: 0.7, roughness: 0.4 }));
    line.position.y = 0.25; scene.add(line);
    // A low net along the line so the divide reads in 3D.
    for (let i = 0; i < 14; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6),
        new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }));
      post.position.set(0, 1.2, -H + 0.5 + (i / 13) * (H * 2 - 1)); scene.add(post);
    }
    // Perimeter glow strip.
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xcff0ff });
    ([[0, H], [0, -H], [H, 0], [-H, 0]] as const).forEach((pnt, i) => {
      const horiz = i < 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(horiz ? H * 2 : 0.8, 0.8, horiz ? 0.8 : H * 2), trimMat);
      bar.position.set(pnt[0], 0.4, pnt[1]); scene.add(bar);
    });
  }

  private makeBall(): THREE.Group {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 14),
      new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, emissive: 0x3a2400, emissiveIntensity: 0.3 }));
    g.add(ball);
    for (const ry of [0, Math.PI / 2]) {
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.09, 6, 20),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
      stripe.rotation.y = ry; g.add(stripe);
    }
    return g;
  }

  private spawnBall(x: number, z: number) {
    const g = this.makeBall();
    g.position.set(x, 0.8, z);
    this.ctx.scene.add(g);
    this.balls.push({ g, x, z, vx: 0, vz: 0, state: 'loose', holder: -1, thrower: -1, power: false, life: 0 });
  }

  // --- input ------------------------------------------------------------------
  ability() {} // throw/catch are handled by the on-screen buttons (kept clear of the corner-tap)

  private heldBall(pi: number): Ball | null { return this.balls.find((b) => b.state === 'held' && b.holder === pi) ?? null; }

  private doThrow(p: Player, power: boolean) {
    const b = this.heldBall(p.index);
    if (!b || p.dead || this.finished) return;
    const tgt = this.nearestEnemy(p);
    let dirx: number, dirz: number;
    if (tgt) { const lx = tgt.x + tgt.vx * 0.25, lz = tgt.z + tgt.vz * 0.25; const L = Math.hypot(lx - p.x, lz - p.z) || 1; dirx = (lx - p.x) / L; dirz = (lz - p.z) / L; }
    else { dirx = this.sign(this.teamOf(p) === 0 ? 1 : 0); dirz = 0; } // toward enemy half
    const sp = power ? BALL_P : BALL_N;
    b.state = 'thrown'; b.thrower = p.index; b.holder = -1; b.power = power; b.life = 2.2;
    b.x = p.x + dirx * 1.6; b.z = p.z + dirz * 1.6;
    b.vx = dirx * sp; b.vz = dirz * sp;
    p.standFacing = Math.atan2(dirx, dirz);
    SFX.hit(); this.ctx.fx.burst(p.x, p.z, power ? '#ff4d4d' : '#ffe66d', power ? 12 : 6);
    if (p.you) this.ctx.fx.banner(power ? '🏐 POWER THROW!' : '🏐 THROW!', power ? '#ff4d4d' : '#FFD23F');
  }

  private doCatch(p: Player) {
    if (p.dead || this.finished) return;
    this.catchT[p.index] = CATCH_WINDOW;
    if (p.you) SFX.tick();
  }

  private nearestEnemy(p: Player): Player | null {
    let best: Player | null = null, bd = Infinity;
    for (const q of this.alive(this.teamOf(p) === 0 ? 1 : 0)) {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    this.startGrace = Math.max(0, this.startGrace - dt);

    // Charge the throw while held.
    if (this.charging) this.chargeT = Math.min(0.9, this.chargeT + dt);

    // Movement.
    for (const p of ctx.players) {
      if (p.dead) continue;
      this.catchT[p.index] = Math.max(0, this.catchT[p.index] - dt);
      if (p.freezeT > 0) continue;
      if (p.index === 0) localMove(ctx, dt, { noClamp: true });
      else this.botTick(p, dt);
      this.clampHalf(p);
    }
    collidePlayers(ctx);
    for (const p of ctx.players) if (!p.dead) this.clampHalf(p); // keep collisions on-side

    this.tickBalls(dt, elapsed);
    this.updateHeldBalls();
    this.updateUI();
    tickRoster(ctx, dt, elapsed);

    // Win / lose.
    if (this.alive(1).length === 0) return this.doFinish(0, 'LEFT team wipes out RIGHT!');
    if (this.alive(0).length === 0) return this.doFinish(1, 'RIGHT team wipes out LEFT!');
    if (this.timeLeft <= 0) {
      const l0 = this.teamLives(0), l1 = this.teamLives(1);
      const w = l0 !== l1 ? (l0 > l1 ? 0 : 1) : (this.alive(0).length >= this.alive(1).length ? 0 : 1);
      return this.doFinish(w, `Time! ${w === 0 ? 'LEFT' : 'RIGHT'} team wins on lives.`);
    }
  }

  private teamLives(team: number): number {
    return this.ctx.players.filter((p) => this.teamOf(p) === team).reduce((s, p) => s + Math.max(0, p.lives), 0);
  }

  private clampHalf(p: Player) {
    const H = this.H, r = HITBOX_RADIUS, sign = this.sign(this.teamOf(p));
    if (sign < 0) p.x = Math.max(-H + r, Math.min(-LINE_BUF, p.x));
    else p.x = Math.min(H - r, Math.max(LINE_BUF, p.x));
    p.z = Math.max(-H + r, Math.min(H - r, p.z));
  }

  // --- balls ------------------------------------------------------------------
  private updateHeldBalls() {
    for (const b of this.balls) {
      if (b.state !== 'held') continue;
      const p = this.ctx.players[b.holder];
      const f = p.standFacing ?? 0;
      b.x = p.x + Math.sin(f) * 1.2; b.z = p.z + Math.cos(f) * 1.2;
      b.g.position.set(b.x, 1.4, b.z);
    }
  }

  private tickBalls(dt: number, elapsed: number) {
    for (const b of this.balls) {
      if (b.state === 'loose') {
        b.g.position.set(b.x, 0.8 + Math.sin(elapsed * 3 + b.x) * 0.08, b.z);
        // Auto-grab: nearest eligible player on this ball's side (or a line ball).
        const onLine = Math.abs(b.x) < 1.5;
        let taker: Player | null = null, bd = GRAB_R;
        for (const p of this.ctx.players) {
          if (p.dead || p.freezeT > 0 || this.heldBall(p.index)) continue;
          const mine = onLine || Math.sign(b.x) === this.sign(this.teamOf(p));
          if (!mine) continue;
          const d = Math.hypot(p.x - b.x, p.z - b.z);
          if (d < bd) { bd = d; taker = p; }
        }
        if (taker) { b.state = 'held'; b.holder = taker.index; SFX.gem(); if (taker.you) this.ctx.fx.banner('🏐 GRABBED! tap THROW', '#7CF07C'); }
      } else if (b.state === 'thrown') {
        b.life -= dt;
        b.x += b.vx * dt; b.z += b.vz * dt;
        b.g.position.set(b.x, BALL_Y, b.z);
        b.g.rotation.x += dt * 12; b.g.rotation.z += dt * 8;
        // Reaching an ENEMY of the thrower?
        const thrower = this.ctx.players[b.thrower];
        const foeTeam = this.teamOf(thrower) === 0 ? 1 : 0;
        let resolved = false;
        for (const p of this.alive(foeTeam)) {
          const d = Math.hypot(p.x - b.x, p.z - b.z);
          if (this.catchT[p.index] > 0 && d < CATCH_R) { this.onCatch(p, b); resolved = true; break; }
          if (d < HIT_R) {
            if (this.heldBall(p.index)) { this.blockBall(p, b); } // shield
            else this.onHit(p, b);
            resolved = true; break;
          }
        }
        if (resolved) continue;
        // Out of bounds / expired → drop loose (or replace on the line).
        if (b.life <= 0 || Math.abs(b.x) > this.H + 1 || Math.abs(b.z) > this.H + 1) {
          if (Math.abs(b.x) > this.H + 1 || Math.abs(b.z) > this.H + 1) { b.x = 0; b.z = (Math.random() - 0.5) * this.H * 1.2; }
          b.state = 'loose'; b.vx = 0; b.vz = 0; b.holder = -1; b.thrower = -1; b.power = false;
        }
      }
    }
  }

  private blockBall(p: Player, b: Ball) {
    // Deflect back toward the thrower's half, drop loose.
    b.state = 'loose'; b.vx = 0; b.vz = 0;
    b.x = p.x + this.sign(this.teamOf(p)) * 0.5; b.holder = -1; b.thrower = -1;
    SFX.bump(); this.ctx.fx.burst(p.x, p.z, '#cff0ff', 8);
    if (p.you) this.ctx.fx.banner('🛡️ BLOCKED!', '#cff0ff');
  }

  private onCatch(p: Player, b: Ball) {
    const thrower = this.ctx.players[b.thrower]; // capture BEFORE clearing
    this.catchT[p.index] = 0;
    b.state = 'held'; b.holder = p.index; b.thrower = -1; b.power = false;
    this.hits[p.index]++;
    SFX.power(); this.ctx.fx.burst(p.x, p.z, '#7CF07C', 18); this.ctx.fx.shake(1.2);
    // Revive a downed teammate if there is one; otherwise the THROWER loses a life.
    const downed = this.ctx.players.find((q) => this.teamOf(q) === this.teamOf(p) && q.dead);
    if (downed) {
      this.revive(downed);
      this.ctx.fx.banner(p.you ? '🙌 CAUGHT — TEAMMATE BACK!' : `${p.hero.name} catch — revive!`, '#7CF07C');
    } else {
      if (thrower && !thrower.dead) this.loseLife(thrower, true);
      this.ctx.fx.banner(p.you ? '🙌 CAUGHT — THEY LOSE A LIFE!' : `${p.hero.name} caught it!`, '#7CF07C');
    }
  }

  private onHit(p: Player, b: Ball) {
    if (p.invulnT > 0 || this.startGrace > 0) { // whiff during grace/invuln → drop loose
      b.state = 'loose'; b.vx = 0; b.vz = 0; b.holder = -1; b.thrower = -1; return;
    }
    const kx = b.vx, kz = b.vz, L = Math.hypot(kx, kz) || 1;
    this.hits[b.thrower] = (this.hits[b.thrower] ?? 0) + 1;
    b.state = 'loose'; b.vx = 0; b.vz = 0; b.x = p.x + (kx / L) * 1.2; b.holder = -1; b.thrower = -1;
    p.vx += (kx / L) * 8; p.vz += (kz / L) * 8;
    this.loseLife(p, false);
  }

  private loseLife(p: Player, fromCatch: boolean) {
    p.lives--;
    setScore(p, p.lives > 0 ? '❤'.repeat(p.lives) : 'OUT');
    SFX.fall(); this.ctx.fx.burst(p.x, p.z, p.hero.col, 16); this.ctx.fx.shake(1.4);
    if (p.lives <= 0) { this.eliminate(p); return; }
    p.invulnT = INVULN; p.freezeT = Math.max(p.freezeT, STUN); p.zapped = true;
    if (p.you) this.ctx.fx.banner(fromCatch ? '💥 CAUGHT OUT!' : `💥 HIT! ${p.lives} left`, '#FF4D4D');
    else this.ctx.fx.banner(`${p.hero.name} hit! ${p.lives} left`, p.hero.col);
  }

  private eliminate(p: Player) {
    p.dead = true;
    markDead(p);
    // Drop any held ball.
    const hb = this.heldBall(p.index);
    if (hb) { hb.state = 'loose'; hb.holder = -1; }
    SFX.out();
    this.ctx.fx.banner(p.you ? '☠️ YOU\'RE OUT!' : `${p.hero.name} is OUT!`, '#FF4D4D');
    setObjective(`LEFT ${this.alive(0).length} — ${this.alive(1).length} RIGHT`);
  }

  private revive(p: Player) {
    p.dead = false; p.lives = 1; p.invulnT = INVULN; p.freezeT = 0;
    const sign = this.sign(this.teamOf(p));
    p.x = sign * this.H * 0.7; p.z = (Math.random() - 0.5) * this.H;
    p.vx = 0; p.vz = 0;
    setScore(p, '❤');
    if (p.group) p.group.visible = true;
    SFX.win();
  }

  // --- bot AI -----------------------------------------------------------------
  private botTick(p: Player, dt: number) {
    const i = p.index;
    // Dodge an incoming ball if one is bearing down.
    const threat = this.incomingBall(p);
    p.retarget -= dt;
    this.botAct[i] -= dt;

    const held = this.heldBall(i);
    if (held) {
      // Attack: pick a spot with a clear shot, then throw after a beat.
      if (p.retarget <= 0) {
        p.retarget = 0.4 + Math.random() * 0.3;
        const foe = this.nearestEnemy(p);
        if (foe) { p.tx = p.x + (Math.random() - 0.5) * 6; p.tz = foe.z + (Math.random() - 0.5) * 6; }
      }
      if (this.botAct[i] <= 0) {
        this.botAct[i] = 0.6 + Math.random() * 0.9;
        // Better bots throw power more and aim truer (handled by lead in doThrow).
        this.doThrow(p, Math.random() < 0.35 + this.ctx.diff.cap * 0.4);
      }
    } else if (threat && Math.random() < 0.02 + this.ctx.diff.cap * 0.05) {
      // Occasionally attempt a catch.
      this.doCatch(p);
      p.tx = p.x; p.tz = p.z;
    } else if (threat) {
      // Dodge perpendicular to the incoming ball.
      const perp = Math.atan2(threat.vx, threat.vz) + Math.PI / 2;
      p.tx = p.x + Math.sin(perp) * 6 * (Math.random() < 0.5 ? 1 : -1);
      p.tz = p.z + Math.cos(perp) * 6 * (Math.random() < 0.5 ? 1 : -1);
    } else if (p.retarget <= 0) {
      p.retarget = 0.3 + Math.random() * 0.3;
      // Chase the nearest grabbable ball, else hold mid-court ready.
      const ball = this.nearestLoose(p);
      if (ball) { p.tx = ball.x; p.tz = ball.z; }
      else { p.tx = this.sign(this.teamOf(p)) * this.H * 0.5; p.tz = (Math.random() - 0.5) * this.H * 1.2; }
    }
    botMove(this.ctx, p, p.tx, p.tz, dt, { noClamp: true });
  }

  private incomingBall(p: Player): Ball | null {
    for (const b of this.balls) {
      if (b.state !== 'thrown' || this.teamOf(this.ctx.players[b.thrower]) === this.teamOf(p)) continue;
      const dx = p.x - b.x, dz = p.z - b.z, d = Math.hypot(dx, dz);
      if (d > 16) continue;
      const bl = Math.hypot(b.vx, b.vz) || 1;
      if ((dx / d) * (b.vx / bl) + (dz / d) * (b.vz / bl) > 0.8) return b; // heading at me
    }
    return null;
  }

  private nearestLoose(p: Player): Ball | null {
    let best: Ball | null = null, bd = Infinity;
    for (const b of this.balls) {
      if (b.state !== 'loose') continue;
      const onLine = Math.abs(b.x) < 1.5;
      if (!onLine && Math.sign(b.x) !== this.sign(this.teamOf(p))) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('dbUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'dbUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    ui.innerHTML = `
      <div id="dbScore" style="position:fixed;top:112px;left:50%;transform:translateX(-50%);display:flex;gap:14px;align-items:center;
        font-size:15px;color:#fff;text-shadow:0 2px 4px #000;background:rgba(10,20,34,.5);padding:6px 14px;border-radius:12px;"></div>
      <button id="dbCatch" data-nostick style="pointer-events:auto;position:fixed;left:20px;bottom:26px;">🧤 CATCH</button>
      <button id="dbThrow" data-nostick style="pointer-events:auto;position:fixed;right:20px;bottom:26px;">🏐 THROW</button>`;
    document.body.appendChild(ui);
    const btnCss = 'font-family:Bungee,system-ui,sans-serif;font-size:19px;border:none;border-radius:18px;padding:18px 24px;color:#12142e;cursor:pointer;box-shadow:0 5px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.catchBtn = ui.querySelector('#dbCatch')!;
    this.throwBtn = ui.querySelector('#dbThrow')!;
    this.catchBtn.style.cssText += btnCss + 'background:#7CF07C;';
    this.throwBtn.style.cssText += btnCss + 'background:#FFD23F;';
    this.scoreEl = ui.querySelector('#dbScore')!;
    this.catchBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); this.doCatch(this.ctx.players[0]);
      this.catchBtn.style.filter = 'brightness(1.3)'; setTimeout(() => this.catchBtn && (this.catchBtn.style.filter = ''), 140);
    });
    const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.charging = true; this.chargeT = 0; this.throwBtn.style.filter = 'brightness(1.3)'; };
    const up = (e: Event) => {
      e.preventDefault();
      if (this.charging) { this.doThrow(this.ctx.players[0], this.chargeT > 0.45); this.charging = false; this.chargeT = 0; }
      this.throwBtn.style.filter = '';
    };
    this.throwBtn.addEventListener('pointerdown', down);
    this.throwBtn.addEventListener('pointerup', up);
    this.throwBtn.addEventListener('pointerleave', up);
    this.throwBtn.addEventListener('pointercancel', up);
  }

  private updateUI() {
    if (!this.scoreEl) return;
    const hearts = (team: number) => this.ctx.players.filter((p) => this.teamOf(p) === team)
      .map((p) => p.dead ? '🖤' : '❤'.repeat(Math.max(0, p.lives))).join(' ');
    this.scoreEl.innerHTML = `<span style="color:#8fc0ff">LEFT ${hearts(0)}</span><span style="opacity:.6">VS</span><span style="color:#ff9a8f">${hearts(1)} RIGHT</span>`;
    // Charging throw glows the button red as it powers up.
    if (this.throwBtn) this.throwBtn.style.background = this.charging && this.chargeT > 0.45 ? '#ff4d4d' : '#FFD23F';
  }

  private doFinish(winTeam: number, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('dbUI')?.remove();
    for (const b of this.balls) this.ctx.scene.remove(b.g);
    const ctx = this.ctx;
    ctx.players.forEach((p) => {
      const won = this.teamOf(p) === winTeam;
      (p as any)._res = won ? `🏆 ${this.hits[p.index]} hits` : (p.dead ? 'OUT' : `${this.hits[p.index]} hits`);
    });
    ctx.finish(rankBy(ctx, (p) => (this.teamOf(p) === winTeam ? 1e6 : 0) + Math.max(0, p.lives) * 1000 + this.hits[p.index]), sub);
  }
}
