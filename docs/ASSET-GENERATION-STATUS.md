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

---

# Voice-bark batch — session 2026-07-16 (VOICE-BATCH-RUNBOOK.md)

Executing `docs/VOICE-BATCH-RUNBOOK.md` (8 heroes × 6 lines = 48 clips). Line
keys: `spawn, victory, losing, dodge, ability, trash`. Model `seed_audio`,
wav/24 kHz, ~0.1 cr each. Egress is **blocked** (upload host, result CDN, and
`d1xarpci4ikg0w` all 403 CONNECT), so clips **cannot be downloaded/committed** —
user exports each `.wav` from the Higgsfield app. Voice sourcing (this session):
**Zap = Brooks preset** (custom clone couldn't upload — egress); heroes 2–8 =
best-fit presets, tuned. Delivery target on disk stays
`public/audio/voices/<key>-<line>.wav`.

Pacing: one character per batch; user copies from Higgsfield, then next hero.

## Zap (zip) — Brooks preset `c2acff45-84b2-4974-892d-89fa2d4e5598`, pitch +2 / speech_rate +20 (losing +15) / loudness +5 — GENERATED ✅ + DELIVERED TO REPO ✅
All 6 clips exported by user from Higgsfield app and committed to
`public/audio/voices/zip-<line>.wav`. NOTE: `zip-spawn.wav` is a user
re-generation (job `75a375b9-bc73-477f-bd68-67448105ac83`, ~2.7s), not the
original `8621d05c…` spawn — pending user confirm it's the intended take.
| line | emotion | text | job id | dur (s) |
|---|---|---|---|---|
| spawn | hyped | LET'S GOOO! | `8621d05c-f565-4c11-a9ae-bc7d725f3533` | 0.63 |
| victory | gloating | I'M WINNING! Woo-hoo-hoo! Hahaha! | `49f7567d-c143-4d77-970d-f67786b4f91d` | 2.62 |
| losing | angry | No no NO! Grrr! | `73d7c2ec-22a8-49ec-9695-69227aaba860` | 1.38 |
| dodge | mocking | You CAN'T hit me! Hehehe! | `c8a92808-ce30-4430-83d5-d4399aa42538` | 1.30 |
| ability | showoff | WATCH THIS! | `ada9a30a-55ed-4120-8c3c-0e3258304c34` | 0.70 |
| trash | mocking @Brutus | Too slow, big guy! Hahaha! | `a7e30970-7161-41f7-8cf2-40a4b67ad3b3` | 1.91 |

## Prompt style (adopted from Vex onward)
Per-line prompt now carries an **anime acting direction** in brackets, then the
line text: `[anime fight-scene voice bark, <hero voice character>, <emotion>
delivery, screamed/growled/sung over-the-top like an anime character, ending
with <tail>] <THE LINE>`. Verified on Zap-spawn A/B: seed_audio treats the
bracketed direction as a **style cue, not spoken text** (40-word direction →
1.97s clip, not 12–15s). Zap's committed clips used words-only prompts; can be
re-done in this style later if desired.

## Vex (rax) — Vlad preset `e5666b9c-99a2-4fac-8b4e-abee078b186d`, loudness +8, pitch 0/-1 — GENERATED ✅ (awaiting user export → repo)
| line | emotion | text | job id |
|---|---|---|---|
| spawn | dramatic | SHOWTIME! Heh heh heh… | `d0985d2d-b2c0-40c6-b704-7ada6aecc3f4` |
| victory | gloating | Bow to the KING! Ahahaha! | `fe1b8383-3255-4126-a07b-0db8cd7ee370` |
| losing | furious | GRRR… you'll PAY for that! | `bde4d782-f180-4c1e-bac8-2a7e6fa8e968` |
| dodge | smug | Pathetic! Heh heh! | `ca140c22-c44f-4551-a346-6b72a69769e8` |
| ability | menacing | LIGHTS OUT! | `6b491eab-2267-4464-a38d-e038ac60d97d` |
| trash | mocking @Luna | Go play with a doll! Hahahaha! | `033cd92f-839a-49f9-8e60-c3f21f4e9ed2` |

## Luna (luna) — Luna preset `375a3398-e3b4-4f91-845d-42181e352899`, pitch +1 (melodic), varied rate/loudness — GENERATED ✅ (awaiting user export → repo)
| line | emotion | text | job id |
|---|---|---|---|
| spawn | enchanting | The stars guide me~! | `2bf416e8-7272-43a1-ab77-22c42ac3b8cb` |
| victory | delighted | The stars favor ME~! Ahahaha! | `5b14108c-d391-418f-ae15-b6f28c358d11` |
| losing | sad | This… cannot be… | `ded4e349-773d-4ea8-a924-c851d4048771` |
| dodge | playful | Too slow for magic~! Hmhm! | `fe12b7ae-877a-44e9-b217-1e02f480b1e2` |
| ability | powerful | BEHOLD! | `21799a56-296a-46c4-bf2b-85b52ede1999` |
| trash | teasing @Vex | Bad puppy! Go fetch! Hahaha~! | `11fcefee-c69c-4c18-9939-40eed38d89e9` |

## Ollie (ollie) — Zoe preset `d0374db1-44b9-4f05-939e-0a9ae9dbbe6a`, pitch +5 (kid), speech_rate +20/25/30 — GENERATED ✅ (awaiting user export → repo)
| line | emotion | text | job id |
|---|---|---|---|
| spawn | excited | GADGETS READY! Hehehe! | `b3f8e7b6-bf2e-4f52-b374-ac2ee81d4291` |
| victory | ecstatic | I'M WINNING I'M WINNING! WOOHOO! | `573aa3d4-f115-4b45-b7cd-f47d31e04b83` |
| losing | whiny | Aw man, RECALCULATING! | `afea7b80-6e7d-493c-862e-e6a0abf3d7c7` |
| dodge | giggling | Missed! Missed again! Heehee! | `fd173910-12ce-4d36-ae17-522428a6b6ca` |
| ability | proud | CHECK THIS OUT! | `6ada3000-b7ae-4e84-9815-2cfdfe941d17` |
| trash | cheeky @Slam | Big muscles, tiny brain! Hahaha! | `642d3b58-194e-4cbc-ba74-f379046e2c6f` |

## Slam (slam) — Roman preset `7e63ac18-5fcd-4aba-8078-a86d4e11c127`, pitch -2 (deep), loudness +7/8 — GENERATED ✅ (awaiting user export → repo)
| line | emotion | text | job id |
|---|---|---|---|
| spawn | roaring | GAME TIIIME! | `2352b196-aef2-4243-b137-83811b24933b` |
| victory | booming | SCOREBOARD, BABY! HAHAHA! | `00510a56-5191-409d-9838-d0d250d09543` |
| losing | raging | REF! RAAAGH! | `fb867e91-a141-43e9-a3db-817ab2c19ebf` |
| dodge | cocky | Swing and a MISS! Ha! | `dc1ee157-a0cb-450f-a851-ab141b6abcf5` |
| ability | warning | HEADS UP! | `e8bfc33a-6784-4c65-89b4-a6747b01878c` |
| trash | booming @Ollie | Nap time, junior! Ho ho ho! | `cd1f4b9d-12ac-4127-bf59-7ed2b2f86724` |

Note: user feedback — avoid over-pitched/baby (Ollie +5) and breathy/sultry
takes; keep pitch moderate from Slam onward. Ollie re-gen at lower pitch
offered.

## Rolo (rolo) — Leo preset `73a45c18-0c56-4642-a61e-f6b303f8ded1`, pitch +2 (chipper), speech_rate +15/20 — GENERATED ✅ (awaiting user export → repo)
| line | emotion | text | job id |
|---|---|---|---|
| spawn | chipper | SYSTEMS ONLINE! Hehe-snort! | `474f6271-4f1d-4c7f-a75f-be3fbcde5934` |
| victory | giddy | Victory calculated! Ha-ha-snort! | `d84861b0-12fb-454b-be4d-bea13f239fd0` |
| losing | panicked | ERROR! ERROR! | `7ecf683a-8ed9-4c27-9d17-c2ebbf1512a6` |
| dodge | playful | Nope! Nope! Hehe! | `386e1dd2-babe-4794-946e-aa632c28aa90` |
| ability | eager | DEPLOYING! | `5ff225c2-76c0-4a8b-868c-646c5c90a2cc` |
| trash | snarky @Pix | Bird brain! Ha-ha-snort! | `19c9f995-835f-43fc-99f3-511e3cb8b88a` |

## Progress: Zap ✅repo · Vex ✅repo · Luna ✅repo · Ollie ✅repo · Slam ✅repo · Rolo ✅gen. Next: Pix, Brutus.

## Remaining heroes — preset plan (not yet generated)
Vex=Vlad `e5666b9c-99a2-4fac-8b4e-abee078b186d`, Luna=Luna
`375a3398-e3b4-4f91-845d-42181e352899`, Ollie=Zoe
`d0374db1-44b9-4f05-939e-0a9ae9dbbe6a`, Slam=Roman
`7e63ac18-5fcd-4aba-8078-a86d4e11c127`, Rolo=Leo
`73a45c18-0c56-4642-a61e-f6b303f8ded1`, Pix=Harper
`47fb207f-63fe-449e-915b-27b3d8098fd1`, Brutus=Orion
`ed69c516-92d2-4b30-a967-617737a342e5`. (Picks not locked — approve per hero.)
