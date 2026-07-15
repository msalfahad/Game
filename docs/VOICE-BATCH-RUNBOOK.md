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

## Voices — USER DIRECTIVE: NOT plain human narration. These are cartoon
## animal mascots — exaggerated anime/game-mascot delivery: screamed lines,
## thick character voices, laughs / "woo-hoo!" / growl tails. Brooks preset was
## rejected as "boring". Use `create_voice` to DESIGN a custom character voice
## per hero from these descriptions (preset IDs below only as last-resort
## fallback if create_voice is unavailable):

| key | hero | create_voice description |
|---|---|---|
| zip | Zap | hyperactive cartoon lizard hero, young male, fast squeaky-raspy energy, always shouting with excitement, anime protagonist scream, cheeky laugh |
| rax | Vex | sly cartoon wolf antihero, smug gravelly mid voice, dramatic villain flair, sinister chuckle |
| luna | Luna | elegant cartoon fox sorceress, melodic mystical female voice, theatrical and enchanting, airy magical laugh |
| ollie | Ollie | tiny cartoon kid inventor, super high-pitched excited child voice, talks too fast, giggles constantly |
| slam | Slam | huge cartoon bear jock, booming deep voice, roaring hype energy like a wrestling announcer, big belly laugh |
| rolo | Rolo | nerdy cartoon rabbit engineer, quick nasal chipper voice, giddy about gadgets, snorting laugh |
| pix | Pix | mischievous cartoon raven trickster, screechy playful bird voice, cackling wildly, squawk accents |
| brutus | Brutus | massive cartoon bulldog enforcer, guttural growling monster voice, slow menacing power, threatening snarl-laugh |

Fallback presets: zip=Brooks c2acff45, rax=Cillian d8ba9f14, luna=Skye
1fb253b8, ollie=Leo 73a45c18, slam=Sterling dc382508, rolo=Kevin f1373f24,
pix=Zoe d0374db1, brutus=Gideon 1ad38ba4.

Rate limit: seed_audio 429s fast — space calls ~2-3s apart, retry once after 5s.
Existing Zap clips from earlier jobs (see docs/ASSET-GENERATION-STATUS.md)
can be reused instead of regenerating: ability-charged 32cdd003, taunt
f1f94db1, ability-use 7d83fbe0, round-win c292cc3d, surprise fe0f172b,
climax 71d47515.

## Lines (personality-flavored; clips 0.8–2s). DELIVERY IS EVERYTHING:
## screamed / sung / growled like an anime fight scene, and most lines end
## with a vocal tail — laugh, "woo-hoo!", growl, cackle, squawk. Example the
## user gave: "I'M WINNING!" screamed in a thick anime voice + "woo-hoo!" +
## laugh at the end. Add such tails especially to victory / round-win /
## climax / taunt lines for every hero.
Line keys: spawn, ability-charged, hit, victory, taunt, revival, ability-use,
round-win, surprise, climax.

### zip / Zap — cocky speedster (screaming excitement + cheeky laugh)
spawn "LET'S GOOO!" · ability-charged "Charged UP! Hehe!" · hit "WHOA-oa!" ·
victory "I'M WINNING! Woo-hoo-hoo! Hahaha!" · taunt "Catch me if you CAN!
Hehehe!" · revival "I'm NOT done yet!" · ability-use "WATCH THIS!" ·
round-win "THAT'S how it's done! Haha!" · surprise "NO WAY?!" · climax
"LET'S FINISH THIS!"

### rax / Vex — sly wildcard (smug drama + sinister chuckle)
spawn "SHOWTIME! Heh heh heh…" · ability-charged "NOW we're talking…" · hit
"TCH! Grr!" · victory "HAH! Too easy! Ahahaha!" · taunt "That ALL you got?
Heh!" · revival "Not… YET!" · ability-use "LIGHTS OUT!" · round-win "Told
you. Heh heh." · surprise "WHAT?!" · climax "Time to END this! Grrhaha!"

### luna / Luna — theatrical mystic (enchanting + airy laugh)
spawn "The stars guide me~!" · ability-charged "Power FLOWS through me!" ·
hit "AH!" · victory "As foreseen! Ahaha~!" · taunt "You cannot TOUCH me~!" ·
revival "I rise AGAIN!" · ability-use "BEHOLD!" · round-win "Balance…
restored! Hmhm~!" · surprise "IMPOSSIBLE?!" · climax "DESTINY CALLS!"

### ollie / Ollie — hyper kid genius (talking fast + giggles)
spawn "GADGETS READY! Hehehe!" · ability-charged "IT'S WORKING IT'S
WORKING!" · hit "HEY!!" · victory "WOO-HOO! SCIENCE WINS! Hahaha!" · taunt
"Bet you can't do THIS! Heehee!" · revival "Just a SETBACK!" · ability-use
"CHECK THIS OUT!" · round-win "INVENTION ACCOMPLISHED! Woo!" · surprise
"WHOA WHAT?!" · climax "FOR SCIENCE!!"

### slam / Slam — wrestling-announcer bear (booming roar + belly laugh)
spawn "GAME TIIIME!" · ability-charged "PUMPED UP! RAAAH!" · hit "OOF!" ·
victory "SLAM DUNK, BABY! HAHAHA!" · taunt "COME AT ME! HA!" · revival "I
AIN'T DONE!" · ability-use "HEADS UP!" · round-win "CHAMPIONS play like
THAT! Ho ho ho!" · surprise "HUH?!" · climax "FOURTH QUARTER, BABY! WOO!"

### rolo / Rolo — giddy engineer rabbit (chipper + snort-laugh)
spawn "SYSTEMS ONLINE! Hehe-snort!" · ability-charged "FULLY CHARGED!" · hit
"MY CALIBRATIONS!" · victory "FLAWLESS EXECUTION! Ha-ha-snort!" · taunt "You
need an UPGRADE! Heh!" · revival "REBOOTING!" · ability-use "DEPLOYING!" ·
round-win "PRECISION ENGINEERING! Woo!" · surprise "That's not in the
MANUAL?!" · climax "OVERCLOCKING!!"

### pix / Pix — wild trickster bird (screechy cackle + squawks)
spawn "Hehehe, LET'S PLAY! SQUAWK!" · ability-charged "Ooh, SHINY!" · hit
"SQUAWK?!" · victory "AHAHAHA! MINE, ALL MINE! Hehehe!" · taunt "Missed me,
MISSED me! Nyahaha!" · revival "Can't cage THIS bird! Squawk!" · ability-use
"SURPRIIISE!" · round-win "Trickster takes it ALL! Cacaw!" · surprise
"WARK?!" · climax "LAST LAUGH'S MINE! AHAHAHA!"

### brutus / Brutus — monster growl (slow menace + snarl-laugh)
spawn "BRUTUS… IS HERE. Grrr." · ability-charged "Ready… to CRUSH." · hit
"GRRRR!" · victory "NOBODY beats Brutus! GRAHAHA!" · taunt "WEAK. Heh." ·
revival "STILL… STANDING." · ability-use "CRUUUSH!" · round-win "DOMINATED.
Grrhehe." · surprise "WHAT!?" · climax "TIME TO BREAK SOMETHING! RAAAGH!"

## Audio prompt template (per clip)
"Exaggerated <voice description> cartoon game-character voice bark, anime
fight-scene delivery, shouted with over-the-top energy: '<line text>'.
Include the laugh/growl/whoop tail written in the line. Clean studio audio,
no background noise, no music, 0.8-2 seconds."

## Delivery targets
`public/audio/voices/<key>-<lineKey>.wav`
(mp3 also fine — if mp3, ALSO update voice-barks.ts fetch extension to .mp3.)
Client trigger wiring for spawn/victory already exists in match.ts;
remaining triggers (hit/taunt/etc.) get wired after clips land.
