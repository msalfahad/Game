import { SFX } from './audio';

// Unified input (SPEC section 9). Produces a movement axis in [-1,1]^2, an
// "ability" edge trigger, and a jump edge trigger, from three sources:
//   - Keyboard (WASD/arrows, space=ability, shift=jump)
//   - Gamepad (left stick + face buttons), polled each frame
//   - Touch: floating PS4-style analog that fades in under the thumb, OR a
//     hidden 1:1 direct-drag mode for 1-axis games like hockey.
// Tap on the right side of the screen = ability.

export type StickMode = 'float' | 'hidden' | 'none';

export class Input {
  ax = 0; // -1..1 horizontal
  ay = 0; // -1..1 vertical (screen down = +, maps to +z toward camera)
  hockeyDX = 0; // accumulated 1:1 drag delta for hidden mode

  private abilityQueued = false;
  private jumpQueued = false;
  private enabled = false;
  private mode: StickMode = 'float';

  private keys = { left: 0, right: 0, up: 0, down: 0 };
  private prevGpAbility = false;
  private prevGpJump = false;

  private stick = { id: null as number | null, ox: 0, oy: 0, lastX: 0 };
  private base: HTMLElement;
  private knob: HTMLElement;

  constructor() {
    this.base = document.getElementById('stickBase')!;
    this.knob = document.getElementById('stickKnob')!;

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('touchstart', this.onTouchStart, { passive: false });
    addEventListener('touchmove', this.onTouchMove, { passive: false });
    addEventListener('touchend', this.onTouchEnd, { passive: false });
    addEventListener('touchcancel', this.onTouchEnd, { passive: false });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.ax = 0;
    this.ay = 0;
    this.hockeyDX = 0;
    this.stick.id = null;
    if (!on) this.hideStick();
  }

  setMode(mode: StickMode) {
    this.mode = mode;
    this.hideStick();
  }

  /** Consume the ability trigger (true once per press). */
  takeAbility(): boolean {
    const v = this.abilityQueued;
    this.abilityQueued = false;
    return v;
  }
  takeJump(): boolean {
    const v = this.jumpQueued;
    this.jumpQueued = false;
    return v;
  }

  // --- Keyboard -------------------------------------------------------------
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') this.keys.left = 1;
    if (e.key === 'ArrowRight' || e.key === 'd') this.keys.right = 1;
    if (e.key === 'ArrowUp' || e.key === 'w') this.keys.up = 1;
    if (e.key === 'ArrowDown' || e.key === 's') this.keys.down = 1;
    if (e.key === ' ') this.abilityQueued = true;
    if (e.key === 'Shift') this.jumpQueued = true;
    this.applyKeys();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') this.keys.left = 0;
    if (e.key === 'ArrowRight' || e.key === 'd') this.keys.right = 0;
    if (e.key === 'ArrowUp' || e.key === 'w') this.keys.up = 0;
    if (e.key === 'ArrowDown' || e.key === 's') this.keys.down = 0;
    this.applyKeys();
  };
  private applyKeys() {
    const kx = this.keys.right - this.keys.left;
    const ky = this.keys.down - this.keys.up;
    if (kx || ky) {
      this.ax = kx;
      this.ay = ky;
    } else if (this.stick.id === null) {
      this.ax = 0;
      this.ay = 0;
    }
  }

  // --- Gamepad (polled) -----------------------------------------------------
  pollGamepad() {
    if (!this.enabled) return;
    const pads = navigator.getGamepads?.();
    const gp = pads && pads[0];
    if (!gp) return;
    const dead = 0.18;
    const lx = Math.abs(gp.axes[0]) > dead ? gp.axes[0] : 0;
    const ly = Math.abs(gp.axes[1]) > dead ? gp.axes[1] : 0;
    if (lx || ly) {
      this.ax = lx;
      this.ay = ly;
    }
    // A / RT = ability, X / LB = jump
    const ability = !!(gp.buttons[0]?.pressed || gp.buttons[7]?.pressed);
    const jump = !!(gp.buttons[2]?.pressed || gp.buttons[4]?.pressed);
    if (ability && !this.prevGpAbility) this.abilityQueued = true;
    if (jump && !this.prevGpJump) this.jumpQueued = true;
    this.prevGpAbility = ability;
    this.prevGpJump = jump;
  }

  // --- Touch ----------------------------------------------------------------
  private placeBase(x: number, y: number) {
    this.base.style.left = x - 60 + 'px';
    this.base.style.top = y - 60 + 'px';
  }
  private placeKnob(x: number, y: number) {
    this.knob.style.left = x - 28 + 'px';
    this.knob.style.top = y - 28 + 'px';
  }
  private showStick(x: number, y: number) {
    this.base.style.display = 'block';
    this.knob.style.display = 'block';
    this.placeBase(x, y);
    this.placeKnob(x, y);
    requestAnimationFrame(() => {
      this.base.style.opacity = '0.9';
      this.knob.style.opacity = '1';
    });
  }
  private hideStick() {
    this.base.style.opacity = '0';
    this.knob.style.opacity = '0';
    this.base.style.display = 'none';
    this.knob.style.display = 'none';
  }

  private onTouchStart = (e: TouchEvent) => {
    if (!this.enabled) return;
    SFX.unlock();
    for (const t of Array.from(e.changedTouches)) {
      // Ability = the ⚡ button in the bottom-right CORNER only. (This used to
      // be the whole lower-right 38% of the screen, which swallowed movement
      // drags — you couldn't steer from the right half in hockey.)
      if (t.clientX >= innerWidth - 150 && t.clientY >= innerHeight - 150) {
        this.abilityQueued = true;
        continue;
      }
      // 'none': no analog stick at all (movement is button-driven, e.g. Musical
      // Chairs) — so a tap under the RUN/HIT buttons never spawns a phantom stick.
      if (this.mode === 'none') continue;
      // A touch that starts on a game-control button (marked [data-nostick], e.g.
      // the kart SPEED/ITEM buttons) must not also spawn a steering stick.
      const tgt = t.target as HTMLElement | null;
      if (tgt && tgt.closest && tgt.closest('[data-nostick]')) continue;
      if (this.stick.id !== null) continue;
      this.stick.id = t.identifier;
      this.stick.ox = t.clientX;
      this.stick.oy = t.clientY;
      this.stick.lastX = t.clientX;
      if (this.mode === 'float') {
        this.showStick(t.clientX, t.clientY);
        this.moveStick(t.clientX, t.clientY);
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.stick.id) continue;
      if (this.mode === 'hidden') {
        this.hockeyDX += t.clientX - this.stick.lastX;
        this.stick.lastX = t.clientX;
      } else {
        this.moveStick(t.clientX, t.clientY);
      }
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stick.id) this.endStick();
    }
  };

  private moveStick(x: number, y: number) {
    let dx = x - this.stick.ox;
    let dy = y - this.stick.oy;
    const max = 58;
    let L = Math.hypot(dx, dy);
    if (L > max) {
      dx *= max / L;
      dy *= max / L;
      L = max;
    }
    this.placeKnob(this.stick.ox + dx, this.stick.oy + dy);
    const deadR = 9;
    if (L < deadR) {
      this.ax = 0;
      this.ay = 0;
    } else {
      const f = (L - deadR) / (max - deadR) / L;
      this.ax = dx * f;
      this.ay = dy * f;
    }
  }

  private endStick() {
    this.stick.id = null;
    this.ax = 0;
    this.ay = 0;
    this.hockeyDX = 0;
    if (this.mode === 'float') this.hideStick();
  }
}
