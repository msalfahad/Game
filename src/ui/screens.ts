import { HEROES, heroImg, type Hero } from '../data/characters';
import { FROSTBITE_MAPS, GREYBOX_MAP, type MapDef } from '../data/maps';
import type { Player } from '../game/player';

// Front-end screen flow (SPEC section 8): title -> character select ->
// game/map picker -> versus -> results. Screens are injected into #screens and
// toggled by id. Gameplay selection is reported back through callbacks.

export type Diff = 'easy' | 'normal' | 'hard' | 'expert';

export interface Selection {
  hero: Hero;
  diff: Diff;
  mapId: string;
  gameId: 'hockey' | 'surfacelab';
}

interface Hooks {
  onStart: (sel: Selection) => void;
  onShakeChange: (v: number) => void;
  onQualityChange: (t: 'low' | 'medium' | 'high' | 'ultra') => void;
}

const root = document.getElementById('screens')!;
let sel: Hero = HEROES[0];
let diff: Diff = 'normal';
let chosenMapId = FROSTBITE_MAPS[0].id;
let chosenGame: Selection['gameId'] = 'hockey';

const ids = ['scrTitle', 'scrChar', 'scrGames', 'scrVs', 'scrOver'];
export function show(id: string) {
  for (const s of ids) document.getElementById(s)?.classList.add('hidden');
  document.getElementById(id)?.classList.remove('hidden');
}
/** Hide every menu screen so the 3D canvas + HUD are visible during a match. */
export function hideScreens() {
  for (const s of ids) document.getElementById(s)?.classList.add('hidden');
}

export function buildScreens(hooks: Hooks) {
  root.innerHTML = `
  <div id="scrTitle" class="screen hidden">
    <h1>BASH<br>ARENA</h1>
    <p class="tag">Original 2-4 player arcade brawler. Themed 3D arenas, invisible-stick controls, you vs 3 bots. Touch the left side to move, tap the right for your ultimate ⚡. Keyboard: WASD/arrows, Space = ⚡, Shift = jump. Gamepad supported.</p>
    <button class="big" data-go="scrChar">PLAY</button>
    <div class="settingRow"><span>CAMERA SHAKE</span><input id="shakeSlider" type="range" min="0" max="100" value="100"></div>
    <div class="settingRow"><span>QUALITY</span>
      <select id="qualitySel">
        <option value="low">Low</option><option value="medium">Medium</option>
        <option value="high" selected>High</option><option value="ultra">Ultra</option>
      </select>
    </div>
  </div>

  <div id="scrChar" class="screen hidden">
    <h2>CHOOSE YOUR HERO</h2>
    <div class="charGrid" id="charGrid"></div>
    <div id="selInfo"></div>
    <div class="diffRow">
      <div class="diff" data-d="easy">EASY</div>
      <div class="diff sel" data-d="normal">NORMAL</div>
      <div class="diff" data-d="hard">HARD</div>
      <div class="diff" data-d="expert">EXPERT</div>
    </div>
    <button class="big" data-go="scrGames">NEXT ▶</button>
  </div>

  <div id="scrGames" class="screen hidden">
    <h2>PICK A GAME</h2>
    <div class="gameRow" id="gameRow"></div>
    <button class="alt" data-go="scrChar">◀ BACK</button>
  </div>

  <div id="scrVs" class="screen hidden">
    <h2 id="vsTitle">MATCH UP</h2>
    <div class="vsRow" id="vsRow"></div>
    <p class="tag" id="vsMap"></p>
    <button class="big" id="startBtn">START ▶</button>
    <button class="alt" data-go="scrGames">◀ BACK</button>
  </div>

  <div id="scrOver" class="screen hidden">
    <h2 id="overTitle">RESULTS</h2>
    <p class="tag" id="overSub"></p>
    <div id="resList"></div>
    <button class="big" id="rematchBtn">REMATCH</button>
    <button class="alt" data-go="scrGames">OTHER GAMES</button>
  </div>`;

  // Title settings.
  const shake = document.getElementById('shakeSlider') as HTMLInputElement;
  shake.addEventListener('input', () => hooks.onShakeChange(Number(shake.value) / 100));
  const quality = document.getElementById('qualitySel') as HTMLSelectElement;
  quality.addEventListener('change', () => hooks.onQualityChange(quality.value as any));

  // Character grid.
  const grid = document.getElementById('charGrid')!;
  HEROES.forEach((h, i) => {
    const d = document.createElement('div');
    d.className = 'cc' + (i === 0 ? ' sel' : '');
    d.innerHTML = `<img src="${heroImg(h)}"><div class="n" style="color:${h.col}">${h.name.toUpperCase()}</div>`;
    d.onclick = () => {
      sel = h;
      grid.querySelectorAll('.cc').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
      updInfo();
    };
    grid.appendChild(d);
  });
  updInfo();

  document.querySelectorAll('.diff').forEach((d) =>
    d.addEventListener('click', () => {
      diff = (d as HTMLElement).dataset.d as Diff;
      document.querySelectorAll('.diff').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
    }),
  );

  // Game / map picker.
  buildGameRow();

  // Nav buttons.
  root.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => show((b as HTMLElement).dataset.go!)),
  );

  document.getElementById('startBtn')!.addEventListener('click', () =>
    hooks.onStart({ hero: sel, diff, mapId: chosenMapId, gameId: chosenGame }),
  );
  document.getElementById('rematchBtn')!.addEventListener('click', () =>
    hooks.onStart({ hero: sel, diff, mapId: chosenMapId, gameId: chosenGame }),
  );
}

function updInfo() {
  const el = document.getElementById('selInfo');
  if (el) el.textContent =
    `${sel.name.toUpperCase()} · ${sel.role} — SPD ${sel.spd} · STR ${sel.str} · ACC ${sel.acc} · DEF ${sel.def} · ULT: ${sel.ultName}`;
}

function gameButton(icon: string, name: string, desc: string, onClick: () => void, locked = false) {
  const d = document.createElement('div');
  d.className = 'gameBtn' + (locked ? ' locked' : '');
  d.innerHTML = `<div class="ico">${icon}</div><div><div class="nm">${name}</div><div class="ds">${desc}</div></div>`;
  if (!locked) d.addEventListener('click', onClick);
  return d;
}

function buildGameRow() {
  const row = document.getElementById('gameRow')!;
  row.innerHTML = '';

  // Surface Lab (movement greybox).
  row.appendChild(
    gameButton('🧪', 'SURFACE LAB', GREYBOX_MAP.blurb, () => {
      chosenGame = 'surfacelab';
      chosenMapId = GREYBOX_MAP.id;
      toVersus();
    }),
  );

  // Frostbite family — Ice Hockey Brawl across the 4 difficulty-ramp maps.
  FROSTBITE_MAPS.forEach((m) => {
    row.appendChild(
      gameButton('🏒', `HOCKEY · ${m.name.toUpperCase()}`, `${m.tierName} (tier ${m.tier}) — ${m.blurb}`, () => {
        chosenGame = 'hockey';
        chosenMapId = m.id;
        toVersus();
      }),
    );
  });

  // Signposts for the rest of the family / other families (SPEC scope).
  ['Slip & Slide', 'Snowball Smash', 'Avalanche Run'].forEach((n) =>
    row.appendChild(gameButton('❄️', n.toUpperCase(), 'Frostbite family — coming next', () => {}, true)),
  );
}

function toVersus() {
  const rivals = HEROES.filter((h) => h.key !== sel.key);
  for (let i = rivals.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rivals[i], rivals[j]] = [rivals[j], rivals[i]];
  }
  const roster: { hero: Hero; you: boolean }[] = [
    { hero: sel, you: true },
    { hero: rivals[0], you: false },
    { hero: rivals[1], you: false },
    { hero: rivals[2], you: false },
  ];
  const row = document.getElementById('vsRow')!;
  row.innerHTML = '';
  roster.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'vsCard' + (p.you ? ' you' : '');
    d.innerHTML = `<img src="${heroImg(p.hero)}"><div class="n" style="color:${p.hero.col}">${p.hero.name.toUpperCase()}${p.you ? '<br>(YOU)' : ''}</div>`;
    row.appendChild(d);
  });
  const map = [GREYBOX_MAP, ...FROSTBITE_MAPS].find((m) => m.id === chosenMapId) as MapDef;
  document.getElementById('vsTitle')!.textContent = chosenGame === 'hockey' ? 'ICE HOCKEY BRAWL' : 'SURFACE LAB';
  document.getElementById('vsMap')!.textContent = `📍 ${map.family} · ${map.name} · ${map.tierName}`;
  show('scrVs');
}

export function showResults(ranked: Player[], subtitle: string, youWon: boolean) {
  const you = ranked.find((p) => p.you)!;
  document.getElementById('overTitle')!.textContent = youWon
    ? '🏆 YOU WIN!'
    : ranked[ranked.length - 1] === you
      ? '💀 YOU LOSE!'
      : 'FULL TIME!';
  document.getElementById('overSub')!.textContent = subtitle;
  const list = document.getElementById('resList')!;
  list.innerHTML = '';
  ranked.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'resRow' + (i === 0 ? ' first' : '');
    const res = (p as any)._res ?? '';
    d.innerHTML = `<img src="${heroImg(p.hero)}"><div class="rn" style="color:${p.hero.col}">${i + 1}. ${p.hero.name.toUpperCase()}${p.you ? ' (YOU)' : ''}</div><div class="rs">${res}</div>`;
    list.appendChild(d);
  });
  show('scrOver');
}
