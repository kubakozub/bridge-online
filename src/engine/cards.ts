/**
 * Card primitives, hand evaluation, the deterministic shuffle, and PBN I/O.
 *
 * Everything here is PURE: no mutation of arguments, no clock, no ambient
 * randomness. The single exception is `randomSeed()`, which is deliberately
 * isolated at the bottom of the file so that every other function stays
 * reproducible from its inputs alone.
 *
 * TWO SUIT ORDERS LIVE IN THIS FILE - do not mix them up:
 *
 *  - Bidding rank (Law 18, "Bids"): C < D < H < S. That is the order of the
 *    `SUITS` constant in ./types and the only order that matters in the
 *    auction. Nothing in this file sorts by it.
 *  - Sorting / notation order: S, H, D, C (highest ranking suit first). This
 *    is what `compareCards`, `FULL_DECK`, `shape` and the PBN deal string use.
 *  - Display order: S, H, C, D. Same suits, re-ordered so that no two
 *    same-coloured suits sit next to each other on screen. `sortHand` uses it.
 */

import {
  RANK_CHARS,
  SEATS,
  type Card,
  type Hands,
  type RankChar,
  type Seat,
  type Strain,
  type Suit,
} from './types';

// ---------------------------------------------------------------------------
// Internal tables
// ---------------------------------------------------------------------------

/** Law 1: within a suit the ranks run A (high) down to 2 (low). */
const RANK_VALUE: Readonly<Record<RankChar, number>> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

/** Milton Work count: A=4, K=3, Q=2, J=1, everything else 0. */
const HCP_VALUE: Readonly<Record<RankChar, number>> = {
  '2': 0,
  '3': 0,
  '4': 0,
  '5': 0,
  '6': 0,
  '7': 0,
  '8': 0,
  '9': 0,
  T: 0,
  J: 1,
  Q: 2,
  K: 3,
  A: 4,
};

/** Suits from highest ranking to lowest - the notation / sorting order. */
const SUITS_HIGH_TO_LOW: readonly Suit[] = ['S', 'H', 'D', 'C'] as const;

/** Position of each suit in `SUITS_HIGH_TO_LOW`, for O(1) comparisons. */
const SUIT_SORT_INDEX: Readonly<Record<Suit, number>> = { S: 0, H: 1, D: 2, C: 3 };

/**
 * Screen order per trump strain: the trump suit first, then the remaining
 * three arranged so the colours alternate (black S/C, red H/D). Alternating
 * colours is the standard defence against a revoke caused by misreading two
 * adjacent same-coloured suits.
 */
const DISPLAY_SUIT_ORDER: Readonly<Record<Strain, readonly Suit[]>> = {
  S: ['S', 'H', 'C', 'D'],
  H: ['H', 'S', 'D', 'C'],
  D: ['D', 'S', 'H', 'C'],
  C: ['C', 'H', 'S', 'D'],
  N: ['S', 'H', 'C', 'D'],
};

/** A PBN hand is always four dot-separated holdings, even when some are empty. */
const PBN_SUITS_PER_HAND = 4;

/** Outputs discarded when seeding sfc32, to wash out weak / similar seeds. */
const RNG_WARMUP = 15;

function isSuit(ch: string): ch is Suit {
  return ch === 'C' || ch === 'D' || ch === 'H' || ch === 'S';
}

function isRankChar(ch: string): ch is RankChar {
  return (RANK_CHARS as readonly string[]).includes(ch);
}

/** The four seats clockwise, starting at `from` (Law 5 seating / rotation). */
function seatsClockwiseFrom(from: Seat): Seat[] {
  const start = Math.max(0, SEATS.indexOf(from));
  const out: Seat[] = [];
  for (let i = 0; i < SEATS.length; i++) out.push(SEATS[(start + i) % SEATS.length]);
  return out;
}

/** Cards of one suit, high to low, as a fresh array (never mutates input). */
function holdingIn(cards: readonly Card[], suit: Suit): Card[] {
  return cards.filter((c) => suitOf(c) === suit).sort((a, b) => rankValue(b) - rankValue(a));
}

// ---------------------------------------------------------------------------
// Card primitives
// ---------------------------------------------------------------------------

/** The suit letter of a card: "HT" -> "H". */
export function suitOf(card: Card): Suit {
  return card.charAt(0) as Suit;
}

/** The rank letter of a card: "HT" -> "T". */
export function rankChar(card: Card): RankChar {
  return card.charAt(1) as RankChar;
}

/** Numeric rank of a card, 2..14 (T=10, J=11, Q=12, K=13, A=14). */
export function rankValue(card: Card): number {
  return RANK_VALUE[rankChar(card)];
}

/** Builds a card from its two halves: ("S", "A") -> "SA". */
export function makeCard(suit: Suit, rank: RankChar): Card {
  return `${suit}${rank}`;
}

/**
 * Canonical string form of a card - the same two-character token used on the
 * wire and in bridge notation ("SA", "HT", "C2"). Kept as a function so that
 * any future presentational form ("A of Spades") has one place to live.
 */
export function cardToString(card: Card): string {
  return card;
}

/** Runtime type guard, for validating cards that arrive from the network. */
export function isCard(value: unknown): value is Card {
  return (
    typeof value === 'string' &&
    value.length === 2 &&
    isSuit(value.charAt(0)) &&
    isRankChar(value.charAt(1))
  );
}

/**
 * Tolerant parser for human- or file-supplied card text. Accepts either order
 * ("SA" and "AS"), any case, surrounding whitespace, "10" as a synonym for T,
 * and the Unicode suit symbols found in pasted hand records. Returns null for
 * anything it cannot read - it never guesses.
 *
 * Suit letters (C D H S) and rank letters (2-9 T J Q K A) are disjoint, so
 * "rank first or suit first" is decidable without ambiguity.
 */
export function parseCard(s: string): Card | null {
  if (typeof s !== 'string') return null;
  let t = s.trim().toUpperCase();
  t = t
    .replace(/[♠♤]/g, 'S')
    .replace(/[♥♡]/g, 'H')
    .replace(/[♦♢]/g, 'D')
    .replace(/[♣♧]/g, 'C');
  t = t.replace('10', 'T');
  if (t.length !== 2) return null;
  const a = t.charAt(0);
  const b = t.charAt(1);
  if (isSuit(a) && isRankChar(b)) return makeCard(a, b);
  if (isRankChar(a) && isSuit(b)) return makeCard(b, a);
  return null;
}

/**
 * The 52 cards of the pack (Law 1), in a fixed order: suits S, H, D, C and,
 * within each suit, A down to 2. Frozen, so a shuffled copy can never corrupt
 * the master pack.
 */
export const FULL_DECK: readonly Card[] = Object.freeze(
  ((): Card[] => {
    const deck: Card[] = [];
    for (const suit of SUITS_HIGH_TO_LOW) {
      for (let i = RANK_CHARS.length - 1; i >= 0; i--) deck.push(makeCard(suit, RANK_CHARS[i]));
    }
    return deck;
  })(),
);

/**
 * Total ordering used for canonical storage and for PBN: suits S, H, D, C,
 * then rank high to low. Suitable directly as an Array#sort comparator.
 *
 * Note this is the *notation* order, not the auction order of Law 18 (where
 * clubs are the lowest ranking suit and spades the highest).
 */
export function compareCards(a: Card, b: Card): number {
  const sa = SUIT_SORT_INDEX[suitOf(a)];
  const sb = SUIT_SORT_INDEX[suitOf(b)];
  if (sa !== sb) return sa - sb;
  return rankValue(b) - rankValue(a);
}

/**
 * Returns a NEW array holding the same cards in on-screen order: the trump
 * suit (when given) first, then the rest in alternating colours, ranks high to
 * low inside each suit. With no trump - or in No-Trump - the order is
 * S, H, C, D.
 */
export function sortHand(cards: readonly Card[], trump?: Strain): Card[] {
  const order = DISPLAY_SUIT_ORDER[trump !== undefined && trump !== 'N' ? trump : 'N'];
  const position: Record<Suit, number> = { C: 0, D: 0, H: 0, S: 0 };
  for (let i = 0; i < order.length; i++) position[order[i]] = i;
  return cards.slice().sort((a, b) => {
    const pa = position[suitOf(a)];
    const pb = position[suitOf(b)];
    if (pa !== pb) return pa - pb;
    return rankValue(b) - rankValue(a);
  });
}

// ---------------------------------------------------------------------------
// Hand evaluation
// ---------------------------------------------------------------------------

/**
 * Milton Work high-card points: A=4, K=3, Q=2, J=1. A hand-evaluation
 * convention, not a Law - the Laws never mention point count.
 */
export function hcp(cards: readonly Card[]): number {
  let total = 0;
  for (const card of cards) total += HCP_VALUE[rankChar(card)];
  return total;
}

/** Number of cards held in each suit; every suit is present, zeroes included. */
export function suitLengths(cards: readonly Card[]): Record<Suit, number> {
  const out: Record<Suit, number> = { C: 0, D: 0, H: 0, S: 0 };
  for (const card of cards) out[suitOf(card)] += 1;
  return out;
}

/** Suit lengths as a tuple in notation order: [spades, hearts, diamonds, clubs]. */
export function shape(cards: readonly Card[]): [number, number, number, number] {
  const len = suitLengths(cards);
  return [len.S, len.H, len.D, len.C];
}

/** The three balanced patterns, as sorted-descending length strings. */
const BALANCED_PATTERNS: ReadonlySet<string> = new Set(['4333', '4432', '5332']);

/**
 * True for the balanced distributions 4333, 4432 and 5332 - i.e. no void, no
 * singleton and at most one doubleton. This is the shape test that gates
 * balanced No-Trump openings; suit order is irrelevant, only the pattern.
 */
export function isBalanced(cards: readonly Card[]): boolean {
  const pattern = shape(cards)
    .slice()
    .sort((a, b) => b - a)
    .join('');
  return BALANCED_PATTERNS.has(pattern);
}

/**
 * Shortness (support / dummy) points: void=3, singleton=2, doubleton=1, summed
 * over the four suits. Only meaningful once a trump fit is known, because the
 * value of shortness is the ability to ruff - add them to HCP for support, not
 * for a No-Trump evaluation.
 */
export function distributionPoints(cards: readonly Card[]): number {
  const len = suitLengths(cards);
  let total = 0;
  for (const suit of SUITS_HIGH_TO_LOW) {
    const n = len[suit];
    if (n === 0) total += 3;
    else if (n === 1) total += 2;
    else if (n === 2) total += 1;
  }
  return total;
}

/**
 * Standard Losing Trick Count: within the top three cards of each suit, every
 * missing ace, king or queen is a loser. Short suits cannot hold more losers
 * than they hold cards - a void has none, a singleton at most one (none if it
 * is the ace), a doubleton at most two (the queen does not count there,
 * because a doubleton queen cannot be promoted without help).
 *
 * Range 0..12 for a 13-card hand. Used by the bots for trump-fit hand
 * valuation, where HCP alone undervalues distribution.
 */
export function losingTrickCount(cards: readonly Card[]): number {
  let losers = 0;
  for (const suit of SUITS_HIGH_TO_LOW) {
    const holding = holdingIn(cards, suit);
    const len = holding.length;
    if (len === 0) continue;
    const hasA = holding.some((c) => rankValue(c) === 14);
    const hasK = holding.some((c) => rankValue(c) === 13);
    const hasQ = holding.some((c) => rankValue(c) === 12);
    if (len === 1) {
      losers += hasA ? 0 : 1;
    } else if (len === 2) {
      losers += 2 - (hasA ? 1 : 0) - (hasK ? 1 : 0);
    } else {
      losers += 3 - (hasA ? 1 : 0) - (hasK ? 1 : 0) - (hasQ ? 1 : 0);
    }
  }
  return losers;
}

/**
 * Quick tricks (defensive tricks), counted per suit and summed:
 * AK=2, AQ=1.5, A=1, KQ=1, K with at least one small card=0.5, bare king=0.
 * A holding is capped at 2 - AKQ is still only two quick tricks, because the
 * queen cannot be cashed until the defence has already lost the lead.
 *
 * Returns a multiple of 0.5, which is exact in binary floating point.
 */
export function countQuickTricks(cards: readonly Card[]): number {
  let total = 0;
  for (const suit of SUITS_HIGH_TO_LOW) {
    const holding = holdingIn(cards, suit);
    const len = holding.length;
    if (len === 0) continue;
    const hasA = holding.some((c) => rankValue(c) === 14);
    const hasK = holding.some((c) => rankValue(c) === 13);
    const hasQ = holding.some((c) => rankValue(c) === 12);
    if (hasA && hasK) total += 2;
    else if (hasA && hasQ) total += 1.5;
    else if (hasA) total += 1;
    else if (hasK && hasQ) total += 1;
    else if (hasK && len >= 2) total += 0.5;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Seeded RNG (cyrb128 hash -> sfc32 generator)
// ---------------------------------------------------------------------------

/**
 * cyrb128: expands an arbitrary string into four well-mixed 32-bit seeds.
 * Uses charCodeAt (UTF-16 code units), so the result is identical in every
 * JavaScript engine - Worker, browser and test runner alike.
 */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** sfc32: small fast counter PRNG, 128 bits of state, period >= 2^32. */
function sfc32(seedA: number, seedB: number, seedC: number, seedD: number): () => number {
  let a = seedA | 0;
  let b = seedB | 0;
  let c = seedC | 0;
  let d = seedD | 0;
  return function next(): number {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Builds a deterministic uniform generator over [0, 1) from a seed string.
 * The same seed always yields the same sequence on every platform, which is
 * what lets a board be replayed, audited or re-dealt identically to both
 * tables - the duplicate-bridge requirement that every table plays the very
 * same deal (Law 6, The Shuffle and Deal).
 *
 * The first 15 outputs are discarded so that near-identical seeds ("board-1"
 * vs "board-2") do not start out correlated.
 */
export function makeRng(seed: string): () => number {
  const [a, b, c, d] = cyrb128(seed);
  const rng = sfc32(a, b, c, d);
  for (let i = 0; i < RNG_WARMUP; i++) rng();
  return rng;
}

/**
 * Fisher-Yates shuffle, returning a NEW array; the input is never touched.
 * The randomness is entirely the caller's `rng`, so a shuffle is reproducible
 * from its seed - the electronic equivalent of Law 6's requirement that the
 * pack be shuffled and the same deal be presented at every table.
 *
 * The drawn index is clamped, so a caller's misbehaving rng can never produce
 * an out-of-range swap and silently drop a card from the pack.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    let j = Math.floor(rng() * (i + 1));
    if (!(j >= 0)) j = 0;
    if (j > i) j = i;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * A fresh random seed as lowercase hex, from the platform CSPRNG (available
 * both in Workers and in browsers).
 *
 * THIS IS THE ONLY IMPURE FUNCTION IN THE ENGINE. Call it once at the edge -
 * when a board is created - store the string on the Board, and let everything
 * downstream derive from that seed via `makeRng`.
 *
 * @param bytes entropy in bytes, default 8 (16 hex chars); clamped to 1..64.
 */
export function randomSeed(bytes = 8): string {
  const n = Math.min(64, Math.max(1, Math.floor(bytes) || 1));
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// PBN (Portable Bridge Notation) deal strings
// ---------------------------------------------------------------------------

/** One hand as PBN: four suit holdings, S.H.D.C, ranks high to low. */
function handToPbn(cards: readonly Card[]): string {
  return SUITS_HIGH_TO_LOW.map((suit) => holdingIn(cards, suit).map(rankChar).join('')).join('.');
}

/**
 * Renders the four hands as a PBN deal string, e.g.
 * `N:AQ54.T92.KJ7.QJ3 KJ.AKQ.9852.9764 ...`.
 *
 * The leading letter names the seat whose hand comes first; the remaining
 * three follow clockwise. Passing the dealer there is the usual convention for
 * a hand record, so that the string reads in the same order as the auction.
 * Suits within a hand are always S.H.D.C and ranks always run high to low,
 * with T for the ten - that is what makes two records of the same board
 * byte-identical.
 */
export function handsToPbn(hands: Hands, dealer: Seat): string {
  const parts = seatsClockwiseFrom(dealer).map((seat) => handToPbn(hands[seat] ?? []));
  return `${dealer}:${parts.join(' ')}`;
}

/**
 * Parses a PBN deal string back into hands, or returns null if it is not a
 * well-formed deal. Tolerant about surrounding quotes (as written inside a
 * `[Deal "..."]` tag), case, extra whitespace between hands, and "10" written
 * out instead of T. Strict about everything that could corrupt a board: the
 * seat prefix must be present, there must be exactly four hands of exactly
 * four suit holdings, every rank must be legal, and no card may appear twice.
 *
 * A hand written as "-" (PBN's marker for a hand that was not recorded) parses
 * to an empty array. Hand length is otherwise not enforced, so a partially
 * played board can round-trip; callers that need a complete deal should check
 * for 13 cards per seat themselves.
 *
 * Each returned hand is sorted into canonical `compareCards` order regardless
 * of the order it was written in.
 */
export function pbnToHands(pbn: string): Hands | null {
  if (typeof pbn !== 'string') return null;
  let text = pbn.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  if (text.charAt(1) !== ':') return null;
  const first = text.charAt(0).toUpperCase();
  if (first !== 'N' && first !== 'E' && first !== 'S' && first !== 'W') return null;

  const body = text.slice(2).trim();
  if (body.length === 0) return null;
  const parts = body.split(/\s+/);
  if (parts.length !== SEATS.length) return null;

  const order = seatsClockwiseFrom(first);
  const hands: Hands = { N: [], E: [], S: [], W: [] };
  const seen = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const seat = order[i];
    const handText = parts[i];
    if (handText === '-') continue;
    const holdings = handText.toUpperCase().replace(/10/g, 'T').split('.');
    if (holdings.length !== PBN_SUITS_PER_HAND) return null;
    for (let s = 0; s < PBN_SUITS_PER_HAND; s++) {
      const suit = SUITS_HIGH_TO_LOW[s];
      for (const ch of holdings[s]) {
        if (!isRankChar(ch)) return null;
        const card = makeCard(suit, ch);
        if (seen.has(card)) return null;
        seen.add(card);
        hands[seat].push(card);
      }
    }
  }

  for (const seat of SEATS) hands[seat].sort(compareCards);
  return hands;
}
