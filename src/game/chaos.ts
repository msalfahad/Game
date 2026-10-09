import type { Engine } from '../core/engine';
import type { Mechanic } from '../data/maps';
import * as HUD from '../ui/hud';
import { SFX } from '../core/audio';
import type { Player } from './player';

// Chaos events: every so often the whole match gets thrown a curveball so no
// two rounds play the same. They reuse existing status effects (speed shoes,
// giant) and the engine's slow-mo, so they behave consistently everywhere.
// Only enabled in the free-roaming brawl modes — races, hockey and 2v2 games
// have bespoke controls that these would break.

const CHAOS_MECHANICS = new Set<Mechanic>([
  'pushout', 'icepush', 'breaktiles', 'throwfight', 'collect', 'paint', 'dodge', 'lavafloor',
]);

interface ChaosEvent {
  name: string;
  col: string;
  apply: (players: Player[], engine: Engine) => void;
}

const EVENTS: ChaosEvent[] = [
  {
    name: '⚡ SPEED RUSH!',
    col: '#FFD23F',
    apply: (ps) => ps.forEach((p) => { if (!p.dead) p.shoesT = Math.max(p.shoesT, 7); }),
  },
  {
    name: '🦣 GIANT MODE!',
    col: '#FF5C8A',
    apply: (ps) => ps.forEach((p) => { if (!p.dead) p.giantT = Math.max(p.giantT, 8); }),
  },
  {
    name: '🐌 SLOW-MO!',
    col: '#4DC3FF',
    apply: (_ps, engine) => engine.slowmo(0.5, 4.5),
  },
];

const FIRST_AT = [14, 20]; // seconds into the match
const GAP = [18, 26];
const MAX_EVENTS = 3;

const rand = ([a, b]: number[]) => a + Math.random() * (b - a);

export class Chaos {
  private t = 0;
  private next = rand(FIRST_AT);
  private fired = 0;
  private last = -1;

  static supports(mechanic: Mechanic): boolean {
    return CHAOS_MECHANICS.has(mechanic);
  }

  tick(dt: number, players: Player[], engine: Engine) {
    if (this.fired >= MAX_EVENTS) return;
    this.t += dt;
    if (this.t < this.next) return;
    // Never repeat the same event twice in a row.
    let i = Math.floor(Math.random() * EVENTS.length);
    if (i === this.last) i = (i + 1) % EVENTS.length;
    this.last = i;
    const ev = EVENTS[i];
    ev.apply(players, engine);
    HUD.banner(ev.name, ev.col, 1800);
    SFX.power();
    engine.camera.shake(0.4);
    this.fired++;
    this.next = this.t + rand(GAP);
  }
}
