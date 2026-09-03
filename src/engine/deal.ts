/**
 * Dealing and board metadata.
 *
 * Everything here is pure: no clock, no global RNG, no I/O. Randomness enters
 * only through the caller-supplied `seed`, so a board number + seed always
 * reproduces byte-identical hands - which is what lets the server replay an
 * action log and what lets a hand record be re-dealt in a test.
 *
 * Board metadata (who deals, who is vulnerable) is fixed by the board number
 * alone under Law 2 (The Boards) of the Laws of Duplicate Bridge: each board
 * carries a designated dealer and vulnerability, so two tables playing board 7
 * anywhere in the world play it with the same dealer and the same vulnerability.
 */

import type { Board, Card, Hands, Seat, Side, Vulnerability } from './types';
import { SEATS } from './types';
import {
  FULL_DECK,
  hcp,
  isBalanced,
  losingTrickCount,
  makeRng,
  shape,
  shuffle,
  sortHand,
} from './cards';

/** A bridge hand is 13 cards; 4 x 13 = the 52-card deck. */
const CARDS_PER_HAND = 13;

/**
 * Vulnerability for boards 1..16, in order.
 *
 * Law 2 (The Boards): vulnerability runs on a 16-board cycle, so board 17 is
 * dealt exactly like board 1. The cycle is *not* a simple rotation - it is a
 * fixed table designed so that over 16 boards every seat deals at each of the
 * four vulnerabilities.
 */
const VULNERABILITY_CYCLE: readonly Vulnerability[] = [
  'None', // 1
  'NS', // 2
  'EW', // 3
  'Both', // 4
  'NS', // 5
  'EW', // 6
  'Both', // 7
  'None', // 8
  'EW', // 9
  'Both', // 10
  'None', // 11
  'NS', // 12
  'Both', // 13
  'None', // 14
  'NS', // 15
  'EW', // 16
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Coerce anything the caller passed into a usable board number.
 *
 * There is no board 0 and no board -3, so out-of-range or non-integer input is
 * a caller bug. We clamp to board 1 rather than throwing: this code runs inside
 * a Durable Object serving four live players, and a nonsense board number must
 * not take the table down.
 */
function normalizeBoardNumber(boardNumber: number): number {
  if (!Number.isFinite(boardNumber)) return 1;
  const n = Math.trunc(boardNumber);
  return n >= 1 ? n : 1;
}

/** Assemble a fresh, unplayed `Board` around an already-sorted set of hands. */
function makeBoard(boardNumber: number, seed: string, hands: Hands): Board {
  const n = normalizeBoardNumber(boardNumber);
  return {
    boardNumber: n,
    dealer: dealerForBoard(n),
    vulnerability: vulnerabilityForBoard(n),
    hands,
    auction: [],
    contract: null,
    play: null,
    result: null,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Board metadata
// ---------------------------------------------------------------------------

/**
 * The seat that deals (and therefore makes the first call) on a given board.
 *
 * Law 2 (The Boards): the dealer rotates clockwise with period 4 - board 1 is
 * dealt by North, board 2 by East, board 3 by South, board 4 by West, board 5
 * by North again. Out-of-range input is clamped to board 1.
 */
export function dealerForBoard(boardNumber: number): Seat {
  const n = normalizeBoardNumber(boardNumber);
  return SEATS[(n - 1) % SEATS.length];
}

/**
 * The vulnerability of a given board.
 *
 * Law 2 (The Boards): a fixed 16-board cycle (see `VULNERABILITY_CYCLE`), so
 * board 17 repeats board 1, board 33 repeats board 1, and so on.
 * Out-of-range input is clamped to board 1.
 */
export function vulnerabilityForBoard(boardNumber: number): Vulnerability {
  const n = normalizeBoardNumber(boardNumber);
  return VULNERABILITY_CYCLE[(n - 1) % VULNERABILITY_CYCLE.length];
}

/**
 * Whether a seat is vulnerable under the given vulnerability.
 *
 * Vulnerability is a property of a *side*, never of a single player: if North
 * is vulnerable then South is too. Bonuses and undertrick penalties both key
 * off this, so it has to be asked per seat and answered per side.
 */
export function isVulnerable(seat: Seat, vul: Vulnerability): boolean {
  if (vul === 'Both') return true;
  if (vul === 'None') return false;
  return sideOf(seat) === vul;
}

/** The partnership a seat belongs to: North and South are NS, East and West EW. */
export function sideOf(seat: Seat): Side {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

/** The seat sitting opposite - i.e. this seat's partner (two seats clockwise). */
export function partnerOf(seat: Seat): Seat {
  return nextSeat(seat, 2);
}

/**
 * The seat `steps` places clockwise (N -> E -> S -> W -> N); defaults to the
 * next seat. Clockwise rotation is the order of both the auction and the play,
 * so this is the engine's single source of "whose turn is it next".
 *
 * Negative and oversized steps are wrapped into range, so `nextSeat(s, -1)`
 * correctly gives the seat to the right.
 */
export function nextSeat(seat: Seat, steps: number = 1): Seat {
  const from = SEATS.indexOf(seat);
  const delta = Number.isFinite(steps) ? Math.trunc(steps) : 0;
  const size = SEATS.length;
  // Double modulo: JS `%` keeps the sign of the dividend, which would produce a
  // negative index for anticlockwise steps.
  const index = (((from + delta) % size) + size) % size;
  return SEATS[index];
}

/**
 * The four seats clockwise, starting from `seat`.
 *
 * Used wherever a bridge procedure starts at a nominated player and goes round
 * the table once: the auction from the dealer, a trick from its leader, a claim
 * poll from the claimer's LHO. Returns a fresh array on every call.
 */
export function seatsInOrderFrom(seat: Seat): Seat[] {
  return [seat, nextSeat(seat, 1), nextSeat(seat, 2), nextSeat(seat, 3)];
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/**
 * Deal a fresh board: shuffle the deck with `seed` and hand out 13 cards to
 * each seat in N, E, S, W order.
 *
 * Deterministic by design - the same board number and seed always produce the
 * same 52 cards in the same 4 hands, which is what makes the action log
 * replayable and a reported hand reproducible. The dealer and vulnerability
 * come from the board number under Law 2, not from the shuffle.
 */
export function dealBoard(boardNumber: number, seed: string): Board {
  const deck = shuffle(FULL_DECK, makeRng(seed));
  const hands: Hands = { N: [], E: [], S: [], W: [] };
  for (let i = 0; i < SEATS.length; i++) {
    const seat = SEATS[i];
    hands[seat] = sortHand(deck.slice(i * CARDS_PER_HAND, (i + 1) * CARDS_PER_HAND));
  }
  return makeBoard(boardNumber, seed, hands);
}

/**
 * Build a board from hands that are already known, for tests and for replaying
 * a hand record (a PBN deal, a bug report, a saved end position).
 *
 * The input is copied and re-sorted, never mutated. It is deliberately *not*
 * validated as a legal 52-card deal: a test is allowed to hand in a partial
 * layout - five cards each to set up a squeeze, say - and still get a usable
 * `Board` back. Dealer and vulnerability still come from the board number, so a
 * replayed deal scores exactly as the original did.
 */
export function dealBoardFromHands(boardNumber: number, seed: string, hands: Hands): Board {
  const copied: Hands = {
    N: sortHand(hands.N.slice()),
    E: sortHand(hands.E.slice()),
    S: sortHand(hands.S.slice()),
    W: sortHand(hands.W.slice()),
  };
  return makeBoard(boardNumber, seed, copied);
}

/**
 * Summarise a hand the way a bidding system does: high-card points, suit
 * lengths, whether it is balanced, and its Losing Trick Count.
 *
 * Every number here comes from `cards.ts` so that a hand is valued identically
 * wherever it is asked about - the bots, the UI and the post-mortem must never
 * disagree about how many points a hand holds.
 *
 * - `hcp` is the Milton Work count (A=4, K=3, Q=2, J=1).
 * - `shape` is suit lengths in notation order, [spades, hearts, diamonds,
 *   clubs] - the order hands are written and quoted in, and the same order
 *   `shape()` in cards.ts returns. Note this is *not* the low-to-high `SUITS`
 *   order that the auction ranks suits by.
 * - `balanced` means no void, no singleton and at most one doubleton - the
 *   4-3-3-3, 4-4-3-2 and 5-3-3-2 patterns that a No-Trump opening promises.
 *   Only meaningful for a complete 13-card hand.
 * - `ltc` is the standard Losing Trick Count (0..12): within the top three
 *   cards of a suit, every missing ace, king or queen is a loser. Cards below
 *   the third in a suit are assumed to be ruffed or discarded once a trump fit
 *   is found, which is why the count stops at three.
 */
export function describeHand(cards: readonly Card[]): {
  hcp: number;
  shape: [number, number, number, number];
  balanced: boolean;
  ltc: number;
} {
  return {
    hcp: hcp(cards),
    shape: shape(cards),
    balanced: isBalanced(cards),
    ltc: losingTrickCount(cards),
  };
}
