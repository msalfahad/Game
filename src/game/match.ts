import * as THREE from 'three';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import { SFX } from '../core/audio';
import { characterVoice } from '../core/voice-barks';
import { Player } from './player';
import { buildWorld } from './world';
import { Hazards } from './hazards';
import { HEROES, type Hero } from '../data/characters';
import { gameById, familyById } from '../data/maps';
import { makeGame } from './games/index';
import { CLIMB_W, CLIMB_L } from './games/climb';
import { victoryWalk } from './victorywalk';
import { DIFFICULTY, type Fx, type GameModule, type MatchContext } from './context';
import * as HUD from '../ui/hud';
import { FAMILY_GRADE } from '../core/postfx';

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

  // Voice-bark edge detection for the local player (players[0]): barks fire on
  // state transitions this frame (ability used, dash started, rival KO'd).
  private vPrevCd = 0;
  private vPrevDash = 0;
  private vPrevDead: boolean[] = [];

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
    hitstop: (s) => this.engine.hitstop(s),
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

    // Ice push + hockey pull back so the FULL arena fits, extra on portrait
    // phones where the rink corners were getting cut off. The chase game uses a
    // steep near-overhead view so the whole yard reads at a glance.
    const portrait = innerWidth < innerHeight;
    if (game.mechanic === 'chase' || game.mechanic === 'maze' || game.mechanic === 'dodgeball' || game.mechanic === 'foosball') this.engine.camera.frameTopDown(halfSize);
    else this.engine.camera.frame(isClimb ? 17 : halfSize, isGoal ? (portrait ? 1.62 : 1.28) : isIce ? 1.18 : game.mechanic === 'hotpotato' ? 1.05 : game.mechanic === 'kart' ? (portrait ? 1.24 : 1.05) : 1.0);

    this.engine.post.setGrade(FAMILY_GRADE[family.id] ?? {});
    this.game.init(this.ctx);
    // Snapshot post-init state so the first loop frame doesn't read a stale
    // cooldown as a fresh ability/dash and fire a spurious bark.
    this.vPrevCd = players[0].cd;
    this.vPrevDash = players[0].dashCd;
    this.vPrevDead = players.map((p) => p.dead);
    HUD.showHud(true);
    HUD.setObjective(this.game.objective);
    this.input.setEnabled(true);
    this.input.setMode(this.game.stickMode);
    this.running = true;
    SFX.unlock();
    SFX.start();
    SFX.playMusic(family.id);
    HUD.banner(game.name + '!', '#' + new THREE.Color(family.theme.trim).getHexString());
    characterVoice.spawn(opts.hero.key).catch(() => {});

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
    this.voiceBarks(you);
    this.tickParts(dt);
  }

  // Per-frame juice + voice barks off local-player state transitions this
  // frame: ability use, dashes, and knockouts get hitstop/shake/burst plus the
  // matching bark. dodge/ability/trash barks are throttled inside
  // characterVoice so rapid events don't stack.
  private voiceBarks(you: Player) {
    if (!this.ctx) return;
    const key = you.hero.key;
    // Ability used: cooldown transitioned from ready to charging.
    if (this.vPrevCd <= 0 && you.cd > 0) {
      characterVoice.ability(key).catch(() => {});
      this.engine.hitstop(0.04);
      this.engine.camera.shake(0.3);
    }
    this.vPrevCd = you.cd;
    // Dodge: a dash just started (dash cooldown began).
    if (this.vPrevDash <= 0 && you.dashCd > 0) characterVoice.dodge(key).catch(() => {});
    this.vPrevDash = you.dashCd;
    // Knockouts this frame: freeze-frame + shake + spark burst. Bigger when
    // it's you; a rival KO while you're alive also fires your trash bark.
    const players = this.ctx.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.dead && !this.vPrevDead[i]) {
        const isYou = i === 0;
        this.engine.hitstop(isYou ? 0.12 : 0.07);
        this.engine.camera.shake(isYou ? 0.9 : 0.55);
        this.spawnBurst(p.x, p.z, isYou ? '#ff5a5a' : '#ffffff', isYou ? 22 : 14);
        if (!isYou && !you.dead) characterVoice.trash(key).catch(() => {});
      }
    }
    this.vPrevDead = players.map((q) => q.dead);
  }

  private finish(ranked: Player[], subtitle: string) {
    if (!this.running) return;
    this.running = false;
    this.engine.stop();
    this.input.setEnabled(false);
    HUD.showHud(false);
    SFX.playMusic('menu');
    const you = ranked.find((p) => p.you)!;
    const youWon = ranked[0] === you;
    if (youWon) {
      characterVoice.victory(you.hero.key).catch(() => {});
      SFX.win();
    } else {
      characterVoice.losing(you.hero.key).catch(() => {});
      SFX.lose();
    }
    // Finishing-order parade before the results screen.
    const isClimb = this.ctx?.game.mechanic === 'climb';
    const isKart = this.ctx?.game.mechanic === 'kart';
    const labels = ranked.map((p) => String((p as any)._res ?? ''));
    victoryWalk(
      this.engine, ranked, labels,
      { z: Math.min(this.ctx?.halfSize ?? 30, 30) * 0.24, follow: isClimb, kart: isKart, laneZ: (this.ctx?.halfSize ?? 30) * 0.62 },
      () => this.onFinish?.(ranked, subtitle, youWon),
    );
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
