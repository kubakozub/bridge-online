/**
 * Duplicate-bridge scoring.
 *
 * Every number in this file comes from the *Duplicate Bridge Scoring Table*
 * (Law 77 of the Laws of Duplicate Bridge) and the *Methods of Scoring*
 * (Law 78: 78A match points, 78B international match points / the IMP scale).
 * Where a rule is not obvious from the arithmetic the Law is cited inline.
 *
 * The module is pure: no input is mutated, and there is no clock, no RNG and
 * no I/O. Everything is a function of its arguments, so the same board always
 * produces the same score on the server and in the browser.
 */

import type {
  BidLevel,
  Board,
  BoardResult,
  Contract,
  MatchScore,
  PlayState,
  Risk,
  ScoreLine,
  ScoringMode,
  Seat,
  Side,
  Strain,
  Vulnerability,
} from './types';

// ---------------------------------------------------------------------------
// Constants from the Law 77 scoring table
// ---------------------------------------------------------------------------

/** Trick points for one odd trick in a minor (clubs, diamonds). */
const MINOR_ODD_TRICK = 20;
/** Trick points for one odd trick in a major (hearts, spades). */
const MAJOR_ODD_TRICK = 30;
/** Trick points for the *first* odd trick in no-trump. */
const NT_FIRST_ODD_TRICK = 40;
/** Trick points for every no-trump odd trick after the first. */
const NT_LATER_ODD_TRICK = 30;

/** A contract is for game when its (possibly doubled) trick score reaches this. */
const GAME_THRESHOLD = 100;

/** Total tricks in a deal. */
const TRICKS_IN_DEAL = 13;
/** The "book": the first six tricks, which do not count towards the contract. */
const BOOK = 6;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The partnership a seat belongs to. */
function sideOf(seat: Seat): Side {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

/** Doubling multiplier applied to the trick score: undoubled 1, X 2, XX 4. */
function riskMultiplier(risk: Risk): 1 | 2 | 4 {
  if (risk === 'XX') return 4;
  if (risk === 'X') return 2;
  return 1;
}

/**
 * Points for one trick in the given strain *after the first*.
 * Note that a no-trump overtrick is worth 30, not 40 - only the first odd
 * trick of a no-trump contract carries the 40-point premium (Law 77).
 */
function laterTrickValue(strain: Strain): number {
  return strain === 'C' || strain === 'D' ? MINOR_ODD_TRICK : MAJOR_ODD_TRICK;
}

/** Undoubled trick score of a contract, before any doubling multiplier. */
function baseContractTrickScore(level: BidLevel, strain: Strain): number {
  if (strain === 'N') return NT_FIRST_ODD_TRICK + NT_LATER_ODD_TRICK * (level - 1);
  return laterTrickValue(strain) * level;
}

/** Force a trick count into the only range a deal can produce: 0..13. */
function clampTricks(tricks: number): number {
  const whole = Math.round(tricks);
  if (!Number.isFinite(whole) || whole < 0) return 0;
  return whole > TRICKS_IN_DEAL ? TRICKS_IN_DEAL : whole;
}

/**
 * Whether the declaring side is vulnerable on this board.
 * Vulnerability is a property of the board, not of the contract, which is why
 * it is decided by the board's vulnerability and the declarer's partnership.
 */
export function isDeclarerVulnerable(vulnerability: Vulnerability, declarer: Seat): boolean {
  if (vulnerability === 'Both') return true;
  if (vulnerability === 'None') return false;
  return vulnerability === sideOf(declarer);
}

/**
 * Renders a contract in standard bridge notation ("4S", "3N", "2DX", "1NXX"),
 * or "Passed out" for a board with no contract. Declarer is deliberately not
 * included: `ScoreLine` carries it in its own field.
 */
export function formatContract(contract: Contract | null): string {
  if (contract === null) return 'Passed out';
  const suffix = contract.risk === 'none' ? '' : contract.risk;
  return `${contract.level}${contract.strain}${suffix}`;
}

interface ParsedContract {
  level: BidLevel;
  strain: Strain;
  risk: Risk;
}

/** Inverse of {@link formatContract}; returns null for anything unparseable. */
function parseContractLabel(label: string): ParsedContract | null {
  const text = label.replace(/\s+/g, '').toUpperCase();
  const match = /^([1-7])(NT|N|[CDHS])(XX|X)?$/.exec(text);
  if (match === null) return null;
  const level = Number(match[1]) as BidLevel;
  const strain: Strain = match[2] === 'NT' ? 'N' : (match[2] as Strain);
  const doubling = match[3];
  const risk: Risk = doubling === 'XX' ? 'XX' : doubling === 'X' ? 'X' : 'none';
  return { level, strain, risk };
}

// ---------------------------------------------------------------------------
// Overtricks and undertricks
// ---------------------------------------------------------------------------

/**
 * Premium for overtricks (Law 77).
 * Undoubled overtricks are worth the plain trick value; once the contract is
 * doubled the strain stops mattering entirely and only vulnerability counts.
 */
function overtrickPremium(overtricks: number, strain: Strain, risk: Risk, vulnerable: boolean): number {
  if (overtricks <= 0) return 0;
  if (risk === 'none') return overtricks * laterTrickValue(strain);
  if (risk === 'X') return overtricks * (vulnerable ? 200 : 100);
  // Redoubled overtricks are exactly twice the doubled value.
  return overtricks * (vulnerable ? 400 : 200);
}

/**
 * Penalty for undertricks, as a positive number of points to the defenders
 * (Law 77).
 *
 * The doubled non-vulnerable ladder is the one people get wrong: 100 for the
 * first undertrick, 200 each for the second and third, 300 each from the
 * fourth on (totals 100 / 300 / 500 / 800 / 1100 ...). Doubled vulnerable is
 * 200 for the first and 300 for each subsequent one (200 / 500 / 800 ...).
 * Redoubled penalties are exactly twice the doubled penalties.
 */
function undertrickPenalty(undertricks: number, risk: Risk, vulnerable: boolean): number {
  if (undertricks <= 0) return 0;
  if (risk === 'none') return undertricks * (vulnerable ? 100 : 50);

  let doubled: number;
  if (vulnerable) {
    doubled = 200 + (undertricks - 1) * 300;
  } else {
    doubled = 100;
    if (undertricks >= 2) doubled += 200 * Math.min(undertricks - 1, 2);
    if (undertricks >= 4) doubled += 300 * (undertricks - 3);
  }
  return risk === 'XX' ? doubled * 2 : doubled;
}

// ---------------------------------------------------------------------------
// Contract scoring
// ---------------------------------------------------------------------------

/**
 * Scores one contract from the DECLARER's point of view: positive when
 * declarer made the contract, negative when declarer went down.
 *
 * `tricksWon` is the total number of tricks taken by the declaring side on the
 * whole deal (0..13), not the number of odd tricks - the first six tricks are
 * the "book" and do not count towards the contract (Law 77).
 *
 * The game/part-score test uses the trick score *after* doubling, which is why
 * 2Hx (120) earns a game bonus while 2H (60) does not.
 */
export function scoreContract(contract: Contract, tricksWon: number, vulnerable: boolean): number {
  const tricks = clampTricks(tricksWon);
  const required = BOOK + contract.level;
  const result = tricks - required;

  if (result < 0) {
    return -undertrickPenalty(-result, contract.risk, vulnerable);
  }

  const trickScore = baseContractTrickScore(contract.level, contract.strain) * riskMultiplier(contract.risk);

  // Law 77: game bonus when the contract's trick score reaches 100, otherwise
  // the flat part-score bonus of 50 (which is the same at both vulnerabilities).
  const gameBonus = trickScore >= GAME_THRESHOLD ? (vulnerable ? 500 : 300) : 50;

  // Slam bonus: small slam = 12 tricks contracted, grand slam = all 13.
  let slamBonus = 0;
  if (contract.level === 6) slamBonus = vulnerable ? 750 : 500;
  else if (contract.level === 7) slamBonus = vulnerable ? 1500 : 1000;

  // "Insult" bonus for making a doubled/redoubled contract (Law 77).
  const insultBonus = contract.risk === 'XX' ? 100 : contract.risk === 'X' ? 50 : 0;

  const overtricks = overtrickPremium(result, contract.strain, contract.risk, vulnerable);

  return trickScore + overtricks + gameBonus + slamBonus + insultBonus;
}

// ---------------------------------------------------------------------------
// Board scoring
// ---------------------------------------------------------------------------

/**
 * Tricks taken by the declaring side, or null while the deal is still
 * undecided.
 *
 * The recorded trick counts are authoritative once they account for all 13
 * tricks. Before that, an unopposed claim settles the deal: Law 68/69 give the
 * claimer's side exactly the tricks it claimed once every opponent has
 * acquiesced, and the remaining tricks go to the other side.
 */
function declarerTricks(play: PlayState, declarer: Seat): number | null {
  const declarerSide = sideOf(declarer);
  if (play.tricksNS + play.tricksEW === TRICKS_IN_DEAL) {
    return declarerSide === 'NS' ? play.tricksNS : play.tricksEW;
  }
  const claim = play.claim;
  if (claim !== null && claim.pending.length === 0 && claim.rejected.length === 0) {
    const claimed = clampTricks(claim.tricks);
    return sideOf(claim.by) === declarerSide ? claimed : TRICKS_IN_DEAL - claimed;
  }
  return null;
}

/**
 * Scores a finished board and expresses the result from North-South's point of
 * view, negating the declarer-side score when declarer sits East or West.
 *
 * A passed-out board (four passes, so no contract) scores 0 for both sides
 * (Law 22). A board whose play has not yet produced a decision is reported
 * with null tricks and a score of 0.
 */
export function scoreBoard(board: Board): BoardResult {
  const contract = board.contract;
  if (contract === null) {
    return {
      contract: null,
      tricksWon: null,
      resultRelative: null,
      scoreNS: 0,
      passedOut: true,
    };
  }

  const tricksWon = board.play === null ? null : declarerTricks(board.play, contract.declarer);
  if (tricksWon === null) {
    return {
      contract,
      tricksWon: null,
      resultRelative: null,
      scoreNS: 0,
      passedOut: false,
    };
  }

  const vulnerable = isDeclarerVulnerable(board.vulnerability, contract.declarer);
  const declarerScore = scoreContract(contract, tricksWon, vulnerable);
  const scoreNS = sideOf(contract.declarer) === 'NS' ? declarerScore : -declarerScore;

  return {
    contract,
    tricksWon,
    resultRelative: tricksWon - (BOOK + contract.level),
    scoreNS,
    passedOut: false,
  };
}

/** Builds the scoreboard row for one board, ready to hand to the client. */
export function scoreLineFromBoard(board: Board): ScoreLine {
  const result = scoreBoard(board);
  return {
    boardNumber: board.boardNumber,
    contractLabel: formatContract(result.contract),
    declarer: result.contract === null ? null : result.contract.declarer,
    tricksWon: result.tricksWon,
    resultRelative: result.resultRelative,
    scoreNS: result.scoreNS,
    vulnerability: board.vulnerability,
  };
}

// ---------------------------------------------------------------------------
// Match points and IMPs (Law 78)
// ---------------------------------------------------------------------------

/**
 * Upper bound of each row of the IMP scale (Law 78B), indexed by the number of
 * IMPs: a point difference of `d` is worth the index of the first bound that is
 * >= d, and anything above the last bound is worth 24 IMPs.
 */
const IMP_UPPER_BOUNDS: readonly number[] = [
  10, 40, 80, 120, 160, 210, 260, 310, 360, 420, 490, 590, 740, 890, 1090, 1290, 1490, 1740, 1990,
  2240, 2490, 2990, 3490, 3990,
];

/** Largest IMP award on the scale, for any difference of 4000 points or more. */
const MAX_IMPS = 24;

/**
 * Converts a point difference into IMPs using the standard WBF table
 * (Law 78B). The sign is carried through, so a negative difference yields
 * negative IMPs: `impsFromDiff(-430) === -10`.
 */
export function impsFromDiff(difference: number): number {
  const magnitude = Math.abs(Math.trunc(difference));
  const sign = difference < 0 ? -1 : 1;
  for (let i = 0; i < IMP_UPPER_BOUNDS.length; i += 1) {
    if (magnitude <= IMP_UPPER_BOUNDS[i]) return sign * i;
  }
  return sign * MAX_IMPS;
}

/**
 * Match-point percentage for one score against the field (Law 78A): two match
 * points for every score beaten, one for every score tied, expressed as a
 * percentage of the top.
 *
 * A pair never scores match points against itself, so one occurrence of `mine`
 * is removed from `scores` first. That makes the function correct whether the
 * caller passes the whole field (the usual case) or only the other tables.
 * With nothing to compare against, the board is an average: 50%.
 */
export function matchPointsPercentage(scores: number[], mine: number): number {
  const field = scores.slice();
  const selfIndex = field.indexOf(mine);
  if (selfIndex >= 0) field.splice(selfIndex, 1);

  const top = 2 * field.length;
  if (top === 0) return 50;

  let earned = 0;
  for (const other of field) {
    if (mine > other) earned += 2;
    else if (mine === other) earned += 1;
  }
  return Math.round((earned / top) * 10000) / 100;
}

/**
 * Totals a set of score lines into a match scoreboard.
 *
 * `scoreNS` is signed, so each board's points are credited to whichever side
 * actually earned them: a positive `scoreNS` goes to North-South, a negative
 * one goes to East-West as a positive amount.
 *
 * In 'imp' mode each board is additionally converted to IMPs against a
 * baseline datum of 0 (Law 78B), which is what a head-to-head table without an
 * opposing datum can compare to; the per-board figure is written to
 * `ScoreLine.imps` on a copy of the line, never on the caller's object.
 */
export function buildMatchScore(lines: ScoreLine[], mode: ScoringMode): MatchScore {
  const out: ScoreLine[] = [];
  let totalNS = 0;
  let totalEW = 0;
  let impsNS = 0;
  let impsEW = 0;

  for (const line of lines) {
    if (line.scoreNS > 0) totalNS += line.scoreNS;
    else if (line.scoreNS < 0) totalEW += -line.scoreNS;

    if (mode === 'imp') {
      const imps = impsFromDiff(line.scoreNS);
      if (imps > 0) impsNS += imps;
      else if (imps < 0) impsEW += -imps;
      out.push({ ...line, imps });
    } else {
      out.push({ ...line });
    }
  }

  if (mode === 'imp') {
    return { lines: out, totalNS, totalEW, impsNS, impsEW };
  }
  return { lines: out, totalNS, totalEW };
}

// ---------------------------------------------------------------------------
// Rubber presentation
// ---------------------------------------------------------------------------

/**
 * Splits the running score the way a rubber-bridge score pad does: contract
 * trick points go *below* the line (they are what wins a game), and everything
 * else - overtricks, bonuses, the insult bonus and undertrick penalties - goes
 * *above* the line.
 *
 * `gamesNS` / `gamesEW` count games won: a side wins a game when its
 * below-the-line total reaches 100, at which point the line is drawn and BOTH
 * sides' part-scores are wiped out - an unfinished part-score never carries
 * across a game.
 *
 * This is a presentation of duplicate scores on a rubber-shaped pad, not a
 * separate rubber-scoring engine: the per-deal game bonus that duplicate awards
 * (which rubber replaces with a rubber bonus) is still included above the line.
 * Lines whose contract cannot be parsed, or that have no result yet, are
 * skipped.
 */
export function rubberScoreSummary(lines: ScoreLine[]): {
  aboveNS: number;
  belowNS: number;
  aboveEW: number;
  belowEW: number;
  gamesNS: number;
  gamesEW: number;
} {
  let aboveNS = 0;
  let belowNS = 0;
  let aboveEW = 0;
  let belowEW = 0;
  let gamesNS = 0;
  let gamesEW = 0;

  // Below-the-line points towards the game currently being played for.
  let legNS = 0;
  let legEW = 0;

  for (const line of lines) {
    if (line.declarer === null || line.resultRelative === null) continue;
    const parsed = parseContractLabel(line.contractLabel);
    if (parsed === null) continue;

    const declarerIsNS = sideOf(line.declarer) === 'NS';
    const declarerScore = declarerIsNS ? line.scoreNS : -line.scoreNS;

    if (line.resultRelative < 0) {
      // Undertricks are a premium to the defenders, always above the line.
      const penalty = -declarerScore;
      if (declarerIsNS) aboveEW += penalty;
      else aboveNS += penalty;
      continue;
    }

    const below = baseContractTrickScore(parsed.level, parsed.strain) * riskMultiplier(parsed.risk);
    const above = declarerScore - below;

    if (declarerIsNS) {
      belowNS += below;
      aboveNS += above;
      legNS += below;
      if (legNS >= GAME_THRESHOLD) {
        gamesNS += 1;
        legNS = 0;
        legEW = 0;
      }
    } else {
      belowEW += below;
      aboveEW += above;
      legEW += below;
      if (legEW >= GAME_THRESHOLD) {
        gamesEW += 1;
        legNS = 0;
        legEW = 0;
      }
    }
  }

  return { aboveNS, belowNS, aboveEW, belowEW, gamesNS, gamesEW };
}
