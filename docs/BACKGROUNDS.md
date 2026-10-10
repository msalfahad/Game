# Game backgrounds

`buildWorld` (src/game/world.ts) looks for background art in this order and
uses the first that loads:

1. `public/maps/<gameId>-bg.png`  — a picture for one specific game
2. `public/maps/<family>-bg.png`  — portrait picture for the whole family
3. `public/maps/<family>.webp`    — the wide card art (fallback)

Pictures are fitted "cover"-style (cropped, never stretched) and the ground
fades to a soft halo around the board so the scenery shows through. Games that
draw their own scenery (raft, coaster, sprint, foosball) keep a flat sky; the
night maze (Night Heist) only uses `dune-4-bg.png`.

## Pending portrait (3:4) backgrounds — generated in Higgsfield

| File | Used by |
|---|---|
| `inferno-bg.png` | Lava Hockey, Floor Is Lava, Blast Zone |
| `dune-bg.png` | Race Kart, Musical Chairs, The Great Escape |
| `wildwood-bg.png` | River Rush, Rolling Logs, Watermelon Bomb |
| `sky-bg.png` | Dodge Brawl, Wind Gauntlet |
| `mech-bg.png` | Gear Bash, Laser Dodge, Robot Rumble, Conveyor Chaos |
| `pirate-bg.png` | Cannon Blast, Sinking Ship, Treasure Scramble |
| `classic-bg.png` | Ring Rumble, Gem Grab, Paint Panic, Crate Brawl, Mallet Mash |
| `dune-4-bg.png` | Night Heist |
| `frost-4-bg.png` | Avalanche Run |
| `inferno-4-bg.png` | Volcano Rush |

Optimize each to ~1200px wide WebP/PNG before committing (the Frostbite one is
896x1200).
