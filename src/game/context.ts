import type * as THREE from 'three';
import type { Player } from './player';
import type { World } from './world';
import type { MapDef } from '../data/maps';
import type { Input } from '../core/input';
import type { IsoCamera } from '../core/camera';
import type { Hazards } from './hazards';

// Visual/feedback helpers a game or hazard can call without knowing about the
// match plumbing.
export interface Fx {
  banner(text: string, col?: string): void;
  shake(amount: number): void;
  burst(x: number, z: number, col: string, n?: number): void;
}

// Difficulty knobs shared by every bot (SPEC section 13). `cap` limits bot top
// speed, `err` is aim error, `lapse` is reaction delay.
export interface DiffParams {
  cap: number;
  err: number;
  lapse: number;
}

export const DIFFICULTY: Record<string, DiffParams> = {
  easy: { cap: 0.5, err: 0.3, lapse: 0.6 },
  normal: { cap: 0.66, err: 0.18, lapse: 0.38 },
  hard: { cap: 0.82, err: 0.08, lapse: 0.18 },
  expert: { cap: 0.95, err: 0.03, lapse: 0.08 },
};

// Everything a game module needs from the match.
export interface MatchContext {
  scene: THREE.Scene;
  camera: IsoCamera;
  world: World;
  hazards: Hazards;
  map: MapDef;
  players: Player[];
  input: Input;
  diff: DiffParams;
  fx: Fx;
  halfSize: number;
  setObjective: (text: string) => void;
  setScore: (p: Player, text: string | number) => void;
  setClock: (secondsLeft: number) => void;
  finish: (ranked: Player[], subtitle: string) => void;
}

// A mini-game plugs into the match via this interface.
export interface GameModule {
  readonly title: string;
  readonly objective: string;
  /** Stick control style: 'hidden' = 1:1 drag (hockey), 'float' = analog. */
  readonly stickMode: 'hidden' | 'float';
  init(ctx: MatchContext): void;
  tick(dt: number, elapsed: number): void;
  ability(): void; // local player's ability / ultimate
  jump?(): void;
}
