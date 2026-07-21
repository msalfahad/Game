import { Engine } from './core/engine';
import { Input } from './core/input';
import { SFX } from './core/audio';
import { loadTuning } from './core/tuning';
import { Match } from './game/match';
import { buildScreens, show, hideScreens, showResults } from './ui/screens';
import { buildOnlineScreens, enterOnline } from './ui/online';
import { OnlineMatch } from './net/onlinematch';
import { OnlineHockey } from './net/onlinehockey';
import { OnlineFreeRoam } from './net/onlinefreeroam';
import { net } from './net/client';
import { gameById, familyById } from './data/maps';
import { startFpsMeter } from './ui/fps';

// Boot: engine + input + match controller, screen flow, tuning, title.

loadTuning();
startFpsMeter();

const engine = new Engine();
const input = new Input();
const match = new Match(engine, input);

// In-match tracking so the ✕ button and the phone back button can bail out to
// the menu (a match has no screen of its own to navigate away from).
let inMatch = false;
let matchKind: 'offline' | 'online' = 'offline';
function enterMatch(kind: 'offline' | 'online') {
  inMatch = true;
  matchKind = kind;
  // Push a history entry so the browser/phone BACK button pops back to the menu
  // instead of leaving the site.
  history.pushState({ inMatch: true }, '');
}
function quitToMenu() {
  if (!inMatch) return;
  inMatch = false;
  match.stop();
  online?.stop();
  SFX.playMusic('menu');
  if (matchKind === 'online') { net.leaveSeries(); enterOnline(); }
  else show('scrTitle');
}

buildScreens({
  onStart: (sel) => {
    hideScreens();
    enterMatch('offline');
    match.start({
      hero: sel.hero,
      diff: sel.diff,
      gameId: sel.gameId,
      onFinish: (ranked, subtitle, youWon) => { inMatch = false; showResults(ranked, subtitle, youWon); },
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
    enterMatch('online');
    // In a series the per-game result is driven by the server (series screens),
    // so the controller's finish callback just marks the game over.
    const done = () => { inMatch = false; };
    SFX.playMusic(familyById(gameById(m.gameId).familyId).id);
    const mech = gameById(m.gameId).mechanic;
    online =
      mech === 'goal' ? new OnlineHockey(engine, input, done)
      : mech === 'pushout' ? new OnlineMatch(engine, input, done)
      : new OnlineFreeRoam(engine, input, done);
    online.start(m);
  },
  // Halt the 3D controller between games / when leaving a series.
  stopMatch: () => { online?.stop(); online = null; inMatch = false; },
});
document.getElementById('onlineBtn')!.addEventListener('click', () => enterOnline());

// ✕ quit button (shown during matches) + the browser/phone BACK button both
// bail the current match back to the menu.
document.getElementById('quit')!.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  if (inMatch) history.back(); // pops the pushed state → popstate → quitToMenu
});
addEventListener('popstate', () => { if (inMatch) quitToMenu(); });

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
// mobile — prime iOS output synchronously in the gesture BEFORE scheduling).
addEventListener('pointerdown', () => { SFX.unlock(); SFX.playMusic('menu'); }, { once: true });

document.getElementById('loading')!.style.display = 'none';
show('scrTitle');
