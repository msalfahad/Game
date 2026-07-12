# Bash Arena

Original 2–4 player arcade party game — themed 3D arenas, invisible-stick
controls, fast matches vs bots. Built with **Three.js + TypeScript + Vite**.

This is the **greybox foundation** (build-order steps 1–2 of `CLAUDE-CODE-SPEC.md`):
the core engine + the first family end-to-end. It is designed to grow into the
full 28-mini-game / 7-family game described in the spec.

## What's implemented

- **Core engine** — WebGL renderer, ~35° isometric camera with aspect-aware
  dynamic zoom (whole arena + all players fit any screen; portrait pulls back)
  and an accessibility camera-shake slider; quality tiers (Low–Ultra).
- **Input** — unified movement axis from keyboard (WASD/arrows, Space = ability,
  Shift = jump), gamepad (left stick + face buttons), and touch: a floating
  analog stick that fades in under the thumb, plus a hidden 1:1 direct-drag mode
  for the hockey paddle. Tap the right side of the screen for your ability.
- **Movement + surfaces** — walk / sprint / jump / double-jump / dash / dive with
  momentum, over five surfaces: metal (neutral), ice (slides), mud (slows),
  sand (drifts), conveyor (pushes).
- **8 heroes** — bible stats (SPD/STR/ACC/DEF) and ultimates from the design
  bible. Identical hitboxes; stats are normalized so no hero has more than a
  ~15% mechanical advantage.
- **Frostbite Arena family** — **Ice Hockey Brawl** playable end-to-end across
  the 4 difficulty-ramp maps (Learn → Adapt → Master → Survive), each adding
  hazards: blizzard (curves the puck / shoves paddles), falling icicles, and
  sliding boulders. Bots at 4 difficulty tiers (Easy/Normal/Hard/Expert) using
  a reaction-lapse / aim-error / speed-cap model.
- **Surface Lab** — a greybox free-roam mode to feel the movement + surface
  systems (four labelled quadrants + a conveyor strip).
- **Match flow** — title → hero select → game/map picker → versus → live match
  with HUD (corner panels, timer, objective, banners, ability hint) → results.
- **Audio** — synthesized original SFX with a mute toggle.

Character sprites live in `public/chars/*.webp` and are billboarded onto hover
discs (the spec's accepted greybox fallback until rigged `.glb` models exist).

## Run

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
```

> The UI references Google Fonts (Bungee/Nunito). If your environment blocks
> external fonts it falls back gracefully to system fonts.

## Project layout

```
src/
  core/     engine, isometric camera, input, audio
  data/     heroes, surfaces, map/family definitions
  game/     match orchestration, player, physics, world, textures, hazards
    games/  hockey (Frostbite 1.1), surfacelab (movement greybox)
  ui/       screens (menu flow), hud, styles
public/chars/  the 8 character sprites
```

## Not yet built (next per the spec)

Rigged `.glb` hero models + animations; the other 3 Frostbite games (Slip &
Slide, Snowball Smash, Avalanche Run) and the remaining 6 families; power-up
economy + anti-snowball; online (FFA + 2v2) netcode; Tournament/Survival modes;
progression/cosmetics; adaptive music.
