// Synthesized SFX (WebAudio), original tones only — a starting point per SPEC
// section 11, to be replaced/expanded with original audio. Every major event
// has a distinct, sub-0.2s-identifiable sound. Mute toggle supported.
//
// Also hosts an original procedural MUSIC layer: a lookahead-scheduled loop of
// bass + arpeggio + soft lead, one mood per arena family. Fully synthesized
// (no external audio, no licensing), ducks under SFX/voice, and honours mute.

interface Mood {
  root: number;
  scale: number[];
  tempo: number;
  wave: OscillatorType;
  lead: OscillatorType;
}

// One mood per arena family id (+ a menu theme). Keys match FamilyDef.id.
const MOODS: Record<string, Mood> = {
  menu: { root: 220.0, scale: [0, 3, 5, 7, 10], tempo: 92, wave: 'triangle', lead: 'sine' },
  frost: { root: 246.94, scale: [0, 2, 3, 7, 9], tempo: 96, wave: 'triangle', lead: 'sine' },
  inferno: { root: 220.0, scale: [0, 3, 5, 6, 10], tempo: 140, wave: 'sawtooth', lead: 'square' },
  dune: { root: 196.0, scale: [0, 2, 4, 7, 9], tempo: 108, wave: 'triangle', lead: 'sine' },
  wildwood: { root: 174.61, scale: [0, 2, 4, 5, 9], tempo: 114, wave: 'triangle', lead: 'sine' },
  sky: { root: 261.63, scale: [0, 2, 4, 7, 9], tempo: 118, wave: 'sine', lead: 'triangle' },
  mech: { root: 164.81, scale: [0, 3, 5, 7, 10], tempo: 136, wave: 'sawtooth', lead: 'square' },
  pirate: { root: 196.0, scale: [0, 2, 3, 7, 8], tempo: 104, wave: 'triangle', lead: 'sine' },
  classic: { root: 233.08, scale: [0, 3, 5, 7, 10], tempo: 128, wave: 'sawtooth', lead: 'square' },
  lab: { root: 220.0, scale: [0, 2, 5, 7, 9], tempo: 110, wave: 'triangle', lead: 'sine' },
};

class AudioEngine {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  // Music-layer state.
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private musicMood: string | null = null;
  private musicStepIdx = 0;
  private musicNextTime = 0;
  private musicVol = 0.2;

  private ctx(): AudioContext {
    if (!this.ac) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ac = new Ctor();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ac.destination);
    }
    if (this.ac.state === 'suspended') this.ac.resume();
    return this.ac;
  }

  /** Call from a user gesture to unlock audio on mobile browsers. */
  unlock() {
    this.ctx();
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0) {
    if (this.muted) return;
    const ac = this.ctx();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    const t0 = ac.currentTime + delay;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g);
    g.connect(this.master!);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, vol: number, fc = 1800, delay = 0) {
    if (this.muted) return;
    const ac = this.ctx();
    const n = ac.sampleRate * dur;
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = ac.createBufferSource();
    s.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = fc;
    const g = ac.createGain();
    g.gain.value = vol;
    s.connect(f);
    f.connect(g);
    g.connect(this.master!);
    s.start(ac.currentTime + delay);
  }

  hit() { this.tone(220, 440, 0.09, 'square', 0.25); this.noise(0.06, 0.2, 2500); }
  bump() { this.tone(120, 60, 0.12, 'triangle', 0.35); this.noise(0.08, 0.3, 900); }
  goal() { this.tone(600, 150, 0.4, 'sawtooth', 0.3); this.noise(0.3, 0.25, 1200); }
  power() { this.tone(200, 900, 0.25, 'sawtooth', 0.3); this.tone(400, 1400, 0.3, 'square', 0.15, 0.05); }
  fall() { this.tone(500, 80, 0.5, 'sine', 0.35); }
  out() { this.tone(300, 80, 0.6, 'square', 0.3); this.noise(0.4, 0.3, 700); }
  tick() { this.tone(1000, 1000, 0.05, 'square', 0.15); }
  gem() { this.tone(880, 1320, 0.12, 'sine', 0.25); this.tone(1320, 1760, 0.1, 'sine', 0.15, 0.06); }
  crack() { this.tone(180, 90, 0.14, 'triangle', 0.3); this.noise(0.12, 0.35, 1500); }
  zap() { this.tone(1600, 120, 0.28, 'sawtooth', 0.32); this.noise(0.22, 0.3, 4000); }
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.18, 'square', 0.25, i * 0.13)); }
  lose() { [400, 350, 300, 200].forEach((f, i) => this.tone(f, f * 0.9, 0.2, 'sawtooth', 0.25, i * 0.15)); }
  start() { this.tone(440, 440, 0.12, 'square', 0.25, 0); this.tone(660, 660, 0.12, 'square', 0.25, 0.4); this.tone(880, 880, 0.3, 'square', 0.3, 0.8); }
  countdown() { this.tone(700, 700, 0.12, 'square', 0.25); }

  // --- Music layer ---------------------------------------------------------

  /** Start, or crossfade to, the procedural music loop for a mood/family id. */
  playMusic(mood: string) {
    const ac = this.ctx();
    const key = MOODS[mood] ? mood : 'menu';
    if (!this.musicGain) {
      this.musicGain = ac.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.master!);
    }
    if (this.musicMood === key && this.musicTimer != null) return;
    this.musicMood = key;
    this.musicStepIdx = 0;
    this.musicNextTime = ac.currentTime + 0.08;
    if (this.musicTimer == null) {
      this.musicTimer = window.setInterval(() => this.scheduleMusic(), 40);
    }
  }

  /** Stop the music loop and fade out. */
  stopMusic() {
    if (this.musicTimer != null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.musicGain && this.ac) this.musicGain.gain.setTargetAtTime(0, this.ac.currentTime, 0.1);
    this.musicMood = null;
  }

  // Lookahead scheduler: schedules ~120ms of notes ahead every 40ms.
  private scheduleMusic() {
    if (!this.ac || !this.musicGain || !this.musicMood) return;
    const ac = this.ac;
    const m = MOODS[this.musicMood] ?? MOODS.menu;
    // Duck to silence while muted but keep the clock running so it resumes.
    this.musicGain.gain.setTargetAtTime(this.muted ? 0 : this.musicVol, ac.currentTime, 0.08);
    const sixteenth = 60 / m.tempo / 4;
    while (this.musicNextTime < ac.currentTime + 0.12) {
      if (!this.muted) this.musicStep(this.musicStepIdx, this.musicNextTime, m);
      this.musicNextTime += sixteenth;
      this.musicStepIdx = (this.musicStepIdx + 1) & 63;
    }
  }

  // One 16th-note step: bass on the beats, arpeggio on off-eighths, soft lead.
  private musicStep(idx: number, t: number, m: Mood) {
    const beat = 60 / m.tempo;
    const bar = (idx >> 4) & 3;
    const s = idx & 15;
    const deg = (d: number, oct: number) => {
      const n = m.scale[((d % m.scale.length) + m.scale.length) % m.scale.length];
      return m.root * Math.pow(2, oct) * Math.pow(2, n / 12);
    };
    if (s === 0) this.musicVoice(deg(0, -1), beat * 0.95, t, m.wave, 0.42);
    else if (s === 8) this.musicVoice(deg(bar & 1 ? 2 : 1, -1), beat * 0.95, t, m.wave, 0.38);
    else if (s === 4 || s === 12) this.musicVoice(deg(4, -1), beat * 0.5, t, m.wave, 0.22);
    if (s % 2 === 0) {
      const arp = [0, 2, 4, 2, 3, 4, 2, 0];
      this.musicVoice(deg(arp[(idx >> 1) % arp.length], 0), beat * 0.4, t, m.lead, 0.12);
    }
    if (s === 0 && (bar === 0 || bar === 2)) this.musicVoice(deg(4, 1), beat * 1.4, t + 0.01, m.lead, 0.07);
  }

  private musicVoice(freq: number, dur: number, t: number, type: OscillatorType, vol: number) {
    if (!this.ac || !this.musicGain) return;
    const ac = this.ac;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.connect(g);
    g.connect(this.musicGain);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

export const SFX = new AudioEngine();
