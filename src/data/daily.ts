import { GAMES, type GameDef, type Mechanic } from './maps';

// Daily challenge: one game per UTC day, the same for everyone ("win Floor Is
// Lava today"). Completing it extends a day-streak kept on this device. Only
// free-for-all games where first place is a clear "win" are eligible — team
// and role-based modes (2v2, chase, maze) are excluded.

const ELIGIBLE = new Set<Mechanic>([
  'pushout', 'icepush', 'breaktiles', 'throwfight', 'collect', 'paint', 'dodge',
  'lavafloor', 'mash', 'climb', 'goal', 'race', 'hotpotato', 'musicalchairs', 'kart', 'sprint',
]);

const KEY = 'ba-daily';

interface Saved { lastDone: string; streak: number }

const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const today = () => dayStr(new Date());
const yesterday = () => dayStr(new Date(Date.now() - 86400000));

function load(): Saved {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '');
    if (typeof j?.lastDone === 'string' && typeof j?.streak === 'number') return j;
  } catch { /* first run / blocked storage */ }
  return { lastDone: '', streak: 0 };
}

function save(s: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface Daily {
  game: GameDef;
  done: boolean;
  /** Consecutive days completed (0 once a day is missed). */
  streak: number;
}

export function dailyChallenge(): Daily {
  const pool = GAMES.filter((g) => ELIGIBLE.has(g.mechanic));
  const game = pool[hash(today()) % pool.length];
  const s = load();
  const alive = s.lastDone === today() || s.lastDone === yesterday();
  return { game, done: s.lastDone === today(), streak: alive ? s.streak : 0 };
}

/** Call when an offline match ends. Returns whether this result completed today's challenge. */
export function recordDailyResult(gameId: string, won: boolean): { completed: boolean; streak: number } {
  const d = dailyChallenge();
  if (!won || d.done || d.game.id !== gameId) return { completed: false, streak: d.streak };
  const s = load();
  const streak = s.lastDone === yesterday() ? s.streak + 1 : 1;
  save({ lastDone: today(), streak });
  return { completed: true, streak };
}
