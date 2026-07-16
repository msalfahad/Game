# RUNBOOK — Photoreal AAA Character + Map Generation via Higgsfield

USER DIRECTIVE (latest): Use Higgsfield to CREATE the best possible versions of
the 8 characters BASED ON the existing photos — photorealistic, "2026 top-rated
game graphics" quality. Keep each character's exact identity (species, colors,
outfit, props, personality) but render them like a next-gen AAA game character.
Then convert to 3D and wire into the game.

Source identity images (already in repo): `assets-staging/chars-png/<key>.png`
(512x512, from user's approved art). High-res originals in session uploads dir.

## MASTER STYLE TOKEN (append to every character prompt)
"Rendered as a 2026 AAA video game hero: photorealistic fur/scales/skin with
subsurface scattering, physically-based materials (worn leather, brushed metal,
fabric weave), cinematic 3-point studio lighting, Unreal Engine 5 / Octane
quality, 8k detail, full body, neutral A-pose, front view, clean neutral
background, sharp focus. Stylized-realistic like modern Ratchet & Clank /
Sonic movie / Crash Bandicoot 4 cinematics — believable but keeps the fun
mascot proportions of the reference."

## PIPELINE PER CHARACTER (x8)
1. media_upload `assets-staging/chars-png/<key>.png` → reference image
   (check models_explore action:'get' for soul_cast / image models that accept
   a reference/identity media role; if reference input is supported, pass the
   user's art as the identity anchor — this is strongly preferred)
2. generate_image with the per-character prompt below (+ master style token),
   aspect 3:4 or 1:1, reference image attached if supported
3. upscale_image the winner to 2K
4. generate_3d (image_to_3d) from the photoreal image → GLB
5. Download: photoreal portrait → `public/chars/hd/<key>.png` (character select),
   GLB → `src/assets/models/character-<key>.glb`

## PER-CHARACTER PROMPTS (identity anchored to user's art)

### zip — Zip the Speedster (green, #7ED321)
"Athletic anthropomorphic green lizard-dragon hero, bright green scaled skin,
spiky flowing RED mohawk crest running down his head, mischievous confident
grin with small fangs, large amber-red eyes, aviator goggles with green-tinted
lenses pushed up on forehead, red bandana scarf around neck, black leather
sleeveless biker vest with a yellow lightning bolt emblem, utility belt,
dark cargo pants with green dino-scale knee patches, chunky red-white-green
sneakers, fingerless black gloves, small green tail with darker spikes.
Lean fast sprinter build, giving a thumbs-up."

### rax — Vex the Wildcard (purple, #B06BFF)
"Anthropomorphic purple-black wolf antihero, thick dark indigo fur with wild
spiky hair tuft, sharp amber-gold eyes with a sly smirk showing one fang,
tall pointed ears, purple leather biker jacket with grey fur collar and
silver zippers over black shirt, studded belt with V-buckle, black armored
pants with silver knee plates, heavy purple-black armored boots with claw
marks, black fingerless gloves. Medium agile build, cocky pose."

### luna — Luna the Elemental (blue, #4DA6FF)
"Elegant anthropomorphic arctic fox sorceress, soft white-grey fur, long
flowing ELECTRIC BLUE hair, large violet-pink magical eyes with long lashes,
inner-pink pointed ears, ornate midnight-blue and purple sorceress outfit
with gold filigree trim, glowing amethyst gems set in chest piece and belt,
layered flowing coat-skirt with galaxy-nebula pattern lining, armored
bracers, gold-trimmed purple boots with gem clasps. Graceful mystical
stance, faint magical aura."

### ollie — Ollie the Gadgeteer (orange, #FF9C3F)
"Cheerful young human boy inventor, spiky golden-blonde hair, huge round
brass steampunk goggles with thick glass lenses magnifying his bright teal
eyes, freckled grinning face, mustard-yellow work jacket with orange trim
and brass buckles over grey shirt, brown leather gloves and tool belt,
grey work pants, heavy brown leather work boots, holding a big steel wrench,
wearing an intricate copper-brass steampunk jetpack backpack with pipes,
gauges and a propeller. Small scrappy kid-genius build."

### slam — Slam the Juggernaut (indigo, #3D5AFE)
"Massive anthropomorphic brown grizzly bear athlete, hugely muscular arms and
shoulders, thick realistic brown fur, confident smirk, small blue baseball
cap, royal-blue basketball jersey with large white NUMBER 7 and gold eagle
shoulder prints, black leather belt, dark denim shorts with copper rivets,
blue wristbands on both wrists, blue-white-gold basketball sneakers.
Powerhouse tank build, knuckles clenched."

### rolo — Rolo the Tech Genius (teal, #2BD9C8)
"Anthropomorphic grey-blue rabbit engineer, soft grey fur, very long upright
ears with pink inner lining, bright blue eyes, friendly buck-tooth smile,
brass mechanic goggles on forehead, navy-and-bronze steampunk mechanic suit
covered in pouches, glowing cyan gadget modules on the belt and chest strap,
armored bronze knee plates, blue-white boots, brown work gloves, holding a
large chrome double-ended wrench. Nimble medium build."

### pix — Pix the Trickster (pink, #FF3D9E)
"Anthropomorphic black raven trickster, glossy black feathers with magenta-pink
iridescent tips, wild hot-pink feather crest mohawk, big turquoise eyes,
golden-yellow beak with a cheeky grin, brass goggles on head, hot-pink neck
bandana, black leather adventurer vest covered in gold pins and patches over
feathered body, brown utility belt with satchels and pouches, black shorts
with pink patch details, colorful teal-pink-white high-top sneakers, large
folded black-to-magenta gradient wings. Small agile prankster build."

### brutus — Brutus the Tank (red, #E05038)
"Hulking anthropomorphic bulldog enforcer, wrinkled tan-brown muzzle with
huge white underbite fangs, fierce orange eyes, cropped ears with metal
spikes, enormous muscular torso in dark-brown spiked leather harness armor,
chrome-studded straps and massive silver-buckled belt, spiked steel shoulder
guards and studded gauntlet gloves, heavy brown leather pants with armored
studded knee plates, giant armored boots, spiked collar. Widest heaviest
build of the roster, fists clenched, intimidating stance."

## MAPS / BACKGROUNDS (after characters, per family — soul_location)
Photoreal arena environment keyart per family, same "2026 AAA" token, 16:9,
then use as skydome/background reference + upscale:
1. Frostbite: aurora night ice arena (job dec0c1f3 may already cover this)
2. Ember: volcanic obsidian arena, lava rivers, ash storm
3. Dunes: golden desert colosseum at sunset, heat haze
4. Wildwood: ancient forest arena, god rays through canopy
5. Skyfall: floating sky islands arena above clouds at dawn
6. Forge: industrial mech factory arena, neon signage, steam
7. Tides: pirate cove arena, galleons, stormy sea
8. Neon: cyberpunk rooftop arena at night, holographic ads

## ALREADY GENERATED (retrieve via show_generations, do NOT regenerate)
- Ice PBR textures: albedo b0bd7adc, normal 9f0b6b19, rough/metal 4ec0c344
- Aurora skybox: dec0c1f3
- Zip voice barks (Brooks voice c2acff45-84b2-4974-892d-89fa2d4e5598):
  ability-charged 32cdd003, taunt f1f94db1, ability-use 7d83fbe0,
  round-win c292cc3d, surprise fe0f172b, climax 71d47515 (+ earlier session:
  spawn/hit/victory/revival — search generations; regenerate missing ones,
  2s apart, seed_audio rate limits fast)

## VOICES FOR OTHER 7 HEROES (10 lines each, save <key>-<line>.wav)
Vex=Cillian d8ba9f14, Luna=Skye 1fb253b8, Ollie=Leo 73a45c18,
Slam=Sterling dc382508, Rolo=Kevin f1373f24, Pix=Zoe d0374db1,
Brutus=Gideon 1ad38ba4. Lines: spawn "Let's go!", ability-charged "Got it!",
hit "Whoa!", victory "Yeah!", taunt "Come on!", revival "I'm not done!",
ability-use "Watch this!", round-win "That's how it's done!",
surprise "No way!", climax "Let's finish this!" — reword per personality
(Brutus gruff, Luna mystical-calm, Ollie excited kid, Pix cackling, etc.)

## INTEGRATION (code already wired on this branch)
- world.ts auto-loads src/assets/textures/ice-*.png for ice family
- match.ts plays characterVoice.spawn()/.victory(); voice-barks.ts handles rest
- loader.ts loadCharacterModel() + character-models.ts registry → add all 8
- Replace placeholder files in src/assets/ (paths already correct)
- Character select art: point heroImg() at public/chars/hd/<key>.png when added

## ORDER OF WORK
1. balance → confirm credits (~1000, plus plan)
2. show_generations → download finished ice/skybox/voice assets, replace placeholders
3. Characters: upload refs → generate photoreal x8 → review → upscale → 3D x8
4. Voices: remaining zip lines + 7 heroes x 10 lines (spaced, rate limit)
5. Maps: 8 family keyart backgrounds
6. Download everything → src/assets/ + public/chars/hd/
7. npm run build && npm run preview → verify → commit + push claude/awaiting-info-wfsny5
8. Higgsfield connector drops in long sessions → download assets EARLY and often
