import { Engine } from './core/engine';
import { Input } from './core/input';
import { SFX } from './core/audio';
import { Match } from './game/match';
import { HockeyGame } from './game/games/hockey';
import { SurfaceLabGame } from './game/games/surfacelab';
import type { GameModule } from './game/context';
import { buildScreens, show, hideScreens, showResults, type Selection } from './ui/screens';

// Boot: build the engine + input + match controller, wire the screen flow, and
// show the title. Each "start" tears down the previous match and runs the
// chosen game module on the chosen map.

const engine = new Engine();
const input = new Input();
const match = new Match(engine, input);

function makeGame(sel: Selection): () => GameModule {
  return sel.gameId === 'hockey' ? () => new HockeyGame() : () => new SurfaceLabGame();
}

buildScreens({
  onStart: (sel) => {
    hideScreens();
    match.start({
      hero: sel.hero,
      diff: sel.diff,
      mapId: sel.mapId,
      makeGame: makeGame(sel),
      onFinish: (ranked, subtitle, youWon) => showResults(ranked, subtitle, youWon),
    });
  },
  onShakeChange: (v) => match.setShakeScale(v),
  onQualityChange: (t) => match.setQuality(t),
});

// Mute toggle.
const muteBtn = document.getElementById('mute')!;
muteBtn.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  SFX.muted = !SFX.muted;
  muteBtn.textContent = SFX.muted ? '🔇' : '🔊';
});

document.getElementById('loading')!.style.display = 'none';
show('scrTitle');
