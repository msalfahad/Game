import * as THREE from 'three';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import { SFX } from '../core/audio';
import { Player } from './player';
import { buildWorld } from './world';
import { Hazards } from './hazards';
import { HEROES, type Hero } from '../data/characters';
import { gameById, familyById } from '../data/maps';
import { makeGame } from './games/index';
import { CLIMB_W, CLIMB_L } from './games/climb';
import { DIFFICULTY, type Fx, type GameModule, type MatchContext } from './context';
import * as HUD from '../ui/hud';

const ASBASE = 30;

interface StartOpts {
  hero: Hero;
  diff: keyof typeof DIFFICULTY;
  gameId: string;
  onFinish: (ranked: Player[], subtitle: string, youWon: boolean) => void;
}

// Orchestrates a single match: resolves the catalog entry, builds the themed
// world + hazards + roster + mechanic module, runs the loop, and hands the
// ranking to the results screen.
export class Match {
  private engine: Engine;
  input: Input;
  private running = false;
  private game: GameModule | null = null;
  private ctx: MatchContext | null = null;
  private parts: { m: THREE.Mesh; vx: number; vy: number; vz: number; life: number }[] = [];
  private onFinish: StartOpts['onFinish'] | null = null;

  constructor(engine: Engine, input: Input) {
    this.engine = engine;
    this.input = input;
  }

  setShakeScale(s: number) {
    this.engine.camera.setShakeScale(s);
  }
  setQuality(t: 'low' | 'medium' | 'high' | 'ultra') {
    this.engine.setQuality(t);
  }

  private fx: Fx = {
    banner: (t, c) => HUD.banner(t, c),
    shake: (a) => this.engine.camera.shake(a),
    burst: (x, z, col, n = 16) => this.spawnBurst(x, z, col, n),
  };

  private spawnBurst(x: number, z: number, col: string, n: number) {
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
      const s = Math.max(p.life, 0.01);
      p.m.scale.set(s, s, s);
      return true;
    });
  }

  start(opts: StartOpts) {
    this.stop();
    this.onFinish = opts.onFinish;
    const game = gameById(opts.gameId);
    const family = familyById(game.familyId);
    this.game = makeGame(game);
    const isGoal = game.mechanic === 'goal';
    // Ice push plays on a small round rink; the climb is a long narrow slope.
    const isClimb = game.mechanic === 'climb';
    const isIce = game.mechanic === 'icepush';
    const halfSize = isGoal ? ASBASE * 0.48 : isIce ? ASBASE * 0.7 : isClimb ? CLIMB_L : ASBASE;

    this.engine.clearScene();
    this.parts = [];
    const world = buildWorld(this.engine.scene, family, game, halfSize, isClimb ? { w: CLIMB_W, l: CLIMB_L } : undefined);
    const hazards = new Hazards(this.engine.scene, game, family, halfSize, this.fx);

    // Roster: local hero + three distinct random rivals (FFA).
    const rivals = HEROES.filter((h) => h.key !== opts.hero.key);
    for (let i = rivals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rivals[i], rivals[j]] = [rivals[j], rivals[i]];
    }
    const roster: Hero[] = [opts.hero, rivals[0], rivals[1], rivals[2]];
    const sides = ['bottom', 'top', 'left', 'right'] as const;
    const players = roster.map((h, i) => {
      const p = new Player(h, i === 0, i, i as 0 | 1);
      p.side = sides[i];
      return p;
    });

    this.ctx = {
      scene: this.engine.scene,
      camera: this.engine.camera,
      world,
      hazards,
      game,
      family,
      players,
      decoys: [],
      input: this.input,
      diff: DIFFICULTY[opts.diff],
      fx: this.fx,
      halfSize,
      setObjective: HUD.setObjective,
      setScore: HUD.setScore,
      setClock: HUD.setClock,
      finish: (ranked, subtitle) => this.finish(ranked, subtitle),
    };

    // Ice push pulls back a touch so the FULL circular rink fits on phones.
    this.engine.camera.frame(isClimb ? 17 : halfSize, isGoal ? 1.28 : isIce ? 1.18 : 1.0);

    this.game.init(this.ctx);
    HUD.showHud(true);
    HUD.setObjective(this.game.objective);
    this.input.setEnabled(true);
    this.input.setMode(this.game.stickMode);
    this.running = true;
    SFX.unlock();
    SFX.start();
    HUD.banner(game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());

    this.engine.start((dt, elapsed) => this.loop(dt, elapsed));
  }

  private loop(dt: number, elapsed: number) {
    if (!this.running || !this.game || !this.ctx) return;
    this.input.pollGamepad();

    if (this.input.takeAbility()) this.game.ability();
    if (this.input.takeJump() && this.game.jump) this.game.jump();

    const you = this.ctx.players[0];
    HUD.setAbilityHint(you.armed ? 'armed' : you.cd <= 0 ? 'ready' : '');

    this.game.tick(dt, elapsed);
    this.ctx.world.tick(dt);
    this.tickParts(dt);
  }

  private finish(ranked: Player[], subtitle: string) {
    if (!this.running) return;
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    const you = ranked.find((p) => p.you)!;
    const youWon = ranked[0] === you;
    if (youWon) SFX.win();
    else SFX.lose();
    this.onFinish?.(ranked, subtitle, youWon);
  }

  stop() {
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    if (this.ctx) {
      for (const d of this.ctx.decoys) this.engine.scene.remove(d.sprite);
      this.ctx.decoys = [];
    }
  }
}
