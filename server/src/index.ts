import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { loadAccounts, hello } from './accounts.js';
import { Lobby } from './rooms.js';
import type { HelloMsg, WelcomeMsg } from './protocol.js';

// Bash Arena multiplayer server. Serves the built client from ../dist (when
// present, e.g. on Render) and runs accounts + rooms + quick-play + matches
// over Socket.IO. GitHub Pages clients connect cross-origin, so CORS is open.

const PORT = Number(process.env.PORT ?? 3001);

const app = express();
// The client build lives at repo-root/dist. Depending on where the server is
// started from (repo root on Render, server/ in dev), probe for index.html.
const distDir = [join(process.cwd(), 'dist'), join(process.cwd(), '..', 'dist')]
  .find((d) => existsSync(join(d, 'index.html')));
if (distDir) {
  app.use(express.static(distDir));
  console.log('serving client from', distDir);
}
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const http = createServer(app);
const io = new Server(http, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

loadAccounts();
const lobby = new Lobby();

io.on('connection', (socket) => {
  let authed = false;

  socket.on('hello', (msg: HelloMsg, cb?: (w: WelcomeMsg) => void) => {
    const acc = hello(msg?.token, msg?.name);
    lobby.addSession(socket, acc);
    authed = true;
    const welcome: WelcomeMsg = {
      token: acc.token,
      id: acc.id,
      name: acc.name,
      xp: acc.xp,
      games: acc.games,
      wins: acc.wins,
    };
    if (cb) cb(welcome);
    else socket.emit('welcome', welcome);
  });

  const guard = (fn: () => void) => () => { if (authed) fn(); };
  const guard1 = <T>(fn: (arg: T) => void) => (arg: T) => { if (authed) fn(arg); };

  socket.on('hero', guard1<string>((heroKey) => lobby.setHero(socket.id, heroKey)));
  socket.on('queue:join', guard(() => lobby.joinQueue(socket.id)));
  socket.on('queue:leave', guard(() => lobby.leaveQueue(socket.id)));
  socket.on('room:create', guard1<(code: string | null) => void>((cb) => {
    const code = lobby.createRoom(socket.id);
    if (typeof cb === 'function') cb(code);
  }));
  socket.on('room:join', (code: string, cb?: (ok: string | null) => void) => {
    if (!authed) return;
    const joined = lobby.joinRoom(socket.id, code);
    if (typeof cb === 'function') cb(joined);
  });
  socket.on('room:leave', guard(() => lobby.leaveRoom(socket.id)));
  socket.on('room:mode', guard1<string>((mode) => lobby.setRoomMode(socket.id, mode as 'ffa' | '2v2')));
  socket.on('room:game', guard1<string>((gameId) => lobby.setRoomGame(socket.id, String(gameId))));
  socket.on('room:team', guard(() => lobby.toggleTeam(socket.id)));
  socket.on('room:start', guard(() => lobby.startRoom(socket.id)));
  socket.on('input', (msg: unknown) => lobby.handleInput(socket.id, msg));
  // Series: between-game reactions, the all-vote rematch, and leaving to find a new game.
  socket.on('reaction', guard1<string>((emoji) => lobby.sendReaction(socket.id, emoji)));
  socket.on('rematch:vote', guard(() => lobby.voteRematch(socket.id)));
  socket.on('series:leave', guard(() => lobby.leaveSeries(socket.id)));

  socket.on('disconnect', () => lobby.disconnect(socket.id));
});

http.listen(PORT, () => console.log(`bash-arena server on :${PORT}`));
