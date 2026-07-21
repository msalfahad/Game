import { HEROES, heroImg, type Hero } from '../data/characters';
import { portraitImg, attachPortraitFallback } from './portrait';
import { GAMES, FAMILIES, gameById } from '../data/maps';
import { net, resolveServerUrl, rememberServerUrl, savedName } from '../net/client';
import type {
  MatchStartMsg, ReactionShowMsg, RematchUpdateMsg, SeriesEndMsg, SeriesNextMsg,
} from '../net/protocol';
import { show, hideScreens } from './screens';

// Clickable between-game reactions.
const REACTIONS = ['GG', 'EZ', '😂', '😢', '👍'];

// Which games are playable online (mirrors server/src/catalog.ts): only the
// mechanics the server can simulate. The bespoke offline-only games (kart, maze,
// boat, raft, foosball, sprint, …) are excluded so the picker never offers a
// game the server can't run.
const ONLINE_MECHANICS = new Set(['goal', 'icepush', 'climb', 'breaktiles', 'pushout', 'throwfight', 'dodge', 'collect', 'paint', 'mash']);
const TEAM_MECHANICS = new Set(['pushout', 'throwfight', 'breaktiles', 'dodge', 'icepush']);
function onlinePool(mode: 'ffa' | '2v2') {
  return GAMES.filter((g) => ONLINE_MECHANICS.has(g.mechanic) && (mode === 'ffa' || TEAM_MECHANICS.has(g.mechanic)));
}

// Online screens: sign-in (once), quick-play queue, and party rooms with
// 4-letter codes. Kept separate from the local-play flow in screens.ts.

interface OnlineHooks {
  onMatchStart: (m: MatchStartMsg) => void;
  stopMatch?: () => void; // halt the 3D controller (series intermission / leave)
}

let hooks: OnlineHooks;
let hero: Hero = HEROES[0];
let seriesPlayers: SeriesNextMsg['players'] = [];
let mySlot = 0;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

const ids = ['scrOnlineHome', 'scrQueue', 'scrParty', 'scrSeries', 'scrOnlineOver'];
function showOnline(id: string) {
  hideScreens();
  for (const s of ids) document.getElementById(s)?.classList.add('hidden');
  document.getElementById(id)?.classList.remove('hidden');
}
export function hideOnlineScreens() {
  for (const s of ids) document.getElementById(s)?.classList.add('hidden');
}

export function buildOnlineScreens(h: OnlineHooks) {
  hooks = h;
  const root = document.getElementById('screens')!;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div id="scrOnlineHome" class="screen hidden">
    <h2>🌐 PLAY ONLINE</h2>
    <p class="tag" id="onlineWho"></p>
    <div class="charGrid" id="onlineCharGrid"></div>
    <div class="gameRow">
      <div class="gameBtn" id="btnQuickPlay"><div class="ico">⚡</div>
        <div><div class="nm">QUICK PLAY</div><div class="ds">Match with random players · random map · bots fill empty seats.</div></div></div>
      <div class="gameBtn" id="btnCreateParty"><div class="ico">🎉</div>
        <div><div class="nm">CREATE PARTY</div><div class="ds">Get a 4-letter code, friends join you.</div></div></div>
      <div class="gameBtn" id="btnJoinParty"><div class="ico">🔑</div>
        <div><div class="nm">JOIN PARTY</div><div class="ds">Enter a friend's room code.</div></div></div>
    </div>
    <p class="tag" id="onlineErr" style="color:var(--red)"></p>
    <button class="alt" id="onlineBack">◀ BACK</button>
  </div>

  <div id="scrQueue" class="screen hidden">
    <h2>FINDING PLAYERS…</h2>
    <p class="tag" id="queueStatus">Waiting…</p>
    <button class="alt" id="queueCancel">CANCEL</button>
  </div>

  <div id="scrParty" class="screen hidden">
    <h2>🎉 PARTY ROOM</h2>
    <h1 id="partyCode" style="letter-spacing:12px"></h1>
    <p class="tag">Share this code — friends tap JOIN PARTY and type it in. Empty seats become bots.</p>
    <div class="diffRow" id="modeRow">
      <div class="diff sel" data-mode="ffa">⚔️ FREE-FOR-ALL</div>
      <div class="diff" data-mode="2v2">🤝 2 VS 2</div>
    </div>
    <div class="settingRow" id="mapRow"><span>MAP</span><select id="partyGameSel"></select></div>
    <div id="teamCols" class="teamCols hidden">
      <div class="teamCol" id="teamCol0"><div class="teamName" style="color:#4DC3FF">TEAM BLUE</div></div>
      <div class="teamCol" id="teamCol1"><div class="teamName" style="color:#FF4D4D">TEAM RED</div></div>
    </div>
    <div class="vsRow" id="partyList"></div>
    <button class="alt" id="teamSwitch" style="display:none">🔁 SWITCH TEAM</button>
    <button class="big" id="partyStart">START MATCH ▶</button>
    <button class="alt" id="partyLeave">LEAVE</button>
  </div>

  <div id="scrSeries" class="screen hidden">
    <div id="serScore" class="serScore"></div>
    <h2 id="serTitle">GAME 1 / 5</h2>
    <div id="serGame" class="serGame"></div>
    <p class="tag" id="serLast"></p>
    <div id="serCount" class="serCount">5</div>
    <p class="tinyTag">Get ready…</p>
    ${reactBarHtml('serReact')}
  </div>

  <div id="scrOnlineOver" class="screen hidden">
    <h2 id="onlineOverTitle">SERIES OVER</h2>
    <p class="tag" id="onlineOverSub">Best of 5 complete.</p>
    <div id="onlineResList"></div>
    ${reactBarHtml('endReact')}
    <button class="big" id="onlineRematch">🔁 REMATCH</button>
    <p class="tinyTag" id="rematchStatus"></p>
    <button class="alt" id="onlineFindNew">🔎 FIND NEW GAME</button>
  </div>`;
  root.appendChild(wrap);

  // Floating reaction pop-ups layer (over everything).
  if (!document.getElementById('reactPops')) {
    const pops = document.createElement('div');
    pops.id = 'reactPops';
    pops.style.cssText = 'position:fixed;inset:0;z-index:45;pointer-events:none;overflow:hidden;';
    document.body.appendChild(pops);
  }

  // Hero picker for online play.
  const grid = document.getElementById('onlineCharGrid')!;
  HEROES.forEach((hh, i) => {
    const d = document.createElement('div');
    d.className = 'cc' + (i === 0 ? ' sel' : '');
    d.innerHTML = `${portraitImg(hh)}<div class="n" style="color:${hh.col}">${hh.name.toUpperCase()}</div>`;
    d.onclick = () => {
      hero = hh;
      grid.querySelectorAll('.cc').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
      net.setHero(hh.key);
    };
    grid.appendChild(d);
  });
  attachPortraitFallback(grid);

  document.getElementById('onlineBack')!.addEventListener('click', () => show('scrTitle'));
  document.getElementById('btnQuickPlay')!.addEventListener('click', () => {
    net.setHero(hero.key);
    net.joinQueue();
    document.getElementById('queueStatus')!.textContent = 'Waiting for players…';
    showOnline('scrQueue');
  });
  document.getElementById('queueCancel')!.addEventListener('click', () => {
    net.leaveQueue();
    showOnline('scrOnlineHome');
  });
  document.getElementById('btnCreateParty')!.addEventListener('click', async () => {
    net.setHero(hero.key);
    const code = await net.createRoom();
    if (code) {
      document.getElementById('partyCode')!.textContent = code;
      showOnline('scrParty');
    }
  });
  document.getElementById('btnJoinParty')!.addEventListener('click', async () => {
    const code = prompt('Enter the 4-letter party code:');
    if (!code) return;
    net.setHero(hero.key);
    const ok = await net.joinRoom(code);
    if (ok) {
      document.getElementById('partyCode')!.textContent = ok;
      showOnline('scrParty');
    } else {
      setErr('Room not found (or already started / full).');
    }
  });
  document.getElementById('partyStart')!.addEventListener('click', () => net.startRoom());
  document.getElementById('teamSwitch')!.addEventListener('click', () => net.toggleTeam());
  document.querySelectorAll('#modeRow .diff').forEach((d) =>
    d.addEventListener('click', () => net.setRoomMode((d as HTMLElement).dataset.mode as 'ffa' | '2v2')),
  );
  document.getElementById('partyGameSel')!.addEventListener('change', (e) =>
    net.setRoomGame((e.target as HTMLSelectElement).value),
  );
  document.getElementById('partyLeave')!.addEventListener('click', () => {
    net.leaveRoom();
    showOnline('scrOnlineHome');
  });
  // Series end: REMATCH needs everyone to click; FIND NEW GAME leaves.
  document.getElementById('onlineRematch')!.addEventListener('click', () => {
    net.voteRematch();
    (document.getElementById('onlineRematch') as HTMLButtonElement).disabled = true;
    document.getElementById('rematchStatus')!.textContent = 'Waiting for the others to accept…';
  });
  document.getElementById('onlineFindNew')!.addEventListener('click', () => {
    net.leaveSeries();
    hooks.stopMatch?.();
    stopCountdown();
    showOnline('scrOnlineHome');
    refreshWho();
  });
  // Clickable reactions (delegated) — sent to everyone, shown between games.
  document.getElementById('screens')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.reactBtn') as HTMLElement | null;
    if (btn?.dataset.emoji) net.sendReaction(btn.dataset.emoji);
  });

  // Series flow.
  net.cb.onSeriesNext = (m) => renderIntermission(m);
  net.cb.onSeriesEnd = (m) => renderSeriesEnd(m);
  net.cb.onReaction = (m) => popReaction(m);
  net.cb.onRematch = (m) => updateRematch(m);

  // Lobby events.
  net.cb.onQueue = (m) => {
    const el = document.getElementById('queueStatus');
    if (!el) return;
    const botNote = m.botFillInSec >= 0 ? ` Starting with bots in ${m.botFillInSec}s…` : '';
    el.textContent = `${m.count}/${m.needed} players in queue.${botNote}`;
  };
  net.cb.onRoom = (m) => {
    document.getElementById('partyCode')!.textContent = m.code;
    const is2v2 = m.mode === '2v2';
    const meHost = m.players.some((p) => p.you && p.host);

    // Mode toggle: reflect server state; only the host can click it.
    document.querySelectorAll('#modeRow .diff').forEach((d) => {
      const el = d as HTMLElement;
      el.classList.toggle('sel', el.dataset.mode === m.mode);
      el.style.pointerEvents = meHost ? '' : 'none';
      el.style.opacity = meHost || el.dataset.mode === m.mode ? '1' : '.4';
    });

    // Map picker: host chooses RANDOM or a specific game, grouped by world.
    const sel2 = document.getElementById('partyGameSel') as HTMLSelectElement;
    sel2.disabled = !meHost;
    sel2.innerHTML = '<option value="random">🎲 RANDOM</option>';
    for (const f of FAMILIES) {
      const games = onlinePool(m.mode).filter((g) => g.familyId === f.id);
      if (!games.length) continue;
      const og = document.createElement('optgroup');
      og.label = `${f.icon} ${f.name}`;
      for (const g of games) {
        const o = document.createElement('option');
        o.value = g.id;
        o.textContent = `${g.icon} ${g.name}`;
        og.appendChild(o);
      }
      sel2.appendChild(og);
    }
    sel2.value = m.gameId ?? 'random';
    if (sel2.selectedIndex < 0) sel2.value = 'random';

    const makeCard = (p: (typeof m.players)[0]) => {
      const hh = HEROES.find((x) => x.key === p.heroKey) ?? HEROES[0];
      const d = document.createElement('div');
      d.className = 'vsCard' + (p.you ? ' you' : '');
      d.innerHTML = `<img src="${heroImg(hh)}"><div class="n" style="color:${hh.col}">${p.name}${p.host ? ' 👑' : ''}${p.you ? '<br>(YOU)' : ''}</div>`;
      return d;
    };

    const flat = document.getElementById('partyList')!;
    const cols = document.getElementById('teamCols')!;
    flat.innerHTML = '';
    cols.classList.toggle('hidden', !is2v2);
    flat.classList.toggle('hidden', is2v2);
    (document.getElementById('teamSwitch') as HTMLElement).style.display = is2v2 ? '' : 'none';

    if (is2v2) {
      for (const t of [0, 1]) {
        const col = document.getElementById('teamCol' + t)!;
        col.querySelectorAll('.vsCard').forEach((e) => e.remove());
        for (const p of m.players.filter((q) => q.team === t)) col.appendChild(makeCard(p));
      }
    } else {
      for (const p of m.players) flat.appendChild(makeCard(p));
    }

    const start = document.getElementById('partyStart') as HTMLButtonElement;
    start.style.display = meHost ? '' : 'none';
  };
  net.cb.onMatchStart = (m) => {
    mySlot = m.youSlot;
    stopCountdown();
    hideOnlineScreens();
    hideScreens();
    hooks.onMatchStart(m);
  };
  net.cb.onDisconnect = () => {
    setErr('Disconnected from server.');
    showOnline('scrOnlineHome');
  };
}

function setErr(text: string) {
  const el = document.getElementById('onlineErr');
  if (el) el.textContent = text;
}

/** Entry point from the title screen: connect (asking name/server once), then show the online home. */
export async function enterOnline() {
  setErr('');
  if (net.connected) {
    showOnline('scrOnlineHome');
    refreshWho();
    return;
  }
  let server = resolveServerUrl();
  if (!server) {
    const url = prompt(
      'Server URL for online play\n(e.g. https://your-app.onrender.com — see README to deploy yours):',
    );
    if (!url) return;
    rememberServerUrl(url);
    server = resolveServerUrl();
    if (!server) return;
  }
  const name = savedName() ?? prompt('Pick a player name:') ?? '';
  const loading = document.getElementById('loading')!;
  try {
    loading.textContent = 'CONNECTING… (a sleeping free server can take up to a minute to wake)';
    loading.style.display = 'flex';
    await net.connect(server, name);
    showOnline('scrOnlineHome');
    refreshWho();
  } catch (e) {
    show('scrTitle');
    alert((e as Error).message + '\nCheck the server URL (see README → Multiplayer).');
    localStorage.removeItem('ba-server');
  } finally {
    loading.style.display = 'none';
    loading.textContent = 'LOADING ARENA…';
  }
}

function refreshWho() {
  const el = document.getElementById('onlineWho');
  if (el && net.me) el.textContent = `Signed in as ${net.me.name} · ${net.me.xp} XP · ${net.me.wins} wins in ${net.me.games} games`;
}

const TEAM_NAMES = ['TEAM BLUE', 'TEAM RED'];
const TEAM_COLS = ['#4DC3FF', '#FF4D4D'];

// --- Best-of-5 series screens -------------------------------------------------

function reactBarHtml(id: string): string {
  const btns = REACTIONS.map((e) =>
    `<button class="reactBtn" data-emoji="${e}" style="pointer-events:auto;background:rgba(20,28,54,.85);border:1px solid rgba(255,255,255,.28);color:#fff;font-family:Bungee,system-ui,sans-serif;font-size:16px;border-radius:12px;padding:8px 13px;cursor:pointer;">${e}</button>`,
  ).join('');
  return `<div id="${id}" class="reactBar" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px;">${btns}</div>`;
}

function seriesScoreHtml(mode: string, score: number[], players: SeriesNextMsg['players']): string {
  if (mode === '2v2') {
    return `<div style="display:flex;gap:14px;justify-content:center;align-items:center;font-family:Bungee,system-ui,sans-serif;font-size:22px;">
      <span style="color:${TEAM_COLS[0]}">BLUE ${score[0] ?? 0}</span><span style="opacity:.55">–</span>
      <span style="color:${TEAM_COLS[1]}">${score[1] ?? 0} RED</span></div>`;
  }
  return `<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">` +
    players.map((p, i) => {
      const hh = HEROES.find((x) => x.key === p.heroKey) ?? HEROES[0];
      return `<span style="background:rgba(20,28,54,.7);border-radius:10px;padding:4px 9px;color:${hh.col};font-size:12px;">${p.name.split(' ')[0]} ${score[i] ?? 0}🏆</span>`;
    }).join('') + `</div>`;
}

function renderIntermission(m: SeriesNextMsg) {
  hooks.stopMatch?.(); // halt the just-finished game's 3D during the countdown
  seriesPlayers = m.players;
  const def = gameById(m.nextGameId);
  document.getElementById('serTitle')!.textContent = `GAME ${m.gameNum} / ${m.ofN}`;
  document.getElementById('serGame')!.innerHTML =
    `<div style="font-size:46px;line-height:1">${def.icon}</div>` +
    `<div style="color:#FFD23F;font-family:Bungee,system-ui,sans-serif;font-size:20px;margin-top:4px">${def.name.toUpperCase()}</div>` +
    `<div class="tag" style="max-width:340px;margin:6px auto 0">${def.blurb}</div>`;
  document.getElementById('serScore')!.innerHTML = seriesScoreHtml(m.mode, m.score, m.players);
  const last = document.getElementById('serLast') as HTMLElement;
  if (m.lastRanking && m.lastRanking.length) {
    last.textContent = m.mode === '2v2'
      ? `${TEAM_NAMES[m.lastWinnerTeam ?? 0]} took the last game.`
      : `${m.lastRanking[0].name} won the last game.`;
    last.style.display = '';
  } else {
    last.style.display = 'none';
  }
  startCountdown(m.inSec);
  showOnline('scrSeries');
}

function renderSeriesEnd(m: SeriesEndMsg) {
  hooks.stopMatch?.();
  stopCountdown();
  seriesPlayers = m.players;
  const myTeam = m.players[mySlot]?.team ?? 0;
  const topSlot = [...m.standings].sort((a, b) => b.wins - a.wins)[0]?.slot;
  const youWon = m.mode === '2v2' ? myTeam === m.winnerTeam : topSlot === mySlot;
  const titleEl = document.getElementById('onlineOverTitle')!;
  titleEl.textContent = m.mode === '2v2'
    ? (youWon ? '🏆 ' : '') + TEAM_NAMES[m.winnerTeam] + ' WIN THE SERIES!'
    : youWon ? '🏆 YOU WIN THE SERIES!' : 'SERIES OVER';
  (titleEl as HTMLElement).style.color = m.mode === '2v2' ? TEAM_COLS[m.winnerTeam] : '';
  document.getElementById('onlineOverSub')!.textContent = m.mode === '2v2'
    ? `Final: BLUE ${m.score[0]} – ${m.score[1]} RED`
    : 'Best of 5 complete.';
  const list = document.getElementById('onlineResList')!;
  list.className = '';
  list.innerHTML = '';
  [...m.standings].sort((a, b) => b.wins - a.wins).forEach((r, i) => {
    const hh = HEROES.find((x) => x.key === r.heroKey) ?? HEROES[0];
    const d = document.createElement('div');
    d.className = 'resRow' + (i === 0 ? ' first' : '');
    const teamChip = m.mode === '2v2' ? `<span style="color:${TEAM_COLS[r.team]};font-size:10px"> ${TEAM_NAMES[r.team]}</span>` : '';
    d.innerHTML = `<img src="${heroImg(hh)}"><div class="rn" style="color:${hh.col}">${i + 1}. ${r.name}${r.slot === mySlot ? ' (YOU)' : ''}${teamChip}</div><div class="rs">${r.wins} 🏆</div>`;
    list.appendChild(d);
  });
  (list as HTMLElement).style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const rb = document.getElementById('onlineRematch') as HTMLButtonElement;
  rb.disabled = false; rb.textContent = '🔁 REMATCH';
  document.getElementById('rematchStatus')!.textContent = 'Everyone must accept to run another 5-game series.';
  showOnline('scrOnlineOver');
}

function updateRematch(m: RematchUpdateMsg) {
  const voted = m.votedSlots.length, need = Math.max(1, m.humanSlots.length);
  const rb = document.getElementById('onlineRematch') as HTMLButtonElement | null;
  if (rb) rb.textContent = `🔁 REMATCH (${voted}/${need})`;
  const status = document.getElementById('rematchStatus');
  if (status) status.textContent = `Rematch: ${voted}/${need} accepted.`;
}

function popReaction(m: ReactionShowMsg) {
  const pops = document.getElementById('reactPops');
  if (!pops) return;
  const who = seriesPlayers[m.slot]?.name?.split(' ')[0] ?? '';
  const el = document.createElement('div');
  el.textContent = `${m.emoji} ${who}`.trim();
  el.style.cssText = `position:absolute;left:${10 + Math.random() * 62}%;bottom:24%;opacity:1;font-family:Bungee,system-ui,sans-serif;font-size:22px;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.7);transition:transform 1.8s ease-out,opacity 1.8s ease-out;`;
  pops.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateY(-130px)'; el.style.opacity = '0'; });
  setTimeout(() => el.remove(), 1900);
}

function startCountdown(sec: number) {
  stopCountdown();
  let n = Math.max(1, Math.round(sec));
  const set = (t: string) => { const e = document.getElementById('serCount'); if (e) e.textContent = t; };
  set(String(n));
  countdownTimer = setInterval(() => {
    n -= 1;
    set(n > 0 ? String(n) : 'GO!');
    if (n <= 0) stopCountdown();
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
