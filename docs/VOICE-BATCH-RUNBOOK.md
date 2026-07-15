# VOICE BATCH RUNBOOK (FINAL) — 8 heroes × 6 clips = 48 clips

Target: `public/audio/voices/<key>-<line>.wav` (16-bit PCM wav; mp3 also ok —
if mp3, update the fetch extension in `src/core/voice-barks.ts`).
Missing files auto-fall back to synth SFX, so partial delivery is safe.

## USER DIRECTIVES (locked)
- NOT plain human narration (Brooks preset rejected as boring). These are
  cartoon animal mascots: design a CUSTOM voice per hero with `create_voice`.
- Anime fight-scene delivery: screamed, growled, sung — over the top.
- Lines end with vocal tails: laughs, "woo-hoo!", growls, cackles, squawks.
- Each clip has an EMOTION and the acting must match it.
- BATCHING: one hero at a time, max 10 clips in flight, 2-3s between calls.
  create_voice → ONE test line → user approves in app → rest of the set.
  On 429/hang: stop 30s, resume. Keep a manifest (hero, line, job id, URL)
  in docs/ASSET-GENERATION-STATUS.md so progress survives disconnects.

## Voice designs (create_voice descriptions)
| key | hero | voice |
|---|---|---|
| zip | Zap | hyperactive cartoon lizard hero, young male, squeaky-raspy, always shouting with excitement, anime protagonist scream, cheeky laugh |
| rax | Vex | sly cartoon wolf antihero, smug gravelly mid voice, dramatic villain flair, sinister chuckle |
| luna | Luna | elegant cartoon fox sorceress, melodic mystical female voice, theatrical and enchanting, airy magical laugh |
| ollie | Ollie | tiny cartoon kid inventor, super high-pitched excited child voice, talks too fast, giggles constantly |
| slam | Slam | huge cartoon bear jock, booming deep voice, roaring wrestling-announcer hype, big belly laugh |
| rolo | Rolo | nerdy cartoon rabbit engineer, quick nasal chipper voice, giddy about gadgets, snorting laugh |
| pix | Pix | mischievous cartoon raven trickster, screechy playful bird voice, cackling wildly, squawk accents |
| brutus | Brutus | massive cartoon bulldog enforcer, guttural growling monster voice, slow menacing power, threatening snarl-laugh |

## The 6 lines per hero
Line keys: `spawn, victory, losing, dodge, ability, trash`

### zip / Zap
spawn [hyped] "LET'S GOOO!" · victory [gloating] "I'M WINNING! Woo-hoo-hoo!
Hahaha!" · losing [angry] "No no NO! Grrr!" · dodge [mocking] "You CAN'T hit
me! Hehehe!" · ability [showoff] "WATCH THIS!" · trash [mocking, at Brutus]
"Too slow, big guy! Hahaha!"

### rax / Vex
spawn [dramatic] "SHOWTIME! Heh heh heh…" · victory [gloating] "Bow to the
KING! Ahahaha!" · losing [furious] "GRRR… you'll PAY for that!" · dodge
[smug] "Pathetic! Heh heh!" · ability [menacing] "LIGHTS OUT!" · trash
[mocking, at Luna] "Go play with a doll! Hahahaha!"

### luna / Luna
spawn [enchanting] "The stars guide me~!" · victory [delighted] "The stars
favor ME~! Ahahaha!" · losing [sad] "This… cannot be…" · dodge [playful]
"Too slow for magic~! Hmhm!" · ability [powerful] "BEHOLD!" · trash
[teasing, at Vex] "Bad puppy! Go fetch! Hahaha~!"

### ollie / Ollie
spawn [excited] "GADGETS READY! Hehehe!" · victory [ecstatic] "I'M WINNING
I'M WINNING! WOOHOO!" · losing [whiny] "Aw man, RECALCULATING!" · dodge
[giggling] "Missed! Missed again! Heehee!" · ability [proud] "CHECK THIS
OUT!" · trash [cheeky, at Slam] "Big muscles, tiny brain! Hahaha!"

### slam / Slam
spawn [roaring] "GAME TIIIME!" · victory [booming] "SCOREBOARD, BABY!
HAHAHA!" · losing [raging] "REF! RAAAGH!" · dodge [cocky] "Swing and a
MISS! Ha!" · ability [warning] "HEADS UP!" · trash [booming, at Ollie]
"Nap time, junior! Ho ho ho!"

### rolo / Rolo
spawn [chipper] "SYSTEMS ONLINE! Hehe-snort!" · victory [giddy] "Victory
calculated! Ha-ha-snort!" · losing [panicked] "ERROR! ERROR!" · dodge
[playful] "Nope! Nope! Hehe!" · ability [eager] "DEPLOYING!" · trash
[snarky, at Pix] "Bird brain! Ha-ha-snort!"

### pix / Pix
spawn [cackling] "Hehehe, LET'S PLAY! SQUAWK!" · victory [wild] "WINNER
WINNER! CACAW! Ahahaha!" · losing [squawking mad] "WAAARK! No fair!" ·
dodge [taunting] "Can't catch a bird! Nyahaha!" · ability [gleeful]
"SURPRIIISE!" · trash [screechy, at Rolo] "Nice ears, carrot boy! AHAHAHA!"

### brutus / Brutus
spawn [menacing] "BRUTUS… IS HERE. Grrr." · victory [thunderous] "NOBODY
beats Brutus! GRAHAHA!" · losing [furious] "RAAAAGH! BRUTUS ANGRY!" · dodge
[dismissive] "Heh. Missed." · ability [roaring] "CRUUUSH!" · trash
[growling, at Zap] "Little lizard, BIG mouth! Grrhaha!"

## Audio prompt template (per clip)
"Exaggerated <voice description> cartoon game-character voice bark,
[EMOTION] anime fight-scene delivery, shouted with over-the-top energy:
'<line text>'. Include the laugh/growl/whoop tail written in the line.
Clean studio audio, no background noise, no music, 0.8-2 seconds."

## Egress / delivery
Test first: `curl -sSI https://d1xarpci4ikg0w.cloudfront.net/ | head -1`
- Tunnel established (even 403/404 body) → download clips directly into
  `public/audio/voices/`, commit, push to `claude/awaiting-info-wfsny5`.
- "CONNECT tunnel failed" → downloads blocked: keep the manifest updated and
  the user exports .wav from the Higgsfield app hero-by-hero (confirmed
  working, 16-bit PCM 24kHz) and delivers them to the integration session.

## Client wiring (after clips land)
- spawn/victory: already wired in match.ts (characterVoice.spawn/.victory)
- losing: on knockout / big deficit · dodge: on dash-away/near-miss ·
  ability: on ultimate use · trash: attacker's line on KO'ing a rival
- voice-barks.ts maps line keys → files; extend its trigger table to the
  final 6 keys and delete triggers for removed lines.
