/**
 * The auction state machine.
 *
 * Everything here is a pure function of `(auction, dealer)`: the call list is
 * the single source of truth, so any derived fact (whose turn it is, whether
 * the auction is over, who declares) is recomputed rather than stored. That
 * keeps replay, undo and server/client agreement trivially consistent.
 *
 * Terminology follows the Laws of Duplicate Bridge: a *call* is any auction
 * token (pass, double, redouble or bid), a *bid* is specifically a contract
 * bid naming a level and a denomination (strain).
 */

import { SEATS, STRAINS } from './types';
import type { Bid, BidLevel, Call, Contract, Risk, Seat, Side, Strain } from './types';

// ---------------------------------------------------------------------------
// Module-private helpers and tables
// ---------------------------------------------------------------------------

/** The seven legal bidding levels ("odd tricks"), low to high. */
const LEVELS: readonly BidLevel[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * Column order of the classic printed auction grid. Reading left to right is
 * also clockwise rotation (West's left-hand opponent is North), so successive
 * calls always land in successive columns.
 */
const AUCTION_COLUMNS: readonly Seat[] = ['W', 'N', 'E', 'S'];

/** Every contract bid, ascending: 1C, 1D, 1H, 1S, 1N, 2C, ... 7N. */
const ALL_BIDS: readonly Bid[] = LEVELS.flatMap((level) =>
  STRAINS.map((strain) => `${level}${strain}` as Bid),
);

/** Narrowing guard: true when the call is a contract bid rather than P/X/XX. */
function isBid(call: Call): call is Bid {
  return parseBid(call) !== null;
}

/** The partnership a seat belongs to. */
function sideOf(seat: Seat): Side {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

/** True when the two seats sit on opposing sides of the table. */
function isOpponent(a: Seat, b: Seat): boolean {
  return sideOf(a) !== sideOf(b);
}

/**
 * The seat that made the call `offset` positions after the dealer.
 * Calls are made in clockwise rotation beginning with the dealer (Law 17B),
 * and SEATS is stored in clockwise order, so this is plain modular arithmetic.
 */
function seatAt(dealer: Seat, offset: number): Seat {
  const n = SEATS.length;
  const start = Math.max(0, SEATS.indexOf(dealer));
  return SEATS[(((start + offset) % n) + n) % n];
}

/**
 * Index of the last call that was not a pass, or -1 if there is none.
 * The doubling Laws are phrased in terms of the "last preceding bid/double"
 * with "no call other than a pass intervening", which is exactly this index.
 */
function lastNonPassIndex(auction: readonly Call[]): number {
  for (let i = auction.length - 1; i >= 0; i--) {
    if (auction[i] !== 'P') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

/**
 * Splits a call into its level and denomination, or returns null when the call
 * is a pass, double or redouble (or an unrecognised token off the wire).
 */
export function parseBid(call: Call): { level: BidLevel; strain: Strain } | null {
  if (call.length !== 2) return null;
  const levelChar = call.charAt(0);
  const strainChar = call.charAt(1);
  const level = LEVELS.find((l) => String(l) === levelChar);
  if (level === undefined) return null;
  const strain = STRAINS.find((s) => s === strainChar);
  if (strain === undefined) return null;
  return { level, strain };
}

/**
 * Total order over contract bids as a dense index 0..34
 * (1C=0, 1D=1, 1H=2, 1S=3, 1N=4, 2C=5, ... 7N=34).
 *
 * The denominations rank clubs < diamonds < hearts < spades < no-trump
 * (Law 18), which is why STRAINS is stored in that order. Returns -1 for a
 * value that is not a well-formed bid.
 */
export function bidRank(bid: Bid): number {
  const parsed = parseBid(bid);
  if (parsed === null) return -1;
  return (parsed.level - 1) * STRAINS.length + STRAINS.indexOf(parsed.strain);
}

/**
 * Comparator over contract bids: negative if `a` is lower than `b`, zero if
 * they are the same bid, positive if `a` is higher.
 *
 * Law 18C: a bid supersedes a previous bid if it names a greater number of odd
 * tricks, or the same number in a higher-ranking denomination - which is
 * exactly a comparison of `bidRank`.
 */
export function compareBids(a: Bid, b: Bid): number {
  return bidRank(a) - bidRank(b);
}

/**
 * The most recent contract bid in the auction and its index, ignoring passes,
 * doubles and redoubles. Null when nobody has bid yet.
 */
export function lastContractBid(auction: Call[]): { bid: Bid; index: number } | null {
  for (let i = auction.length - 1; i >= 0; i--) {
    const call = auction[i];
    if (isBid(call)) return { bid: call, index: i };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn order and termination
// ---------------------------------------------------------------------------

/**
 * The seat whose turn it is to call. Calls are made in clockwise rotation
 * beginning with the dealer (Law 17B).
 *
 * Only meaningful while the auction is open; callers should test
 * `isAuctionClosed` first, since after the auction ends nobody is on turn
 * (this keeps rotating regardless).
 */
export function seatToCall(auction: Call[], dealer: Seat): Seat {
  return seatAt(dealer, auction.length);
}

/**
 * True once no further calls may be made (Law 22A): either all four players
 * passed on the first round ("passed out"), or, after there has been a bid,
 * three passes in rotation have followed.
 *
 * The three trailing passes are counted after the last *call*, not the last
 * bid, because a double or redouble restarts the count: 1S-X-P-P-P is closed,
 * but 1S-P-P-X-P-P is not yet.
 */
export function isAuctionClosed(auction: Call[]): boolean {
  const n = auction.length;
  if (n < 4) return false;
  if (lastContractBid(auction) === null) {
    // Nobody bid: the auction ends on the fourth pass of the first round.
    return auction[0] === 'P' && auction[1] === 'P' && auction[2] === 'P' && auction[3] === 'P';
  }
  return auction[n - 1] === 'P' && auction[n - 2] === 'P' && auction[n - 3] === 'P';
}

/**
 * True when the board was passed out: the auction is over and no contract bid
 * was ever made (Law 22A1). Such a board has no declarer, no play and a score
 * of zero for both sides.
 */
export function isPassedOut(auction: Call[]): boolean {
  return isAuctionClosed(auction) && lastContractBid(auction) === null;
}

/**
 * Whether the standing contract bid is currently undoubled, doubled or
 * redoubled. Only calls made *after* the last contract bid count, because any
 * new bid wipes out an earlier double or redouble (Law 19: a double applies
 * only to the last preceding bid).
 */
export function currentRisk(auction: Call[]): Risk {
  const last = lastContractBid(auction);
  if (last === null) return 'none';
  let risk: Risk = 'none';
  for (let i = last.index + 1; i < auction.length; i++) {
    const call = auction[i];
    if (call === 'X') risk = 'X';
    else if (call === 'XX') risk = 'XX';
  }
  return risk;
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/**
 * Whether `seat` may make `call` right now.
 *
 * - Nothing is legal once the auction is closed, and nothing is legal out of
 *   rotation, so this also returns false when it is not `seat`'s turn.
 * - Pass is otherwise always legal.
 * - A contract bid must be *sufficient* (Law 18C): strictly higher ranking
 *   than the last contract bid.
 * - Double is legal only against the last preceding bid, made by an opponent,
 *   with no call other than a pass intervening (Law 19A) - so a bid that has
 *   already been doubled or redoubled cannot be doubled again.
 * - Redouble is legal only against the last preceding double, made by an
 *   opponent, with no call other than a pass intervening (Law 19B) - i.e. your
 *   own side's contract has been doubled and not yet redoubled.
 */
export function isLegalCall(auction: Call[], dealer: Seat, seat: Seat, call: Call): boolean {
  if (isAuctionClosed(auction)) return false;
  if (seatToCall(auction, dealer) !== seat) return false;

  if (call === 'P') return true;

  if (call === 'X' || call === 'XX') {
    const i = lastNonPassIndex(auction);
    if (i < 0) return false;
    // A double or redouble is always aimed at an opponent's call: you may
    // never double your own side's bid, nor redouble your own side's double.
    if (!isOpponent(seat, seatAt(dealer, i))) return false;
    const target = auction[i];
    return call === 'X' ? isBid(target) : target === 'X';
  }

  const parsed = parseBid(call);
  if (parsed === null) return false; // unrecognised token off the wire
  const last = lastContractBid(auction);
  return last === null || compareBids(call, last.bid) > 0;
}

/**
 * Every call `seat` may legally make right now, for the bidding box and for
 * bots. Empty when it is not `seat`'s turn or the auction is closed.
 *
 * Order is deterministic: 'P', then 'X' or 'XX' if available, then every
 * sufficient contract bid in ascending rank.
 */
export function legalCalls(auction: Call[], dealer: Seat, seat: Seat): Call[] {
  const out: Call[] = [];
  const specials: readonly Call[] = ['P', 'X', 'XX'];
  for (const call of specials) {
    if (isLegalCall(auction, dealer, seat, call)) out.push(call);
  }
  for (const bid of ALL_BIDS) {
    if (isLegalCall(auction, dealer, seat, bid)) out.push(bid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result of the auction
// ---------------------------------------------------------------------------

/**
 * The final contract, or null while the auction is still open and for a
 * passed-out board.
 *
 * The declarer rule is the subtle one. Per the Laws' definition of *Declarer*,
 * it is the player who, for the side that won the final contract, FIRST bid
 * the denomination named in that contract - not the player who made the final
 * bid, and not the first member of that side to bid at all. So in
 * 1H(N) 2H(E) 4H(S) the declarer is North, and in 1C(N)-P-1S(S)-P-4S(N) the
 * declarer is South, who bid spades first.
 */
export function deriveContract(auction: Call[], dealer: Seat): Contract | null {
  if (!isAuctionClosed(auction)) return null;
  const last = lastContractBid(auction);
  if (last === null) return null; // passed out
  const parsed = parseBid(last.bid);
  if (parsed === null) return null;

  const winner = seatAt(dealer, last.index);
  const winningSide = sideOf(winner);

  // Scan forwards for the first bid of the winning strain by the winning side.
  // The final bid itself always qualifies, so this loop cannot fail to match.
  let declarer: Seat = winner;
  for (let i = 0; i <= last.index; i++) {
    const call = auction[i];
    const candidate = parseBid(call);
    if (candidate === null || candidate.strain !== parsed.strain) continue;
    const by = seatAt(dealer, i);
    if (sideOf(by) !== winningSide) continue;
    declarer = by;
    break;
  }

  return {
    level: parsed.level,
    strain: parsed.strain,
    declarer,
    risk: currentRisk(auction),
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Lays the auction out as rows of four cells for the classic W-N-E-S auction
 * grid. Cells before the dealer's first call are null so that the dealer's
 * calls line up under the dealer's column, and the final row is padded with
 * nulls to keep every row exactly four wide. An empty auction yields no rows.
 *
 * The column order is fixed at W, N, E, S whoever deals, which is how auctions
 * are printed on hand records and travellers.
 */
export function auctionRows(auction: Call[], dealer: Seat): (Call | null)[][] {
  if (auction.length === 0) return [];
  const width = AUCTION_COLUMNS.length;
  const start = Math.max(0, AUCTION_COLUMNS.indexOf(dealer));
  const total = start + auction.length;
  const rowCount = Math.ceil(total / width);

  const rows: (Call | null)[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: (Call | null)[] = [];
    for (let c = 0; c < width; c++) {
      const cell = r * width + c;
      row.push(cell >= start && cell < total ? auction[cell - start] : null);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Human-readable contract, e.g. "4S x by W", "3NT by N", "7H xx by E", or
 * "Passed out" when there is no contract.
 */
export function contractLabel(contract: Contract | null): string {
  if (contract === null) return 'Passed out';
  const strain = contract.strain === 'N' ? 'NT' : contract.strain;
  const risk = contract.risk === 'X' ? ' x' : contract.risk === 'XX' ? ' xx' : '';
  return `${contract.level}${strain}${risk} by ${contract.declarer}`;
}
