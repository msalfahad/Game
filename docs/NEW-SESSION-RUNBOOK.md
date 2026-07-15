# New Session Runbook — 3D Characters from USER'S OWN ART

## Key correction from the user
Do NOT generate new character designs. The user already provided all 8 character
images (one per character). Use those as the image input for `generate_3d`
(image_to_3d). The definitive per-character art lives in the repo:

- `public/chars/zip.webp`    → Zip (Speedster, green)
- `public/chars/rax.webp`    → Vex (Wildcard, purple)
- `public/chars/luna.webp`   → Luna (Elemental, blue)
- `public/chars/ollie.webp`  → Ollie (Gadgeteer, orange)
- `public/chars/slam.webp`   → Slam (Juggernaut, indigo)
- `public/chars/rolo.webp`   → Rolo (Tech Genius, teal)
- `public/chars/pix.webp`    → Pix (Trickster, pink)
- `public/chars/brutus.webp` → Brutus (Tank, red)

PNG copies (512x512, ready to upload) are staged IN THIS REPO at:
`assets-staging/chars-png/{zip,rax,luna,ollie,slam,rolo,pix,brutus}.png`
High-res originals also exist in `/root/.claude/uploads/35cb639a-8c7f-592e-bcfe-a64b0a02b3b7/`.

## Pipeline per character (x8)
1. `media_upload` (or media_import_url) the staged PNG → get media id
2. `media_confirm` if required
3. `generate_3d` with the image in the `image` role → GLB mesh
4. Download GLB → `src/assets/models/character-<key>.glb`

## Already generating on Higgsfield (check show_generations, account: plus, ~1004 credits)
These 15 jobs were submitted ~Jul 15 12:20 and should be COMPLETE — retrieve, don't regenerate:
- Skybox aurora: dec0c1f3-fe2f-4b8b-97df-5bc344574b65 → textures/skybox-frostbite (use as scene bg or skydome texture)
- Ice albedo: b0bd7adc-6149-4997-ac60-1f464697f8ad → textures/ice-albedo.png
- Ice normal: 9f0b6b19-7d19-4f00-b0e0-e69d9046fcf2 → textures/ice-normal.png
- Ice rough/metal: 4ec0c344-602d-4c47-9324-ae440b81143e → textures/ice-roughmetal.png
- (soul_cast char 99f52101 — IGNORE, superseded by user's own art)
- Voice barks (Brooks voice c2acff45-84b2-4974-892d-89fa2d4e5598):
  - Got it! 32cdd003 → zip-in-ability-charged.wav
  - Come on! f1f94db1 → zip-in-taunt.wav
  - Watch this! 7d83fbe0 → zip-in-ability-use.wav
  - That's how it's done! c292cc3d → zip-in-round-win.wav
  - No way! fe0f172b → zip-in-surprise.wav
  - Let's finish this! 71d47515 → zip-in-climax.wav
  - (also earlier session jobs: spawn/hit/victory/revival — check show_generations for
    "Let's go", "Whoa", "Yeah", "I'm not done" — regenerate any missing, space calls
    2s apart, seed_audio rate limit is tight)

## Voice plan for OTHER characters
Each hero should sound different. Suggested preset voices (from list_voices):
Zip=Brooks (done), Vex=Cillian, Luna=Skye, Ollie=Leo, Slam=Sterling,
Rolo=Kevin, Pix=Zoe, Brutus=Gideon. Same 10 lines each, save as
`src/assets/audio/voices/<key>-<line>.wav`.

## Integration (already wired in code, commits 70df302/791a28d/288b3f5)
- Ice PBR: world.ts auto-loads assets/textures/ice-*.png for ice family
- Voices: match.ts plays characterVoice.spawn() and .victory()
- 3D models: loader.ts has loadCharacterModel(); character-models.ts registry —
  extend CHARACTER_MODELS with all 8 keys once GLBs are downloaded
- Placeholders exist for textures + zip voices; REPLACE files in place, paths already correct

## Download mechanics
Higgsfield asset URLs are on CloudFront. In-session curl to CDN got 403 previously;
if that persists, use job_display to get signed URLs and WebFetch, or download via
the media tools. Test one file first before batch.

## Order of work in the new session
1. balance + show_generations → collect completed URLs
2. Download skybox + 3 ice textures + 6-10 zip voices → replace placeholders
3. Upload 8 staged PNGs → generate_3d x8 (these take a while; queue all, poll)
4. Meanwhile generate remaining voice barks (7 other heroes, spaced)
5. Download GLBs → src/assets/models/ → extend CHARACTER_MODELS registry
6. npm run build + preview → verify → commit + push to claude/awaiting-info-wfsny5
