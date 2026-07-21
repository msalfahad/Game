import * as THREE from 'three';
import type { Player } from '../player';
import { HITBOX_RADIUS } from '../player';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, tickRoster, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore, setObjective } from '../../ui/hud';

// FOOT BRAWL (Wildwood tier 4). A simple, chunky, zoomed-in 2v2 table-football
// (Mario-Party ice-hockey feel). BLUE (left) vs RED (right); an ATTACKER + a
// DEFENDER per team slide up/down their rails and whack a fast ball into the
// rival goal. Two team abilities that reward playing together:
//   • SMASH — a cannon shot (needs the ball, 3s), stuns the first blocker.
//   • WIDEN — opens the ENEMY goal wide for a few seconds (no ball, 6s) so a
//     team-mate can slam one in. First team to 3 goals in a 1-minute match.

const BALL_R = 1.1;
const BALL_SPEED = 32;        // fast ball
const BALL_MAX = 50;
const SMASH_V = 62;
const MOVE_SPEED = 34;        // quick side-to-side
const WIN_GOALS = 3;
const SMASH_CD = 3;           // reliable — one smash every 3s
const STUN_TIME = 1.2;
const WIDEN_CD = 6;           // open the enemy goal every 6s
const WIDEN_TIME = 3.5;       // how long it stays open
const WIDEN_MUL = 1.9;        // how much wider
const MATCH_SECS = 60;        // 1-minute match

export class FoosballGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Foot Brawl';
  objective = '⚽ Slide up/down · SMASH on the ball · WIDEN the enemy goal — first to 3!';

  private ctx!: MatchContext;
  private finished = false;
  private timeLeft = MATCH_SECS;
  private X = 20; private Z = 12; private goalHalf = 5;

  private railX: number[] = [];
  private ball!: THREE.Mesh;
  private bx = 0; private bz = 0; private bvx = 0; private bvz = 0;
  private score = [0, 0];            // [blue, red]
  private resetT = 1.4;
  private smashCd = [0, 0, 0, 0];    // per-player smash cooldown
  private widenCd = [0, 0, 0, 0];    // per-player widen cooldown
  private stunT = [0, 0, 0, 0];      // per-player dizzy timer
  private widenT = [0, 0];           // per-goal "wide open" timer (0=left, 1=right)
  private goalGroups: THREE.Group[] = [];
  private dots: THREE.Mesh[] = [];   // tiny team marker under each hero
  private hitFx = 0;

  private smashBtn!: HTMLButtonElement;
  private widenBtn!: HTMLButtonElement;
  private blueEl!: HTMLElement; private redEl!: HTMLElement;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(MATCH_SECS);
    // Top-down stadium seen from above — the family fog would wash it out, so
    // turn it off and add a bright fill.
    ctx.scene.fog = null;
    ctx.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    // A compact WIDE pitch (goals left/right). Small in world units so the
    // heroes look big and chunky when the camera fits it to the screen.
    this.X = ctx.halfSize * 0.66; this.Z = ctx.halfSize * 0.42; this.goalHalf = this.Z * 0.42;
    this.score = [0, 0]; this.resetT = 1.6;
    this.smashCd = [0, 0, 0, 0]; this.widenCd = [0, 0, 0, 0]; this.stunT = [0, 0, 0, 0]; this.widenT = [0, 0];

    // Rails: attacker mid-field, defender back near their own goal.
    this.railX = [-this.X * 0.34, -this.X * 0.80, this.X * 0.34, this.X * 0.80];

    this.buildPitch();
    this.buildStadiumFrame();
    setupRoster(ctx, '', 0.5);
    this.buildDots();

    ctx.players.forEach((p) => {
      const blue = p.index < 2;
      p.x = this.railX[p.index]; p.z = (p.index % 2 === 0 ? -1 : 1) * this.Z * 0.28;
      p.vx = 0; p.vz = 0; p.dead = false;
      p.standFacing = blue ? Math.PI / 2 : -Math.PI / 2; // face the enemy goal
      // The character body IS the hitbox — hide the big marker rings.
      if (p.ring) p.ring.visible = false;
      if (p.glow) p.glow.visible = false;
      setScore(p, blue ? '🔵' : '🔴');
    });

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    const spot = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 0.42, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    spot.position.set(0.4, 0.4, 0.3); this.ball.add(spot);
    this.ball.castShadow = true; ctx.scene.add(this.ball);
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;

    // Zoom in tight: fit the pitch (+ goal depth) snugly so it fills the screen.
    ctx.camera.frameArena(this.X + 5, this.Z + 4);

    this.buildUI();
    setObjective(this.objective);
    ctx.fx.banner('⚽ FOOT BRAWL — FIRST TO 3!', '#7CF07C');
  }

  private teamOf(p: Player): number { return p.index < 2 ? 0 : 1; }
  private enemyGoalSide(team: number): number { return team === 0 ? 1 : 0; }
  private effGoalHalf(side: number): number { return this.goalHalf * (this.widenT[side] > 0 ? WIDEN_MUL : 1); }

  // --- pitch ------------------------------------------------------------------
  private buildPitch() {
    const scene = this.ctx.scene, X = this.X, Z = this.Z;
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      const w = (X * 2) / stripes;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, Z * 2),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0x3f8a3a : 0x357a32, roughness: 1 }));
      m.rotation.x = -Math.PI / 2; m.position.set(-X + w * (i + 0.5), 0.02, 0); m.receiveShadow = true; scene.add(m);
    }
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
      m.position.set(x, 0.1, z); scene.add(m);
    };
    line(0, 0, 0.5, Z * 2);                       // halfway line
    line(-X + 0.4, 0, 0.5, Z * 2); line(X - 0.4, 0, 0.5, Z * 2);
    line(0, Z - 0.4, X * 2, 0.5); line(0, -Z + 0.4, X * 2, 0.5);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Z * 0.34, 0.22, 6, 40), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.1; scene.add(ring);
    for (const sx of [-1, 1]) {
      line(sx * (X - 6), Z * 0.5, 0.5, Z); line(sx * (X - 6), -Z * 0.5, 0.5, Z);
      line(sx * (X - 3), Z * 0.55, 6, 0.5); line(sx * (X - 3), -Z * 0.55, 6, 0.5);
    }

    // Boards around the pitch (ball bounces off), goal-coloured on the ends.
    const board = (x: number, z: number, w: number, d: number, col: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, emissive: (col & 0xfefefe) >> 1, emissiveIntensity: 0.15 }));
      m.position.set(x, 1.1, z); m.castShadow = true; scene.add(m);
    };
    board(0, Z + 0.6, X * 2 + 2, 1.2, 0xece8d8); board(0, -Z - 0.6, X * 2 + 2, 1.2, 0xece8d8);
    const seg = (Z - this.goalHalf) / 2;
    for (const [sx, col] of [[-1, 0x2f6bd8], [1, 0xd8452f]] as const) {
      board(sx * (X + 0.6), (this.goalHalf + seg), 1.2, seg * 2, col);
      board(sx * (X + 0.6), -(this.goalHalf + seg), 1.2, seg * 2, col);
      this.buildGoal(sx, col);
    }

    // Coloured rails + up/down arrowheads (like the reference art).
    [-1, -1, 1, 1].forEach((s, i) => {
      const col = s < 0 ? 0x2f6bd8 : 0xd8452f;
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, Z * 2 - 2),
        new THREE.MeshStandardMaterial({ color: col, emissive: s < 0 ? 0x123a7a : 0x7a1a12, emissiveIntensity: 0.5, roughness: 0.5 }));
      rail.position.set(this.railX[i], 0.12, 0); scene.add(rail);
      const arrowMat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.5 });
      for (const sz of [-1, 1]) {
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.6, 4), arrowMat);
        arrow.rotation.x = sz < 0 ? Math.PI / 2 : -Math.PI / 2;
        arrow.position.set(this.railX[i], 0.2, sz * (Z - 2.2)); scene.add(arrow);
      }
    });
  }

  private buildGoal(sx: number, col: number) {
    const X = this.X, gh = this.goalHalf;
    const g = new THREE.Group();               // scaled in z when the goal is "widened"
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.2, emissive: (col & 0xfefefe) >> 2, emissiveIntensity: 0.5 });
    const depth = 4.5, postR = 0.45, H = 3.6;
    for (const sz of [-gh, gh]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); post.position.set(sx * (X + 0.2), H / 2, sz); g.add(post); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, gh * 2, 10), mat); bar.rotation.x = Math.PI / 2; bar.position.set(sx * (X + 0.2), H, 0); g.add(bar);
    for (const sz of [-gh, gh]) { const bp = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, H, 10), mat); bp.position.set(sx * (X + depth), H / 2, sz); g.add(bp); }
    const netMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(gh * 2, H, 6, 4), netMat); back.rotation.y = Math.PI / 2; back.position.set(sx * (X + depth), H / 2, 0); g.add(back);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(depth, gh * 2, 4, 6), netMat); top.rotation.x = -Math.PI / 2; top.position.set(sx * (X + depth / 2 + 0.1), H, 0); g.add(top);
    for (const sz of [-gh, gh]) { const side = new THREE.Mesh(new THREE.PlaneGeometry(depth, H, 4, 4), netMat); side.position.set(sx * (X + depth / 2 + 0.1), H / 2, sz); g.add(side); }
    // Glowing goal-mouth on the floor (grows when the goal is widened).
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(3.0, gh * 2),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    mouth.rotation.x = -Math.PI / 2; mouth.position.set(sx * (X - 1.5), 0.13, 0); g.add(mouth);
    this.ctx.scene.add(g);
    this.goalGroups[sx < 0 ? 0 : 1] = g;
  }

  // Stone stadium frame + fans on the LONG sides only (top & bottom); the goal
  // ends stay clear so the full pitch is playable.
  private buildStadiumFrame() {
    const scene = this.ctx.scene, X = this.X, Z = this.Z;
    const stone = new THREE.MeshStandardMaterial({ color: 0x7b818e, roughness: 0.95 });
    const stoneDark = new THREE.MeshStandardMaterial({ color: 0x4b505b, roughness: 1 });
    const wallH = 3.4, wt = 2.6, ox = X + 3.0, oz = Z + 3.0;
    const wall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), stone);
      m.position.set(x, wallH / 2, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, 0.6, d + 0.5), stoneDark);
      cap.position.set(x, wallH + 0.25, z); scene.add(cap);
    };
    const fullW = ox * 2 + wt * 2;
    wall(fullW, wt, 0, oz + wt / 2); wall(fullW, wt, 0, -(oz + wt / 2));
    wall(wt, oz * 2, ox + wt / 2, 0); wall(wt, oz * 2, -(ox + wt / 2), 0);
    // Raked stands packed with fans, top & bottom (pulled in close to the pitch).
    for (const sz of [-1, 1]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(fullW + 24, 9, 30),
        new THREE.MeshStandardMaterial({ color: 0x2f3547, roughness: 1 }));
      stand.position.set(0, 3.6, sz * (oz + wt + 14)); stand.rotation.x = sz * 0.36; scene.add(stand);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(fullW + 24, 0.6, 1.2),
        new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffd23f, emissiveIntensity: 0.6 }));
      trim.position.set(0, 6.6, sz * (oz + wt + 2)); scene.add(trim);
      this.buildFans(sz, fullW + 20, oz + wt);
    }
    // Corner pillars + team pennants (blue left, red right).
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const px = sx * (ox + wt / 2), pz = sz * (oz + wt / 2);
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(wt + 1.4, wallH + 2.4, wt + 1.4), stoneDark);
      pillar.position.set(px, (wallH + 2.4) / 2, pz); pillar.castShadow = true; scene.add(pillar);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 7, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 }));
      pole.position.set(px, wallH + 5, pz); scene.add(pole);
      const teamCol = sx < 0 ? 0x2f6bd8 : 0xd8452f;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.9),
        new THREE.MeshStandardMaterial({ color: teamCol, emissive: teamCol, emissiveIntensity: 0.35, roughness: 0.7, side: THREE.DoubleSide }));
      flag.position.set(px + 1.6, wallH + 6.6, pz); scene.add(flag);
    }
  }

  // Rows of instanced spectators on one long-side stand (coloured body + head).
  private buildFans(sz: number, spanX: number, innerZ: number) {
    const scene = this.ctx.scene;
    const rows = 7, cols = Math.max(10, Math.round(spanX / 2.6));
    const n = rows * cols;
    const bodyGeo = new THREE.CapsuleGeometry(0.5, 1.0, 3, 6);
    const headGeo = new THREE.SphereGeometry(0.42, 6, 6);
    const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), n);
    bodies.castShadow = false; heads.castShadow = false;
    const cloth = ['#ff5a5a', '#4dc3ff', '#ffd23f', '#7cf07c', '#b06bff', '#ff7a3a', '#ffffff', '#2f6bd8', '#e8e8e8', '#d84550'];
    const skin = ['#f2cda2', '#d9a06a', '#a06a40', '#ffe0b8', '#8a5a34'];
    const m = new THREE.Matrix4(); const col = new THREE.Color();
    let k = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -spanX / 2 + (c + 0.5) * (spanX / cols) + (Math.random() - 0.5);
        const z = sz * (innerZ + 1.5 + r * 3.1);
        const y = 1.2 + r * 1.7;
        const s = 0.85 + Math.random() * 0.4;
        m.makeScale(s, s, s); m.setPosition(x, y, z);
        bodies.setMatrixAt(k, m); bodies.setColorAt(k, col.set(cloth[(Math.random() * cloth.length) | 0]));
        m.setPosition(x, y + 1.05 * s, z);
        heads.setMatrixAt(k, m); heads.setColorAt(k, col.set(skin[(Math.random() * skin.length) | 0]));
        k++;
      }
    }
    bodies.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    scene.add(bodies); scene.add(heads);
  }

  private buildDots() {
    this.dots = this.ctx.players.map((p) => {
      const col = this.teamOf(p) === 0 ? 0x2f6bd8 : 0xd8452f;
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.3, 16),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.7, roughness: 0.5 }));
      dot.position.set(this.railX[p.index], 0.14, p.z);
      this.ctx.scene.add(dot);
      return dot;
    });
  }

  // --- input ------------------------------------------------------------------
  ability() { this.doSmash(0); }
  jump() { this.doSmash(0); }

  private doSmash(i: number) {
    if (this.finished || this.resetT > 0 || this.stunT[i] > 0 || this.smashCd[i] > 0) return;
    const p = this.ctx.players[i];
    const d = Math.hypot(this.bx - p.x, this.bz - p.z);
    if (d >= HITBOX_RADIUS + BALL_R + 4) { if (i === 0) SFX.tick(); return; } // not on the ball → no cd spent
    this.smashCd[i] = SMASH_CD;
    const dir = this.teamOf(p) === 0 ? 1 : -1;
    const dz = this.bz - p.z, L = Math.hypot(dir * 7, dz) || 1;
    this.bx = p.x + dir * (HITBOX_RADIUS + BALL_R + 0.6);
    this.bvx = (dir * 7 / L) * SMASH_V; this.bvz = (dz / L) * SMASH_V;
    this.hitFx = 0.3;
    SFX.hit(); this.ctx.fx.burst(this.bx, this.bz, '#FFD23F', 18); this.ctx.fx.shake(1.6);
    if (i === 0) this.ctx.fx.banner('⚡ SMASH!', '#FFD23F');
    this.stunFirstInPath(i, dir);
  }

  private stunFirstInPath(shooter: number, dir: number) {
    let victim = -1, bestT = Infinity;
    for (const o of this.ctx.players) {
      if (o.index === shooter) continue;
      const ahead = (o.x - this.bx) * dir;
      if (ahead <= 0) continue;
      const t = (o.x - this.bx) / this.bvx;
      if (t <= 0) continue;
      const predZ = this.bz + this.bvz * t;
      if (Math.abs(o.z - predZ) > HITBOX_RADIUS + BALL_R + 1.5) continue;
      if (t < bestT) { bestT = t; victim = o.index; }
    }
    if (victim >= 0) this.applyStun(victim);
  }

  private applyStun(i: number) {
    const o = this.ctx.players[i];
    this.stunT[i] = STUN_TIME;
    o.setStatusIcon('🐦💫🐦', STUN_TIME);
    this.ctx.fx.burst(o.x, o.z, '#FFE23A', 12);
    if (i === 0) this.ctx.fx.banner('😵 DIZZY!', '#FFD23F');
  }

  // WIDEN — throw the ENEMY goal wide open for a few seconds so a team-mate can
  // score. No ball needed; 6s cooldown.
  private doWiden(i: number) {
    if (this.finished || this.resetT > 0 || this.stunT[i] > 0 || this.widenCd[i] > 0) return;
    this.widenCd[i] = WIDEN_CD;
    const side = this.enemyGoalSide(this.teamOf(this.ctx.players[i]));
    this.widenT[side] = WIDEN_TIME;
    const col = side === 1 ? '#ff4da6' : '#4DC3FF';
    this.ctx.fx.burst(side === 0 ? -this.X : this.X, 0, col, 18);
    SFX.power();
    if (i === 0) this.ctx.fx.banner('🥅 GOAL WIDE OPEN — shoot!', '#7CF07C');
  }

  // --- tick -------------------------------------------------------------------
  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt; ctx.setClock(this.timeLeft);
    this.hitFx = Math.max(0, this.hitFx - dt);
    for (let i = 0; i < 4; i++) {
      this.smashCd[i] = Math.max(0, this.smashCd[i] - dt);
      this.widenCd[i] = Math.max(0, this.widenCd[i] - dt);
      if (this.stunT[i] > 0) {
        this.stunT[i] -= dt;
        ctx.players[i].group.rotation.y = (1 - Math.max(0, this.stunT[i]) / STUN_TIME) * Math.PI * 4;
        if (this.stunT[i] <= 0) ctx.players[i].group.rotation.y = 0;
      }
    }
    // Widen timers + goal scale animation.
    for (const side of [0, 1]) {
      this.widenT[side] = Math.max(0, this.widenT[side] - dt);
      const g = this.goalGroups[side];
      if (g) { const target = this.widenT[side] > 0 ? WIDEN_MUL : 1; g.scale.z += (target - g.scale.z) * Math.min(1, 8 * dt); }
    }

    if (this.resetT > 0) {
      this.resetT -= dt;
      if (this.resetT <= 0) this.kickoff();
    } else {
      this.moveLocal(dt);
      for (const p of ctx.players.slice(1)) this.moveBot(p, dt);
      this.tickBall(dt);
    }

    for (const p of ctx.players) {
      p.x = this.railX[p.index]; if (this.stunT[p.index] <= 0) p.standFacing = this.teamOf(p) === 0 ? Math.PI / 2 : -Math.PI / 2;
      const dot = this.dots[p.index]; if (dot) dot.position.set(this.railX[p.index], 0.14, p.z);
    }
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
    if (this.stunT[0] > 0) { p.vz = 0; return; }
    const ay = this.ctx.input.ay; // stick up → slide up (−z)
    p.z += ay * MOVE_SPEED * dt;
    p.vz = ay * MOVE_SPEED; p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
  }

  private moveBot(p: Player, dt: number) {
    if (this.stunT[p.index] > 0) { p.vz = 0; return; }
    const lead = this.bz + this.bvz * 0.18;
    const err = (1 - this.ctx.diff.cap) * this.Z * 0.5 * (Math.random() - 0.5);
    const target = lead + err;
    const onMySide = this.teamOf(p) === 0 ? this.bx < 4 : this.bx > -4;
    const spd = MOVE_SPEED * (onMySide ? 1 : 0.65) * (0.7 + this.ctx.diff.cap * 0.4);
    const dz = target - p.z;
    p.z += Math.max(-spd * dt, Math.min(spd * dt, dz));
    p.vz = Math.sign(dz) * Math.min(Math.abs(dz) / dt, spd); p.vx = 0;
    p.z = Math.max(-this.Z + HITBOX_RADIUS, Math.min(this.Z - HITBOX_RADIUS, p.z));
    // Bot SMASH when it's on the ball.
    if (this.smashCd[p.index] <= 0 && Math.hypot(this.bx - p.x, this.bz - p.z) < HITBOX_RADIUS + BALL_R + 3 && Math.random() < (0.6 + this.ctx.diff.cap) * dt) {
      this.doSmash(p.index);
    }
    // Bot WIDEN when the ball is in the team's attacking half (help a team-mate).
    const attacking = this.teamOf(p) === 0 ? this.bx > 2 : this.bx < -2;
    if (this.widenCd[p.index] <= 0 && attacking && Math.random() < 0.5 * dt) this.doWiden(p.index);
  }

  private tickBall(dt: number) {
    this.bx += this.bvx * dt; this.bz += this.bvz * dt;
    if (this.bz > this.Z - BALL_R) { this.bz = this.Z - BALL_R; this.bvz = -Math.abs(this.bvz); SFX.tick(); }
    if (this.bz < -this.Z + BALL_R) { this.bz = -this.Z + BALL_R; this.bvz = Math.abs(this.bvz); SFX.tick(); }
    for (const sx of [-1, 1]) {
      if (sx < 0 ? this.bx < -this.X + BALL_R : this.bx > this.X - BALL_R) {
        const side = sx < 0 ? 0 : 1;
        if (Math.abs(this.bz) < this.effGoalHalf(side)) { this.onGoal(sx < 0 ? 1 : 0); return; }
        this.bx = sx < 0 ? -this.X + BALL_R : this.X - BALL_R; this.bvx = -this.bvx; SFX.bump();
      }
    }
    for (const p of this.ctx.players) {
      if (this.stunT[p.index] > 0) continue;                 // dizzy — can't block
      const dx = this.bx - p.x, dz = this.bz - p.z, d = Math.hypot(dx, dz), min = HITBOX_RADIUS + BALL_R;
      if (d < min && d > 0.001) {
        const nz = dz / d;
        const sp = Math.hypot(this.bvx, this.bvz);
        const dir = this.teamOf(p) === 0 ? 1 : -1;
        this.bx = p.x + dir * (min + 0.4);
        this.bz = p.z + nz * min;
        this.bvx = dir * Math.max(sp * 0.72, BALL_SPEED * 0.85);
        this.bvz = nz * sp * 0.6 + p.vz * 0.5;
        this.hitFx = 0.16; SFX.bump(); this.ctx.fx.burst(this.bx, this.bz, p.hero.col, 6);
      }
    }
    let sp = Math.hypot(this.bvx, this.bvz);
    if (sp < BALL_SPEED) { const k = BALL_SPEED / (sp || 1); this.bvx *= k; this.bvz *= k; }
    else if (sp > BALL_MAX) { const k = BALL_MAX / sp; this.bvx *= k; this.bvz *= k; }
  }

  private onGoal(scorer: number) {
    this.score[scorer]++;
    SFX.win(); this.ctx.fx.shake(2.4); this.ctx.fx.burst(this.bx, this.bz, scorer === 0 ? '#4DC3FF' : '#ff4da6', 26);
    this.ctx.fx.banner(scorer === 0 ? '🔵 BLUE GOAL!' : '🔴 RED GOAL!', scorer === 0 ? '#4DC3FF' : '#ff4da6');
    this.bx = 0; this.bz = 0; this.bvx = 0; this.bvz = 0;
    this.resetT = 1.4;
    this.widenT = [0, 0];
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
      <button id="fbWiden" data-nostick style="pointer-events:auto;position:fixed;right:158px;bottom:30px;">🥅<br>WIDEN</button>
      <button id="fbSmash" data-nostick style="pointer-events:auto;position:fixed;right:18px;bottom:22px;">⚡<br>SMASH</button>`;
    document.body.appendChild(ui);
    const round = 'font-family:Bungee,system-ui,sans-serif;border:none;cursor:pointer;box-shadow:0 6px 0 rgba(0,0,0,.35);touch-action:none;user-select:none;text-align:center;line-height:1.05;border-radius:50%;';
    this.smashBtn = ui.querySelector('#fbSmash')!;
    this.widenBtn = ui.querySelector('#fbWiden')!;
    this.smashBtn.style.cssText += round + 'width:118px;height:118px;font-size:19px;color:#12142e;background:#FFD23F;';
    this.widenBtn.style.cssText += round + 'width:100px;height:100px;font-size:15px;color:#08320f;background:#3bd45a;';
    this.smashBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.doSmash(0); });
    this.widenBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.doWiden(0); });
    this.blueEl = ui.querySelector('#fbBlue .balls')!; this.redEl = ui.querySelector('#fbRed .balls')!;
  }

  private updateUI() {
    const balls = (n: number) => '⚽'.repeat(n) + '·'.repeat(Math.max(0, WIN_GOALS - n));
    if (this.blueEl) this.blueEl.textContent = balls(this.score[0]);
    if (this.redEl) this.redEl.textContent = balls(this.score[1]);
    if (this.smashBtn) {
      const cd = this.smashCd[0];
      this.smashBtn.style.opacity = cd > 0 ? '0.5' : '1';
      this.smashBtn.innerHTML = cd > 0 ? `⚡<br>${Math.ceil(cd)}s` : '⚡<br>SMASH';
    }
    if (this.widenBtn) {
      const cd = this.widenCd[0];
      this.widenBtn.style.opacity = cd > 0 ? '0.5' : '1';
      this.widenBtn.innerHTML = cd > 0 ? `🥅<br>${Math.ceil(cd)}s` : '🥅<br>WIDEN';
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
