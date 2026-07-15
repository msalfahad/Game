# Asset Generation — Status & Resume Manifest

_Session 2026-07-15. Read this together with `docs/NEW-SESSION-RUNBOOK.md`._

## TL;DR

15 photoreal 2K images (8 heroes + 7 arenas) were **generated in Higgsfield**
this session but **could not be downloaded into the repo**: the Higgsfield
result CDN and upload host are blocked by this environment's egress policy
(403 CONNECT policy denial). Nothing binary was committed because there are no
bytes to commit. Voices and 3D models were intentionally **not** generated yet,
to avoid spending credits on assets that can't be retrieved until egress opens.

Once egress is unblocked, this manifest makes finishing the job turnkey.

## Blocker (must be fixed first)

Allowlist these hosts in the environment's network policy, then start a **new
session** in that environment (egress policy is fixed at environment creation;
changing it does not affect an already-running session):

- `upload.higgsfield.ai` — needed to upload reference art (identity anchor)
- `d8j0ntlcm91z4.cloudfront.net` (Higgsfield result CDN) — needed to download
  generated images/audio/GLB. Allowlisting `*.cloudfront.net` is simplest.

Verify from a session with:
`curl -sSI https://d8j0ntlcm91z4.cloudfront.net/... ` → expect 200, not 403.

Do **not** attempt to route around the policy — see `/root/.ccr/README.md`.

## Generated this session (job IDs are stable; re-fetch rawUrl via
`show_generations` if a URL 404s)

Model: `nano_banana_pro` (served as `nano_banana_2`), 2K. Generated from the
runbook's detailed per-character text prompts (reference-image anchoring was
blocked — see above), so identity is prompt-described, not pixel-matched.

### Characters — 3:4, 1792×2400 → download to `public/chars/hd/<key>.png`
| key | hero | job id |
|---|---|---|
| zip | Zip the Speedster | `6510891f-1952-47f4-98e3-48aec1d8ef33` |
| rax | Vex the Wildcard | `e1bec1b4-d878-4a15-9331-2de983200135` |
| luna | Luna the Elemental | `811f539b-e3e6-444c-805d-0ee0d6966ae9` |
| ollie | Ollie the Gadgeteer | `005fda2b-1547-49f2-b33b-84c556de7651` |
| slam | Slam the Juggernaut | `e54e20eb-9456-4113-9aea-75ddedfd12f0` |
| rolo | Rolo the Tech Genius | `43adcc4e-1bb1-474b-836c-46dc86cd6a13` |
| pix | Pix the Trickster | `6bd1f39b-6054-4eff-8cb8-b1b53a3a2442` |
| brutus | Brutus the Tank | `44a6dee5-d561-4ae7-8ebf-89fa709941d5` |

### Arenas — 16:9, 2752×1536 → download to `public/maps/<family>.png`
| family | job id |
|---|---|
| frostbite (pre-existing aurora) | `dec0c1f3-fe2f-4b8b-97df-5bc344574b65` |
| ember (Inferno) | `981239bf-a5f2-4065-b07c-7e8f64fdec76` |
| dunes (Dune Clash) | `5e96ff91-5087-4ec0-a22e-faa6b51a44bf` |
| wildwood | `76e82bee-7417-4173-913f-62461c904657` |
| skyfall (Sky Island) | `9020ceec-edba-4fa4-824b-1b2d98b89fe6` |
| forge (Mech Factory) | `0c4e5ec7-946c-4255-9d01-d57bf3a7c399` |
| tides (Pirate Cove) | `82c6b5dd-94ec-4b82-8519-6714e2d547dc` |
| neon (Classic/Neon) | `7af29a2e-e7e9-4161-88b6-3235b5e00db1` |

Uploaded reference media_ids (usable once upload host is unblocked, for a
reference-anchored regen): zip `cd53dcd8-…`, rax `5d037902-…`, luna
`87a8883f-…`, ollie `655c4c62-…`, slam `ef52d550-…`, rolo `813cec0e-…`,
pix `91d0ce37-…`, brutus `866c15bc-…` (full IDs in this session's
media_upload response; re-upload from `assets-staging/chars-png/` if expired).

## Still to generate (once download works — do in the same pass)

### Voices — 8 heroes × 10 lines = 80 clips (`seed_audio`, ~0.1 cr each ≈ 8 cr)
Save to **`public/audio/voices/<key>-<line>.wav`** (NOT `src/assets/…` — see
wiring note 1). Line keys: `spawn, ability-charged, hit, victory, taunt,
revival, ability-use, round-win, surprise, climax`.

Preset voice_ids (voice_type `preset`): zip=Brooks
`c2acff45-84b2-4974-892d-89fa2d4e5598`, rax(Vex)=Cillian
`d8ba9f14-8a24-44db-932b-99e16c45bd32`, luna=Skye
`1fb253b8-928b-4d29-a349-f242a71eaddf`, ollie=Leo
`73a45c18-0c56-4642-a61e-f6b303f8ded1`, slam=Sterling
`dc382508-c8bd-443c-8cb2-46e57b8d2e6f`, rolo=Kevin
`f1373f24-3b96-433f-9a68-e595810ef608`, pix=Zoe
`d0374db1-44b9-4f05-939e-0a9ae9dbbe6a`, brutus=Gideon
`1ad38ba4-9cc4-4f2f-9fde-b0fefdf67ae5`. Reword lines per personality (Brutus
gruff, Luna mystical-calm, Ollie excited kid, Pix cackling, etc). Space calls
~2s apart — seed_audio rate-limits fast.

### 3D models — OPTIONAL, needs explicit go-ahead (large spend)
`image_to_3d` from each character's generated image job_id. Base mesh 20 cr;
textured/rigged/animated cost more (×8 ≈ 160–600+ cr). Save GLB to
`src/assets/models/character-<key>.glb`. Integration is uncertain (Meshy
single-image rigs are rough) — confirm with user before spending.

## Wiring changes required after download (code currently半-wired)

1. **Voices don't load today.** `src/core/voice-barks.ts` fetches
   `audio/voices/<key>-<line>.wav` (served from `public/`), but the only files
   present are 44-byte placeholders at `src/assets/audio/voices/zip-in-*.wav`
   (wrong dir AND wrong name). Fix by placing real clips at
   `public/audio/voices/<key>-<line>.wav`; then delete the stale
   `src/assets/audio/voices/` placeholders. No code change needed after that.
2. **HD portraits.** `heroImg()` (`src/data/characters.ts`) returns
   `chars/<key>.webp` and is used both in character-select UI *and* the
   in-world billboard (`src/game/player.ts`). To use HD art only in menus
   without changing in-world rendering, add a `heroPortrait(h)` →
   `chars/hd/<key>.png` helper and swap the `<img>` calls in
   `src/ui/screens.ts`, `src/ui/online.ts`, `src/ui/hud.ts`. Leave `player.ts`
   on `heroImg()`.
3. **Arena backgrounds.** The skydome is shader-driven
   (`AAA visual pass 2` commit). Wire the `public/maps/<family>.png` images as
   menu/loading/family-picker backdrops (low-risk), or as a skydome background
   texture via `assetLoader.applySkybox` if going further. Confirm the exact
   `world.ts`/family hook before deep integration.
4. **Ice PBR is mislabeled.** Runbook calls `b0bd7adc/9f0b6b19/4ec0c344` "ice
   albedo/normal/roughness" but they are `soul_location` arena photos, not
   tiling PBR maps. Real tiling ice textures still need generating if PBR is
   wanted.

## Credits
Start 997.86 → ~968 after 15 images (~30 cr). No further spend this session.
