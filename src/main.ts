import { Engine } from './core/engine';
import { Input } from './core/input';
import { SFX } from './core/audio';
import { loadTuning } from './core/tuning';
import { Match } from './game/match';
import { buildScreens, show, hideScreens, showResults } from './ui/screens';
import { buildOnlineScreens, enterOnline, showOnlineResults } from './ui/online';
import { OnlineMatch } from './net/onlinematch';
import { OnlineHockey } from './net/onlinehockey';
import { OnlineFreeRoam } from './net/onlinefreeroam';
import { gameById, familyById } from './data/maps';

// Boot: engine + input + match controller, screen flow, tuning, title.

loadTuning();

const engine = new Engine();
const input = new Input();
const match = new Match(engine, input);

buildScreens({
  onStart: (sel) => {
    hideScreens();
    match.start({
      hero: sel.hero,
      diff: sel.diff,
      gameId: sel.gameId,
      onFinish: (ranked, subtitle, youWon) => showResults(ranked, subtitle, youWon),
    });
  },
  onShakeChange: (v) => match.setShakeScale(v),
  onQualityChange: (t) => match.setQuality(t),
});

// Online play: sign in once, then quick play or party rooms. The controller
// is picked by the mechanic of the server-chosen game.
let online: OnlineMatch | OnlineHockey | OnlineFreeRoam | null = null;
buildOnlineScreens({
  onMatchStart: (m) => {
    match.stop();
    online?.stop();
    const done = (end: Parameters<typeof showOnlineResults>[0], youSlot: number) => {
      SFX.playMusic('menu');
      showOnlineResults(end, youSlot);
    };
    SFX.playMusic(familyById(gameById(m.gameId).familyId).id);
    const mech = gameById(m.gameId).mechanic;
    online =
      mech === 'goal' ? new OnlineHockey(engine, input, done)
      : mech === 'pushout' ? new OnlineMatch(engine, input, done)
      : new OnlineFreeRoam(engine, input, done);
    online.start(m);
  },
});
document.getElementById('onlineBtn')!.addEventListener('click', () => enterOnline());

// Mute toggle.
// In-game speaker button = master (all sound) mute. Persists + syncs the title
// toggles so the two never disagree.
const muteBtn = document.getElementById('mute')!;
SFX.muted = localStorage.getItem('muteAll') === '1';
muteBtn.textContent = SFX.muted ? '🔇' : '🔊';
muteBtn.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  SFX.muted = !SFX.muted;
  localStorage.setItem('muteAll', SFX.muted ? '1' : '0');
  muteBtn.textContent = SFX.muted ? '🔇' : '🔊';
  (globalThis as any).__refreshAudioUI?.();
});

// Kick off the menu theme on the first user interaction (also unlocks audio on
// mobile). Match/online start switches to the arena mood; results return here.
addEventListener('pointerdown', () => SFX.playMusic('menu'), { once: true });

document.getElementById('loading')!.style.display = 'none';
show('scrTitle');
