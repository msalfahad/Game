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
}

export function makeHeads(players: Player[], initialScore: string | number) {
  headsEl.innerHTML = '';
  for (const p of players) {
    const d = document.createElement('div');
    d.className = 'head' + (p.you ? ' you' : '');
    d.style.borderColor = p.you ? '#FFD23F' : p.hero.col + '66';
    d.innerHTML = `<img src="${heroImg(p.hero)}"><div class="sc">${initialScore}</div>`;
    headsEl.appendChild(d);
    p.headEl = d;
    p.scoreEl = d.querySelector('.sc');
  }
}

export function setScore(p: Player, text: string | number) {
  if (p.scoreEl) p.scoreEl.textContent = String(text);
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
