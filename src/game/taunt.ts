import { characterVoice } from '../core/voice-barks';
import { linesFor } from '../data/taunts';
import * as HUD from '../ui/hud';
import type { Player } from './player';

/**
 * Someone just got knocked out (or lost a life): a hero gloats in a speech
 * bubble. If YOU were knocked out, a random surviving rival rubs it in; if a
 * rival was, YOU gloat (with your voice bark). Returns true when it was the
 * local player's own knockout, so callers can scale the slow-mo.
 */
export function koTaunt(victim: Player, players: Player[]): boolean {
  const you = players.find((p) => p.you);
  if (!you) return false;
  if (victim.you) {
    const rivals = players.filter((q) => q !== you && !q.dead);
    const r = rivals[Math.floor(Math.random() * rivals.length)];
    if (r) HUD.taunt(r.hero.name, linesFor(r.hero.key).trash, r.hero.col);
    return true;
  }
  if (!you.dead) {
    characterVoice.trash(you.hero.key).catch(() => {});
    HUD.taunt(you.hero.name, linesFor(you.hero.key).trash, you.hero.col);
  }
  return false;
}
