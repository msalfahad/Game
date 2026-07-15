# VOICE BATCH RUNBOOK — 8 heroes, distinct voices, game-ready clips

Goal: per-hero voice barks wired to `src/core/voice-barks.ts`, which loads
`audio/voices/<key>-<line>.wav` (served from `public/`). Missing files fall
back to synth SFX automatically, so partial delivery is safe.

## STEP 0 — Test egress FIRST (determines the plan)
`curl -sSI https://d1xarpci4ikg0w.cloudfront.net/ | head -1`
(any 2xx/3xx/404 = reachable; 403 CONNECT/policy error = blocked)
- Reachable → FULL PLAN: generate all 80 lines, download each to
  `public/audio/voices/`, convert to wav if needed, commit + push to
  `claude/awaiting-info-wfsny5`.
- Blocked → REDUCED PLAN: generate only the 4 core lines per hero
  (spawn, victory, hit, ability-use = 32 clips), then tell the user to
  download them from their Higgsfield library and send them to the OTHER
  Claude session IN PER-HERO BATCHES, IN ORDER (the receiving session cannot
  listen to audio — order is the only way to map files to lines).

## Voices (voice_type "preset", model seed_audio)
| key | hero | voice | voice_id |
|---|---|---|---|
| zip | Zap | Brooks | c2acff45-84b2-4974-892d-89fa2d4e5598 |
| rax | Vex | Cillian | d8ba9f14-8a24-44db-932b-99e16c45bd32 |
| luna | Luna | Skye | 1fb253b8-928b-4d29-a349-f242a71eaddf |
| ollie | Ollie | Leo | 73a45c18-0c56-4642-a61e-f6b303f8ded1 |
| slam | Slam | Sterling | dc382508-c8bd-443c-8cb2-46e57b8d2e6f |
| rolo | Rolo | Kevin | f1373f24-3b96-433f-9a68-e595810ef608 |
| pix | Pix | Zoe | d0374db1-44b9-4f05-939e-0a9ae9dbbe6a |
| brutus | Brutus | Gideon | 1ad38ba4-9cc4-4f2f-9fde-b0fefdf67ae5 |

Rate limit: seed_audio 429s fast — space calls ~2-3s apart, retry once after 5s.
Existing Zap clips from earlier jobs (see docs/ASSET-GENERATION-STATUS.md)
can be reused instead of regenerating: ability-charged 32cdd003, taunt
f1f94db1, ability-use 7d83fbe0, round-win c292cc3d, surprise fe0f172b,
climax 71d47515.

## Lines (personality-flavored; keep clips 0.6–1.5s, energetic game-bark tone)
Line keys: spawn, ability-charged, hit, victory, taunt, revival, ability-use,
round-win, surprise, climax.

### zip / Zap — cocky speedster
spawn "Let's go!" · ability-charged "Charged up!" · hit "Whoa!" · victory
"Yeah! Too fast!" · taunt "Catch me if you can!" · revival "I'm not done!" ·
ability-use "Watch this!" · round-win "That's how it's done!" · surprise
"No way!" · climax "Let's finish this!"

### rax / Vex — sly wildcard, low smirk
spawn "Showtime." · ability-charged "Now we're talking." · hit "Tch!" ·
victory "Hah! Too easy." · taunt "That all you got?" · revival "Not yet." ·
ability-use "Lights out!" · round-win "Told you." · surprise "What?!" ·
climax "Time to end this."

### luna / Luna — calm mystic
spawn "The stars guide me." · ability-charged "Power flows." · hit "Ah!" ·
victory "As foreseen." · taunt "You cannot touch me." · revival "I rise
again." · ability-use "Behold!" · round-win "Balance restored." · surprise
"Impossible!" · climax "Destiny calls."

### ollie / Ollie — excited kid genius
spawn "Gadgets ready!" · ability-charged "It's working, it's working!" · hit
"Hey!" · victory "Woo-hoo! Science wins!" · taunt "Bet you can't do THIS!" ·
revival "Just a setback!" · ability-use "Check this out!" · round-win
"Invention accomplished!" · surprise "Whoa, what?!" · climax "For science!"

### slam / Slam — big jock bear
spawn "Game time." · ability-charged "Pumped up!" · hit "Oof!" · victory
"Slam dunk!" · taunt "Come at me!" · revival "I ain't done!" · ability-use
"Heads up!" · round-win "Champions play like that!" · surprise "Huh?!" ·
climax "Fourth quarter, baby!"

### rolo / Rolo — clever upbeat engineer
spawn "Systems online!" · ability-charged "Fully charged!" · hit "My
calibrations!" · victory "Flawless execution!" · taunt "You need an
upgrade!" · revival "Rebooting!" · ability-use "Deploying!" · round-win
"Precision engineering!" · surprise "That's not in the manual!" · climax
"Overclocking!"

### pix / Pix — cackling trickster
spawn "Hehehe, let's play!" · ability-charged "Ooh, shiny!" · hit "Squawk!"
· victory "Ahahaha! Mine, all mine!" · taunt "Missed me, missed me!" ·
revival "Can't cage this bird!" · ability-use "Surprise!" · round-win
"Trickster takes it all!" · surprise "Wark?!" · climax "Last laugh's mine!"

### brutus / Brutus — gruff tank, slow growl
spawn "Brutus is here." · ability-charged "Ready to crush." · hit "Grrr!" ·
victory "Nobody beats Brutus." · taunt "Weak." · revival "Still standing." ·
ability-use "CRUSH!" · round-win "Dominated." · surprise "What!?" · climax
"Time to break something."

## Audio prompt template (per clip)
"<personality> male/female game character voice bark, single short
exclamation: '<line text>'. <tone notes>. Clean studio audio, no background
noise, no music, 0.6-1.5 seconds."

## Delivery targets
`public/audio/voices/<key>-<lineKey>.wav`
(mp3 also fine — if mp3, ALSO update voice-barks.ts fetch extension to .mp3.)
Client trigger wiring for spawn/victory already exists in match.ts;
remaining triggers (hit/taunt/etc.) get wired after clips land.
