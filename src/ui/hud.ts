import type { Player } from '../game/player';
import { heroImg } from '../data/characters';

// In-match HUD (SPEC section 12): corner player panels (head + score/status),
// top-center timer + objective, banner callouts, and the ability hint.

const headsEl = document.getElementById('hudHeads')!;
const clockEl = document.getElementById('clock')!;
const objectiveEl = document.getElementById('objective')!;
const bannerEl = document.getElementById('banner')!;
const abilityHintEl = document.getElementById('abilityHint')!;
let bannerTimer = 0;

export function showHud(on: boolean) {
  for (const el of [headsEl, clockEl, objectiveEl]) el.classList.toggle('hidden', !on);
  document.getElementById('mute')!.classList.toggle('hidden', !on);
  abilityHintEl.style.display = on ? 'block' : 'none';
  if (!on) hideClimbMap();
}

// --- Climb minimap -----------------------------------------------------------
// A vertical race track on the right edge: one dot per climber (their color),
// YOUR dot is bigger with a white ring, the summit flag sits at the top. Shows
// at a glance who leads and who's breathing down your neck.

let climbMapEl: HTMLElement | null = null;
let climbDots: HTMLElement[] = [];

export function showClimbMap(cols: string[], youIndex: number) {
  hideClimbMap();
  const el = document.createElement('div');
  el.id = 'climbMap';
  el.style.cssText =
    'position:fixed;right:12px;top:50%;transform:translateY(-50%);width:16px;height:46vh;' +
    'background:rgba(10,18,48,.6);border:2px solid rgba(154,223,255,.4);border-radius:10px;' +
    'z-index:40;pointer-events:none;';
  const flag = document.createElement('div');
  flag.textContent = '🏔️';
  flag.style.cssText = 'position:absolute;top:-26px;left:50%;transform:translateX(-50%);font-size:17px;line-height:1;';
  el.appendChild(flag);
  climbDots = cols.map((c, i) => {
    const you = i === youIndex;
    const s = you ? 15 : 10;
    const d = document.createElement('div');
    d.style.cssText =
      `position:absolute;left:50%;width:${s}px;height:${s}px;margin-left:${-s / 2}px;` +
      `border-radius:50%;background:${c};bottom:1%;transition:bottom .15s linear;` +
      (you ? 'border:2px solid #fff;box-shadow:0 0 8px #fff;z-index:2;' : 'opacity:.92;');
    el.appendChild(d);
    return d;
  });
  document.body.appendChild(el);
  climbMapEl = el;
}

/** progress: 0 (start) .. 1 (summit) per player; dead climbers fade. */
export function updateClimbMap(progress: number[], dead?: boolean[]) {
  if (!climbMapEl) return;
  progress.forEach((t, i) => {
    const d = climbDots[i];
    if (!d) return;
    d.style.bottom = Math.max(0, Math.min(1, t)) * 92 + 1 + '%';
    if (dead?.[i]) d.style.opacity = '0.25';
  });
}

export function hideClimbMap() {
  climbMapEl?.remove();
  climbMapEl = null;
  climbDots = [];
}

// Each player's "power" shows as a BAR (in their hero colour) rather than a
// number — the bars fill relative to the current leader, so the panel reads
// like a live race at a glance.
let hudList: Player[] = [];
const hudVal = new Map<Player, number>();
const hudFill = new Map<Player, HTMLElement>();

function num(v: string | number): number {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function refreshBars() {
  let max = 0;
  for (const p of hudList) max = Math.max(max, hudVal.get(p) ?? 0);
  max = Math.max(max, 1);
  for (const p of hudList) {
    const fill = hudFill.get(p);
    if (fill) fill.style.width = Math.max(0, Math.min(1, (hudVal.get(p) ?? 0) / max)) * 100 + '%';
  }
}

export function makeHeads(players: Player[], initialScore: string | number) {
  headsEl.innerHTML = '';
  hudList = players.slice();
  hudVal.clear();
  hudFill.clear();
  for (const p of players) {
    const d = document.createElement('div');
    d.className = 'head' + (p.you ? ' you' : '');
    d.style.borderColor = p.you ? '#FFD23F' : p.hero.col + '66';
    d.innerHTML = `<img src="${heroImg(p.hero)}"><div class="pbar"><div class="pfill" style="background:${p.hero.col};color:${p.hero.col}"></div></div>`;
    headsEl.appendChild(d);
    p.headEl = d;
    p.scoreEl = d.querySelector('.pfill');
    hudFill.set(p, d.querySelector('.pfill') as HTMLElement);
    hudVal.set(p, num(initialScore));
  }
  refreshBars();
}

export function setScore(p: Player, text: string | number) {
  hudVal.set(p, num(text));
  refreshBars();
}

export function markDead(p: Player) {
  p.headEl?.classList.add('dead');
}

export function setClock(secondsLeft: number) {
  const s = Math.max(0, secondsLeft);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  clockEl.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
}

export function setObjective(text: string) {
  objectiveEl.textContent = text;
}

export function banner(text: string, col = '#FFD23F') {
  if (!text) return;
  bannerEl.textContent = text;
  bannerEl.style.color = col;
  bannerEl.style.opacity = '1';
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => (bannerEl.style.opacity = '0'), 900);
}

export function setAbilityHint(state: 'armed' | 'ready' | '') {
  abilityHintEl.className = state;
}
