# Game backgrounds

`buildWorld` (src/game/world.ts) looks for background art in this order and
uses the first that loads:

1. `public/maps/<gameId>-bg.webp` — a picture for one specific game
2. `public/maps/<family>-bg.webp` — portrait picture for the whole family
3. `public/maps/<family>.webp`    — the wide card art (fallback)

Pictures are fitted "cover"-style (cropped, never stretched) and the ground
fades to a soft halo around the board so the scenery shows through. Games that
draw their own scenery (raft, coaster, sprint, foosball) keep a flat sky; the
night maze (Night Heist) only uses `dune-4-bg.webp`. The ground halo is sized
per camera: tight for top-down boards, by width for the climb corridor.
Portrait pictures get a gentler brightness boost (1.6) than card art (2.6).

## Portrait (3:4) backgrounds — generated in Higgsfield, all delivered

| File | Used by |
|---|---|
| `inferno-bg.webp` | Lava Hockey, Floor Is Lava, Blast Zone |
| `dune-bg.webp` | Race Kart, Musical Chairs, The Great Escape |
| `wildwood-bg.webp` | River Rush, Rolling Logs, Watermelon Bomb |
| `sky-bg.webp` | Dodge Brawl, Wind Gauntlet |
| `mech-bg.webp` | Gear Bash, Laser Dodge, Robot Rumble, Conveyor Chaos |
| `pirate-bg.webp` | Cannon Blast, Sinking Ship, Treasure Scramble |
| `classic-bg.webp` | Ring Rumble, Gem Grab, Paint Panic, Crate Brawl, Mallet Mash |
| `dune-4-bg.webp` | Night Heist |
| `frost-4-bg.webp` | Avalanche Run |
| `inferno-4-bg.webp` | Volcano Rush |

Each is 1200px wide WebP (~170-530 KB). `frost-bg.webp` (896x1200) covers the
other Frostbite games.
