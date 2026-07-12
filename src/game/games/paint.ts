import * as THREE from 'three';
import type { GameModule, MatchContext } from '../context';
import { setupRoster, localMove, botMove, collidePlayers, tickRoster, localJump, rankBy } from '../freeroam';
import { matchTime } from '../../core/tuning';
import { SFX } from '../../core/audio';
import { setScore } from '../../ui/hud';

// PAINT — claim floor tiles in your color; most tiles when the clock ends
// (Paint Panic). Ability = paint bomb: claims a 3x3 splash around you.

const PN = 9;

interface PTile { m: THREE.Mesh; owner: number; }

export class PaintGame implements GameModule {
  readonly stickMode = 'float' as const;
  title = 'Paint Panic';
  objective = 'Claim tiles in your color · most tiles wins';

  private ctx!: MatchContext;
  private tiles: PTile[] = [];
  private timeLeft = 60;
  private finished = false;

  init(ctx: MatchContext) {
    this.ctx = ctx;
    this.title = ctx.game.name;
    this.finished = false;
    this.timeLeft = matchTime(60);
    this.tiles = [];
    const half = ctx.halfSize;
    const step = (half * 2) / PN;
    ctx.world.floorMesh.visible = false;
    for (let gy = 0; gy < PN; gy++) {
      for (let gx = 0; gx < PN; gx++) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(step * 0.94, 0.6, step * 0.94),
          new THREE.MeshStandardMaterial({ color: 0x333a5c, roughness: 0.8 }),
        );
        m.position.set(-half + step * (gx + 0.5), 0.3, -half + step * (gy + 0.5));
        m.receiveShadow = true;
        ctx.scene.add(m);
        this.tiles.push({ m, owner: -1 });
      }
    }
    setupRoster(ctx, 0, 0.5);
  }

  private idxAt(x: number, z: number): number {
    const half = this.ctx.halfSize;
    const step = (half * 2) / PN;
    const gx = Math.floor((x + half) / step);
    const gy = Math.floor((z + half) / step);
    return gx >= 0 && gy >= 0 && gx < PN && gy < PN ? gy * PN + gx : -1;
  }

  private claim(idx: number, pi: number): boolean {
    if (idx < 0 || this.tiles[idx].owner === pi) return false;
    this.tiles[idx].owner = pi;
    const mat = this.tiles[idx].m.material as THREE.MeshStandardMaterial;
    mat.color.setStyle(this.ctx.players[pi].hero.col);
    mat.emissive.setStyle(this.ctx.players[pi].hero.col);
    mat.emissiveIntensity = 0.25;
    return true;
  }

  private bomb(pi: number) {
    const p = this.ctx.players[pi];
    if (p.cd > 0 || p.dead) return;
    p.cd = 8;
    const half = this.ctx.halfSize;
    const step = (half * 2) / PN;
    const gx = Math.floor((p.x + half) / step);
    const gy = Math.floor((p.z + half) / step);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (gx + dx >= 0 && gx + dx < PN && gy + dy >= 0 && gy + dy < PN) {
          this.claim((gy + dy) * PN + (gx + dx), pi);
        }
      }
    }
    SFX.power();
    this.ctx.fx.burst(p.x, p.z, p.hero.col, 24);
    this.ctx.fx.shake(1.5);
    this.ctx.fx.banner(p.you ? 'PAINT BOMB!' : '', p.hero.col);
  }

  ability() {
    this.bomb(0);
  }
  jump() {
    localJump(this.ctx);
  }

  tick(dt: number, elapsed: number) {
    if (this.finished) return;
    const ctx = this.ctx;
    this.timeLeft -= dt;
    ctx.setClock(this.timeLeft);
    if (this.timeLeft <= 0) return this.doFinish();

    localMove(ctx, dt);
    for (const p of ctx.players.slice(1)) {
      const pi = ctx.players.indexOf(p);
      p.retarget -= dt;
      if (p.retarget <= 0) {
        p.retarget = ctx.diff.lapse * 1.3 + Math.random() * ctx.diff.lapse;
        // Seek unowned/opponent tiles.
        let bx = 0, bz = 0, tries = 0;
        do {
          bx = (Math.random() - 0.5) * ctx.halfSize * 1.8;
          bz = (Math.random() - 0.5) * ctx.halfSize * 1.8;
          tries++;
        } while (tries < 8 && this.tiles[this.idxAt(bx, bz)]?.owner === pi);
        p.tx = bx;
        p.tz = bz;
        if (ctx.diff.cap > 0.55 && p.cd <= 0 && Math.random() < 0.2) this.bomb(pi);
      }
      botMove(ctx, p, p.tx, p.tz, dt);
    }
    collidePlayers(ctx);

    ctx.players.forEach((p, pi) => {
      if (this.claim(this.idxAt(p.x, p.z), pi)) SFX.tick();
    });
    ctx.players.forEach((p, pi) => setScore(p, this.tiles.filter((t) => t.owner === pi).length));

    tickRoster(ctx, dt, elapsed);
  }

  private doFinish() {
    if (this.finished) return;
    this.finished = true;
    const counts = this.ctx.players.map((_, pi) => this.tiles.filter((t) => t.owner === pi).length);
    this.ctx.players.forEach((p, pi) => ((p as any)._res = counts[pi] + ' tiles'));
    this.ctx.finish(rankBy(this.ctx, (p) => counts[this.ctx.players.indexOf(p)]), 'Most tiles painted wins.');
  }
}
