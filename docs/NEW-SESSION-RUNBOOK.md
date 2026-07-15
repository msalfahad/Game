# New-Session Runbook — Bash Arena

_A fresh session runs this top-to-bottom to get oriented, confirm the build is
healthy, and pick up the right next task. Keep it current: when the project's
structure, priorities, or commands change, update this file in the same PR._

---

## 0. TL;DR (30 seconds)

Bash Arena is an original 2–4 player Crash-Bash-style party game.
**Client:** Three.js r160 + TypeScript + Vite. **Server:** Node + Socket.IO
(authoritative 20 Hz sim). **33 mini-games / 8 families**, online + offline,
bots fill empty seats. Functionally complete; current work is a
**gameplay-preserving AAA presentation pass** (see `docs/PROJECT_AUDIT.md`).

- Play locally: `npm install && npm run dev` → http://localhost:5173
- Never change mini-game **rules or layouts** unless explicitly asked — the
  audit and all in-flight work are presentation/feel/netcode/code-health only.

---

## 1. Orient (read these, in order)

1. `README.md` — what the game is, the 33 games, systems, how to run/deploy.
2. `docs/PROJECT_AUDIT.md` — the standing audit: problems found, the ordered
   technical tasks (T1–T12), risks, and **§10 Next Priority**. This is the
   source of truth for *what to work on next*.
3. `git log --oneline -15` — what the last few sessions actually shipped.
   (Recent line: cinematic post-processing stack + animated skydome, "zero
   credits" AAA visual passes.)

## 2. Confirm the environment is healthy

```bash
npm install            # client deps (three, vite, typescript)
npm run typecheck      # tsc --noEmit — must be clean before you touch code
npm run build          # typecheck + production build to dist/
```

Server (only if you're touching multiplayer):

```bash
cd server && npm install && npm run typecheck && npm run build
```

If any of these fail on a *fresh* checkout, that's the first thing to fix —
report it before starting feature work.

## 3. Know where things live

```
src/
  core/     engine, isometric camera, input, audio, tuning, post-processing
  data/     heroes, surfaces, families + the 33-game catalog
  game/     match, player, physics, world, textures, hazards, ultimates, power-ups
    games/  the 9 mechanic modules + surface lab
  net/      client-side netcode (prediction, reconciliation, interpolation)
  ui/       screens (menu flow + tuning drawer), hud, styles
server/     Node + Socket.IO: accounts, rooms, matchmaking, authoritative sim
scripts/    build-single.mjs (one self-contained HTML build)
public/chars/  the 8 character sprites (.webp, billboarded)
docs/       PROJECT_AUDIT.md, this runbook
```

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server, hot reload, http://localhost:5173 |
| `npm run build` | Typecheck + production build → `dist/` |
| `npm run preview` | Serve the production build |
| `npm run build:single` | `dist/bash-arena-single.html` — one shareable file |

Run the full stack (client + server on one port) exactly as `README.md` §Multiplayer shows.

## 4. Guardrails (do not violate)

- **Preserve every mini-game's rules and layout.** All current work is
  graphics, animation, audio, netcode robustness, code quality, and docs.
- **Keep the art style locked.** One master style token (audit §7); re-roll
  off-style generations rather than letting the look drift.
- **Watch generation credits.** Higgsfield credits are finite (audit §8 risk
  #1): do a small vertical slice, get sign-off, *then* scale in batches. Never
  "generate everything" up front. Video/3D generation is gated behind explicit
  user approval.
- **Two open user decisions** live in the audit and block spend until answered:
  - **Characters Path A vs B** (polish 2D sprites vs full rigged 3D) — audit §3.5 / §8.
  - Reconnect Higgsfield before any generation-bound task.
- **Client/server constant drift is a known bug source** (audit §Code Quality).
  If you edit a shared constant (arena geometry, projectile tables, hero data),
  change it in **both** places or the game desyncs.

## 5. Pick the next task

Default to `docs/PROJECT_AUDIT.md` **§10 Next Priority** and the T1–T12 table
(§4), respecting the dependency column. As of the last audit update the visual
passes T1 (post-processing) and part of T3 (skydome) have landed; consult
`git log` for the true latest state before assuming what's done.

If the user gave you a specific task, that wins — this runbook is only the
default when no direction is given.

## 6. Ship it

1. Work on your assigned feature branch (never commit straight to `main`).
2. `npm run typecheck && npm run build` must pass before you commit.
3. If the change has runtime behavior, actually run the app and confirm it
   (dev server or the single-file build), don't rely on typecheck alone.
4. Commit with a clear, scoped message; push with `git push -u origin <branch>`.
5. Only open a PR if the user asks.
6. Update `docs/PROJECT_AUDIT.md` (and this runbook if the process changed) when
   a task or priority moves.

---

_Last updated: 2026-07-15. Keep the TL;DR, guardrails, and §5 priorities in sync
with `docs/PROJECT_AUDIT.md` as the project evolves._
