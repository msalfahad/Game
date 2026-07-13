# Bash Arena

Original 2–4 player arcade party game — themed 3D arenas, invisible-stick
controls, fast matches vs bots. Built with **Three.js + TypeScript + Vite**.

**33 mini-games** across the 7 spec families (SPEC section 5) + a Classic
bonus family, plus a Surface Lab greybox. Every game is you vs 3 bots at 4
difficulty tiers.

## The 33 games

| Family | Games (tier 1 → 4) |
|---|---|
| ❄️ Frostbite Arena | Ice Hockey Brawl · Slip & Slide · Snowball Smash · Avalanche Run |
| 🌋 Inferno Arena | Lava Hockey · Floor Is Lava · Blast Zone · Volcano Rush |
| 🏜️ Dune Clash | Sand Soccer · Shifting Sands · Cactus Chaos · Oasis Dash |
| 🌲 Wildwood Arena | Tree Top Tumble · Rolling Logs · Poison Pond · Jungle Race |
| ☁️ Sky Island Arena | Cloud Soccer · Falling Platform · Wind Gauntlet · Sky Race |
| ⚙️ Mech Factory | Gear Bash · Laser Dodge · Robot Rumble · Conveyor Chaos |
| 🏴‍☠️ Pirate Cove | Cannon Blast · Sinking Ship · Treasure Scramble · Pirate Race |
| 🎪 Classic Arena | Ring Rumble · Gem Grab · Paint Panic · Crate Brawl · Mallet Mash |

Nine reusable mechanics power them: goal-defense, break-tiles, push-out,
throw-fight, race, dodge, collect, paint, mash — each themed by its family
(floor style, sky, props, ambient particles, surface physics) and its hazard
ramp (wind, falling debris, rollers, geysers, lasers) that escalates over the
match.

## Systems

- **8 heroes** with design-bible stats (SPD/STR/ACC/DEF, ≤15% mechanical
  spread, identical hitboxes) and **working ultimates**: Lightning Blink, Fire
  Spin, Phantom Clone (decoy), Stellar Burst, Root Cage, Healing Grove, Frozen
  Ground Slam, Rolling Fortress.
- **Power-ups with anti-snowball** — Speed / Shield / Giant / Magnet / Heal
  spawn ~every 20s at the spot **farthest from the current leader**.
- **Movement + surfaces** — walk/sprint/jump/double-jump/dash/dive with
  momentum over metal, ice, mud, sand and conveyors.
- **Camera** — ~35° isometric, aspect-aware zoom, accessibility shake slider,
  quality tiers Low–Ultra.
- **Input** — keyboard (WASD/arrows · Space = ⚡ · Shift = jump), gamepad, and
  touch (floating analog stick + hidden 1:1 drag for hockey; right-side tap = ⚡).
- **Live tuning panel** (⚙️ on the title screen) — match length, hazard
  intensity, power-up rate, move speed, bot skill; persisted per device. This
  is the "adjust it before the app store" dial set.

Character sprites live in `public/chars/*.webp`, billboarded onto hover discs
(the spec's accepted greybox fallback until rigged `.glb` models exist).

## Run & preview

```bash
npm install
npm run dev           # dev server at http://localhost:5173
npm run build         # typecheck + production build to dist/
npm run preview       # serve the production build
npm run build:single  # dist/bash-arena-single.html — ONE self-contained file,
                      # sprites embedded, works from a double-click. Share it,
                      # email it, drop it anywhere; nothing can get separated.
```

**GitHub Pages**: `.github/workflows/deploy.yml` builds and deploys on every
push. One-time setup: repo **Settings → Pages → Source: GitHub Actions**. Then
play at `https://<user>.github.io/<repo>/` from any phone/tablet/desktop.

## Multiplayer (online play)

The `server/` folder is a Node + Socket.IO multiplayer server:

- **Accounts** — pick a username once; a private device token stored in the
  browser is your sign-in. XP / games / wins tracked per account.
- **Quick Play** — press 🌐 PLAY ONLINE → QUICK PLAY: you join a queue; when 4
  players gather (or after 12 s) a match starts on a random online map, with
  **bots filling empty seats**. A dropped player's seat becomes a bot.
- **Party rooms** — CREATE PARTY gives a 4-letter code; friends JOIN PARTY
  with the code; the host starts the match.
- **Modes** — the host picks ⚔️ Free-for-all (1v1v1v1, everyone against
  everyone) or 🤝 2 vs 2 (Team Blue vs Team Red). In 2v2 players can switch
  sides in the lobby (max 2 per team), bots balance uneven teams, teammates
  can't knock each other out, and ultimates only hit the enemy team.
- **Netcode** — the server runs an authoritative 20 Hz simulation; clients
  send inputs at 30 Hz, predict their own hero locally, and interpolate
  rivals ~120 ms behind. Online v1 covers the pushout games (Ring Rumble,
  Tree Top Tumble); the other mechanics come next.

Run it locally (serves the game AND the server on one port):

```bash
npm run build            # build the client
cd server && npm install && npm run build && npm start
# open http://localhost:3001
```

Deploy for friends: push to GitHub, then on [Render](https://render.com) choose
**New + → Blueprint** and pick this repo (`render.yaml` configures everything;
free plan works for playtesting). You get a URL like
`https://bash-arena.onrender.com` — share that link and everyone plays there.
Playing from GitHub Pages instead? Open the Pages URL once as
`https://<user>.github.io/Game/?server=https://your-app.onrender.com` — the
server address is remembered on that device.

## Path to the app stores

The game is a standard web app, so the proven route is:
1. Tune & playtest via the web preview (Pages URL or the single file).
2. Wrap with [Capacitor](https://capacitorjs.com) (`npx cap add ios android`)
   to ship the same build as native iOS/Android apps.
3. Add app icons/splash, then submit via Xcode / Play Console.

## Project layout

```
src/
  core/     engine, isometric camera, input, audio, tuning
  data/     heroes, surfaces, families + 33-game catalog
  game/     match, player, physics, world, textures, hazards,
            freeroam helpers, ultimates, power-ups
    games/  the 9 mechanic modules + surface lab
  ui/       screens (menu flow + tuning drawer), hud, styles
scripts/    build-single.mjs (one-file build)
public/chars/  the 8 character sprites
```

## Not yet built (next per the spec)

Rigged `.glb` hero models + animations; online (FFA + 2v2) netcode;
Tournament/Survival modes; progression/cosmetics; adaptive music; 2v2 teams.
