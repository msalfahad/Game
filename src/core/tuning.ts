// Live tuning knobs (the "adjust it before the app store" panel).
// Values persist to localStorage and are read by the game systems at match
// start (and some continuously). 1.0 = designed default everywhere.

export interface Tuning {
  timeScale: number; // match length multiplier (0.5 .. 1.5)
  hazardScale: number; // hazard spawn intensity (0 .. 2)
  powerupScale: number; // power-up spawn rate (0 .. 2)
  speedScale: number; // player move speed (0.8 .. 1.3)
  botScale: number; // extra bot skill multiplier on top of difficulty (0.5 .. 1.3)
}

const KEY = 'bash-arena-tuning';

export const TUNING: Tuning = {
  timeScale: 1,
  hazardScale: 1,
  powerupScale: 1,
  speedScale: 1,
  botScale: 1,
};

export function loadTuning() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(TUNING, JSON.parse(raw));
  } catch {
    /* ignore */
  }
}

export function saveTuning() {
  try {
    localStorage.setItem(KEY, JSON.stringify(TUNING));
  } catch {
    /* ignore */
  }
}

export function resetTuning() {
  TUNING.timeScale = 1;
  TUNING.hazardScale = 1;
  TUNING.powerupScale = 1;
  TUNING.speedScale = 1;
  TUNING.botScale = 1;
  saveTuning();
}

/** Match length helper: base seconds scaled by the tuning panel. */
export function matchTime(base: number): number {
  return Math.round(base * TUNING.timeScale);
}
