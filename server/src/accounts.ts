import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Device-token accounts: sign in once with a username, get a private token
// the client stores; every later connection with that token is the same
// account. Email attach / recovery is a later upgrade — the token IS the
// credential for v1. Persisted to a JSON file (note: on free hosts with
// ephemeral disks this resets on redeploy — fine for playtesting).

export interface Account {
  id: string;
  token: string;
  name: string;
  xp: number;
  games: number;
  wins: number;
  createdAt: string;
}

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'server-data');
const FILE = join(DATA_DIR, 'accounts.json');

const byToken = new Map<string, Account>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadAccounts() {
  try {
    if (existsSync(FILE)) {
      const arr: Account[] = JSON.parse(readFileSync(FILE, 'utf8'));
      for (const a of arr) byToken.set(a.token, a);
      console.log(`accounts: loaded ${byToken.size}`);
    }
  } catch (e) {
    console.error('accounts: load failed', e);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FILE, JSON.stringify([...byToken.values()]));
    } catch (e) {
      console.error('accounts: save failed', e);
    }
  }, 2000);
}

function sanitizeName(raw: string | undefined): string {
  const name = (raw ?? '').replace(/[^\w\- ]/g, '').trim().slice(0, 16);
  return name || 'Basher' + Math.floor(Math.random() * 9000 + 1000);
}

/** Resolve or create the account for a hello message. */
export function hello(token: string | undefined, name: string | undefined): Account {
  if (token) {
    const existing = byToken.get(token);
    if (existing) {
      if (name && sanitizeName(name) !== existing.name) {
        existing.name = sanitizeName(name);
        scheduleSave();
      }
      return existing;
    }
  }
  const acc: Account = {
    id: randomUUID().slice(0, 8),
    token: randomUUID(),
    name: sanitizeName(name),
    xp: 0,
    games: 0,
    wins: 0,
    createdAt: new Date().toISOString(),
  };
  byToken.set(acc.token, acc);
  scheduleSave();
  return acc;
}

export function recordResult(token: string, won: boolean) {
  const acc = byToken.get(token);
  if (!acc) return;
  acc.games++;
  acc.xp += won ? 50 : 15;
  if (won) acc.wins++;
  scheduleSave();
}
