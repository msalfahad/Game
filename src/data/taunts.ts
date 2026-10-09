// Each hero's on-screen one-liners. The same lines are scripted for the voice
// clips in docs/VOICE-BATCH-RUNBOOK.md, so text and audio match once the
// clips land (the text alone already makes knockouts funny).

export interface HeroLines {
  /** Said after knocking out a rival. */
  trash: string;
  /** Said when this hero gets knocked out. */
  lose: string;
  /** Said when this hero wins the match. */
  win: string;
}

export const LINES: Record<string, HeroLines> = {
  zip: { trash: 'Too slow, big guy! Hahaha!', lose: 'No no NO! Grrr!', win: "I'M WINNING! Woo-hoo!" },
  rax: { trash: 'Go play with a doll! Hahaha!', lose: "You'll PAY for that!", win: 'Bow to the KING!' },
  luna: { trash: 'Bad puppy! Go fetch!', lose: 'This… cannot be…', win: 'The stars favor ME~!' },
  ollie: { trash: 'Big muscles, tiny brain!', lose: 'Aw man, RECALCULATING!', win: 'SCIENCE WINS! Woo-hoo!' },
  slam: { trash: 'Nap time, junior! Ho ho ho!', lose: 'REF! RAAAGH!', win: 'SCOREBOARD, BABY!' },
  rolo: { trash: 'Bird brain! Ha-ha-snort!', lose: 'ERROR! ERROR!', win: 'Victory calculated!' },
  pix: { trash: 'Nice ears, carrot boy! Ahahaha!', lose: 'WAAARK! No fair!', win: 'WINNER WINNER! Cacaw!' },
  brutus: { trash: 'Little lizard, BIG mouth!', lose: 'RAAAGH! BRUTUS ANGRY!', win: 'NOBODY beats Brutus!' },
};

export function linesFor(heroKey: string): HeroLines {
  return LINES[heroKey] ?? LINES.zip;
}
