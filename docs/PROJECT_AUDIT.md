# Bash Arena — Project Audit

_Audit date: 2026-07-14 · Auditor: Claude (acting Game/Technical/Art/Audio Director)_

> Scope note: This audit **preserves all existing mini-game rules and layouts**.
> It targets graphics, animation, audio, networking, code quality, game feel and
> documentation only. No mechanic is redesigned here.

---

## 1. Executive Summary

Bash Arena is an **original** 2–4 player Crash-Bash-style online party game built
on **Three.js r160 + TypeScript + Vite** (client) and **Node.js + Socket.IO**
(authoritative server). It ships **34 mini-games across 9 families**, full online
play (quick-play matchmaking, party rooms with codes, FFA + 2v2), an offline
mode, a live tuning panel, and a one-URL Render deployment plus a single-file
shareable build.

The **engine is already 3D** — arenas, props, hazards, projectiles and the
victory ceremony are real meshes with dynamic lighting and shadows. The one
element that is **not** 3D is the **characters**, which render as the user's
2D art animated as frame-swapped billboard planes (a deliberate earlier choice
to preserve the supplied character art).

The project is **functionally complete and fun**, but visually reads as
"clean stylized indie," not "AAA stylized-realism." The biggest levers for a
premium look are: (a) PBR materials + post-processing on the already-3D
environments, and (b) optionally upgrading characters from 2D sprites to rigged
3D models. Audio is currently minimal (synth SFX, no music, no per-character
voice).

**Overall production health: strong foundation, thin presentation layer.**

---

## 2. Problems Found

### Rendering / Art
- **Flat materials.** Most meshes use `MeshStandardMaterial` with solid colors,
  no texture maps, no normal/roughness/metalness maps → no PBR surface detail.
- **No post-processing.** No bloom, tone mapping, SSAO, color grading, vignette
  or depth-of-field. Lighting is a single directional + ambient.
- **Gradient skyboxes.** Skies are 2-stop vertical gradients, not HDRI/painted
  skyboxes; no cloud, aurora, heat-haze or parallax depth.
- **Characters are 2D** billboard planes. They read well at the fixed iso angle
  but have no real volume, self-shadowing, or facial animation.
- **Particles are cubes.** Bursts/embers/snow use untextured box or sprite
  particles; no soft additive textures, trails or ribbon VFX.
- **Surfaces don't "feel" like their material** — ice, sand, snow, lava are
  color-tinted flat planes, not textured/normal-mapped realistic surfaces.

### Audio
- **No music.** No menu theme, no in-match adaptive score, no stingers.
- **Synth-only SFX** generated in code (`src/core/audio.ts`); functional but not
  premium or characterful.
- **No per-character voice** or signature sound. No hit/jump/win voice barks.
- **No spatial/positional audio.**

### Animation / Game Feel
- Character animation is a solid 8-frame walk/run cycle but has **no jump/land
  squash on the sprite, no anticipation, no facial expressions**.
- **No screen-space juice**: limited hit-stop, no chromatic aberration on
  impact, no controller rumble mapping.

### Networking
- Prediction + reconciliation + 120ms interpolation are implemented and solid,
  but there is **no reconnect/resume** after a socket drop, **no server-side
  input-rate anti-cheat clamping beyond basic clamps**, and **no lag
  compensation** for hit registration.

### Code Quality / Architecture
- **Duplicated constants** across client/server (CLIMB_L, HALF, sign/rink
  geometry, PROJ tables) kept in sync by hand — drift-prone. Several bugs this
  session came from exactly this.
- **No shared package** between client and server; protocol + hero data +
  catalog are copy-pasted in two places.
- **No automated tests** (unit, integration, or netcode simulation).
- **Powerups/traps are partly data-driven** but hit-effects and durations are
  sprinkled across mechanic files rather than a single registry.

### UI/UX
- HUD is clean but **not premium**: flat panels, no motion design, no rank
  transitions, no kill/hit feed polish, no controller-navigable menus.
- **No settings depth** (rebind, audio mixers, accessibility beyond shake).

---

## 3. Improvements (proposed, gameplay-preserving)

### Visual (highest ROI, environments are already 3D)
1. **Add a post-processing stack** (`EffectComposer`): ACES tone mapping, bloom,
   SSAO, subtle vignette + color grade per family. _Single biggest look upgrade._
2. **PBR material pass**: albedo + normal + roughness maps on floors, walls,
   props. Generate tiling textures via Higgsfield (ice, snow, sand, lava rock,
   wood, metal).
3. **Painted/HDRI skyboxes** per family + volumetric-ish fog and god-rays.
4. **VFX upgrade**: soft additive particle textures, impact ribbons, ground
   decals for hits/landings, heat-haze over lava, snow accumulation.
5. **Character upgrade (needs user decision — see §8):** either
   - **Path A (keep 2D):** add rim-light, contact shadow, squash/stretch and
     Higgsfield-generated expression frames for win/lose. Cheap, fast, keeps
     approved art. OR
   - **Path B (go 3D):** Higgsfield `generate_3d` each hero from their
     turnaround → rigged GLB → replace the sprite puppet with a skinned mesh
     (idle/walk/run/jump/land/victory/defeat clips). Premium, expensive, large.

### Audio (Voice/Music/SFX Bibles — see §7 for prompts)
6. **Music Bible**: menu theme + one adaptive loop per family (9 tracks) with
   intensity layers; win/lose stingers.
7. **SFX Bible**: replace synth SFX with generated premium hits, whooshes,
   pickups, UI clicks, surface footsteps per material.
8. **Voice Bible**: per-character bark set (spawn, jump, hit, throw, win, lose)
   — 8 characters × ~6 barks. Distinct timbre per hero.

### Netcode / Systems
9. **Reconnect + resume** (rejoin token, snapshot catch-up).
10. **Unified data-driven power/trap registry** (kind → {duration, cd, vfx, sfx,
    apply, counterplay}) shared client+server.
11. **Shared workspace package** to kill the client/server duplication.

### UX
12. Premium HUD motion pass, controller-navigable menus, settings depth,
    accessibility (colorblind rings, reduce-motion, audio mixers).

---

## 4. Technical Tasks (ordered)

| # | Task | Area | Depends on |
|---|------|------|-----------|
| T1 | Add `EffectComposer` post stack (tone map, bloom, SSAO, grade) | Render | — |
| T2 | Generate + apply PBR texture sets per surface (Higgsfield) | Render/Art | Higgsfield |
| T3 | Generate + apply painted skyboxes per family (Higgsfield) | Render/Art | Higgsfield |
| T4 | Soft-particle + decal VFX system | Render | T1 |
| T5 | **Character decision A/B** then execute (see §8) | Art/Anim | user call |
| T6 | Audio engine: music bus + adaptive layers + spatial SFX | Audio | — |
| T7 | Generate Music/SFX/Voice bibles (Higgsfield) | Audio/Art | Higgsfield |
| T8 | Reconnect/resume + lag-comp hit reg | Netcode | — |
| T9 | Unified power/trap registry (shared) | Systems | T11 |
| T10 | HUD/UX premium pass + controller menus | UI | T1 |
| T11 | Extract shared client/server package (kill dup constants) | Arch | — |
| T12 | Netcode + gameplay unit/sim tests | Quality | T11 |

---

## 5. Gameplay Impact

- **Rules unchanged.** All improvements are presentation, feel, audio, netcode
  robustness and code health. No mini-game is redesigned.
- **Feel improves**: better hit-stop, VFX and audio feedback make existing
  mechanics read as more responsive and satisfying (perceived responsiveness),
  even though the simulation is untouched.
- **Readability improves**: PBR surfaces + lighting + colorblind rings make it
  clearer where you are, what surface you're on, and what's a hazard.

## 6. Performance Impact

- Post-processing + PBR + skyboxes raise GPU cost. Mitigations already partly in
  place (quality tiers in `engine.setQuality`). Budget: target 60fps desktop,
  30–60 mobile. SSAO/bloom become quality-gated; textures use compressed
  formats + mipmaps; particle counts scale with tier.
- **3D characters (Path B)** add skinning + draw calls (4–5 rigged meshes).
  Manageable at this player count but the single largest perf line item; 2D
  sprites (Path A) stay nearly free.
- Music/spatial audio: negligible CPU; watch memory for decoded tracks
  (stream/compress).

---

## 7. Higgsfield Prompts (one consistent art style)

**Master style token** (prepend to every prompt for consistency):
`Bash Arena style: stylized-realism, Astro Bot / Overwatch 2 / Ratchet & Clank
influence, chunky readable forms, PBR materials, warm cinematic key light +
cool rim, soft global illumination, high detail, clean silhouette, family-
friendly, 3D render, no text.`

### Characters (turnaround → for 2D frames OR 3D model input)
- _Per hero, reuse their identity._ Example (Zip):
  `<master token> full-body character turnaround sheet, front / 3-4 / side /
  back, T-pose and A-pose, "Zip" a nimble green speedster lizard with a red
  mohawk, goggles, moto jacket, sneakers; consistent proportions across all
  angles; neutral studio lighting; plain background for clean cutout.`
- Walk + run cycle sheets (8 frames each), idle, jump, land, victory dance,
  defeat — matching the existing sheet layout so my slicer ingests them.

### Maps / Skyboxes (keep layout, upgrade look)
- Frostbite: `<master token> panoramic sky + distant environment for an arctic
  arena, aurora borealis, snow flurries, ice cliffs, deep blue night, volumetric
  light.`
- Inferno/Volcano: `<master token> erupting volcano crater environment, glowing
  lava, ember storm, obsidian rock, heat haze, dramatic orange rim light.`
- Dune, Wildwood, Sky Island, Mech, Pirate, Classic-neon — one skybox each.

### Surface textures (tiling PBR)
- `<master token> seamless tileable PBR texture, cracked glacier ice, subtle
  subsurface blue, high normal detail, top-down, 2K.` (repeat: snow, sand, lava
  rock, forest ground, metal deck, ship wood, neon floor.)

### UI / Loading / Marketing
- Loading screens per family, key art / hero splash, logo lockup, results-screen
  frames, store/marketing hero shot — all with the master token.

### Cinematics (optional, credit-heavy)
- 5–8s intro sizzle per family via `generate_video` (gated behind approval).

_All prompts share the master style token so characters, maps and UI read as one
cohesive game._

---

## 8. Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Credit exhaustion** (1,010 credits ≠ "generate all" at AAA fidelity) | High | Vertical slice first, approve, then scale; batch + reuse; gate video/3D |
| **Art-style drift** across many generations | High | Locked master style token; approve slice; re-roll off-style outputs |
| **2D→3D character pivot reverses approved art** | High | **User must choose Path A vs B (§3.5)** before spend |
| Perf regressions from PBR/post on mobile | Med | Quality tiers, compressed textures, gated effects |
| Client/server constant drift (already caused bugs) | Med | Shared package (T11) |
| No tests → regressions during big refactor | Med | Add netcode/sim tests (T12) before major changes |
| Higgsfield MCP connection instability | Med | Retry; queue prompts; generate in batches when connected |

---

## 9. Time Estimate (director-level, with generation)

- **Vertical slice** (1 char new-style + 1 map re-lit + post stack + a few SFX):
  ~1–2 focused sessions.
- **Post-processing + VFX system** (all maps benefit): ~2 sessions.
- **PBR + skyboxes across 9 families**: ~2–3 sessions (generation-bound).
- **Audio bibles** (music + SFX + voice, generate + wire): ~2–3 sessions.
- **Character Path A** (polish 2D + expressions): ~1 session. **Path B** (8×
  image→3D→rig→clips→integrate new render path): ~4–6 sessions + heavy credits.
- **Netcode robustness + shared package + tests**: ~2–3 sessions.

## 10. Next Priority

1. **User decision:** Path A (keep/polish 2D characters) or Path B (full 3D).
2. **Reconnect Higgsfield**, then generate a **single vertical slice**:
   post-processing stack + one re-lit map (Frostbite) + one hero in the chosen
   path + 3–4 premium SFX. Ship it, get sign-off on the look.
3. Only after approval, **scale the locked style** across all maps, characters
   and the audio bibles — in credit-budgeted batches.

---

## Appendix — Nintendo Fun Test (current build)

Scores are for the **current shipped build**; anything < 7 is flagged for the
improvement work above. (Fun/fairness/readability of *rules* are already strong;
most gaps are presentation.)

| Feature | Under­stand | Fun | Fair­ness | Read­ability | Respons­iveness | Replay­ability | Original­ity | Memorable | Spectator |
|---|---|---|---|---|---|---|---|---|---|
| Ice Hockey Brawl | 9 | 8 | 8 | **6** | 8 | 8 | 7 | 7 | **6** |
| Slip & Slide | 8 | 8 | 7 | **6** | 7 | 8 | 7 | 7 | 7 |
| Snowball Smash | 9 | 9 | 8 | 7 | 8 | 8 | 7 | 8 | 7 |
| Avalanche Run | 8 | 8 | 7 | 7 | 7 | 7 | 7 | 7 | 7 |
| Volcano Rush | 9 | 9 | 7 | 7 | 8 | 8 | 8 | 8 | 8 |
| Characters (2D) | 9 | 8 | 9 | 8 | 8 | — | 7 | **6** | 7 |
| Environments | 8 | 7 | 9 | **6** | — | — | **6** | **6** | **6** |
| Audio | 6 | **5** | — | **5** | 7 | — | **5** | **4** | **5** |
| HUD / UI | 8 | 7 | 9 | 7 | 8 | — | **6** | **6** | 7 |

**Flagged (< 7) → addressed by:** readability & spectator (T1–T4 lighting/VFX +
T10 HUD), environment originality/memorability (T2–T3 skyboxes/PBR + landmarks),
**audio across the board (T6–T7 — the weakest area and top upgrade target)**,
character memorability (T5 expressions/victory).

_This audit will be updated after the vertical slice is approved and again after
each scaled batch._
