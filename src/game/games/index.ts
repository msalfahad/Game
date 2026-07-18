import type { GameDef } from '../../data/maps';
import type { GameModule } from '../context';
import { HockeyGame } from './hockey';
import { IcePushGame } from './icepush';
import { ClimbGame } from './climb';
import { BreakTilesGame } from './breaktiles';
import { PushoutGame } from './pushout';
import { ThrowFightGame } from './throwfight';
import { RaceGame } from './race';
import { DodgeGame } from './dodge';
import { CollectGame } from './collect';
import { PaintGame } from './paint';
import { MashGame } from './mash';
import { MusicalChairsGame } from './musicalchairs';
import { ChaseGame } from './chase';
import { HotPotatoGame } from './hotpotato';
import { KartGame } from './kart';
import { MazeGame } from './maze';
import { LavaFloorGame } from './lavafloor';
import { SurfaceLabGame } from './surfacelab';

// Mechanic factory: every entry in the catalog resolves to one of these
// modules, flavored by the game's family theme + mods.
export function makeGame(def: GameDef): GameModule {
  switch (def.mechanic) {
    case 'goal': return new HockeyGame();
    case 'icepush': return new IcePushGame();
    case 'climb': return new ClimbGame();
    case 'breaktiles': return new BreakTilesGame();
    case 'pushout': return new PushoutGame();
    case 'throwfight': return new ThrowFightGame();
    case 'race': return new RaceGame();
    case 'dodge': return new DodgeGame();
    case 'collect': return new CollectGame();
    case 'paint': return new PaintGame();
    case 'mash': return new MashGame();
    case 'musicalchairs': return new MusicalChairsGame();
    case 'chase': return new ChaseGame();
    case 'hotpotato': return new HotPotatoGame();
    case 'kart': return new KartGame();
    case 'maze': return new MazeGame();
    case 'lavafloor': return new LavaFloorGame();
    case 'lab': return new SurfaceLabGame();
  }
}
