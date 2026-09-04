/**
 * The bidding robot: a Standard American Yellow Card (SAYC) style bidder.
 *
 * SAYC in one paragraph: five-card majors, a strong 15-17 No-Trump, better
 * minor, strong artificial 2C, weak two-bids in D/H/S, Stayman and (at the
 * top level) Jacoby transfers and Blackwood.
 *
 * DESIGN
 *
 * Every decision funnels through `decide()`, which asks a role-specific
 * chooser for an ORDERED list of `Suggestion`s (a call plus the reason for it)
 * and then returns the first one that appears in `legalCalls()`. That single
 * choke point is what guarantees the two hard requirements:
 *
 *  1. The bot can never return an illegal call - anything not in `legalCalls`
 *     is skipped, and the list always ends in a pass.
 *  2. `chooseCall` and `explainCall` can never disagree, because they are the
 *     `.call` and the `.why` of the very same `Suggestion`.
 *
 * Because a suggestion that turns out to be illegal simply falls through to the
 * next one, every chooser can be written for the uncontested auction and still
 * behave sanely when the opponents interfere.
 *
 * PURITY: no clock, no ambient randomness, no I/O, and no input is mutated.
 * The same arguments always produce the same call, which is what makes a robot
 * auction reproducible from the board's seed alone.
 *
 * The Laws of Duplicate Bridge do not define a bidding SYSTEM - a system is
 * partnership agreement, not law. What the Laws do define, and what this file
 * leans on, is which calls are *legal* (Law 18C sufficiency, Law 19 doubles),
 * and that is delegated wholesale to `legalCalls()` in the engine.
 */

import { bidRank, lastContractBid, legalCalls, parseBid } from '../engine/auction';
import {
  countQuickTricks,
  distributionPoints,
  hcp,
  isBalanced,
  losingTrickCount,
  rankChar,
  suitLengths,
  suitOf,
} from '../engine/cards';
import { isVulnerable, nextSeat, partnerOf, sideOf } from '../engine/deal';
import type {
  Bid,
  BidLevel,
  Call,
  Card,
  RankChar,
  Seat,
  Strain,
  Suit,
  Vulnerability,
} from '../engine/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * How much system the robot is allowed to use. Declared here rather than
 * imported from the server layer on purpose: the engine and the bots must not
 * depend on the wire protocol. The server's `BotLevel` is structurally
 * identical, so the two are interchangeable at a call site.
 */
export type BotLevel = 'beginner' | 'intermediate' | 'advanced';

/** Everything the bidder needs to know to make one call. */
export interface BiddingArgs {
  hand: Card[];
  auction: Call[];
  dealer: Seat;
  seat: Seat;
  vulnerability: Vulnerability;
  level: BotLevel;
}

/** A candidate call together with the human-readable reason for making it. */
export interface Suggestion {
  call: Call;
  why: string;
}

// ---------------------------------------------------------------------------
// Small constants and bid arithmetic
// ---------------------------------------------------------------------------

const LEVELS: readonly BidLevel[] = [1, 2, 3, 4, 5, 6, 7];

/** Minimum HCP for a standard opening bid; below this the hand passes. */
const OPENING_HCP = 12;

/** Classic textbook target: 25+ combined HCP is a game contract. */
const GAME_HCP = 25;

/** Combined HCP at which a small slam becomes an odds-on proposition. */
const SLAM_HCP = 31;

/** Combined HCP for 6NT on sheer power, with no fit to lean on. */
const NT_SLAM_HCP = 33;

/** Past this many calls the bot stops manufacturing new ideas (see `decide`). */
const LONG_AUCTION = 12;

/** Builds a bid token from its two halves; `2` + `H` -> `"2H"`. */
function makeBid(level: BidLevel, strain: Strain): Bid {
  return `${level}${strain}` as Bid;
}

/** A bid at an arbitrary numeric level, or null when the level is off the 1-7 scale. */
function bidAtLevel(level: number, strain: Strain): Bid | null {
  const found = LEVELS.find((l) => l === level);
  return found === undefined ? null : makeBid(found, strain);
}

/** True for hearts and spades - the suits worth 30 a trick and 4-level games. */
export function isMajorSuit(strain: Strain): boolean {
  return strain === 'H' || strain === 'S';
}

/**
 * The lowest *sufficient* bid in a strain (Law 18C: a bid must name a greater
 * number of odd tricks, or the same number in a higher-ranking denomination).
 * Null when even 7 of that strain would be insufficient.
 */
export function cheapestBid(auction: Call[], strain: Strain): Bid | null {
  const last = lastContractBid(auction);
  const floor = last === null ? -1 : bidRank(last.bid);
  for (const level of LEVELS) {
    const bid = makeBid(level, strain);
    if (bidRank(bid) > floor) return bid;
  }
  return null;
}

/**
 * The cheapest sufficient bid in a strain, raised by `jumps` extra levels -
 * i.e. `jumps === 1` is a single jump, the classic way to show extra values or
 * to preempt. Null when that would go past 7.
 */
export function jumpBid(auction: Call[], strain: Strain, jumps: number): Bid | null {
  const cheap = cheapestBid(auction, strain);
  if (cheap === null) return null;
  const parsed = parseBid(cheap);
  if (parsed === null) return null;
  return bidAtLevel(parsed.level + jumps, strain);
}

/**
 * True when a bid is game or better: 3NT, 4 of a major, 5 of a minor, or any
 * slam. Used as a stop sign - once our side has bid game there is no reason to
 * keep bidding without slam values, which is also what keeps auctions finite.
 */
export function isGameOrBetter(bid: Bid): boolean {
  const parsed = parseBid(bid);
  if (parsed === null) return false;
  if (parsed.level >= 6) return true;
  if (parsed.strain === 'N') return parsed.level >= 3;
  if (isMajorSuit(parsed.strain)) return parsed.level >= 4;
  return parsed.level >= 5;
}

/** The normal game contract in a strain: 4 of a major, 5 of a minor, 3NT. */
export function gameBidIn(strain: Strain): Bid {
  if (strain === 'N') return '3N';
  return isMajorSuit(strain) ? makeBid(4, strain) : makeBid(5, strain);
}

// ---------------------------------------------------------------------------
// Hand evaluation (bidding-specific; the raw counts live in engine/cards.ts)
// ---------------------------------------------------------------------------

/** The high-card points held *inside* one suit. */
export function suitHcp(hand: readonly Card[], suit: Suit): number {
  return hcp(hand.filter((card) => suitOf(card) === suit));
}

/** How many of the ace, king and queen of a suit the hand holds (0-3). */
export function topHonours(hand: readonly Card[], suit: Suit): number {
  let n = 0;
  for (const card of hand) {
    if (suitOf(card) !== suit) continue;
    const rank = rankChar(card);
    if (rank === 'A' || rank === 'K' || rank === 'Q') n += 1;
  }
  return n;
}

/** How many of the top five cards (A K Q J T) of a suit the hand holds (0-5). */
export function honourCount(hand: readonly Card[], suit: Suit): number {
  let n = 0;
  for (const card of hand) {
    if (suitOf(card) !== suit) continue;
    const rank = rankChar(card);
    if (rank === 'A' || rank === 'K' || rank === 'Q' || rank === 'J' || rank === 'T') n += 1;
  }
  return n;
}

/** Aces held - the currency Blackwood is denominated in. */
export function countAces(hand: readonly Card[]): number {
  let n = 0;
  for (const card of hand) if (rankChar(card) === 'A') n += 1;
  return n;
}

/**
 * A suit good enough to name at the table: at least five cards with two of the
 * top three honours, three of the top five, or 5+ HCP in the suit. Overcalls
 * and weak two-bids both promise this, because a bad suit that gets doubled is
 * how a part-score turns into a phone number.
 */
export function isGoodSuit(hand: readonly Card[], suit: Suit): boolean {
  const length = suitLengths(hand)[suit];
  if (length < 5) return false;
  return topHonours(hand, suit) >= 2 || honourCount(hand, suit) >= 3 || suitHcp(hand, suit) >= 5;
}

/**
 * A probable No-Trump stopper: the ace, a guarded king, a queen with two
 * others, or a jack with three others. Required before overcalling or bidding
 * 3NT with the opponents' suit unbid by us.
 */
export function hasStopper(hand: readonly Card[], suit: Suit): boolean {
  const cards = hand.filter((card) => suitOf(card) === suit);
  const n = cards.length;
  const has = (rank: RankChar): boolean => cards.some((card) => rankChar(card) === rank);
  if (has('A')) return true;
  if (has('K') && n >= 2) return true;
  if (has('Q') && n >= 3) return true;
  if (has('J') && n >= 4) return true;
  return false;
}

/**
 * A crude playing-trick count: thirteen cards minus the Losing Trick Count.
 * Used only as the shape-based half of the strong 2C test, where HCP alone
 * badly undervalues a hand like AKQJxxx and an outside ace.
 */
export function playingTricks(hand: readonly Card[]): number {
  return 13 - losingTrickCount(hand);
}

/**
 * The Rule of 20: open when HCP plus the lengths of the two longest suits
 * reach 20. It is the standard licence for opening a shapely 11-count such as
 * 5-5 in the majors, which plays far better than its point count suggests.
 */
export function ruleOf20(hand: readonly Card[]): boolean {
  const lengths = Object.values(suitLengths(hand)).sort((a, b) => b - a);
  return hcp(hand) + lengths[0] + lengths[1] >= 20;
}

/**
 * Points for a hand that is SUPPORTING a known trump suit: HCP plus shortness
 * (void 3, singleton 2, doubleton 1). Shortness is only worth anything once a
 * fit exists, because its value is the ability to ruff - so the bonus is taken
 * in full with four-card support, and heavily discounted with three, where a
 * ruff may cost a natural trump trick instead.
 */
export function supportPoints(hand: readonly Card[], trump: Suit): number {
  const length = suitLengths(hand)[trump];
  const base = hcp(hand);
  if (length >= 4) return base + distributionPoints(hand);
  if (length === 3) return base + Math.min(1, distributionPoints(hand));
  return base;
}

/** Everything the choosers ask about a hand, computed once per decision. */
export interface HandFacts {
  hcp: number;
  lengths: Record<Suit, number>;
  balanced: boolean;
  ltc: number;
  quickTricks: number;
  playingTricks: number;
  aces: number;
  /** Longest suit; ties go to the higher-ranking suit (Law 18 order C<D<H<S). */
  longest: Suit;
}

/** Summarises a hand the way a bidding system looks at it. */
export function describeBiddingHand(hand: readonly Card[]): HandFacts {
  const lengths = suitLengths(hand);
  let longest: Suit = 'C';
  for (const suit of ['C', 'D', 'H', 'S'] as const) {
    if (lengths[suit] >= lengths[longest]) longest = suit;
  }
  return {
    hcp: hcp(hand),
    lengths,
    balanced: isBalanced(hand),
    ltc: losingTrickCount(hand),
    quickTricks: countQuickTricks(hand),
    playingTricks: playingTricks(hand),
    aces: countAces(hand),
    longest,
  };
}

// ---------------------------------------------------------------------------
// Reading the auction
// ---------------------------------------------------------------------------

/** One call, annotated with who made it and what it means structurally. */
export interface CallRecord {
  call: Call;
  seat: Seat;
  index: number;
  bid: Bid | null;
  level: BidLevel | null;
  strain: Strain | null;
  /** True when the caller is on our side (us or partner). */
  ours: boolean;
  byMe: boolean;
  byPartner: boolean;
}

/** Which chair of the auction the bot is sitting in right now. */
export type BidRole =
  /** Nobody has bid yet: this is an opening decision. */
  | 'open'
  /** Our side opened and I am the opener. */
  | 'opener'
  /** Our side opened and partner is the opener. */
  | 'responder'
  /** They opened, partner has not acted, and neither have I. */
  | 'overcall'
  /** They opened, and I have already overcalled or doubled. */
  | 'overcallRebid'
  /** They opened and partner has overcalled or doubled; I am the advancer. */
  | 'advance';

/** A structural view of the auction from one seat's point of view. */
export interface AuctionView {
  seat: Seat;
  partner: Seat;
  records: CallRecord[];
  myRecords: CallRecord[];
  partnerRecords: CallRecord[];
  oppRecords: CallRecord[];
  myBids: CallRecord[];
  partnerBids: CallRecord[];
  oppBids: CallRecord[];
  /** The last contract bid by anyone, or null when nobody has bid. */
  lastBid: CallRecord | null;
  /** The first contract bid of the auction - the opening bid. */
  openingBid: CallRecord | null;
  /** Partner's most recent call, or null if partner has not called. */
  partnerLastCall: Call | null;
  role: BidRole;
  /** 1..4 - which seat of the first round this is, only meaningful for 'open'. */
  position: number;
}

/** The suits (never No-Trump) named by a set of calls, in the order first bid. */
function suitsBidBy(records: readonly CallRecord[]): Suit[] {
  const out: Suit[] = [];
  for (const record of records) {
    const strain = record.strain;
    if (strain === null || strain === 'N') continue;
    if (!out.includes(strain)) out.push(strain);
  }
  return out;
}

/**
 * Annotates every call in the auction with its seat and its relationship to
 * `seat`, then classifies which chair `seat` is bidding from.
 *
 * Calls are made in clockwise rotation beginning with the dealer (Law 17B), so
 * the seat that made call `i` is simply `i` steps clockwise from the dealer.
 */
export function readAuction(auction: Call[], dealer: Seat, seat: Seat): AuctionView {
  const partner = partnerOf(seat);
  const records: CallRecord[] = auction.map((call, index) => {
    const by = nextSeat(dealer, index);
    const parsed = parseBid(call);
    return {
      call,
      seat: by,
      index,
      bid: parsed === null ? null : (call as Bid),
      level: parsed === null ? null : parsed.level,
      strain: parsed === null ? null : parsed.strain,
      ours: sideOf(by) === sideOf(seat),
      byMe: by === seat,
      byPartner: by === partner,
    };
  });

  const myRecords = records.filter((r) => r.byMe);
  const partnerRecords = records.filter((r) => r.byPartner);
  const oppRecords = records.filter((r) => !r.ours);
  const bids = records.filter((r) => r.bid !== null);
  const myBids = bids.filter((r) => r.byMe);
  const partnerBids = bids.filter((r) => r.byPartner);
  const oppBids = bids.filter((r) => !r.ours);

  const openingBid = bids.length > 0 ? bids[0] : null;
  const lastBid = bids.length > 0 ? bids[bids.length - 1] : null;
  const partnerLastCall =
    partnerRecords.length > 0 ? partnerRecords[partnerRecords.length - 1].call : null;

  let role: BidRole;
  if (openingBid === null) {
    role = 'open';
  } else if (openingBid.byMe) {
    role = 'opener';
  } else if (openingBid.byPartner) {
    role = 'responder';
  } else if (myBids.length > 0 || myRecords.some((r) => r.call === 'X' || r.call === 'XX')) {
    role = 'overcallRebid';
  } else if (partnerBids.length > 0 || partnerRecords.some((r) => r.call === 'X')) {
    role = 'advance';
  } else {
    role = 'overcall';
  }

  return {
    seat,
    partner,
    records,
    myRecords,
    partnerRecords,
    oppRecords,
    myBids,
    partnerBids,
    oppBids,
    lastBid,
    openingBid,
    partnerLastCall,
    role,
    position: Math.min(4, auction.length + 1),
  };
}

/** Everything one decision needs, assembled once and passed to the choosers. */
export interface BidContext {
  args: BiddingArgs;
  hand: readonly Card[];
  facts: HandFacts;
  view: AuctionView;
  level: BotLevel;
  vulnerable: boolean;
}

/** Bundles the arguments with the derived hand and auction views. */
export function makeContext(args: BiddingArgs): BidContext {
  return {
    args,
    hand: args.hand,
    facts: describeBiddingHand(args.hand),
    view: readAuction(args.auction, args.dealer, args.seat),
    level: args.level,
    vulnerable: isVulnerable(args.seat, args.vulnerability),
  };
}

// ---------------------------------------------------------------------------
// What partner has promised
// ---------------------------------------------------------------------------

/**
 * The HCP range partner's calls have shown, as [min, max].
 *
 * This is the partnership's shared inference, not a guess about the actual
 * cards: it is what lets the bot add its own count to partner's minimum and
 * decide whether the 25 HCP for game are there. An unrevealing auction yields a
 * wide range, which correctly makes the bot cautious.
 */
export function partnerStrength(view: AuctionView): { min: number; max: number } {
  const bids = view.partnerBids;

  if (bids.length === 0) {
    if (view.partnerRecords.some((r) => r.call === 'X')) return { min: 12, max: 21 };
    const passedFirstChance = view.partnerRecords.some(
      (r) => r.call === 'P' && (view.openingBid === null || r.index < view.openingBid.index),
    );
    // A pass at one's first turn denies an opening bid (Law-neutral inference,
    // pure system): partner cannot hold 12+.
    if (passedFirstChance) return { min: 0, max: OPENING_HCP - 1 };
    if (view.partnerRecords.length > 0) return { min: 0, max: OPENING_HCP };
    return { min: 0, max: 20 };
  }

  const first = bids[0];
  const partnerOpened = view.openingBid !== null && view.openingBid.index === first.index;

  if (partnerOpened) {
    const opening = openingRange(first);
    if (bids.length === 1) return opening;
    return refineOpenerRange(view, first, bids[1], opening);
  }

  // Partner acted over an opposing opening: an overcall or a 1NT overcall.
  if (view.openingBid !== null && !view.openingBid.ours) {
    if (first.call === '1N') return { min: 15, max: 18 };
    return { min: 8, max: 16 };
  }

  // Partner responded to MY opening.
  return responderRange(view, first);
}

/** The strength an opening bid promises in this SAYC-style system. */
function openingRange(open: CallRecord): { min: number; max: number } {
  if (open.call === '1N') return { min: 15, max: 17 };
  if (open.call === '2N') return { min: 20, max: 21 };
  if (open.call === '2C') return { min: 22, max: 37 };
  if (open.level === 2) return { min: 5, max: 10 }; // weak two in D/H/S
  if (open.level !== null && open.level >= 3) return { min: 5, max: 10 }; // preempt
  return { min: OPENING_HCP, max: 21 };
}

/** Narrows an opener's range using their rebid (1NT rebid, jump, reverse...). */
function refineOpenerRange(
  view: AuctionView,
  open: CallRecord,
  rebid: CallRecord,
  base: { min: number; max: number },
): { min: number; max: number } {
  if (open.level !== 1 || open.strain === null || open.strain === 'N') return base;
  if (rebid.call === '1N') return { min: 12, max: 14 };
  if (rebid.call === '2N' || rebid.call === '3N') return { min: 18, max: 19 };

  // Rebidding the opened suit, or raising mine: the size of the jump is the message.
  const myFirstBid = view.myBids.length > 0 ? view.myBids[0] : null;
  const isRepeat = rebid.strain === open.strain;
  const isRaiseOfMine = myFirstBid !== null && rebid.strain === myFirstBid.strain;
  if (isRepeat || isRaiseOfMine) {
    const floor = isRepeat
      ? open.level + 1
      : myFirstBid !== null && myFirstBid.level !== null
        ? myFirstBid.level + 1
        : 2;
    const jump = (rebid.level ?? floor) - floor;
    if (jump <= 0) return { min: 12, max: 15 };
    if (jump === 1) return { min: 16, max: 18 };
    return { min: 19, max: 21 };
  }

  // A reverse - a new suit at the two level ranking above the opened suit -
  // forces partner to the three level to give preference, so it promises extras.
  if (
    rebid.strain !== null &&
    rebid.strain !== 'N' &&
    rebid.level !== null &&
    rebid.level >= 2 &&
    bidRank(makeBid(1, rebid.strain)) > bidRank(makeBid(1, open.strain))
  ) {
    return { min: 17, max: 21 };
  }
  return { min: 12, max: 18 };
}

/** The strength a response to my opening promises. */
function responderRange(view: AuctionView, response: CallRecord): { min: number; max: number } {
  const myOpen = view.myBids.length > 0 ? view.myBids[0] : null;
  if (response.strain === 'N') {
    if (response.level === 1) return { min: 6, max: 10 };
    if (response.level === 2) return { min: 11, max: 12 };
    return { min: 13, max: 16 };
  }
  if (myOpen !== null && response.strain === myOpen.strain && myOpen.level !== null) {
    const jump = (response.level ?? 2) - (myOpen.level + 1);
    if (jump <= 0) return { min: 6, max: 9 };
    if (jump === 1) return { min: 10, max: 12 };
    return { min: 12, max: 16 };
  }
  if (response.level === 1) return { min: 6, max: 18 };
  if (response.level === 2) return { min: 11, max: 18 };
  return { min: 13, max: 18 };
}

/**
 * The trump suit our side has agreed, or null when we have none.
 *
 * A suit both partners have named is agreed explicitly. Failing that, a suit
 * partner named that this hand holds four of is an implied fit, as is
 * three-card support for partner's opening major - which promises five cards
 * in a five-card-major system, so three opposite it is already the eight-card
 * fit that a trump contract needs.
 */
export function agreedFit(view: AuctionView, hand: readonly Card[]): Suit | null {
  const lengths = suitLengths(hand);
  const mine = suitsBidBy(view.myBids);
  const theirs = suitsBidBy(view.partnerBids);

  let explicit: Suit | null = null;
  for (const record of view.records) {
    const strain = record.strain;
    if (strain === null || strain === 'N' || !record.ours) continue;
    if (mine.includes(strain) && theirs.includes(strain)) explicit = strain;
  }
  if (explicit !== null) return explicit;

  const openedByPartner =
    view.openingBid !== null && view.openingBid.byPartner ? view.openingBid : null;
  let best: Suit | null = null;
  for (const suit of theirs) {
    const promisesFive =
      openedByPartner !== null &&
      openedByPartner.strain === suit &&
      openedByPartner.level === 1 &&
      isMajorSuit(suit);
    const need = promisesFive ? 3 : 4;
    if (lengths[suit] < need) continue;
    if (best === null || isMajorSuit(suit) || lengths[suit] > lengths[best]) best = suit;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Blackwood (advanced) - asking for and counting aces
// ---------------------------------------------------------------------------

/**
 * The last call that was not a pass, or null when there is none.
 *
 * Conventional questions and answers have to be read through the passes that
 * separate them: after partner's 4NT, right-hand opponent nearly always passes
 * before the turn comes round, so "did partner just ask for aces?" means "was
 * partner's 4NT the last call other than a pass?" - the same phrasing the Laws
 * use for doubles (Law 19A, "no call other than a pass intervening").
 */
function lastMeaningfulCall(records: readonly CallRecord[]): CallRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].call !== 'P') return records[i];
  }
  return null;
}

/** The number of aces a Blackwood response shows: 5C = 0 or 4, 5D = 1, ... */
function acesShownBy(call: Call): number | null {
  if (call === '5C') return 0;
  if (call === '5D') return 1;
  if (call === '5H') return 2;
  if (call === '5S') return 3;
  return null;
}

/**
 * The mandatory answer to partner's Blackwood 4NT: 5C with none (or all four),
 * 5D with one, 5H with two, 5S with three.
 *
 * This is answered at EVERY level, not just 'advanced': partner may be a
 * stronger robot or a human, and leaving a 4NT ask unanswered would strand the
 * auction in No-Trump. 4NT only counts as Blackwood when our side has already
 * agreed a trump suit - otherwise it is a natural No-Trump bid and gets no
 * artificial answer.
 */
export function blackwoodAnswer(ctx: BidContext): Suggestion | null {
  const { view, hand, facts } = ctx;
  const last = lastMeaningfulCall(view.records);
  if (last === null) return null;
  if (!last.byPartner || last.call !== '4N') return null;
  if (agreedFit(view, hand) === null) return null;
  const aces = facts.aces;
  const call: Call = aces === 1 ? '5D' : aces === 2 ? '5H' : aces === 3 ? '5S' : '5C';
  return { call, why: `Blackwood answer: ${aces} ace${aces === 1 ? '' : 's'}.` };
}

/**
 * The Blackwood asker's decision after partner has shown their aces: sign off
 * in five of the trump suit when two or more aces are missing, otherwise bid
 * the small slam.
 *
 * Blackwood is only ever launched with a MAJOR fit and at least one ace (see
 * `shouldAskBlackwood`), which is what guarantees the five-level sign-off is
 * still a sufficient bid - the trap that makes minor-suit Blackwood dangerous.
 * A grand slam is never bid: aces alone do not justify it.
 */
export function blackwoodSignoff(ctx: BidContext): Suggestion | null {
  const { view, hand, facts, args } = ctx;
  const last = lastMeaningfulCall(view.records);
  if (last === null || !last.byPartner) return null;
  const shown = acesShownBy(last.call);
  if (shown === null) return null;

  const myAsk = view.myRecords.find((r) => r.call === '4N');
  if (myAsk === undefined || myAsk.index > last.index) return null;
  const fit = agreedFit(view, hand);
  if (fit === null) return null;

  const total = facts.aces + shown;
  // Clamped: a malformed deal (a "hand" holding a card partner also holds)
  // could otherwise report a negative number of missing aces in the tooltip.
  const missing = Math.max(0, 4 - total);
  if (missing >= 2) {
    const signoff = cheapestBid(args.auction, fit);
    if (signoff !== null) {
      const parsed = parseBid(signoff);
      if (parsed !== null && parsed.level <= 5) {
        return { call: signoff, why: `Two aces missing - signing off in ${signoff}.` };
      }
    }
    return { call: 'P', why: 'Two aces are missing: stopping below slam.' };
  }
  const slam = bidAtLevel(6, fit);
  if (slam !== null) {
    const why =
      missing === 0
        ? 'All four aces accounted for - bidding the small slam.'
        : 'Only one ace missing - bidding the small slam.';
    return { call: slam, why };
  }
  return null;
}

/**
 * Whether to ask for aces. Deliberately narrow: advanced level only, an agreed
 * MAJOR fit, roughly slam-going combined values, and at least one ace in hand
 * so that every possible answer still leaves a legal five-level sign-off.
 */
export function shouldAskBlackwood(ctx: BidContext, fit: Suit | null, combinedMin: number): boolean {
  if (ctx.level !== 'advanced') return false;
  if (fit === null || !isMajorSuit(fit)) return false;
  if (ctx.facts.aces < 1) return false;
  if (combinedMin < SLAM_HCP) return false;
  const last = ctx.view.lastBid;
  return last === null || last.level === null || last.level <= 4;
}

// ---------------------------------------------------------------------------
// Opening bids
// ---------------------------------------------------------------------------

/** 15-17 balanced: the SAYC strong No-Trump opening. */
export function isOpening1NT(hand: readonly Card[]): boolean {
  const points = hcp(hand);
  return isBalanced(hand) && points >= 15 && points <= 17;
}

/** 20-21 balanced: the 2NT opening, one step below the 2C force. */
export function isOpening2NT(hand: readonly Card[]): boolean {
  const points = hcp(hand);
  return isBalanced(hand) && points >= 20 && points <= 21;
}

/**
 * The strong, artificial and forcing 2C opening: 22+ HCP, or - only at
 * 'advanced', where the follow-ups are trusted - about nine playing tricks
 * with four quick tricks, the shapely hand that HCP alone would understate.
 */
export function isStrongTwoClubs(hand: readonly Card[], level: BotLevel): boolean {
  const points = hcp(hand);
  if (points >= 22) return true;
  if (level !== 'advanced') return false;
  return points >= 18 && playingTricks(hand) >= 9 && countQuickTricks(hand) >= 4;
}

/**
 * Whether the hand is worth an opening bid at the one level: 12+ HCP, or an
 * 11-count that satisfies the Rule of 20 with two quick tricks (advanced only,
 * and never in fourth seat, where opening light risks turning a peaceful
 * pass-out into a minus score).
 */
export function shouldOpen(ctx: BidContext): boolean {
  const points = ctx.facts.hcp;
  if (points >= OPENING_HCP) return true;
  if (ctx.level !== 'advanced') return false;
  if (ctx.view.position >= 4) return false;
  return points >= 11 && ruleOf20(ctx.hand) && ctx.facts.quickTricks >= 2;
}

/**
 * Which suit to open at the one level.
 *
 * Five-card majors: with a five-card major, open it; with two five-card suits
 * open the longer, and spades from 5-5 so that the auction has room to find
 * hearts underneath. Otherwise open the "better minor" - the longer of clubs
 * and diamonds, 1D when they are 4-4 and 1C on 3-3, which is the standard
 * compromise that keeps 1C the catch-all opening.
 */
export function chooseOpeningSuit(hand: readonly Card[]): Suit {
  const len = suitLengths(hand);
  if (len.S >= 5 || len.H >= 5) {
    if (len.S >= 5 && len.H >= 5) return len.H > len.S ? 'H' : 'S';
    return len.S >= 5 ? 'S' : 'H';
  }
  if (len.D > len.C) return 'D';
  if (len.C > len.D) return 'C';
  return len.D >= 4 ? 'D' : 'C';
}

/**
 * A weak two-bid: exactly a six-card suit in diamonds, hearts or spades, 5-10
 * HCP, a decent suit, no void and no side four-card major (holding one, the
 * hand belongs in a constructive auction, not a preempt). Vulnerable, the suit
 * requirement tightens, because the penalty for being wrong doubles.
 */
export function isWeakTwoCandidate(
  hand: readonly Card[],
  suit: Suit,
  vulnerable: boolean,
): boolean {
  if (suit === 'C') return false; // 2C is the strong artificial opening
  const len = suitLengths(hand);
  if (len[suit] !== 6) return false;
  const points = hcp(hand);
  if (points < 5 || points > 10) return false;
  if (vulnerable && (points < 6 || topHonours(hand, suit) < 2)) return false;
  if (!isGoodSuit(hand, suit)) return false;
  for (const other of ['C', 'D', 'H', 'S'] as const) {
    if (other === suit) continue;
    if (len[other] === 0) return false; // a void makes the hand too wild to preempt
    if (isMajorSuit(other) && len[other] >= 4) return false;
  }
  return true;
}

/**
 * A three-level preempt: a seven-card suit, 5-10 HCP, decent quality, no side
 * four-card major. The point of a preempt is to steal bidding space before the
 * opponents have described their hands, so it is only made before anyone has
 * bid and never in fourth seat.
 */
export function isPreemptCandidate(
  hand: readonly Card[],
  suit: Suit,
  vulnerable: boolean,
): boolean {
  const len = suitLengths(hand);
  if (len[suit] < 7) return false;
  const points = hcp(hand);
  if (points < 5 || points > 10) return false;
  if (vulnerable && topHonours(hand, suit) < 2) return false;
  if (!isGoodSuit(hand, suit)) return false;
  for (const other of ['C', 'D', 'H', 'S'] as const) {
    if (other === suit) continue;
    if (isMajorSuit(other) && len[other] >= 4) return false;
  }
  return true;
}

/** The opening call, in priority order, for a hand nobody has bid over. */
export function chooseOpening(ctx: BidContext): Suggestion[] {
  const { facts, hand, level, vulnerable, view } = ctx;
  const out: Suggestion[] = [];
  const points = facts.hcp;

  if (isStrongTwoClubs(hand, level)) {
    out.push({
      call: '2C',
      why: `${points} HCP / ${facts.playingTricks} playing tricks: strong artificial 2C, forcing.`,
    });
  }
  if (isOpening2NT(hand)) {
    out.push({ call: '2N', why: `${points} HCP balanced: 2NT opening (20-21).` });
  }
  if (isOpening1NT(hand)) {
    out.push({ call: '1N', why: `${points} HCP balanced: strong 1NT opening (15-17).` });
  }

  if (shouldOpen(ctx)) {
    const suit = chooseOpeningSuit(hand);
    const why =
      points < OPENING_HCP
        ? `Rule of 20: ${points} HCP plus the two longest suits reach 20, so opening 1${suit}.`
        : isMajorSuit(suit)
          ? `${points} HCP with ${facts.lengths[suit]} ${suit === 'S' ? 'spades' : 'hearts'}: five-card major opening.`
          : `${points} HCP, no five-card major: opening the better minor.`;
    out.push({ call: makeBid(1, suit), why });
  } else if (level !== 'beginner' && view.position < 4) {
    // Preemptive openings: only when the hand is too weak to open at the one
    // level, and never in fourth seat where passing the board out is a fine result.
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (isPreemptCandidate(hand, suit, vulnerable)) {
        out.push({
          call: makeBid(3, suit),
          why: `Seven-card suit and ${points} HCP: preemptive 3${suit} opening.`,
        });
        break;
      }
    }
    for (const suit of ['S', 'H', 'D'] as const) {
      if (isWeakTwoCandidate(hand, suit, vulnerable)) {
        out.push({
          call: makeBid(2, suit),
          why: `Six-card suit and ${points} HCP: weak two in ${suit}.`,
        });
        break;
      }
    }
  }

  out.push({ call: 'P', why: `Only ${points} HCP and no shape to preempt with: pass.` });
  return out;
}

// ---------------------------------------------------------------------------
// Responding to partner's opening
// ---------------------------------------------------------------------------

/**
 * Responses to partner's 15-17 1NT opening.
 *
 * Stayman (2C, intermediate and up) asks for a four-card major; Jacoby
 * transfers (advanced only) make the strong hand declarer by having responder
 * bid the suit *below* the one they hold. Note that the OPENER accepts both
 * conventions at every level - see `rebidAfter1NT` - so that a beginner robot
 * never misreads a partner who uses them.
 */
export function respondTo1NT(ctx: BidContext): Suggestion[] {
  const { facts, level } = ctx;
  const out: Suggestion[] = [];
  const len = facts.lengths;
  const points = facts.hcp;
  const longMajor = len.S >= 5 && len.S >= len.H ? 'S' : len.H >= 5 ? 'H' : null;

  if (level === 'advanced' && longMajor !== null) {
    const transfer: Call = longMajor === 'H' ? '2D' : '2H';
    out.push({
      call: transfer,
      why: `Jacoby transfer: ${len[longMajor]} ${longMajor === 'H' ? 'hearts' : 'spades'}, asking partner to bid the suit.`,
    });
  }
  if (level !== 'beginner' && points >= 8 && (len.H === 4 || len.S === 4)) {
    out.push({ call: '2C', why: `Stayman: ${points} HCP with a four-card major.` });
  }
  if (longMajor !== null && points >= 10) {
    if (len[longMajor] >= 6) {
      out.push({
        call: makeBid(4, longMajor),
        why: `${points} HCP opposite 15-17 and a six-card major: bidding game.`,
      });
    }
  }
  if (points >= NT_SLAM_HCP - 15) {
    out.push({ call: '6N', why: `${points} HCP opposite 15-17: 33+ combined, bidding 6NT.` });
  }
  if (points >= 10) {
    out.push({ call: '3N', why: `${points} HCP opposite 15-17: 25+ combined, bidding game.` });
  }
  if (points >= 8) {
    out.push({ call: '2N', why: `${points} HCP: invitational raise of 1NT.` });
  }
  out.push({ call: 'P', why: `Only ${points} HCP: no game opposite 15-17, passing.` });
  return out;
}

/**
 * Responses to the strong artificial 2C. 2D is the standard waiting bid, which
 * keeps the auction low and lets opener describe; a good five-card suit with
 * 8+ HCP is bid naturally as a positive response instead.
 */
export function respondTo2C(ctx: BidContext): Suggestion[] {
  const { facts, hand, args } = ctx;
  const out: Suggestion[] = [];
  if (facts.hcp >= 8) {
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (facts.lengths[suit] >= 5 && isGoodSuit(hand, suit)) {
        const bid = cheapestBid(args.auction, suit);
        if (bid !== null) {
          out.push({ call: bid, why: `Positive response: ${facts.hcp} HCP and a good ${suit} suit.` });
        }
        break;
      }
    }
  }
  out.push({ call: '2D', why: 'Waiting response to the strong 2C, leaving partner room to describe.' });
  return out;
}

/** Responses to partner's preemptive opening (weak two or three-level). */
export function respondToPreempt(ctx: BidContext, open: CallRecord): Suggestion[] {
  const { facts, hand, args } = ctx;
  const out: Suggestion[] = [];
  const strain = open.strain;
  if (strain === null || strain === 'N') return [{ call: 'P', why: 'Nothing to say.' }];
  const support = facts.lengths[strain];
  const points = facts.hcp;

  if (isMajorSuit(strain) && support >= 3 && points >= 15) {
    out.push({
      call: makeBid(4, strain),
      why: `${points} HCP with ${support}-card support opposite a preempt: bidding game.`,
    });
  }
  if (points >= 16 && facts.balanced && hasStopper(hand, strain)) {
    out.push({ call: '3N', why: `${points} HCP balanced opposite a preempt: 3NT.` });
  }
  if (support >= 3 && points >= 11 && isMajorSuit(strain)) {
    const raise = cheapestBid(args.auction, strain);
    if (raise !== null) {
      out.push({ call: raise, why: `${support}-card support and ${points} HCP: raising the preempt.` });
    }
  }
  out.push({ call: 'P', why: 'Partner has already described a weak hand; passing.' });
  return out;
}

/** Responses to a 2NT opening (20-21 balanced). */
export function respondTo2NT(ctx: BidContext): Suggestion[] {
  const { facts } = ctx;
  const out: Suggestion[] = [];
  const len = facts.lengths;
  const major = len.S >= 5 && len.S >= len.H ? 'S' : len.H >= 5 ? 'H' : null;
  if (major !== null && facts.hcp >= 5) {
    out.push({
      call: makeBid(4, major),
      why: `Five-card major and ${facts.hcp} HCP opposite 20-21: bidding game.`,
    });
  }
  if (facts.hcp >= 4) {
    out.push({ call: '3N', why: `${facts.hcp} HCP opposite 20-21: 25+ combined, bidding 3NT.` });
  }
  out.push({ call: 'P', why: `Only ${facts.hcp} HCP: game is out of reach, passing.` });
  return out;
}

/**
 * Responses to a one-of-a-suit opening: the raise ladder with support, a new
 * suit without it, and the No-Trump ladder with neither.
 *
 * A raise is valued in support points (HCP plus shortness) because once a trump
 * fit exists, ruffing power is worth real tricks; 6-9 raises once, 10-12 makes
 * the limit raise, 13+ bids the game outright.
 */
export function respondToOneOfASuit(ctx: BidContext, open: CallRecord): Suggestion[] {
  const { facts, hand, args, view, level } = ctx;
  const out: Suggestion[] = [];
  const strain = open.strain;
  if (strain === null || strain === 'N') return [{ call: 'P', why: 'Nothing to say.' }];

  const len = facts.lengths;
  const points = facts.hcp;
  const support = len[strain];
  const sp = supportPoints(hand, strain);
  const major = isMajorSuit(strain);
  const contested = view.oppBids.length > 0;

  if (points < 6) {
    if (level !== 'beginner' && contested && support >= 4 && points >= 4) {
      const preemptive = jumpBid(args.auction, strain, 1);
      if (preemptive !== null) {
        out.push({
          call: preemptive,
          why: `${support}-card support with ${points} HCP: preemptive raise to take away their bidding room.`,
        });
      }
    }
    out.push({ call: 'P', why: `Only ${points} HCP: not enough to respond (6 needed).` });
    return out;
  }

  // --- With support for a major, the fit is the whole story.
  if (major && support >= 3) {
    if (sp >= 13) {
      out.push({
        call: makeBid(4, strain),
        why: `${support}-card support and ${sp} support points: bidding game.`,
      });
    } else if (sp >= 10) {
      out.push({
        call: makeBid(3, strain),
        why: `${support}-card support and ${sp} support points: limit raise (10-12), invitational.`,
      });
    } else {
      out.push({
        call: makeBid(2, strain),
        why: `${support}-card support and ${sp} support points: single raise (6-9).`,
      });
    }
  }

  // --- A new suit at the one level is always worth showing.
  if (strain === 'H' && len.S >= 4) {
    out.push({ call: '1S', why: `${len.S} spades and ${points} HCP: new suit at the one level.` });
  }
  if (!major) {
    if (len.S >= 5 && len.S >= len.H) {
      out.push({ call: '1S', why: `${len.S} spades: showing the major at the one level.` });
    } else if (len.H >= 4) {
      out.push({ call: '1H', why: `${len.H} hearts: showing the major at the one level (up the line).` });
    } else if (len.S >= 4) {
      out.push({ call: '1S', why: `${len.S} spades: showing the major at the one level.` });
    }
    if (strain === 'C' && len.D >= 4 && len.H < 4 && len.S < 4) {
      out.push({ call: '1D', why: `${len.D} diamonds and no four-card major: 1D response.` });
    }
  }

  // --- Raising partner's minor needs real length: 1C can be three cards long.
  if (!major) {
    const need = strain === 'D' ? 4 : 5;
    if (support >= need) {
      if (sp >= 13 && facts.balanced) {
        out.push({ call: '3N', why: `${points} HCP balanced with a minor fit: bidding 3NT.` });
      } else if (sp >= 10) {
        out.push({
          call: makeBid(3, strain),
          why: `${support}-card support and ${sp} support points: limit raise of the minor.`,
        });
      } else {
        out.push({
          call: makeBid(2, strain),
          why: `${support}-card support and ${sp} support points: single raise of the minor.`,
        });
      }
    }
  }

  // --- A new suit at the two level promises 11+: it forces partner to the
  //     three level to give preference, so it is not a bid for a weak hand.
  if (points >= 11) {
    let best: Suit | null = null;
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (suit === strain) continue;
      // A new suit at the two level promises a real suit: five cards for a
      // major (bidding a four-card major there would misdescribe the fit), and
      // four for a minor, which is only ever a waypoint to No-Trump or game.
      if (len[suit] < (isMajorSuit(suit) ? 5 : 4)) continue;
      if (bidRank(makeBid(1, suit)) > bidRank(makeBid(1, strain))) continue; // that is a 1-level bid
      if (best === null || len[suit] > len[best]) best = suit;
    }
    if (best !== null) {
      out.push({
        call: makeBid(2, best),
        why: `${points} HCP and ${len[best]} ${best}: two-over-one new suit (11+).`,
      });
    }
  }

  // --- No fit, no biddable suit: describe the strength in No-Trump.
  if (points >= 13 && facts.balanced) {
    out.push({ call: '3N', why: `${points} HCP balanced with no fit: bidding 3NT.` });
  }
  if (points >= 11 && points <= 12 && facts.balanced) {
    out.push({ call: '2N', why: `${points} HCP balanced with no fit: invitational 2NT.` });
  }
  if (points >= 6 && points <= 10) {
    out.push({ call: '1N', why: `${points} HCP with no fit and no biddable suit: 1NT response.` });
  }
  out.push({ call: 'P', why: 'Nothing worth bidding opposite the opening.' });
  return out;
}

/** Dispatches to the right response table for partner's opening bid. */
export function chooseResponse(ctx: BidContext): Suggestion[] {
  const open = ctx.view.openingBid;
  if (open === null) return [{ call: 'P', why: 'No opening bid to respond to.' }];
  if (open.call === '1N') return respondTo1NT(ctx);
  if (open.call === '2N') return respondTo2NT(ctx);
  if (open.call === '2C') return respondTo2C(ctx);
  if (open.level !== null && open.level >= 2) return respondToPreempt(ctx, open);
  return respondToOneOfASuit(ctx, open);
}

// ---------------------------------------------------------------------------
// Opener's rebid
// ---------------------------------------------------------------------------

/**
 * The 1NT opener's rebid: accepting Stayman and Jacoby transfers, and judging
 * an invitation.
 *
 * Both conventions are accepted regardless of `level`. Interpretation must be a
 * partnership agreement, not a per-seat preference: if a beginner opener read
 * partner's transfer as a natural bid the pair would end in chaos, so the
 * meaning of 2C/2D/2H over our 1NT is fixed for every robot.
 */
export function rebidAfter1NT(ctx: BidContext): Suggestion[] {
  const { facts, view, args, hand } = ctx;
  const out: Suggestion[] = [];
  const partnerCall = view.partnerLastCall;
  const len = facts.lengths;

  if (partnerCall === '2C') {
    if (len.H >= 4) out.push({ call: '2H', why: 'Stayman: showing four hearts.' });
    else if (len.S >= 4) out.push({ call: '2S', why: 'Stayman: showing four spades.' });
    else out.push({ call: '2D', why: 'Stayman: denying a four-card major.' });
    return out;
  }
  if (partnerCall === '2D') {
    out.push({ call: '2H', why: 'Accepting the transfer to hearts.' });
    return out;
  }
  if (partnerCall === '2H') {
    out.push({ call: '2S', why: 'Accepting the transfer to spades.' });
    return out;
  }
  if (partnerCall === '2N') {
    if (facts.hcp >= 16) out.push({ call: '3N', why: `${facts.hcp} HCP: accepting the invitation.` });
    out.push({ call: 'P', why: `Minimum 1NT (${facts.hcp} HCP): declining the invitation.` });
    return out;
  }
  // Partner invited in a major after Stayman or a transfer.
  const partnerBids = view.partnerBids;
  if (partnerBids.length >= 2) {
    const lastPartnerBid = partnerBids[partnerBids.length - 1];
    const strain = lastPartnerBid.strain;
    if (strain !== null && strain !== 'N' && lastPartnerBid.level === 3 && isMajorSuit(strain)) {
      const support = len[strain];
      if (facts.hcp >= 16 || (facts.hcp >= 15 && support >= 4)) {
        out.push({
          call: makeBid(4, strain),
          why: `${facts.hcp} HCP with ${support}-card support: accepting and bidding game.`,
        });
      }
      if (support < 3) {
        out.push({ call: '3N', why: 'No fit for the invitational major: 3NT instead.' });
      }
      out.push({ call: 'P', why: 'Minimum 1NT: declining the invitation.' });
      return out;
    }
    if (lastPartnerBid.call === '3N') {
      for (const suit of ['S', 'H'] as const) {
        const shown = partnerBids.some((r) => r.strain === suit);
        if (shown && len[suit] >= 3) {
          out.push({ call: makeBid(4, suit), why: `Eight-card ${suit} fit: correcting 3NT to the major.` });
          break;
        }
      }
      out.push({ call: 'P', why: 'Partner has chosen the final contract.' });
      return out;
    }
  }
  // Unbid territory (usually an opposing overcall): stand pat unless huge.
  if (facts.hcp >= 17 && view.oppBids.length > 0) {
    const stopperSuit = view.oppBids[view.oppBids.length - 1].strain;
    if (stopperSuit !== null && stopperSuit !== 'N' && hasStopper(hand, stopperSuit)) {
      const bid = cheapestBid(args.auction, 'N');
      if (bid !== null && bidRank(bid) <= bidRank('3N')) {
        out.push({ call: bid, why: `Maximum 1NT with a stopper in their suit: bidding on.` });
      }
    }
  }
  out.push({ call: 'P', why: '1NT has already described this hand within three points.' });
  return out;
}

/** Opener's rebid after the strong, forcing 2C opening. */
export function rebidAfter2C(ctx: BidContext): Suggestion[] {
  const { facts, args, view } = ctx;
  const out: Suggestion[] = [];
  const partnerBid = view.partnerBids.length > 0 ? view.partnerBids[0] : null;

  // Partner made a positive suit response: raise it with support.
  if (partnerBid !== null && partnerBid.call !== '2D') {
    const strain = partnerBid.strain;
    if (strain !== null && strain !== 'N' && facts.lengths[strain] >= 3 && isMajorSuit(strain)) {
      out.push({
        call: makeBid(4, strain),
        why: `Support for partner's positive response: bidding game.`,
      });
    }
  }
  if (facts.balanced && facts.hcp >= 25) {
    out.push({ call: '3N', why: `${facts.hcp} HCP balanced: 3NT.` });
  }
  if (facts.balanced && facts.hcp >= 22) {
    out.push({ call: '2N', why: `${facts.hcp} HCP balanced: 2NT rebid (22-24).` });
  }
  for (const suit of ['S', 'H', 'D', 'C'] as const) {
    if (facts.lengths[suit] < 5 && suit !== facts.longest) continue;
    const bid = cheapestBid(args.auction, suit);
    if (bid !== null) {
      out.push({ call: bid, why: `Showing the ${facts.lengths[suit]}-card ${suit} suit after the strong 2C opening.` });
      break;
    }
  }
  out.push({ call: '3N', why: 'No clear suit to name after the strong opening: 3NT.' });
  return out;
}

/**
 * Opener's rebid after a one-of-a-suit opening. The order encodes SAYC's
 * priorities: show a fit, then show a second suit cheaply, then repeat a long
 * suit, then describe a balanced hand by No-Trump level (1NT = 12-14,
 * 2NT = 18-19). A reverse - a two-level new suit ranking above the opened one -
 * forces partner to the three level, so it is reserved for 17+.
 */
export function rebidAfterOneOfASuit(ctx: BidContext, open: CallRecord): Suggestion[] {
  const { facts, hand, args, view } = ctx;
  const out: Suggestion[] = [];
  const strain = open.strain;
  if (strain === null || strain === 'N') return [{ call: 'P', why: 'Nothing to rebid.' }];

  const len = facts.lengths;
  const points = facts.hcp;
  const partnerBid = view.partnerBids.length > 0 ? view.partnerBids[0] : null;

  if (partnerBid === null) {
    out.push({ call: 'P', why: 'Partner has not bid; no reason to bid again unilaterally.' });
    return out;
  }

  const pStrain = partnerBid.strain;
  const pLevel = partnerBid.level ?? 1;

  // --- Partner raised my suit: pure arithmetic on the fit.
  if (pStrain === strain) {
    const myPoints = points + distributionPoints(hand);
    const jump = pLevel - (open.level ?? 1) - 1;
    const game = gameBidIn(strain);
    if (jump <= 0) {
      // Single raise = 6-9.
      if (myPoints >= 19) out.push({ call: game, why: `${myPoints} points opposite a 6-9 raise: game.` });
      else if (myPoints >= 17) {
        const invite = cheapestBid(args.auction, strain);
        if (invite !== null) out.push({ call: invite, why: `${myPoints} points: game try opposite the raise.` });
      }
    } else if (jump === 1) {
      // Limit raise = 10-12.
      if (myPoints >= 14) out.push({ call: game, why: `${myPoints} points opposite a limit raise: game.` });
    } else {
      // Partner raised straight to game. There is nothing left to decide about
      // the contract, but there may still be a slam: hand over to the generic
      // continuation, which owns the Blackwood machinery and the stop sign.
      return chooseContinuation(ctx);
    }
    out.push({ call: 'P', why: `${myPoints} points: the partnership is short of game values.` });
    return out;
  }

  // --- Partner responded 1NT (6-10): show a long suit or pass.
  if (pStrain === 'N') {
    if (pLevel === 1) {
      if (len[strain] >= 6) {
        const rebid = points >= 17 ? jumpBid(args.auction, strain, 1) : cheapestBid(args.auction, strain);
        if (rebid !== null) {
          out.push({ call: rebid, why: `Six-card ${strain} suit: rebidding it opposite 1NT.` });
        }
      }
      out.push({ call: 'P', why: 'Balanced minimum opposite a 6-10 1NT response: passing.' });
      return out;
    }
    if (pLevel === 2) {
      if (points >= 14) out.push({ call: '3N', why: `${points} HCP: accepting the 2NT invitation.` });
      out.push({ call: 'P', why: `Minimum opening (${points} HCP): declining the invitation.` });
      return out;
    }
    out.push({ call: 'P', why: 'Partner has named the final contract.' });
    return out;
  }

  // --- Partner bid a new suit.
  if (pStrain !== null) {
    const support = len[pStrain];
    if (support >= 4) {
      const raise =
        points >= 19
          ? gameBidIn(pStrain)
          : points >= 16
            ? jumpBid(args.auction, pStrain, 1)
            : cheapestBid(args.auction, pStrain);
      if (raise !== null) {
        out.push({
          call: raise,
          why: `${support}-card support for partner's ${pStrain} with ${points} HCP: raising.`,
        });
      }
    }

    // A new suit of my own at the ONE level costs nothing and keeps the auction alive.
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (suit === strain || suit === pStrain) continue;
      if (len[suit] < 4) continue;
      const bid = cheapestBid(args.auction, suit);
      if (bid !== null && parseBid(bid)?.level === 1) {
        out.push({ call: bid, why: `Showing a second suit (${len[suit]} ${suit}) at the one level.` });
        break;
      }
    }

    if (len[strain] >= 6) {
      const rebid = points >= 17 ? jumpBid(args.auction, strain, 1) : cheapestBid(args.auction, strain);
      if (rebid !== null) {
        out.push({ call: rebid, why: `Six-card ${strain} suit: rebidding my own suit.` });
      }
    }

    // A balanced minimum rebids 1NT in preference to raising with three-card
    // support: partner's one-level response promises only four cards, so three
    // opposite it is a seven-card fit, one short of what a trump contract wants.
    if (facts.balanced && points <= 14) {
      const bid = cheapestBid(args.auction, 'N');
      if (bid !== null && parseBid(bid)?.level === 1) {
        out.push({ call: bid, why: `${points} HCP balanced: 1NT rebid (12-14).` });
      }
    }

    // With extra values, or with a ruffing value outside, three-card support is
    // worth showing after all.
    if (support === 3 && isMajorSuit(pStrain) && pLevel === 1) {
      const raise = points >= 19 ? gameBidIn(pStrain) : points >= 16 ? jumpBid(args.auction, pStrain, 1) : cheapestBid(args.auction, pStrain);
      if (raise !== null) {
        out.push({
          call: raise,
          why: `Three-card support for partner's major with ${points} HCP: raising.`,
        });
      }
    }

    if (facts.balanced && points >= 18 && points <= 19) {
      out.push({ call: '2N', why: `${points} HCP balanced: jump rebid to 2NT (18-19).` });
    }

    // A second suit at the two level: only below the opened suit unless 17+,
    // because bidding above it is a reverse and promises extra strength.
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (suit === strain || suit === pStrain) continue;
      if (len[suit] < 4) continue;
      const isReverse = bidRank(makeBid(1, suit)) > bidRank(makeBid(1, strain));
      if (isReverse && points < 17) continue;
      const bid = cheapestBid(args.auction, suit);
      if (bid !== null && (parseBid(bid)?.level ?? 9) <= 2) {
        out.push({
          call: bid,
          why: isReverse
            ? `${points} HCP: strong enough to reverse into ${suit}.`
            : `Second suit: ${len[suit]} ${suit}.`,
        });
        break;
      }
    }

    if (facts.balanced) {
      const bid = cheapestBid(args.auction, 'N');
      if (bid !== null && (parseBid(bid)?.level ?? 9) <= 2 && points <= 17) {
        out.push({ call: bid, why: `${points} HCP balanced with no fit: No-Trump rebid.` });
      }
    }
  }

  out.push({ call: 'P', why: 'Minimum opening with nothing new to say.' });
  return out;
}

/** Dispatches the opener's rebid by what the opening bid was. */
export function chooseOpenerRebid(ctx: BidContext): Suggestion[] {
  const { view } = ctx;
  const open = view.openingBid;
  if (open === null) return [{ call: 'P', why: 'Nothing opened.' }];

  if (open.call === '1N') return rebidAfter1NT(ctx);
  if (open.call === '2C') return rebidAfter2C(ctx);
  if (open.call === '2N') return chooseContinuation(ctx);
  if (open.level !== null && open.level >= 2) {
    // A preempt has already told its whole story; bidding again unasked only
    // helps the opponents defend. Partner is the captain of the auction.
    return [{ call: 'P', why: 'The preempt already described this hand; partner decides.' }];
  }
  if (view.myBids.length >= 2) return chooseContinuation(ctx);
  return rebidAfterOneOfASuit(ctx, open);
}

// ---------------------------------------------------------------------------
// Responder's rebid
// ---------------------------------------------------------------------------

/** Responder's second call after using Stayman or a Jacoby transfer. */
function rebidAfterNTConvention(ctx: BidContext, open: CallRecord): Suggestion[] | null {
  const { facts, view } = ctx;
  if (open.call !== '1N') return null;
  const myFirst = view.myBids.length > 0 ? view.myBids[0] : null;
  const partnerReply = view.partnerBids.length >= 2 ? view.partnerBids[1] : null;
  if (myFirst === null || partnerReply === null) return null;
  const points = facts.hcp;
  const len = facts.lengths;
  const out: Suggestion[] = [];

  // Transfer: I bid the suit below my major, partner completed it.
  if (myFirst.call === '2D' || myFirst.call === '2H') {
    const major: Suit = myFirst.call === '2D' ? 'H' : 'S';
    if (points >= 10) {
      if (len[major] >= 6) {
        out.push({ call: makeBid(4, major), why: `${points} HCP and six ${major}: bidding game in the major.` });
      }
      out.push({ call: '3N', why: `${points} HCP opposite 15-17: game, partner picks the strain.` });
      return out;
    }
    if (points >= 8) {
      out.push({ call: makeBid(3, major), why: `${points} HCP: invitational after the transfer.` });
      return out;
    }
    out.push({ call: 'P', why: `Only ${points} HCP: passing the transfer out at the two level.` });
    return out;
  }

  // Stayman: partner has shown or denied a four-card major.
  if (myFirst.call === '2C') {
    const shown = partnerReply.strain;
    if (shown !== null && shown !== 'N' && isMajorSuit(shown) && len[shown] >= 4) {
      if (points >= 10) {
        out.push({ call: makeBid(4, shown), why: `Eight-card ${shown} fit and ${points} HCP: bidding game.` });
      } else {
        out.push({ call: makeBid(3, shown), why: `Eight-card ${shown} fit and ${points} HCP: invitational raise.` });
      }
      return out;
    }
    if (points >= 10) {
      out.push({ call: '3N', why: `No major fit but ${points} HCP opposite 15-17: 3NT.` });
    } else {
      out.push({ call: '2N', why: `No major fit and ${points} HCP: invitational 2NT.` });
    }
    return out;
  }
  return null;
}

/** Responder's second call after the strong 2C opening. */
function rebidAfter2CResponse(ctx: BidContext): Suggestion[] {
  const { facts, view } = ctx;
  const out: Suggestion[] = [];
  const openerRebid = view.partnerBids.length >= 2 ? view.partnerBids[1] : null;
  if (openerRebid === null) return [{ call: 'P', why: 'Waiting for partner to describe.' }];

  const strain = openerRebid.strain;
  if (strain !== null && strain !== 'N' && isMajorSuit(strain) && facts.lengths[strain] >= 3) {
    out.push({ call: makeBid(4, strain), why: `Support for partner's strong ${strain} suit: bidding game.` });
  }
  if (openerRebid.call === '2N') {
    if (facts.hcp >= 3) out.push({ call: '3N', why: `${facts.hcp} HCP opposite 22-24: bidding game.` });
    out.push({ call: 'P', why: 'A bust opposite 22-24: passing 2NT.' });
    return out;
  }
  out.push({ call: '3N', why: 'Game is a certainty opposite a strong 2C opening.' });
  out.push({ call: 'P', why: 'Partner has named the contract.' });
  return out;
}

/** Dispatches responder's second call. */
export function chooseResponderRebid(ctx: BidContext): Suggestion[] {
  const open = ctx.view.openingBid;
  if (open === null) return [{ call: 'P', why: 'Nothing opened.' }];
  if (open.call === '1N') {
    const conventional = rebidAfterNTConvention(ctx, open);
    if (conventional !== null) return conventional;
  }
  if (open.call === '2C') return rebidAfter2CResponse(ctx);
  return chooseContinuation(ctx);
}

// ---------------------------------------------------------------------------
// Competitive bidding
// ---------------------------------------------------------------------------

/**
 * A takeout double: 12+ HCP, shortness in the suit they bid, and at least
 * three-card support for every unbid suit.
 *
 * A double is only "for takeout" by partnership agreement; the Laws (Law 19A)
 * simply make it a double of their contract. Getting the shape right is what
 * stops partner from passing it for penalties in a suit we cannot beat.
 */
export function isTakeoutDouble(ctx: BidContext, theirSuit: Suit): boolean {
  if (ctx.level === 'beginner') return false;
  const { facts, view } = ctx;
  const last = view.lastBid;
  if (last === null || last.level === null || last.level > 2) return false;
  const needed = last.level === 1 ? 12 : 13;
  if (facts.hcp < needed) return false;
  if (facts.lengths[theirSuit] > 2) return false;
  for (const suit of ['C', 'D', 'H', 'S'] as const) {
    if (suit === theirSuit) continue;
    if (view.oppBids.some((r) => r.strain === suit)) continue;
    if (facts.lengths[suit] < 3 && facts.hcp < 17) return false;
  }
  return true;
}

/**
 * The first action over an opposing opening: overcall, takeout double, 1NT
 * overcall, or pass.
 *
 * An overcall promises a good five-card suit and about 8-16 HCP at the one
 * level; the two level costs a trick if it goes wrong, so it asks for more.
 */
export function chooseCompetitive(ctx: BidContext): Suggestion[] {
  const { facts, hand, args, view, level } = ctx;
  const out: Suggestion[] = [];
  const last = view.lastBid;
  if (last === null) return [{ call: 'P', why: 'Nothing to compete against.' }];
  const theirSuit = last.strain;
  const points = facts.hcp;

  if (theirSuit !== null && theirSuit !== 'N') {
    if (facts.balanced && points >= 15 && points <= 18 && hasStopper(hand, theirSuit)) {
      const bid = cheapestBid(args.auction, 'N');
      if (bid !== null && parseBid(bid)?.level === 1) {
        out.push({ call: bid, why: `${points} HCP balanced with a stopper: 1NT overcall (15-18).` });
      }
    }
    if (isTakeoutDouble(ctx, theirSuit)) {
      out.push({
        call: 'X',
        why: `${points} HCP, short in ${theirSuit} and support for the other suits: takeout double.`,
      });
    }
  }

  if (points >= 8 && points <= 16) {
    let best: Suit | null = null;
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (!isGoodSuit(hand, suit)) continue;
      if (best === null || facts.lengths[suit] > facts.lengths[best]) best = suit;
    }
    if (best !== null) {
      const bid = cheapestBid(args.auction, best);
      const bidLevel = bid === null ? 9 : (parseBid(bid)?.level ?? 9);
      const twoLevelOk = points >= 11 && (facts.lengths[best] >= 6 || topHonours(hand, best) >= 2);
      const allowed = bidLevel === 1 || (bidLevel === 2 && twoLevelOk && level !== 'beginner');
      if (bid !== null && allowed) {
        out.push({
          call: bid,
          why: `${points} HCP with a good ${facts.lengths[best]}-card ${best} suit: simple overcall.`,
        });
      }
    }
  }

  out.push({ call: 'P', why: `${points} HCP with nothing safe to say over their bid: pass.` });
  return out;
}

/**
 * Advancing partner's overcall or takeout double.
 *
 * Answering a takeout double is close to compulsory: partner has asked for a
 * suit, so even a bust hand names its longest unbid suit at the cheapest level
 * rather than converting the double into a penalty pass of a making contract.
 */
export function chooseAdvance(ctx: BidContext): Suggestion[] {
  const { facts, hand, args, view } = ctx;
  const out: Suggestion[] = [];
  const points = facts.hcp;
  const partnerDoubled = view.partnerRecords.some((r) => r.call === 'X');
  const partnerBid = view.partnerBids.length > 0 ? view.partnerBids[0] : null;

  if (partnerBid === null && partnerDoubled) {
    const theirSuits = suitsBidBy(view.oppBids);
    let best: Suit | null = null;
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      if (theirSuits.includes(suit)) continue;
      if (best === null) best = suit;
      else if (
        facts.lengths[suit] > facts.lengths[best] ||
        (facts.lengths[suit] === facts.lengths[best] && isMajorSuit(suit) && !isMajorSuit(best))
      ) {
        best = suit;
      }
    }
    if (best !== null) {
      if (points >= 13 && isMajorSuit(best) && facts.lengths[best] >= 4) {
        out.push({ call: makeBid(4, best), why: `${points} HCP opposite a takeout double: bidding game.` });
      }
      const jump = points >= 9 ? jumpBid(args.auction, best, 1) : null;
      if (jump !== null) {
        out.push({ call: jump, why: `${points} HCP opposite the takeout double: jumping in ${best}.` });
      }
      if (points >= 10 && facts.balanced && theirSuits.every((s) => hasStopper(hand, s))) {
        out.push({ call: '3N', why: `${points} HCP balanced with their suit stopped: 3NT.` });
      }
      const cheap = cheapestBid(args.auction, best);
      if (cheap !== null) {
        out.push({
          call: cheap,
          why: `Partner's double asked for a suit: bidding my longest unbid suit (${facts.lengths[best]} ${best}).`,
        });
      }
    }
    out.push({ call: 'P', why: 'No suit to offer over the double.' });
    return out;
  }

  if (partnerBid !== null) {
    if (partnerBid.call === '1N') {
      if (points >= 8) out.push({ call: '3N', why: `${points} HCP opposite a 15-18 1NT overcall: game.` });
      out.push({ call: 'P', why: 'Not enough opposite the 1NT overcall.' });
      return out;
    }
    const strain = partnerBid.strain;
    if (strain !== null && strain !== 'N') {
      const support = facts.lengths[strain];
      const sp = supportPoints(hand, strain);
      if (support >= 3) {
        if (sp >= 13 && isMajorSuit(strain)) {
          out.push({ call: makeBid(4, strain), why: `${sp} support points and a fit: raising to game.` });
        } else if (sp >= 10) {
          const jump = jumpBid(args.auction, strain, 1);
          if (jump !== null) {
            out.push({ call: jump, why: `${sp} support points with ${support}-card support: invitational raise.` });
          }
        } else if (sp >= 6) {
          const cheap = cheapestBid(args.auction, strain);
          if (cheap !== null) {
            out.push({ call: cheap, why: `${sp} support points with ${support}-card support: raising the overcall.` });
          }
        }
      }
    }
  }
  out.push({ call: 'P', why: 'Nothing to add to what partner has already said.' });
  return out;
}

// ---------------------------------------------------------------------------
// The generic later-round decision
// ---------------------------------------------------------------------------

/**
 * The catch-all for any later round of bidding: add this hand to the minimum
 * partner has shown, and bid game when the partnership is known to hold about
 * 25 HCP or an eight-card major fit with the values to go with it. Invite one
 * level lower when game is possible but not certain; otherwise pass.
 *
 * The safety valve of the whole robot: it never bids past game without the
 * Blackwood machinery below, and it always offers a pass, so every auction it
 * takes part in terminates.
 */
export function chooseContinuation(ctx: BidContext): Suggestion[] {
  const { facts, hand, args, view, level } = ctx;
  const out: Suggestion[] = [];
  const fit = agreedFit(view, hand);
  const strength = partnerStrength(view);
  const combinedMin = facts.hcp + strength.min;
  const combinedMax = facts.hcp + strength.max;
  const last = view.lastBid;
  const theirSuits = suitsBidBy(view.oppBids);

  if (shouldAskBlackwood(ctx, fit, combinedMin)) {
    out.push({
      call: '4N',
      why: `Agreed ${fit} fit and about ${combinedMin}+ combined HCP: Blackwood, asking for aces.`,
    });
  }

  // Our side has already bid game or better: only slam interest justifies more.
  if (last !== null && last.ours && last.bid !== null && isGameOrBetter(last.bid)) {
    out.push({ call: 'P', why: 'Our side has already bid game; no reason to bid on.' });
    return out;
  }

  if (fit !== null) {
    const game = gameBidIn(fit);
    if (combinedMin >= GAME_HCP) {
      out.push({
        call: game,
        why: `About ${combinedMin}+ combined HCP with a ${fit} fit: bidding game.`,
      });
      if (!isMajorSuit(fit) && facts.balanced && theirSuits.every((s) => hasStopper(hand, s))) {
        out.push({ call: '3N', why: `${combinedMin}+ combined HCP: 3NT is the shorter road to game.` });
      }
    } else if (combinedMax >= GAME_HCP && combinedMin >= GAME_HCP - 2) {
      const invite = cheapestBid(args.auction, fit);
      if (invite !== null && (parseBid(invite)?.level ?? 9) <= 3) {
        out.push({ call: invite, why: `About ${combinedMin}-${combinedMax} combined: inviting game.` });
      }
    }
  } else if (facts.balanced || level === 'advanced') {
    const stopped = theirSuits.every((suit) => hasStopper(hand, suit));
    if (combinedMin >= GAME_HCP + 1 && stopped) {
      out.push({ call: '3N', why: `About ${combinedMin}+ combined HCP and no fit: 3NT.` });
    } else if (combinedMin >= GAME_HCP - 2 && combinedMax >= GAME_HCP + 1 && stopped) {
      const invite = cheapestBid(args.auction, 'N');
      if (invite !== null && (parseBid(invite)?.level ?? 9) <= 2) {
        out.push({ call: invite, why: `About ${combinedMin}-${combinedMax} combined: inviting in No-Trump.` });
      }
    }
  }

  out.push({ call: 'P', why: 'The partnership is short of the values for another bid.' });
  return out;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Routes the decision to the chooser for the chair this hand is bidding from. */
export function chooseByRole(ctx: BidContext): Suggestion[] {
  const { view } = ctx;
  switch (view.role) {
    case 'open':
      return chooseOpening(ctx);
    case 'opener':
      return chooseOpenerRebid(ctx);
    case 'responder':
      return view.myBids.length === 0 ? chooseResponse(ctx) : chooseResponderRebid(ctx);
    case 'advance':
      return view.myBids.length === 0 ? chooseAdvance(ctx) : chooseContinuation(ctx);
    case 'overcall':
      return chooseCompetitive(ctx);
    case 'overcallRebid':
      return chooseContinuation(ctx);
    default:
      return [{ call: 'P', why: 'No system rule applies; passing.' }];
  }
}

/**
 * The single decision point: build the candidate list, then return the first
 * candidate that `legalCalls` actually permits.
 *
 * Order of business:
 *  1. Blackwood answers and sign-offs come first and are exempt from the
 *     long-auction guard - leaving an ace ask unanswered would strand the
 *     partnership in 4NT.
 *  2. Past 12 calls, with no such forcing reason, the bot passes. Nothing in
 *     the Laws forbids a long auction, but a robot that keeps finding one more
 *     bid can keep an auction alive to 7NT; this is the circuit breaker.
 *  3. Otherwise the role-specific chooser runs.
 *  4. Whatever happens, an illegal suggestion is skipped and the fallback is a
 *     pass (then, defensively, the cheapest legal call).
 */
function decide(args: BiddingArgs): Suggestion {
  const legal = legalCalls(args.auction, args.dealer, args.seat);
  if (legal.length === 0) {
    return { call: 'P', why: 'No legal call is available for this seat right now.' };
  }
  const legalSet = new Set<Call>(legal);
  const ctx = makeContext(args);

  const candidates: Suggestion[] = [];
  const answer = blackwoodAnswer(ctx);
  if (answer !== null) candidates.push(answer);
  const signoff = blackwoodSignoff(ctx);
  if (signoff !== null) candidates.push(signoff);

  if (candidates.length === 0) {
    if (args.auction.length >= LONG_AUCTION) {
      candidates.push({ call: 'P', why: 'The auction has run long enough; passing it out.' });
    } else {
      candidates.push(...chooseByRole(ctx));
    }
  }

  for (const candidate of candidates) {
    if (legalSet.has(candidate.call)) return candidate;
  }
  if (legalSet.has('P')) return { call: 'P', why: 'No sound call available: passing.' };
  return { call: legal[0], why: 'Fallback: the cheapest legal call.' };
}

/**
 * The robot's call for this seat, in this auction, with this hand.
 *
 * The result is ALWAYS a member of `legalCalls(auction, dealer, seat)` whenever
 * that list is non-empty, so the caller can hand it straight to the engine
 * without re-validating. If it is not this seat's turn (or the auction is
 * already closed under Law 22A) there is no legal call at all, and the function
 * returns 'P' rather than throwing.
 *
 * Pure: same arguments, same call, no clock and no randomness.
 */
export function chooseCall(args: BiddingArgs): Call {
  return decide(args).call;
}

/**
 * A one-line, human-readable reason for the call `chooseCall` would make with
 * exactly these arguments - shown in the UI as the robot's "tooltip".
 *
 * Guaranteed to describe the same call, because both functions read the call
 * and the explanation off the very same chosen `Suggestion`.
 */
export function explainCall(args: BiddingArgs): string {
  return decide(args).why;
}
