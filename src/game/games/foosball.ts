import * as THREE from 'three';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, setObjective } from '../../ui/hud';

// FOOT BRAWL (Wildwood tier 4). Top-down 2v2 TABLE-FOOTBALL. BLUE (left) vs RED
// (right). Each team has an ATTACKER (front rail, near centre) and a DEFENDER
// (back rail, near their own goal). Every player is locked to a vertical rail
// and only slides UP/DOWN (facing the enemy goal). A fast soccer ball bounces
// off the boards and off players; smack it into the rival goal. First team to
// 3 goals wins.

const BALL_R = 1.0;
const BALL_SPEED = 28;       // the ball stays fast
const BALL_MAX = 46;
const SMASH_V = 58;          // a smash is a proper cannon shot
const MOVE_SPEED = 26;
const WIN_GOALS = 3;
const SMASH_CD = 10;         // one smash per player every 10s
const STUN_TIME = 1.3;       // knocked dizzy — spins + birds, can't block

export class FoosballGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Foot Brawl';
  objective = '⚽ Slide up/down — blast the ball into the RED goal!';

  private ctx!: MatchContext;
  private finished = false;
  private timeLeft = 120;
  private X = 30; private Z = 18; private goalHalf = 8;

  private railX: number[] = [];     // fixed x per player
  private ball!: THREE.Mesh;
  private bx = 0; private bz = 0; private bvx = 0; private bvz = 0;
  private score = [0, 0];           // [blue, red]
  private resetT = 1.4;             // kickoff / after-goal freeze
  private smashCd = [0, 0, 0, 0];   // per-player smash cooldown
  private stunT = [0, 0, 0, 0];     // per-player dizzy timer
  private hitFx = 0;

  private smashBtn!: HTMLButtonElement;
  private blueEl!: HTMLElement; private redEl!: HTMLElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(120);
    // Goals sit on the LEFT/RIGHT ends, so goal-to-goal is the SCREEN-WIDTH
    // dimension. The pitch is TALLER than it is wide (players slide up/down)
    // which fits a portrait phone, and the camera fits it exactly (frameArena)
    // so the pitch fills the screen with both goals on view.
    this.X = ctx.halfSize * 0.6; this.Z = ctx.halfSize * 1.05; this.goalHalf = this.Z * 0.3;
    this.score = [0, 0]; this.resetT = 1.6; this.smashCd = [0, 0, 0, 0]; this.stunT = [0, 0, 0, 0];

    // Teams: 0,1 = BLUE (attacks +x, defends −x); 2,3 = RED. You are 0 (blue
    // ATTACKER). Rails: attacker mid-field, defender back near their own goal —
    // spread far apart so the ball can't stall between team-mates.
    this.railX = [-this.X * 0.34, -this.X * 0.80, this.X * 0.34, this.X * 0.80];

    this.buildPitch();
    setupRoster(ctx, '', 0.5);

    ctx.players.forEach((p) => {
      const blue = p.index < 2;
      p.x = this.railX[p.index]; p.z = (p.index % 2 === 0 ? -1 : 1) * this.Z * 0.28;
      p.vx = 0; p.vz = 0; p.dead = false;
      p.standFacing = blue ? Math.PI / 2 : -Math.PI / 2; // face the enemy goal
      setScore(p, blue ? '🔵' : '🔴');
    });

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    const spot = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.42, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    spot.position.set(0.4, 0.4, 0.3); this.ball.add(spot);
    this.ball.castShadow = true; ctx.scene.add(this.ball);
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;

    // Fit the camera to the pitch (+ goal depth + a little margin) so the whole
    // pitch fills the screen and nothing but the pitch really shows.
    ctx.camera.frameArena(this.X + 5, this.Z + 2);

    this.buildUI();
    setObjective(this.objective);
    ctx.fx.banner('⚽ FOOT BRAWL — FIRST TO 3!', '#7CF07C');
  }

  private teamOf(p: Player): number { return p.index < 2 ? 0 : 1; }

  // --- pitch ------------------------------------------------------------------
  private buildPitch() {
    const scene = this.ctx.scene, X = this.X, Z = this.Z;
    // Striped grass.
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      const w = (X * 2) / stripes;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Z * 2),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0x3f8a3a : 0x357a32, roughness: 1 }));
      m.rotation.x = -Math.PI / 2; m.position.set(-X + w * (i + 0.5), 0.02, 0); m.receiveShadow = true; scene.add(m);
    }
    // White markings (raised thin boxes).
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      m.position.set(x, 0.1, z); scene.add(m);
    };
    line(0, 0, 0.5, Z * 2);                       // halfway line
    line(-X + 0.4, 0, 0.5, Z * 2); line(X - 0.4, 0, 0.5, Z * 2); // side (goal) lines
    line(0, Z - 0.4, X * 2, 0.5); line(0, -Z + 0.4, X * 2, 0.5); // top/bottom touchlines
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Z * 0.34, 0.22, 6, 40), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1; scene.add(ring);
    for (const sx of [-1, 1]) { // penalty boxes
      line(sx * (X - 7), Z * 0.5, 0.5, Z); line(sx * (X - 7), -Z * 0.5, 0.5, Z);
      line(sx * (X - 3.5), Z * 0.55, 7, 0.5); line(sx * (X - 3.5), -Z * 0.55, 7, 0.5);
    }

    // Boards around the pitch (ball bounces off), goal-coloured on the ends.
    const board = (x: number, z: number, w: number, d: number, col: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: (col & 0xfefefe) >> 1, emissiveIntensity: 0.15 }));
      m.position.set(x, 1.1, z); m.castShadow = true; scene.add(m);
    };
    board(0, Z + 0.6, X * 2 + 2, 1.2, 0xece8d8); board(0, -Z - 0.6, X * 2 + 2, 1.2, 0xece8d8);
    // End boards with a goal gap.
    const seg = (Z - this.goalHalf) / 2;
    for (const [sx, col] of [[-1, 0x2f6bd8], [1, 0xd8452f]] as const) {
      board(sx * (X + 0.6), (this.goalHalf + seg), 1.2, seg * 2, col);
      board(sx * (X + 0.6), -(this.goalHalf + seg), 1.2, seg * 2, col);
      this.buildGoal(sx, col);
    }

    // Coloured rail strips under each player lane.
    [-1, -1, 1, 1].forEach((s, i) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, Z * 2 - 2),
        new THREE.MeshStandardMaterial({ color: s < 0 ? 0x2f6bd8 : 0xd8452f, emissive: s < 0 ? 0x123a7a : 0x7a1a12, emissiveIntensity: 0.5, roughness: 0.5 }));
      rail.position.set(this.railX[i], 0.12, 0); scene.add(rail);
    });

    // Bright glowing goal-mouth on the floor at each end so it's obvious where
    // to score.
    for (const [sx, col] of [[-1, 0x2f6bd8], [1, 0xd8452f]] as const) {
      const mouth = new THREE.Mesh(new THREE.PlaneGeometry(3.2, this.goalHalf * 2),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      mouth.rotation.x = -Math.PI / 2; mouth.position.set(sx * (X - 1.6), 0.13, 0); scene.add(mouth);
    }
  }

  private buildGoal(sx: number, col: number) {
    const scene = this.ctx.scene, X = this.X, gh = this.goalHalf;
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, emissive: (col & 0xfefefe) >> 2, emissiveIntensity: 0.4 });
    const depth = 4;
    // Frame posts + crossbar-ish + net (a translucent box behind the line).
    for (const sz of [-gh, gh]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 3.4, 8), mat); post.position.set(sx * (X + 0.2), 1.7, sz); scene.add(post); }
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, gh * 2, 8), mat); back.rotation.x = Math.PI / 2; back.position.set(sx * (X + depth), 1.7, 0); scene.add(back);
    const net = new THREE.Mesh(new THREE.BoxGeometry(depth, 3.2, gh * 2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.18, wireframe: true }));
    net.position.set(sx * (X + depth / 2), 1.6, 0); scene.add(net);
  }

  // --- input ------------------------------------------------------------------
  ability() { this.doSmash(0); }
  jump() { this.doSmash(0); }

  // A SMASH is a cannon shot toward the enemy goal. It's only usable when you're
  // on the ball, and only once every 10 seconds per player. The FIRST character
  // standing in the shot's path gets stunned (spun dizzy for a beat) so they
  // can't stop it — friend or foe, so a defender who smashes past their own
  // attacker will floor their team-mate. A second defender further back can
  // still block, so a smash isn't a guaranteed goal.
  private doSmash(i: number) {
    if (this.finished || this.resetT > 0 || this.stunT[i] > 0) return;
    if (this.smashCd[i] > 0) return;
    const p = this.ctx.players[i];
    const d = Math.hypot(this.bx - p.x, this.bz - p.z);
    if (d >= HITBOX_RADIUS + BALL_R + 3) { if (i === 0) SFX.tick(); return; } // not on the ball → no cd spent
    this.smashCd[i] = SMASH_CD;
    const dir = this.teamOf(p) === 0 ? 1 : -1; // blue shoots +x, red −x
    const dz = this.bz - p.z, L = Math.hypot(dir * 7, dz) || 1;
    // Clear the ball off the shooter first so the shot flies clean (no instant
    // re-collision that would sap the smash and make it feel stuck).
    this.bx = p.x + dir * (HITBOX_RADIUS + BALL_R + 0.6);
    this.bvx = (dir * 7 / L) * SMASH_V; this.bvz = (dz / L) * SMASH_V;
    this.hitFx = 0.3;
    SFX.hit(); this.ctx.fx.burst(this.bx, this.bz, '#FFD23F', 18); this.ctx.fx.shake(1.6);
    if (i === 0) this.ctx.fx.banner('⚡ SMASH!', '#FFD23F');
    this.stunFirstInPath(i, dir);
  }

  /** Stun the first character the smashed ball would pass through (any team). */
  private stunFirstInPath(shooter: number, dir: number) {
    let victim = -1, bestT = Infinity;
    for (const o of this.ctx.players) {
      if (o.index === shooter) continue;
      const ahead = (o.x - this.bx) * dir;
      if (ahead <= 0) continue;                       // behind the shot
      const t = (o.x - this.bx) / this.bvx;           // time for the ball to reach its x
      if (t <= 0) continue;
      const predZ = this.bz + this.bvz * t;           // ball's z when it gets there
      if (Math.abs(o.z - predZ) > HITBOX_RADIUS + BALL_R + 1.5) continue; // not in the lane
      if (t < bestT) { bestT = t; victim = o.index; }
    }
    if (victim >= 0) this.applyStun(victim);
  }

  private applyStun(i: number) {
    const o = this.ctx.players[i];
    this.stunT[i] = STUN_TIME;
    o.setStatusIcon('🐦💫🐦', STUN_TIME);
    this.ctx.fx.burst(o.x, o.z, '#FFE23A', 12);
    if (i === 0) this.ctx.fx.banner('😵 DIZZY! birds everywhere', '#FFD23F');
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt; ctx.setClock(this.timeLeft);
    this.hitFx = Math.max(0, this.hitFx - dt);
    // Cooldowns + dizzy spin. A stunned hero whirls two full turns while the
    // birds circle, then straightens up.
    for (let i = 0; i < 4; i++) {
      this.smashCd[i] = Math.max(0, this.smashCd[i] - dt);
      if (this.stunT[i] > 0) {
        this.stunT[i] -= dt;
        ctx.players[i].group.rotation.y = (1 - Math.max(0, this.stunT[i]) / STUN_TIME) * Math.PI * 4;
        if (this.stunT[i] <= 0) ctx.players[i].group.rotation.y = 0;
      }
    }

    if (this.resetT > 0) {
      this.resetT -= dt;
      if (this.resetT <= 0) this.kickoff();
    } else {
      this.moveLocal(dt);
      for (const p of ctx.players.slice(1)) this.moveBot(p, dt);
      this.tickBall(dt);
    }

    // Sync meshes / facing (a stunned hero keeps its dizzy spin).
    for (const p of ctx.players) { p.x = this.railX[p.index]; if (this.stunT[p.index] <= 0) p.standFacing = this.teamOf(p) === 0 ? Math.PI / 2 : -Math.PI / 2; }
    this.ball.position.set(this.bx, BALL_R + 0.1, this.bz);
    this.ball.rotation.z -= this.bvx * dt * 0.4; this.ball.rotation.x += this.bvz * dt * 0.4;
    this.ball.scale.setScalar(1 + this.hitFx * 0.6);

    this.updateUI();
    tickRoster(ctx, dt, elapsed);

    if (this.score[0] >= WIN_GOALS) return this.doFinish(0, 'BLUE team wins the brawl!');
    if (this.score[1] >= WIN_GOALS) return this.doFinish(1, 'RED team wins the brawl!');
    if (this.timeLeft <= 0) return this.doFinish(this.score[0] >= this.score[1] ? 0 : 1, `Time! ${this.score[0] >= this.score[1] ? 'BLUE' : 'RED'} wins.`);
  }

  private moveLocal(dt: number) {
    const p = this.ctx.players[0];
    if (this.stunT[0] > 0) { p.vz = 0; return; }        // dizzy — can't slide
    // Push the stick UP → slide UP the screen (−z). (Matches Hockey Brawl; the
    // old mapping felt inverted.)
    const ay = this.ctx.input.ay; // stick vertical (screen-down = +)
    p.z += ay * MOVE_SPEED * dt;
    p.vz = ay * MOVE_SPEED; p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
  }

  private moveBot(p: Player, dt: number) {
    if (this.stunT[p.index] > 0) { p.vz = 0; return; }  // dizzy — can't slide
    // Track the ball's z (with lead + difficulty error); defenders hang slightly
    // toward their own goal side, attackers press.
    const lead = this.bz + this.bvz * 0.18;
    const err = (1 - this.ctx.diff.cap) * this.Z * 0.5 * (Math.random() - 0.5);
    let target = lead + err;
    // Only chase hard when the ball is roughly on this player's side of pitch.
    const onMySide = this.teamOf(p) === 0 ? this.bx < 4 : this.bx > -4;
    const spd = MOVE_SPEED * (onMySide ? 1 : 0.6) * (0.7 + this.ctx.diff.cap * 0.4);
    const dz = target - p.z;
    p.z += Math.max(-spd * dt, Math.min(spd * dt, dz));
    p.vz = Math.sign(dz) * Math.min(Math.abs(dz) / dt, spd); p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
    // Bot smash when it's on the ball and its 10s cooldown is up.
    if (this.smashCd[p.index] <= 0 && Math.hypot(this.bx - p.x, this.bz - p.z) < HITBOX_RADIUS + BALL_R + 2 && Math.random() < (0.5 + this.ctx.diff.cap) * dt) {
      this.doSmash(p.index);
    }
  }

  private tickBall(dt: number) {
    this.bx += this.bvx * dt; this.bz += this.bvz * dt;
    // Top / bottom boards.
    if (this.bz > this.Z - BALL_R) { this.bz = this.Z - BALL_R; this.bvz = -Math.abs(this.bvz); SFX.tick(); }
    if (this.bz < -this.Z + BALL_R) { this.bz = -this.Z + BALL_R; this.bvz = Math.abs(this.bvz); SFX.tick(); }
    // End boards / goals.
    for (const sx of [-1, 1]) {
      if (sx < 0 ? this.bx < -this.X + BALL_R : this.bx > this.X - BALL_R) {
        if (Math.abs(this.bz) < this.goalHalf) { this.onGoal(sx < 0 ? 1 : 0); return; } // ball in the −x goal → RED scored
        this.bx = sx < 0 ? -this.X + BALL_R : this.X - BALL_R; this.bvx = -this.bvx; SFX.bump();
      }
    }
    // Player collisions. A dizzy (stunned) hero can't block — the ball passes
    // straight through them.
    for (const p of this.ctx.players) {
      if (this.stunT[p.index] > 0) continue;
      const dx = this.bx - p.x, dz = this.bz - p.z, d = Math.hypot(dx, dz), min = HITBOX_RADIUS + BALL_R;
      if (d < min && d > 0.001) {
        const nz = dz / d;
        const sp = Math.hypot(this.bvx, this.bvz);
        // Always drive the ball toward the ENEMY goal on a touch — a blue player
        // sends it +x, a red player −x. This stops the ball stalling in a
        // ping-pong between team-mates and keeps play flowing end to end.
        const dir = this.teamOf(p) === 0 ? 1 : -1;
        // Place the ball CLEAR of the player on the enemy-goal side so it can't
        // immediately re-collide and jitter/stick to the player.
        this.bx = p.x + dir * (min + 0.4);
        this.bz = p.z + nz * min;
        this.bvx = dir * Math.max(sp * 0.72, BALL_SPEED * 0.85);
        this.bvz = nz * sp * 0.6 + p.vz * 0.5;                 // vertical deflection + carry the slide
        this.hitFx = 0.16; SFX.bump(); this.ctx.fx.burst(this.bx, this.bz, p.hero.col, 6);
      }
    }
    // Keep the ball fast (clamped) and never fully stalled.
    let sp = Math.hypot(this.bvx, this.bvz);
    if (sp < BALL_SPEED) { const k = BALL_SPEED / (sp || 1); this.bvx *= k; this.bvz *= k; }
    else if (sp > BALL_MAX) { const k = BALL_MAX / sp; this.bvx *= k; this.bvz *= k; }
  }

  private onGoal(scorer: number) {
    this.score[scorer]++;
    SFX.win(); this.ctx.fx.shake(2.4); this.ctx.fx.burst(this.bx, this.bz, scorer === 0 ? '#4DC3FF' : '#ff4da6', 26);
    this.ctx.fx.banner(scorer === 0 ? '🔵 BLUE GOAL!' : '🔴 RED GOAL!', scorer === 0 ? '#4DC3FF' : '#ff4da6');
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;
    this.resetT = 1.5;
    // Reset players to their lanes; clear any dizzy spin.
    this.ctx.players.forEach((p) => {
      p.z = (p.index % 2 === 0 ? -1 : 1) * this.Z * 0.28; p.vz = 0;
      this.stunT[p.index] = 0; p.group.rotation.y = 0; p.setStatusIcon(null);
    });
  }

  private kickoff() {
    const dir = Math.random() < 0.5 ? 1 : -1;
    this.bvx = dir * BALL_SPEED * 0.8; this.bvz = (Math.random() - 0.5) * BALL_SPEED * 0.6;
    this.ctx.fx.banner('GO! ⚽', '#FFD23F'); SFX.gem();
  }

  // --- HUD --------------------------------------------------------------------
  private buildUI() {
    document.getElementById('fbUI')?.remove();
    const ui = document.createElement('div');
    ui.id = 'fbUI';
    ui.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;font-family:Bungee,system-ui,sans-serif;';
    const bar = (side: string, col: string, label: string) =>
      `<div id="fb${side}" style="position:fixed;top:66px;${side === 'Blue' ? 'left:16px' : 'right:16px'};background:${col};color:#fff;
        padding:6px 12px;border-radius:12px;font-size:14px;box-shadow:0 3px 0 rgba(0,0,0,.4);display:flex;gap:6px;align-items:center;">
        ${side === 'Blue' ? label + ' ' : ''}<span class="balls"></span>${side === 'Red' ? ' ' + label : ''}</div>`;
    ui.innerHTML = `
      ${bar('Blue', '#2f6bd8', 'BLUE')}
      ${bar('Red', '#d8452f', 'RED')}
      <button id="fbSmash" style="pointer-events:auto;position:fixed;right:20px;bottom:26px;">⚡ SMASH</button>`;
    document.body.appendChild(ui);
    this.smashBtn = ui.querySelector('#fbSmash')!;
    this.smashBtn.style.cssText += 'font-family:Bungee,system-ui,sans-serif;font-size:20px;border:none;border-radius:18px;padding:20px 28px;color:#12142e;background:#FFD23F;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;';
    this.smashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.doSmash(0); });
    this.blueEl = ui.querySelector('#fbBlue .balls')!; this.redEl = ui.querySelector('#fbRed .balls')!;
  }

  private updateUI() {
    const balls = (n: number) => '⚽'.repeat(n) + '·'.repeat(Math.max(0, WIN_GOALS - n));
    if (this.blueEl) this.blueEl.textContent = balls(this.score[0]);
    if (this.redEl) this.redEl.textContent = balls(this.score[1]);
    // SMASH button shows its 10s cooldown as a countdown.
    if (this.smashBtn) {
      const cd = this.smashCd[0];
      this.smashBtn.style.opacity = cd > 0 ? '0.5' : '1';
      this.smashBtn.textContent = cd > 0 ? `⚡ ${Math.ceil(cd)}s` : '⚡ SMASH';
    }
  }

  private doFinish(winTeam: number, sub: string) {
    if (this.finished) return;
    this.finished = true;
    document.getElementById('fbUI')?.remove();
    this.ctx.scene.remove(this.ball);
    const ctx = this.ctx;
    ctx.players.forEach((p) => { (p as any)._res = this.teamOf(p) === winTeam ? `🏆 ${this.score[winTeam]}–${this.score[1 - winTeam]}` : `${this.score[this.teamOf(p)]} goals`; });
    if (winTeam === 0) { this.ctx.fx.banner('🔵 BLUE WINS!', '#4DC3FF'); } else { this.ctx.fx.banner('🔴 RED WINS!', '#ff4da6'); }
    ctx.finish(rankBy(ctx, (p) => this.teamOf(p) === winTeam ? 1e6 : 0), sub);
  }
}
