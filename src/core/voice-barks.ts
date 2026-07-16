/**
 * Character voice barks — recorded audio for character reactions and callouts.
 * Plays alongside synthesized SFX. Falls back to SFX tones if audio unavailable.
 */

import { SFX } from './audio';

interface VoiceBarkCache {
  audio: HTMLAudioElement;
  ready: boolean;
}

const barkCache: Record<string, VoiceBarkCache> = {};

/**
 * Load and cache a voice bark URL.
 */
export async function loadVoiceBark(url: string): Promise<HTMLAudioElement> {
  if (barkCache[url]?.ready) return barkCache[url].audio;

  const audio = new Audio(url);
  audio.preload = 'auto';
  barkCache[url] = { audio, ready: false };

  return new Promise((resolve, reject) => {
    audio.oncanplaythrough = () => {
      barkCache[url].ready = true;
      resolve(audio);
    };
    audio.onerror = reject;
    audio.load();
  });
}

/**
 * Play a character voice bark. Falls back to SFX tone if loading fails.
 */
export async function playVoiceBark(
  url: string,
  fallbackSfx: () => void,
  volume: number = 0.8,
): Promise<void> {
  try {
    const audio = await loadVoiceBark(url);
    audio.volume = volume;
    audio.currentTime = 0;
    audio.play().catch(() => fallbackSfx());
  } catch {
    fallbackSfx();
  }
}

// A voice bark should never talk over itself. Barks for the same character are
// throttled so rapid-fire events (dashes, chained KOs) don't stack into a
// garbled mess.
let lastBarkAt = 0;
const MIN_BARK_GAP_MS = 900;

function throttled(): boolean {
  const now = performance.now();
  if (now - lastBarkAt < MIN_BARK_GAP_MS) return true;
  lastBarkAt = now;
  return false;
}

/**
 * Character-specific voice bark triggers. Six lines per hero, matching the
 * files delivered to `public/audio/voices/<key>-<line>.wav`
 * (spawn, victory, losing, dodge, ability, trash). Missing files fall back to
 * the synth SFX tone, so partial delivery is always safe.
 */
export const characterVoice = {
  /** Spawn/ready — energetic opening shout. */
  async spawn(characterKey: string) {
    await playVoiceBark(`audio/voices/${characterKey}-spawn.wav`, () => SFX.start(), 0.75);
  },

  /** Victory — celebratory gloat. */
  async victory(characterKey: string) {
    await playVoiceBark(`audio/voices/${characterKey}-victory.wav`, () => SFX.win(), 0.85);
  },

  /** Losing — knocked out / lost the match. */
  async losing(characterKey: string) {
    await playVoiceBark(`audio/voices/${characterKey}-losing.wav`, () => SFX.lose(), 0.8);
  },

  /** Dodge — dashed away / near miss. Throttled. */
  async dodge(characterKey: string) {
    if (throttled()) return;
    await playVoiceBark(`audio/voices/${characterKey}-dodge.wav`, () => SFX.tick(), 0.7);
  },

  /** Ability — ultimate / signature move activation. Throttled. */
  async ability(characterKey: string) {
    if (throttled()) return;
    await playVoiceBark(`audio/voices/${characterKey}-ability.wav`, () => SFX.zap(), 0.85);
  },

  /** Trash talk — landed a KO on a rival. Throttled. */
  async trash(characterKey: string) {
    if (throttled()) return;
    await playVoiceBark(`audio/voices/${characterKey}-trash.wav`, () => SFX.power(), 0.8);
  },
};
