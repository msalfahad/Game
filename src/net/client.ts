import { io, type Socket } from 'socket.io-client';
import type {
  InputMsg, MatchEndMsg, MatchStartMsg, QueueUpdateMsg, RoomUpdateMsg, StateMsg, WelcomeMsg,
} from './protocol';

// Connection manager: resolves the server URL, signs in with the stored
// device token (creating the account on first run), and exposes the lobby +
// match events to the UI and the online match controller.

const TOKEN_KEY = 'ba-token';
const NAME_KEY = 'ba-name';
const SERVER_KEY = 'ba-server';

export function savedName(): string | null {
  return localStorage.getItem(NAME_KEY);
}

/**
 * Where's the server? Same origin when the Node server serves the client;
 * `?server=` URL param or a remembered value otherwise (needed when the
 * client is on GitHub Pages and the server is on Render/Fly/Railway).
 */
export function resolveServerUrl(): string | null {
  const qs = new URLSearchParams(location.search).get('server');
  if (qs) {
    localStorage.setItem(SERVER_KEY, qs);
    return qs;
  }
  const saved = localStorage.getItem(SERVER_KEY);
  if (saved) return saved;
  if (location.protocol === 'file:' || location.hostname.endsWith('github.io')) return null;
  return location.origin;
}

export function rememberServerUrl(url: string) {
  localStorage.setItem(SERVER_KEY, url.trim().replace(/\/$/, ''));
}

export interface NetCallbacks {
  onQueue?: (m: QueueUpdateMsg) => void;
  onRoom?: (m: RoomUpdateMsg) => void;
  onMatchStart?: (m: MatchStartMsg) => void;
  onState?: (m: StateMsg) => void;
  onMatchEnd?: (m: MatchEndMsg) => void;
  onDisconnect?: () => void;
}

export class Net {
  socket: Socket | null = null;
  me: WelcomeMsg | null = null;
  cb: NetCallbacks = {};

  get connected(): boolean {
    return !!this.socket?.connected && !!this.me;
  }

  /**
   * Connect + sign in. Resolves once the account handshake completes.
   * Free-tier hosts (Render) sleep when idle and take up to ~1 min to wake,
   * so we retry connect errors until an overall 75s deadline.
   */
  connect(serverUrl: string, name: string): Promise<WelcomeMsg> {
    return new Promise((resolve, reject) => {
      const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        timeout: 10000,
        reconnectionAttempts: 8,
        reconnectionDelay: 2000,
      });
      this.socket = socket;
      const fail = (why: string) => {
        socket.close();
        this.socket = null;
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('Could not reach the server.'), 75000);
      socket.on('connect', () => {
        socket.emit('hello', { token: localStorage.getItem(TOKEN_KEY) ?? undefined, name }, (w: WelcomeMsg) => {
          clearTimeout(timer);
          this.me = w;
          localStorage.setItem(TOKEN_KEY, w.token);
          localStorage.setItem(NAME_KEY, w.name);
          resolve(w);
        });
      });
      socket.on('queue:update', (m: QueueUpdateMsg) => this.cb.onQueue?.(m));
      socket.on('room:update', (m: RoomUpdateMsg) => this.cb.onRoom?.(m));
      socket.on('match:start', (m: MatchStartMsg) => this.cb.onMatchStart?.(m));
      socket.on('state', (m: StateMsg) => this.cb.onState?.(m));
      socket.on('match:end', (m: MatchEndMsg) => this.cb.onMatchEnd?.(m));
      socket.on('disconnect', () => this.cb.onDisconnect?.());
    });
  }

  setHero(heroKey: string) {
    this.socket?.emit('hero', heroKey);
  }
  joinQueue() {
    this.socket?.emit('queue:join');
  }
  leaveQueue() {
    this.socket?.emit('queue:leave');
  }
  createRoom(): Promise<string | null> {
    return new Promise((res) => this.socket?.emit('room:create', (code: string | null) => res(code)));
  }
  joinRoom(code: string): Promise<string | null> {
    return new Promise((res) => this.socket?.emit('room:join', code, (ok: string | null) => res(ok)));
  }
  leaveRoom() {
    this.socket?.emit('room:leave');
  }
  setRoomMode(mode: 'ffa' | '2v2') {
    this.socket?.emit('room:mode', mode);
  }
  toggleTeam() {
    this.socket?.emit('room:team');
  }
  startRoom() {
    this.socket?.emit('room:start');
  }
  sendInput(msg: InputMsg) {
    this.socket?.emit('input', msg);
  }
}

export const net = new Net();
