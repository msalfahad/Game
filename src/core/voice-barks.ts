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

/**
 * Character-specific voice bark triggers.
 */
export const characterVoice = {
  /**
   * Spawn/ready — energetic opening.
   */
  async spawn(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-spawn.wav`,
      () => SFX.tick(),
      0.7,
    );
  },

  /**
   * Ability charged — alert/ready.
   */
  async abilityCharged(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-ability-charged.wav`,
      () => SFX.power(),
      0.8,
    );
  },

  /**
   * Hit/flinch — pain/reaction.
   */
  async hit(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-hit.wav`,
      () => SFX.hit(),
      0.6,
    );
  },

  /**
   * Victory — celebratory.
   */
  async victory(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-victory.wav`,
      () => SFX.win(),
      0.8,
    );
  },

  /**
   * Taunt — competitive/aggressive.
   */
  async taunt(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-taunt.wav`,
      () => SFX.power(),
      0.7,
    );
  },

  /**
   * Revival — comeback/determination.
   */
  async revival(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-revival.wav`,
      () => SFX.tick(),
      0.75,
    );
  },

  /**
   * Ability use — activation callout.
   */
  async abilityUse(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-ability-use.wav`,
      () => SFX.zap(),
      0.8,
    );
  },

  /**
   * Round win — match result.
   */
  async roundWin(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-round-win.wav`,
      () => SFX.win(),
      0.8,
    );
  },

  /**
   * Surprise/reaction — unexpected.
   */
  async surprise(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-surprise.wav`,
      () => SFX.tick(),
      0.7,
    );
  },

  /**
   * Climax — final match moment.
   */
  async climax(characterKey: string) {
    await playVoiceBark(
      `audio/voices/${characterKey}-climax.wav`,
      () => SFX.win(),
      0.85,
    );
  },
};
