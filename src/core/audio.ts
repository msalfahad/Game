// Synthesized SFX (WebAudio), original tones only — a starting point per SPEC
// section 11, to be replaced/expanded with original audio. Every major event
// has a distinct, sub-0.2s-identifiable sound. Mute toggle supported.

class AudioEngine {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

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
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.18, 'square', 0.25, i * 0.13)); }
  lose() { [400, 350, 300, 200].forEach((f, i) => this.tone(f, f * 0.9, 0.2, 'sawtooth', 0.25, i * 0.15)); }
  start() { this.tone(440, 440, 0.12, 'square', 0.25, 0); this.tone(660, 660, 0.12, 'square', 0.25, 0.4); this.tone(880, 880, 0.3, 'square', 0.3, 0.8); }
  countdown() { this.tone(700, 700, 0.12, 'square', 0.25); }
}

export const SFX = new AudioEngine();
