import { HEROES, heroImg, type Hero } from '../data/characters';
import { net, resolveServerUrl, rememberServerUrl, savedName } from '../net/client';
import type { MatchEndMsg, MatchStartMsg } from '../net/protocol';
import { show, hideScreens } from './screens';

// Online screens: sign-in (once), quick-play queue, and party rooms with
// 4-letter codes. Kept separate from the local-play flow in screens.ts.

interface OnlineHooks {
  onMatchStart: (m: MatchStartMsg) => void;
}

let hooks: OnlineHooks;
let hero: Hero = HEROES[0];

const ids = ['scrOnlineHome', 'scrQueue', 'scrParty', 'scrOnlineOver'];
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
    <div class="vsRow" id="partyList"></div>
    <button class="big" id="partyStart">START MATCH ▶</button>
    <button class="alt" id="partyLeave">LEAVE</button>
  </div>

  <div id="scrOnlineOver" class="screen hidden">
    <h2 id="onlineOverTitle">RESULTS</h2>
    <p class="tag">Online match complete.</p>
    <div id="onlineResList"></div>
    <button class="big" id="onlineAgain">PLAY AGAIN</button>
    <button class="alt" id="onlineHome">ONLINE MENU</button>
  </div>`;
  root.appendChild(wrap);

  // Hero picker for online play.
  const grid = document.getElementById('onlineCharGrid')!;
  HEROES.forEach((hh, i) => {
    const d = document.createElement('div');
    d.className = 'cc' + (i === 0 ? ' sel' : '');
    d.innerHTML = `<img src="${heroImg(hh)}"><div class="n" style="color:${hh.col}">${hh.name.toUpperCase()}</div>`;
    d.onclick = () => {
      hero = hh;
      grid.querySelectorAll('.cc').forEach((e) => e.classList.remove('sel'));
      d.classList.add('sel');
      net.setHero(hh.key);
    };
    grid.appendChild(d);
  });

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
  document.getElementById('partyLeave')!.addEventListener('click', () => {
    net.leaveRoom();
    showOnline('scrOnlineHome');
  });
  document.getElementById('onlineAgain')!.addEventListener('click', () => showOnline('scrOnlineHome'));
  document.getElementById('onlineHome')!.addEventListener('click', () => showOnline('scrOnlineHome'));

  // Lobby events.
  net.cb.onQueue = (m) => {
    const el = document.getElementById('queueStatus');
    if (!el) return;
    const botNote = m.botFillInSec >= 0 ? ` Starting with bots in ${m.botFillInSec}s…` : '';
    el.textContent = `${m.count}/${m.needed} players in queue.${botNote}`;
  };
  net.cb.onRoom = (m) => {
    document.getElementById('partyCode')!.textContent = m.code;
    const list = document.getElementById('partyList')!;
    list.innerHTML = '';
    for (const p of m.players) {
      const hh = HEROES.find((x) => x.key === p.heroKey) ?? HEROES[0];
      const d = document.createElement('div');
      d.className = 'vsCard' + (p.you ? ' you' : '');
      d.innerHTML = `<img src="${heroImg(hh)}"><div class="n" style="color:${hh.col}">${p.name}${p.host ? ' 👑' : ''}${p.you ? '<br>(YOU)' : ''}</div>`;
      list.appendChild(d);
    }
    const start = document.getElementById('partyStart') as HTMLButtonElement;
    const meHost = m.players.some((p) => p.you && p.host);
    start.style.display = meHost ? '' : 'none';
  };
  net.cb.onMatchStart = (m) => {
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
  try {
    document.getElementById('loading')!.style.display = 'flex';
    await net.connect(server, name);
    showOnline('scrOnlineHome');
    refreshWho();
  } catch (e) {
    show('scrTitle');
    alert((e as Error).message + '\nCheck the server URL (see README → Multiplayer).');
    localStorage.removeItem('ba-server');
  } finally {
    document.getElementById('loading')!.style.display = 'none';
  }
}

function refreshWho() {
  const el = document.getElementById('onlineWho');
  if (el && net.me) el.textContent = `Signed in as ${net.me.name} · ${net.me.xp} XP · ${net.me.wins} wins in ${net.me.games} games`;
}

/** Results screen for online matches. */
export function showOnlineResults(m: MatchEndMsg, youSlot: number) {
  const youWon = m.ranking[0]?.slot === youSlot;
  document.getElementById('onlineOverTitle')!.textContent = youWon ? '🏆 YOU WIN!' : 'RESULTS';
  const list = document.getElementById('onlineResList')!;
  list.className = '';
  list.innerHTML = '';
  m.ranking.forEach((r, i) => {
    const hh = HEROES.find((x) => x.key === r.heroKey) ?? HEROES[0];
    const d = document.createElement('div');
    d.className = 'resRow' + (i === 0 ? ' first' : '');
    d.innerHTML = `<img src="${heroImg(hh)}"><div class="rn" style="color:${hh.col}">${i + 1}. ${r.name}${r.slot === youSlot ? ' (YOU)' : ''}</div><div class="rs">${r.dead ? 'OUT' : r.lives + ' lives'}</div>`;
    list.appendChild(d);
  });
  (list as HTMLElement).style.display = 'flex';
  (list as HTMLElement).style.flexDirection = 'column';
  (list as HTMLElement).style.gap = '8px';
  showOnline('scrOnlineOver');
}
