import { HEROES, type Hero } from '../data/characters';
import { portraitImg, attachPortraitFallback } from './portrait';
import { FAMILIES, familyGames, gameById, type GameDef } from '../data/maps';
import type { Player } from '../game/player';
import { TUNING, saveTuning, resetTuning } from '../core/tuning';

// Screen flow (SPEC section 8): title -> hero select -> FAMILY picker ->
// game picker (4 per family) -> versus -> results, plus a live tuning drawer
// for balancing the game before release.

export type Diff = 'easy' | 'normal' | 'hard' | 'expert';

export interface Selection {
  hero: Hero;
  diff: Diff;
  gameId: string;
}

interface Hooks {
  onStart: (sel: Selection) => void;
  onShakeChange: (v: number) => void;
  onQualityChange: (t: 'low' | 'medium' | 'high' | 'ultra') => void;
}

const root = document.getElementById('screens')!;
let sel: Hero = HEROES[0];
let diff: Diff = 'normal';
let chosenGameId = 'frost-1';

const ids = ['scrTitle', 'scrChar', 'scrFamilies', 'scrGames', 'scrVs', 'scrOver'];
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
    <p class="tag">Original 2-4 player arcade brawler · ${countGames()} mini-games across ${FAMILIES.length - 1} themed worlds. Touch left side to move, tap right for ⚡. Keyboard: WASD/arrows · Space = ⚡ · Shift = jump. Gamepad supported.</p>
    <button class="big" id="onlineBtn">🌐 PLAY ONLINE</button>
    <button class="big" data-go="scrChar" style="background:var(--aqua);box-shadow:0 5px 0 #0E9CB2">PLAY OFFLINE</button>
    <button class="alt" id="tuneBtn">⚙️ TUNING</button>
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
    <button class="big" data-go="scrFamilies">NEXT ▶</button>
  </div>

  <div id="scrFamilies" class="screen hidden">
    <h2>PICK A WORLD</h2>
    <div class="famGrid" id="famGrid"></div>
    <button class="alt" data-go="scrChar">◀ BACK</button>
  </div>

  <div id="scrGames" class="screen hidden">
    <h2 id="famTitle">GAMES</h2>
    <p class="tag" id="famBlurb"></p>
    <div class="gameRow" id="gameRow"></div>
    <button class="alt" data-go="scrFamilies">◀ WORLDS</button>
  </div>

  <div id="scrVs" class="screen hidden">
    <h2 id="vsTitle">MATCH UP</h2>
    <div class="vsRow" id="vsRow"></div>
    <p class="tag" id="vsMap"></p>
    <button class="big" id="startBtn">START ▶</button>
    <button class="alt" id="vsBack">◀ BACK</button>
  </div>

  <div id="scrOver" class="screen hidden">
    <h2 id="overTitle">RESULTS</h2>
    <p class="tag" id="overSub"></p>
    <div id="resList"></div>
    <button class="big" id="rematchBtn">REMATCH</button>
    <button class="alt" id="overGames">OTHER GAMES</button>
  </div>

  <div id="tuneDrawer" class="hidden">
    <h3>⚙️ LIVE TUNING</h3>
    <p class="tinyTag">Balance the game — applies to the next match. Saved on this device.</p>
    <div class="tuneRow"><span>MATCH LENGTH</span><input data-k="timeScale" type="range" min="50" max="150" step="5"><em></em></div>
    <div class="tuneRow"><span>HAZARDS</span><input data-k="hazardScale" type="range" min="0" max="200" step="10"><em></em></div>
    <div class="tuneRow"><span>POWER-UPS</span><input data-k="powerupScale" type="range" min="0" max="200" step="10"><em></em></div>
    <div class="tuneRow"><span>MOVE SPEED</span><input data-k="speedScale" type="range" min="80" max="130" step="5"><em></em></div>
    <div class="tuneRow"><span>BOT SKILL</span><input data-k="botScale" type="range" min="50" max="130" step="5"><em></em></div>
    <div style="display:flex;gap:8px;justify-content:center">
      <button class="alt" id="tuneReset">RESET</button>
      <button id="tuneClose">DONE</button>
    </div>
  </div>`;

  // Title settings.
  const shake = document.getElementById('shakeSlider') as HTMLInputElement;
  shake.addEventListener('input', () => hooks.onShakeChange(Number(shake.value) / 100));
  const quality = document.getElementById('qualitySel') as HTMLSelectElement;
  quality.addEventListener('change', () => hooks.onQualityChange(quality.value as 'low' | 'medium' | 'high' | 'ultra'));

  buildTuning();

  // Character grid.
  const grid = document.getElementById('charGrid')!;
  HEROES.forEach((h, i) => {
    const d = document.createElement('div');
    d.className = 'cc' + (i === 0 ? ' sel' : '');
    d.innerHTML = `${portraitImg(h)}<div class="n" style="color:${h.col}">${h.name.toUpperCase()}</div>`;
    d.onclick = () => {
      sel = h;
      grid.querySelectorAll('.cc').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
      updInfo();
    };
    grid.appendChild(d);
  });
  attachPortraitFallback(grid);
  updInfo();

  document.querySelectorAll('.diff').forEach((d) =>
    d.addEventListener('click', () => {
      diff = (d as HTMLElement).dataset.d as Diff;
      document.querySelectorAll('.diff').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
    }),
  );

  // Family cards.
  const fam = document.getElementById('famGrid')!;
  for (const f of FAMILIES) {
    if (f.id === 'lab') continue;
    const d = document.createElement('div');
    d.className = 'famCard';
    d.innerHTML = `<div class="fi">${f.icon}</div><div class="fn">${f.name.toUpperCase()}</div><div class="fd">${familyGames(f.id).length} games</div>`;
    // Photoreal arena keyart backdrop (Higgsfield) with a dark overlay so the
    // gold text stays readable; families without art keep the plain panel.
    d.style.backgroundImage = `linear-gradient(rgba(10,12,24,.55), rgba(10,12,24,.8)), url('maps/${f.id}.webp')`;
    d.style.backgroundSize = 'cover';
    d.style.backgroundPosition = 'center';
    d.onclick = () => openFamily(f.id);
    fam.appendChild(d);
  }
  // Lab as a slim extra card.
  const lab = document.createElement('div');
  lab.className = 'famCard lab';
  lab.innerHTML = `<div class="fi">🧪</div><div class="fn">SURFACE LAB</div><div class="fd">movement test</div>`;
  lab.onclick = () => {
    chosenGameId = 'lab-1';
    toVersus();
  };
  fam.appendChild(lab);

  // Nav buttons.
  root.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => show((b as HTMLElement).dataset.go!)),
  );
  document.getElementById('vsBack')!.addEventListener('click', () => openFamily(gameById(chosenGameId).familyId));
  document.getElementById('overGames')!.addEventListener('click', () => openFamily(gameById(chosenGameId).familyId));

  document.getElementById('startBtn')!.addEventListener('click', () =>
    hooks.onStart({ hero: sel, diff, gameId: chosenGameId }),
  );
  document.getElementById('rematchBtn')!.addEventListener('click', () =>
    hooks.onStart({ hero: sel, diff, gameId: chosenGameId }),
  );
}

function countGames(): number {
  return FAMILIES.filter((f) => f.id !== 'lab').reduce((n, f) => n + familyGames(f.id).length, 0);
}

function buildTuning() {
  const drawer = document.getElementById('tuneDrawer')!;
  document.getElementById('tuneBtn')!.addEventListener('click', () => drawer.classList.toggle('hidden'));
  document.getElementById('tuneClose')!.addEventListener('click', () => drawer.classList.add('hidden'));
  const rows = Array.from(drawer.querySelectorAll('.tuneRow')) as HTMLElement[];
  const sync = () => {
    for (const row of rows) {
      const input = row.querySelector('input') as HTMLInputElement;
      const k = input.dataset.k as keyof typeof TUNING;
      input.value = String(Math.round((TUNING[k] as number) * 100));
      (row.querySelector('em') as HTMLElement).textContent = input.value + '%';
    }
  };
  for (const row of rows) {
    const input = row.querySelector('input') as HTMLInputElement;
    const k = input.dataset.k as keyof typeof TUNING;
    input.addEventListener('input', () => {
      (TUNING[k] as number) = Number(input.value) / 100;
      (row.querySelector('em') as HTMLElement).textContent = input.value + '%';
      saveTuning();
    });
  }
  document.getElementById('tuneReset')!.addEventListener('click', () => {
    resetTuning();
    sync();
  });
  sync();
}

function updInfo() {
  const el = document.getElementById('selInfo');
  if (el) el.textContent =
    `${sel.name.toUpperCase()} · ${sel.role} — SPD ${sel.spd} · STR ${sel.str} · ACC ${sel.acc} · DEF ${sel.def} · ULT: ${sel.ultName}`;
}

function openFamily(familyId: string) {
  const f = FAMILIES.find((x) => x.id === familyId)!;
  document.getElementById('famTitle')!.textContent = `${f.icon} ${f.name.toUpperCase()}`;
  document.getElementById('famBlurb')!.textContent = f.blurb;
  const row = document.getElementById('gameRow')!;
  row.innerHTML = '';
  for (const gm of familyGames(familyId)) {
    const d = document.createElement('div');
    d.className = 'gameBtn';
    d.innerHTML = `<div class="ico">${gm.icon}</div><div><div class="nm">${gm.name.toUpperCase()} <span class="tier">T${gm.tier} · ${gm.tierName}</span></div><div class="ds">${gm.blurb}</div></div>`;
    d.addEventListener('click', () => {
      chosenGameId = gm.id;
      toVersus();
    });
    row.appendChild(d);
  }
  show('scrGames');
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
    d.innerHTML = `${portraitImg(p.hero)}<div class="n" style="color:${p.hero.col}">${p.hero.name.toUpperCase()}${p.you ? '<br>(YOU)' : ''}</div>`;
    row.appendChild(d);
  });
  attachPortraitFallback(row);
  const gm: GameDef = gameById(chosenGameId);
  const f = FAMILIES.find((x) => x.id === gm.familyId)!;
  document.getElementById('vsTitle')!.textContent = gm.name.toUpperCase();
  document.getElementById('vsMap')!.textContent = `📍 ${f.name} · Tier ${gm.tier} (${gm.tierName}) · ${gm.blurb}`;
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
    d.innerHTML = `${portraitImg(p.hero)}<div class="rn" style="color:${p.hero.col}">${i + 1}. ${p.hero.name.toUpperCase()}${p.you ? ' (YOU)' : ''}</div><div class="rs">${res}</div>`;
    list.appendChild(d);
  });
  attachPortraitFallback(list);
  show('scrOver');
}
