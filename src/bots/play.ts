/**
 * The card-play robot: a fast heuristic defender / declarer.
 *
 * DESIGN CONSTRAINTS
 *  - PURE. No clock, no ambient randomness, no I/O, no mutation of the caller's
 *    arrays. The "random-ish" beginner play is a deterministic hash of the
 *    position, so a bot re-asked about the same position always answers the
 *    same card and a replayed board reproduces exactly.
 *  - CHEAP. This runs inside a Durable Object on a budget of a few
 *    milliseconds, so there is no double-dummy solver here. The only search is
 *    the four-card endgame at the bottom of the file, and it is capped by an
 *    explicit node budget.
 *  - SAFE. `chooseCard` can only ever return a card taken from
 *    `legalCards(hand, play)` - the follow-suit obligation of Law 44 is
 *    enforced by filtering the engine's own legal set, never by reasoning
 *    around it. Every heuristic may bail out; the dispatcher then falls back to
 *    the first legal card.
 *
 * WHAT THE BOT IS ALLOWED TO KNOW
 *  `known` carries exactly the hands this seat may legally see: its own, plus
 *  dummy once the opening lead has been faced (Law 41D). When the bot is
 *  declarer it therefore sees both of its own hands and plays them as one
 *  26-card unit (Law 43/45F - dummy takes no part in the play; declarer names
 *  every card from dummy). Nothing here ever peeks at a hidden hand: the
 *  endgame search invents a *worst case* layout for the cards it cannot see.
 */

import type {
  Call,
  Card,
  Contract,
  Hands,
  PlayState,
  PlayedCard,
  Seat,
  Side,
  Strain,
  Suit,
  Trick,
} from '../engine/types';
import { RANK_CHARS, SEATS, SUITS } from '../engine/types';
import { FULL_DECK, makeCard, rankValue, suitOf } from '../engine/cards';
import { currentTrick, dummySeat, legalCards, trickWinner } from '../engine/play';
import { nextSeat, partnerOf, sideOf } from '../engine/deal';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * How hard the robot tries. Deliberately declared here rather than imported
 * from the server protocol so that the bot package has no dependency on the
 * wire format; the two definitions are kept structurally identical.
 */
export type BotLevel = 'beginner' | 'intermediate' | 'advanced';

/** Everything the robot is given in order to pick a card. */
export interface ChooseCardArgs {
  /** The cards of the seat that is to play (dummy's hand when it is dummy's turn). */
  hand: Card[];
  play: PlayState;
  contract: Contract;
  seat: Seat;
  /** Cards the bot is entitled to know: its own hand plus dummy once revealed. */
  known: Partial<Record<Seat, Card[]>>;
  level: BotLevel;
  /**
   * OPTIONAL and purely additive: the auction, if the caller has it to hand.
   * The only heuristic that needs it is "lead partner's bid suit"; with the
   * field omitted that rule is simply skipped and everything else is unchanged.
   * `dealer` is required alongside the calls because a `Call[]` on its own
   * cannot be mapped back to the seats that made the calls.
   */
  auction?: { calls: readonly Call[]; dealer: Seat };
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Jack: the lowest card the Milton Work count calls an honour. */
const HONOUR = 11;
/** Ten: "small" cards are everything below this. */
const TEN = 10;
const ACE = 14;
const KING = 13;
const QUEEN = 12;

/** The endgame search only runs once every hand is down to this many cards. */
const ENDGAME_MAX_CARDS = 4;
/**
 * Hard cap on visited nodes. A node costs a few microseconds, so this ceiling
 * is the ~5 ms a Durable Object turn can spare; with equal-card reduction and
 * alpha-beta a four-card ending is usually solved in a couple of hundred nodes.
 * The rare position that would cost more abandons the search and lets the
 * heuristics answer, rather than blowing the time budget for the whole table.
 */
const ENDGAME_NODE_BUDGET = 1500;

/** Thrown (and caught internally) when the endgame search runs out of budget. */
const BUDGET_EXHAUSTED: unique symbol = Symbol('endgame-budget');

// ---------------------------------------------------------------------------
// Small pure card helpers
// ---------------------------------------------------------------------------

/** A copy of `cards`, highest rank first. */
function sortDesc(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => rankValue(b) - rankValue(a));
}

/** The cards of one suit, highest rank first. Never mutates the input. */
function holdingIn(cards: readonly Card[], suit: Suit): Card[] {
  return sortDesc(cards.filter((c) => suitOf(c) === suit));
}

/** Every suit holding of a hand, each sorted high to low. */
function bySuit(cards: readonly Card[]): Record<Suit, Card[]> {
  const out: Record<Suit, Card[]> = { C: [], D: [], H: [], S: [] };
  for (const card of cards) out[suitOf(card)].push(card);
  for (const suit of SUITS) out[suit] = sortDesc(out[suit]);
  return out;
}

/** True for ace, king, queen and jack - the cards that carry high-card points. */
function isHonour(card: Card): boolean {
  return rankValue(card) >= HONOUR;
}

/** Lowest card of a set; ties across suits break on the fixed `SUITS` order. */
function lowestCard(cards: readonly Card[]): Card {
  let best = cards[0];
  for (const card of cards) {
    const cmp = rankValue(card) - rankValue(best);
    if (cmp < 0 || (cmp === 0 && SUITS.indexOf(suitOf(card)) < SUITS.indexOf(suitOf(best)))) {
      best = card;
    }
  }
  return best;
}

/** Highest card of a set; ties across suits break on the fixed `SUITS` order. */
function highestCard(cards: readonly Card[]): Card {
  let best = cards[0];
  for (const card of cards) {
    const cmp = rankValue(card) - rankValue(best);
    if (cmp > 0 || (cmp === 0 && SUITS.indexOf(suitOf(card)) < SUITS.indexOf(suitOf(best)))) {
      best = card;
    }
  }
  return best;
}

/**
 * FNV-1a over the cards played so far plus the seat: a deterministic stand-in
 * for randomness, so the beginner bot varies from position to position without
 * the engine ever calling `Math.random()`.
 */
function positionHash(ctx: Ctx): number {
  let h = 2166136261;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  mix(ctx.seat);
  for (const trick of ctx.play.tricks) for (const pc of trick.cards) mix(pc.card);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Decision + context
// ---------------------------------------------------------------------------

/** A chosen card together with the sentence `explainCard` will report. */
interface Decision {
  card: Card;
  why: string;
}

function decision(card: Card, why: string): Decision {
  return { card, why: `${card} - ${why}` };
}

/** Everything derived once per call and shared by all the heuristics. */
interface Ctx {
  readonly level: BotLevel;
  readonly seat: Seat;
  readonly partner: Seat;
  readonly declarer: Seat;
  readonly dummy: Seat;
  readonly play: PlayState;
  readonly strain: Strain;
  /** The trump suit, or null in a No-Trump contract. */
  readonly trump: Suit | null;
  readonly ourSide: Side;
  /** True when this seat belongs to declarer's side (declarer or dummy). */
  readonly declaring: boolean;
  readonly hand: Card[];
  readonly legal: Card[];
  readonly leader: Seat;
  readonly trickCards: PlayedCard[];
  /** 0 = on lead, 1 = second hand, 2 = third hand, 3 = fourth hand. */
  readonly position: number;
  readonly led: Suit | null;
  /** The seat currently winning the part-played trick, null when on lead. */
  readonly bestSeat: Seat | null;
  readonly bestCard: Card | null;
  readonly partnerWinning: boolean;
  /** Every card played to every trick, the current one included. */
  readonly played: ReadonlySet<Card>;
  /**
   * Cards from tricks that are over. Deliberately NOT the same as `played`:
   * a card lying on the current trick is still fighting for it, so it can
   * never be treated as a card that has left the deal.
   */
  readonly quitted: ReadonlySet<Card>;
  /** Hands this seat may legally see, stale (already played) cards removed. */
  readonly visible: Partial<Record<Seat, Card[]>>;
  /** Cards our own side is known to hold: this hand plus partner's if visible. */
  readonly ourVisible: ReadonlySet<Card>;
  /** Cards in neither the played pile nor any visible hand. */
  readonly unseen: Card[];
  /** Seats still to play to this trick, in play order. */
  readonly seatsAfter: Seat[];
  /** Cards each seat still holds, inferred from the trick history. */
  readonly remaining: Record<Seat, number>;
  readonly isOpeningLead: boolean;
  /** The first suit partner bid, when the caller supplied the auction. */
  readonly partnerSuit: Suit | null;
}

/** `legalCards`, but tolerant of a malformed or finished `PlayState`. */
function safeLegalCards(args: ChooseCardArgs): Card[] {
  if (args.play.tricks.length === 0) return [...args.hand];
  const legal = legalCards([...args.hand], args.play);
  return legal.length > 0 ? legal : [...args.hand];
}

/** The first suit (never No-Trump) that partner bid in the auction, if any. */
function partnerBidSuit(args: ChooseCardArgs, partner: Seat): Suit | null {
  const auction = args.auction;
  if (auction === undefined) return null;
  for (let i = 0; i < auction.calls.length; i++) {
    if (nextSeat(auction.dealer, i) !== partner) continue;
    const call = auction.calls[i];
    if (call.length !== 2) continue;
    const strain = call.charAt(1);
    if (strain === 'C' || strain === 'D' || strain === 'H' || strain === 'S') return strain;
  }
  return null;
}

/** Collects the derived facts every heuristic below needs. */
function buildContext(args: ChooseCardArgs): Ctx {
  const declarer = args.contract.declarer;
  const dummy = dummySeat(declarer);
  const strain = args.contract.strain;
  const trump: Suit | null = strain === 'N' ? null : strain;
  const hand = [...args.hand];

  const played = new Set<Card>();
  const quitted = new Set<Card>();
  const playedBy: Record<Seat, number> = { N: 0, E: 0, S: 0, W: 0 };
  const lastTrickIndex = args.play.tricks.length - 1;
  for (let i = 0; i < args.play.tricks.length; i++) {
    for (const pc of args.play.tricks[i].cards) {
      played.add(pc.card);
      if (i !== lastTrickIndex) quitted.add(pc.card);
      playedBy[pc.seat] += 1;
    }
  }

  const trick: Trick | null = args.play.tricks.length > 0 ? currentTrick(args.play) : null;
  const trickCards: PlayedCard[] = trick === null ? [] : [...trick.cards];
  const leader: Seat = trick === null ? args.seat : trick.leader;
  const position = trickCards.length;
  const led: Suit | null = position > 0 ? suitOf(trickCards[0].card) : null;

  let bestSeat: Seat | null = null;
  let bestCard: Card | null = null;
  if (position > 0) {
    bestSeat = trickWinner({ leader, cards: trickCards }, strain);
    for (const pc of trickCards) if (pc.seat === bestSeat) bestCard = pc.card;
  }

  const visible: Partial<Record<Seat, Card[]>> = {};
  visible[args.seat] = hand;
  for (const seat of SEATS) {
    if (seat === args.seat) continue;
    const cards = args.known[seat];
    if (cards === undefined) continue;
    visible[seat] = cards.filter((c) => !played.has(c));
  }

  const visibleSet = new Set<Card>();
  for (const seat of SEATS) for (const c of visible[seat] ?? []) visibleSet.add(c);
  const unseen = FULL_DECK.filter((c) => !played.has(c) && !visibleSet.has(c));

  const partner = partnerOf(args.seat);
  const ourVisible = new Set<Card>(hand);
  for (const c of visible[partner] ?? []) ourVisible.add(c);

  const seatsAfter: Seat[] = [];
  for (let i = position + 1; i < 4; i++) seatsAfter.push(nextSeat(leader, i));

  const startSize = hand.length + playedBy[args.seat];
  const remaining: Record<Seat, number> = { N: 0, E: 0, S: 0, W: 0 };
  for (const seat of SEATS) remaining[seat] = Math.max(0, startSize - playedBy[seat]);

  return {
    level: args.level,
    seat: args.seat,
    partner,
    declarer,
    dummy,
    play: args.play,
    strain,
    trump,
    ourSide: sideOf(args.seat),
    declaring: sideOf(args.seat) === sideOf(declarer),
    hand,
    legal: safeLegalCards(args),
    leader,
    trickCards,
    position,
    led,
    bestSeat,
    bestCard,
    partnerWinning: bestSeat !== null && bestSeat === partner,
    played,
    quitted,
    visible,
    ourVisible,
    unseen,
    seatsAfter,
    remaining,
    isOpeningLead: args.play.tricks.length <= 1 && position === 0,
    partnerSuit: partnerBidSuit(args, partner),
  };
}

// ---------------------------------------------------------------------------
// Trick reasoning
// ---------------------------------------------------------------------------

/**
 * The suit that decides a (part-played) trick: the trump suit once anybody has
 * trumped, otherwise the suit led (Law 44, Winner of the Trick).
 */
function decidingSuit(cards: readonly PlayedCard[], trump: Suit | null): Suit | null {
  if (cards.length === 0) return null;
  if (trump !== null && cards.some((pc) => suitOf(pc.card) === trump)) return trump;
  return suitOf(cards[0].card);
}

/** Would playing `card` now make this seat the seat winning the trick so far? */
function wouldWin(ctx: Ctx, card: Card): boolean {
  if (ctx.trickCards.length === 0) return false;
  const cards: PlayedCard[] = [...ctx.trickCards, { seat: ctx.seat, card }];
  return trickWinner({ leader: ctx.leader, cards }, ctx.strain) === ctx.seat;
}

/**
 * Given the cards on the trick so far, does our side still hold it once every
 * opponent yet to play has had a chance?
 *
 * Partners are never threats: a partner playing over us keeps the trick in the
 * partnership either way. An opponent whose cards we can see (dummy) is checked
 * exactly, ruffs included; for a hidden hand we only count higher cards of the
 * deciding suit, because guarding against a ruff we cannot see is impossible
 * and pricing it in would paralyse the bot instead of helping it.
 */
function sideKeepsTrick(ctx: Ctx, cards: PlayedCard[]): boolean {
  if (cards.length === 0) return false;
  const deciding = decidingSuit(cards, ctx.trump);
  if (deciding === null) return false;
  const winner = trickWinner({ leader: ctx.leader, cards }, ctx.strain);
  if (sideOf(winner) !== ctx.ourSide) return false;

  let bestRank = -1;
  for (const pc of cards) {
    if (pc.seat === winner && suitOf(pc.card) === deciding) bestRank = rankValue(pc.card);
  }
  const led = suitOf(cards[0].card);

  for (const other of ctx.seatsAfter) {
    if (sideOf(other) === ctx.ourSide) continue;
    const theirs = ctx.visible[other];
    if (theirs !== undefined) {
      const followers = theirs.filter((c) => suitOf(c) === led);
      const options = followers.length > 0 ? followers : theirs;
      for (const option of options) {
        const probe: PlayedCard[] = [...cards, { seat: other, card: option }];
        if (sideOf(trickWinner({ leader: ctx.leader, cards: probe }, ctx.strain)) !== ctx.ourSide) {
          return false;
        }
      }
      continue;
    }
    if (ctx.unseen.some((c) => suitOf(c) === deciding && rankValue(c) > bestRank)) return false;
  }
  return true;
}

/** Would playing `card` win this trick beyond the reach of the opponents left to play? */
function isSafeWinner(ctx: Ctx, card: Card): boolean {
  return sideKeepsTrick(ctx, [...ctx.trickCards, { seat: ctx.seat, card }]);
}

/** Is the card partner has already played safe from the opponents still to come? */
function partnerCardIsSafe(ctx: Ctx): boolean {
  return ctx.partnerWinning && sideKeepsTrick(ctx, ctx.trickCards);
}

/**
 * The cheapest card that is completely equivalent to `card` right now: walk
 * down the suit while each step is either another of our own cards or a card
 * that has left the deal. Equal cards win equal tricks, so from KQJ we play the
 * jack, and from KJ with the queen already quitted we play the jack - the
 * "lowest of touching honours" principle, which costs nothing and tells the
 * opponents as little as possible.
 *
 * Only QUITTED cards close a gap. A card lying on the current trick is still in
 * play, so stepping past it would be exactly the blunder of dropping from the
 * ace to the queen underneath a king that is winning the trick right now.
 * `stillOk` is the second belt: callers that are trying to win the trick pass a
 * test the cheaper card must also pass.
 */
function lowestEquivalent(
  ctx: Ctx,
  card: Card,
  holding: readonly Card[],
  stillOk?: (candidate: Card) => boolean,
): Card {
  const suit = suitOf(card);
  const mine = new Set<Card>(holding);
  let current = card;
  for (let rank = rankValue(card) - 1; rank >= 2; rank--) {
    const lower = makeCard(suit, RANK_CHARS[rank - 2]);
    if (mine.has(lower)) {
      if (stillOk !== undefined && !stillOk(lower)) break;
      current = lower; // one of ours: strictly equivalent, so step down onto it
      continue;
    }
    if (ctx.quitted.has(lower)) continue; // gone from the deal: not a separator
    break; // a live card sits in between: the run of equals ends here
  }
  return current;
}

/** `lowestEquivalent` for a card that is meant to win: the cheaper card must win too. */
function cheapestEqualWinner(ctx: Ctx, card: Card, holding: readonly Card[]): Card {
  return lowestEquivalent(ctx, card, holding, (candidate) => wouldWin(ctx, candidate));
}

/**
 * Is `card` the highest card of its suit still outstanding, counting our own
 * side's visible cards as ours? Such a card cashes immediately (barring a ruff,
 * which no side can prevent).
 */
function isMaster(ctx: Ctx, card: Card): boolean {
  const suit = suitOf(card);
  for (let rank = rankValue(card) + 1; rank <= ACE; rank++) {
    const higher = makeCard(suit, RANK_CHARS[rank - 2]);
    if (ctx.played.has(higher)) continue;
    if (ctx.ourVisible.has(higher)) continue;
    return false;
  }
  return true;
}

/** How many cards of a suit between two of our own are still out against us. */
function gapsBetween(ctx: Ctx, high: Card, low: Card): number {
  const suit = suitOf(high);
  let gaps = 0;
  for (let rank = rankValue(low) + 1; rank < rankValue(high); rank++) {
    const between = makeCard(suit, RANK_CHARS[rank - 2]);
    if (ctx.played.has(between) || ctx.ourVisible.has(between)) continue;
    gaps += 1;
  }
  return gaps;
}

/** Cards of a suit that are neither played nor held by our own side. */
function outstandingIn(ctx: Ctx, suit: Suit): Card[] {
  return FULL_DECK.filter(
    (c) => suitOf(c) === suit && !ctx.played.has(c) && !ctx.ourVisible.has(c),
  );
}

// ---------------------------------------------------------------------------
// Discarding
// ---------------------------------------------------------------------------

/** Small cards a holding needs below an honour before that honour is guarded. */
function guardsNeeded(card: Card): number {
  const rank = rankValue(card);
  if (rank === ACE) return 0;
  if (rank === KING) return 1;
  if (rank === QUEEN) return 2;
  if (rank === HONOUR) return 3;
  return 0;
}

/**
 * How reluctant we are to throw a particular card - lower means "throw this
 * one". Trumps are all but untouchable, honours are expensive, length is cheap,
 * and two defensive refinements are folded in: never bare an honour that is
 * still guarding (a doubleton king thrown to a singleton king is a trick given
 * away), and hold length parity with dummy so declarer's long suit cannot be
 * run past us.
 */
function discardScore(ctx: Ctx, card: Card, suits: Record<Suit, Card[]>): number {
  const suit = suitOf(card);
  const holding = suits[suit];
  let score = rankValue(card);

  if (ctx.trump !== null && suit === ctx.trump) score += 1000;
  if (isHonour(card)) score += (rankValue(card) - TEN) * 100;

  if (holding.length === 1) {
    score += 60; // throwing our last card in a suit gives up all control of it
  } else {
    // Would this discard leave an honour we keep without enough small cards
    // under it? A bared king falls to the ace; a queen needs two.
    for (let i = 0; i < holding.length; i++) {
      const honour = holding[i];
      if (!isHonour(honour) || honour === card) continue;
      let below = holding.length - (i + 1);
      if (rankValue(card) < rankValue(honour)) below -= 1;
      if (below < guardsNeeded(honour)) {
        score += 250;
        break;
      }
    }
  }

  // Longer, worthless suits are the natural source of discards.
  score -= holding.length * 12;
  if (!holding.some(isHonour)) score -= 40;

  if (!ctx.declaring) {
    const dummyHand = ctx.visible[ctx.dummy];
    if (dummyHand !== undefined) {
      const dummyLength = dummyHand.filter((c) => suitOf(c) === suit).length;
      if (dummyLength >= holding.length && dummyLength > 0) score += 30;
    }
  }
  return score;
}

/** Picks the least valuable card of `candidates` to throw away. */
function discardFrom(ctx: Ctx, candidates: readonly Card[]): Decision {
  const suits = bySuit(ctx.hand);
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const card of candidates) {
    const score = discardScore(ctx, card, suits);
    if (score < bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return decision(best, 'discard: the least useful card, keeping guards and length');
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * The top of a three-card honour sequence (KQJ, QJT, JT9) or of a broken one
 * with a single gap (KQT, QJ9, JT8, AKJ), or null when the holding has none.
 */
function sequenceTop(holding: readonly Card[]): Card | null {
  if (holding.length < 3) return null;
  const r0 = rankValue(holding[0]);
  const r1 = rankValue(holding[1]);
  const r2 = rankValue(holding[2]);
  if (r0 < TEN) return null;
  if (r1 !== r0 - 1) return null;
  if (r2 === r1 - 1 || r2 === r1 - 2) return holding[0];
  return null;
}

/**
 * Which card to lead out of a chosen suit, by the standard leading rules:
 * top of a sequence, low from an honour, fourth best from length, MUD
 * (middle-up-down) from three small, top of nothing from a worthless doubleton.
 *
 * Against a trump contract an ace-headed suit is led with the ace: underleading
 * an ace into an unknown hand hands declarer a free trick with a lower honour.
 */
function leadCardFrom(holding: readonly Card[], vsSuitContract: boolean): Card | null {
  const n = holding.length;
  if (n === 0) return null;
  if (n <= 2) return holding[0];
  const seq = sequenceTop(holding);
  if (seq !== null) return seq;
  if (n === 3) return isHonour(holding[0]) ? holding[2] : holding[1];
  if (isHonour(holding[0])) {
    if (vsSuitContract && rankValue(holding[0]) === ACE) return holding[0];
    return holding[3];
  }
  return vsSuitContract ? holding[1] : holding[3];
}

/** Explains, in words, why `card` was led out of `holding`. */
function leadReason(holding: readonly Card[], card: Card, vsSuitContract: boolean): string {
  const n = holding.length;
  if (n === 1) return 'the only card of the suit';
  if (n === 2) return 'top of a doubleton';
  if (sequenceTop(holding) === card) return 'top of a sequence';
  if (n === 3) return isHonour(holding[0]) ? 'low from an honour' : 'MUD from three small';
  if (card === holding[3]) return 'fourth best from length';
  if (card === holding[0]) return 'the ace: never underlead an ace against a trump contract';
  return vsSuitContract ? 'second highest from a worthless suit' : 'from our longest suit';
}

/**
 * The opening lead (Law 41A: the defender on declarer's left leads to trick one,
 * before dummy is faced - so this decision is taken on 13 cards and the auction
 * alone, with no dummy to look at).
 *
 * Against a suit contract: partner's suit, then a side-suit singleton when we
 * have trump control, then top of a sequence, then fourth best from a suit
 * headed by a non-ace honour, then MUD, then top of nothing. Against No-Trump:
 * fourth best from the longest and strongest suit, leading the top of a
 * sequence when the suit has one.
 */
function openingLeadDecision(ctx: Ctx): Decision | null {
  if (ctx.position !== 0) return null;
  const suits = bySuit(ctx.hand);
  const sideSuits = SUITS.filter((s) => s !== ctx.trump);
  const vsSuit = ctx.trump !== null;

  // Partner told us what to lead during the auction; that beats any table rule.
  const partnerSuit = ctx.partnerSuit;
  if (partnerSuit !== null && partnerSuit !== ctx.trump && suits[partnerSuit].length > 0) {
    const card = leadCardFrom(suits[partnerSuit], vsSuit);
    if (card !== null) return decision(card, `partner bid ${partnerSuit}: lead partner's suit`);
  }

  if (vsSuit && ctx.trump !== null) {
    const trumpHolding = suits[ctx.trump];
    const trumpControl =
      trumpHolding.length >= 3 || trumpHolding.some((c) => rankValue(c) === ACE);

    // A singleton is only a weapon when we can regain the lead to take the ruff.
    if (trumpControl) {
      for (const suit of sideSuits) {
        const holding = suits[suit];
        if (holding.length === 1 && rankValue(holding[0]) <= TEN) {
          return decision(holding[0], 'singleton lead, looking for a ruff while we hold trump control');
        }
      }
    }

    let bestSeq: Card | null = null;
    for (const suit of sideSuits) {
      const top = sequenceTop(suits[suit]);
      if (top === null) continue;
      if (bestSeq === null || rankValue(top) > rankValue(bestSeq)) bestSeq = top;
    }
    if (bestSeq !== null) return decision(bestSeq, 'top of a sequence: safe and it builds tricks');

    let fourthBest: Card | null = null;
    let fourthBestLength = 0;
    for (const suit of sideSuits) {
      const holding = suits[suit];
      if (holding.length < 4) continue;
      const top = rankValue(holding[0]);
      if (top < HONOUR || top === ACE) continue; // never underlead an ace
      if (holding.length > fourthBestLength) {
        fourthBestLength = holding.length;
        fourthBest = holding[3];
      }
    }
    if (fourthBest !== null) return decision(fourthBest, 'fourth best from our long suit');

    for (const suit of sideSuits) {
      const holding = suits[suit];
      if (holding.length === 3 && !holding.some(isHonour)) {
        return decision(holding[1], 'MUD from three small: middle now, up next time');
      }
    }
    for (const suit of sideSuits) {
      const holding = suits[suit];
      if (holding.length === 2 && !holding.some(isHonour)) {
        return decision(holding[0], 'top of nothing from a worthless doubleton');
      }
    }

    // Passive fallback: the longest side suit that does not underlead an ace,
    // and never a trump - leading trumps needs a reason from the auction.
    let fallbackSuit: Suit | null = null;
    for (const suit of sideSuits) {
      const holding = suits[suit];
      if (holding.length === 0) continue;
      if (rankValue(holding[0]) === ACE && holding.length > 1) continue;
      if (fallbackSuit === null || holding.length > suits[fallbackSuit].length) fallbackSuit = suit;
    }
    if (fallbackSuit !== null) {
      const card = leadCardFrom(suits[fallbackSuit], true);
      if (card !== null) {
        return decision(card, `${leadReason(suits[fallbackSuit], card, true)}, avoiding a trump lead`);
      }
    }
    return null;
  }

  // No-Trump: length is what wins tricks, so lead the longest and strongest.
  let target: Suit | null = null;
  for (const suit of SUITS) {
    const holding = suits[suit];
    if (holding.length === 0) continue;
    if (target === null) {
      target = suit;
      continue;
    }
    const current = suits[target];
    if (holding.length > current.length) target = suit;
    else if (holding.length === current.length) {
      const strength = holding.reduce((sum, c) => sum + Math.max(0, rankValue(c) - TEN), 0);
      const best = current.reduce((sum, c) => sum + Math.max(0, rankValue(c) - TEN), 0);
      if (strength > best) target = suit;
    }
  }
  if (target === null) return null;
  const card = leadCardFrom(suits[target], false);
  if (card === null) return null;
  return decision(card, `${leadReason(suits[target], card, false)} against no-trump`);
}

/**
 * The declaring side on lead. Priorities, in the order a human declarer works
 * through them: draw the opponents' trumps while we hold the majority and have
 * no crossruff to protect, then finesse rather than banging down honours, then
 * cash the winners in our long side suit, then start developing it.
 */
function declarerLeadDecision(ctx: Ctx): Decision | null {
  if (ctx.position !== 0) return null;
  const suits = bySuit(ctx.hand);
  const partnerHand = ctx.visible[ctx.partner];

  if (ctx.trump !== null) {
    const outstanding = outstandingIn(ctx, ctx.trump).length;
    let ourTrumps = 0;
    for (const card of ctx.ourVisible) if (suitOf(card) === ctx.trump) ourTrumps += 1;
    const mine = suits[ctx.trump];
    if (outstanding > 0 && ourTrumps > outstanding && mine.length > 0 && !hasCrossruffPlan(ctx)) {
      const top = mine[0];
      const card = isMaster(ctx, top) ? lowestEquivalent(ctx, top, mine) : top;
      return decision(card, 'drawing trumps while we hold the majority');
    }
  }

  // Finesse planning is an advanced-only refinement.
  if (ctx.level === 'advanced' && partnerHand !== undefined) {
    const finesse = finesseLead(ctx, suits, partnerHand);
    if (finesse !== null) return finesse;
  }

  const cash = cashMaster(ctx);
  if (cash !== null) return cash;

  // Nothing to cash: start on the side suit where the two hands are longest,
  // leading a low card up to whatever honours the other hand holds.
  let develop: Suit | null = null;
  let developLength = -1;
  for (const suit of SUITS) {
    if (ctx.trump !== null && suit === ctx.trump) continue;
    const mine = suits[suit];
    if (mine.length === 0) continue;
    const combined = mine.length + (partnerHand ?? []).filter((c) => suitOf(c) === suit).length;
    if (combined > developLength) {
      developLength = combined;
      develop = suit;
    }
  }
  if (develop !== null) {
    return decision(lowestCard(suits[develop]), 'leading low in our longest side suit to set it up');
  }
  return null;
}

/**
 * Do the two hands look like a crossruff - each short where the other is long,
 * so that the trumps are worth more taken separately than used to draw the
 * opponents'? If so, drawing trumps would throw the plan away.
 */
function hasCrossruffPlan(ctx: Ctx): boolean {
  if (ctx.trump === null) return false;
  const partnerHand = ctx.visible[ctx.partner];
  if (partnerHand === undefined) return false;
  const mine = bySuit(ctx.hand);
  const theirs = bySuit(partnerHand);
  let mineShort = false;
  let theirsShort = false;
  for (const suit of SUITS) {
    if (suit === ctx.trump) continue;
    if (mine[suit].length <= 1 && theirs[suit].length >= 3) mineShort = true;
    if (theirs[suit].length <= 1 && mine[suit].length >= 3) theirsShort = true;
  }
  return mineShort && theirsShort;
}

/**
 * Lead a low card towards an honour in the other hand. This is the whole point
 * of a finesse: with AQ opposite small cards you must lead from the small
 * cards, so that the hand holding the king has to commit before the queen does.
 */
function finesseLead(
  ctx: Ctx,
  suits: Record<Suit, Card[]>,
  partnerHand: readonly Card[],
): Decision | null {
  for (const suit of SUITS) {
    if (ctx.trump !== null && suit === ctx.trump) continue;
    const mine = suits[suit];
    if (mine.length === 0) continue;
    const theirs = holdingIn(partnerHand, suit);
    if (theirs.length === 0) continue;
    const low = lowestCard(mine);
    if (rankValue(low) >= QUEEN) continue; // nothing small enough to lead up

    const top = theirs[0];
    if (isMaster(ctx, top) && theirs.length >= 2) {
      const second = theirs[1];
      if (rankValue(second) >= HONOUR && gapsBetween(ctx, top, second) === 1) {
        return decision(low, `low towards the ${suit} tenace: finesse rather than cash the honours`);
      }
      continue;
    }
    if (rankValue(top) >= QUEEN && !isMaster(ctx, top)) {
      return decision(low, `low towards the ${suit} honour, so it wins if the missing card is onside`);
    }
  }
  return null;
}

/**
 * Cash a card that no outstanding card can beat, preferring the suit where our
 * side is longest. Ruffs are ignored: nobody can insure against them, and the
 * alternative is a bot that never cashes anything in a trump contract.
 */
function cashMaster(ctx: Ctx): Decision | null {
  const partnerHand = ctx.visible[ctx.partner] ?? [];
  const dummyHand = ctx.visible[ctx.dummy];
  let best: Card | null = null;
  let bestLength = -1;

  for (const card of ctx.legal) {
    const suit = suitOf(card);
    if (!isMaster(ctx, card)) continue;
    if (ctx.trump !== null && suit === ctx.trump && outstandingIn(ctx, ctx.trump).length > 0) {
      continue; // trump winners are handled by the draw-trumps rule
    }
    if (!ctx.declaring && ctx.trump !== null && dummyHand !== undefined) {
      const dummyVoid = !dummyHand.some((c) => suitOf(c) === suit);
      const dummyHasTrump = dummyHand.some((c) => suitOf(c) === ctx.trump);
      if (suit !== ctx.trump && dummyVoid && dummyHasTrump) continue; // it would be ruffed
    }
    const length =
      ctx.hand.filter((c) => suitOf(c) === suit).length +
      partnerHand.filter((c) => suitOf(c) === suit).length;
    if (length > bestLength) {
      bestLength = length;
      best = card;
    }
  }
  if (best === null) return null;
  const holding = holdingIn(ctx.hand, suitOf(best));
  return decision(lowestEquivalent(ctx, best, holding), 'cashing a winner, cheapest of equals');
}

/**
 * A defender on lead after trick one: cash what is certain, otherwise return
 * the suit partner opened, otherwise make the most passive lead available -
 * never a trump and never away from an ace.
 */
function defenderLeadDecision(ctx: Ctx): Decision | null {
  if (ctx.position !== 0) return null;
  const suits = bySuit(ctx.hand);

  const cash = cashMaster(ctx);
  if (cash !== null) return cash;

  // Returning partner's suit is the defence's default: it is the suit they
  // chose to attack, and continuing it keeps the defenders' communication.
  const firstTrick = ctx.play.tricks[0];
  if (firstTrick !== undefined && firstTrick.cards.length > 0) {
    const opened = firstTrick.cards[0];
    const suit = suitOf(opened.card);
    if (opened.seat === ctx.partner && suit !== ctx.trump && suits[suit].length > 0) {
      const card = leadCardFrom(suits[suit], ctx.trump !== null);
      if (card !== null) return decision(card, "returning partner's suit");
    }
  }

  let bestSeq: Card | null = null;
  for (const suit of SUITS) {
    if (suit === ctx.trump) continue;
    const top = sequenceTop(suits[suit]);
    if (top === null) continue;
    if (bestSeq === null || rankValue(top) > rankValue(bestSeq)) bestSeq = top;
  }
  if (bestSeq !== null) return decision(bestSeq, 'top of a sequence: a safe active lead');

  let safest: Card | null = null;
  let safestScore = Number.POSITIVE_INFINITY;
  for (const card of ctx.legal) {
    const suit = suitOf(card);
    const holding = suits[suit];
    let score = rankValue(card);
    if (ctx.trump !== null && suit === ctx.trump) score += 500;
    if (holding.some((c) => rankValue(c) === ACE) && card !== holding[0]) score += 300;
    if (isHonour(card)) score += 100;
    if (score < safestScore) {
      safestScore = score;
      safest = card;
    }
  }
  if (safest === null) return null;
  return decision(safest, 'passive lead: nothing to attack, so give nothing away');
}

// ---------------------------------------------------------------------------
// Following to a trick
// ---------------------------------------------------------------------------

/** Second hand: low, unless honours want splitting or the trick is free. */
function secondHandDecision(ctx: Ctx, followers: Card[]): Decision {
  const holding = sortDesc(followers);
  const ledCard = ctx.trickCards[0].card;
  const winners = followers.filter((c) => wouldWin(ctx, c)).sort((a, b) => rankValue(a) - rankValue(b));

  // "Cover an honour with an honour": the point is to promote partner's cards.
  if (isHonour(ledCard) && winners.length > 0) {
    const cheapest = cheapestEqualWinner(ctx, winners[0], holding);
    if (rankValue(cheapest) >= TEN) {
      return decision(cheapest, 'covering an honour with an honour');
    }
  }

  // Winning is only right in second seat when it costs nothing.
  if (winners.length > 0) {
    const cheapest = cheapestEqualWinner(ctx, winners[0], holding);
    const isCheapest = cheapest === holding[holding.length - 1];
    if (isSafeWinner(ctx, cheapest) && (isCheapest || rankValue(cheapest) <= TEN)) {
      return decision(cheapest, 'second hand can win cheaply, so it takes the trick');
    }
  }

  // Splitting equal honours makes declarer spend two cards to get one trick.
  if (rankValue(ledCard) < TEN && holding.length >= 2) {
    let blockEnd = 0;
    while (
      blockEnd + 1 < holding.length &&
      rankValue(holding[blockEnd + 1]) === rankValue(holding[blockEnd]) - 1
    ) {
      blockEnd += 1;
    }
    if (blockEnd >= 1 && rankValue(holding[0]) >= HONOUR) {
      return decision(holding[blockEnd], 'splitting touching honours');
    }
  }

  return decision(holding[holding.length - 1], 'second hand low');
}

/** Third hand: high, but only as high as it needs to be. */
function thirdHandDecision(ctx: Ctx, followers: Card[]): Decision {
  const holding = sortDesc(followers);
  const lowest = holding[holding.length - 1];

  if (ctx.partnerWinning && partnerCardIsSafe(ctx)) {
    return decision(lowest, "partner's card already wins the trick, so nothing is wasted on it");
  }

  const winners = followers.filter((c) => wouldWin(ctx, c));
  if (winners.length === 0) {
    return decision(lowest, 'we cannot beat the trick, so we keep everything of value');
  }
  const safe = winners.filter((c) => isSafeWinner(ctx, c)).sort((a, b) => rankValue(a) - rankValue(b));

  // "Third hand high" answers partner's SMALL card. When partner has already
  // put an honour on the trick, throwing a second honour after it just gives
  // declarer two tricks for one - so we only overtake with a certain winner
  // (which is the unblocking case) and otherwise keep our honour guarded.
  if (ctx.partnerWinning && ctx.bestCard !== null && isHonour(ctx.bestCard)) {
    if (safe.length > 0) {
      return decision(
        cheapestEqualWinner(ctx, safe[0], holding),
        "overtaking partner's honour, but only with a card that certainly wins",
      );
    }
    return decision(lowest, "partner led an honour: we keep ours guarded instead of crashing them");
  }

  if (safe.length > 0) {
    return decision(
      cheapestEqualWinner(ctx, safe[0], holding),
      'third hand high: the cheapest card that certainly wins',
    );
  }
  const highest = highestCard(winners);
  return decision(cheapestEqualWinner(ctx, highest, holding), 'third hand high');
}

/** Fourth hand: the trick is decided here, so win it as cheaply as possible. */
function fourthHandDecision(ctx: Ctx, followers: Card[]): Decision {
  const holding = sortDesc(followers);
  const lowest = holding[holding.length - 1];
  if (ctx.partnerWinning) {
    return decision(lowest, 'partner has the trick; keep the rest');
  }
  const winners = followers.filter((c) => wouldWin(ctx, c)).sort((a, b) => rankValue(a) - rankValue(b));
  if (winners.length === 0) {
    return decision(lowest, 'the trick is lost, so we throw the cheapest card of the suit');
  }
  return decision(cheapestEqualWinner(ctx, winners[0], holding), 'winning with the cheapest card that does it');
}

/**
 * Void in the suit led (Law 44 leaves us free to play anything): ruff when the
 * opponents are winning and we can beat what is on the table, but never ruff a
 * trick partner has already won - that spends a trump for nothing.
 */
function voidDecision(ctx: Ctx): Decision {
  if (ctx.partnerWinning) {
    return discardFrom(ctx, ctx.legal);
  }
  if (ctx.trump !== null) {
    const trumps = ctx.legal.filter((c) => suitOf(c) === ctx.trump);
    const winning = trumps.filter((c) => wouldWin(ctx, c)).sort((a, b) => rankValue(a) - rankValue(b));
    if (winning.length > 0) {
      const holding = sortDesc(trumps);
      const card = cheapestEqualWinner(ctx, winning[0], holding);
      const overruff = ctx.trickCards.some((pc) => suitOf(pc.card) === ctx.trump);
      return decision(card, overruff ? 'overruffing with the cheapest trump that wins' : 'ruffing with the cheapest trump');
    }
  }
  return discardFrom(ctx, ctx.legal);
}

/** Dispatches to the right seat-position rule once somebody has led. */
function followDecision(ctx: Ctx): Decision | null {
  if (ctx.position === 0 || ctx.led === null) return null;
  const followers = ctx.legal.filter((c) => suitOf(c) === ctx.led);
  if (followers.length === 0) return voidDecision(ctx);
  if (followers.length === 1) return decision(followers[0], 'the only card we may legally play');
  if (ctx.position === 1) return secondHandDecision(ctx, followers);
  if (ctx.position === 2) return thirdHandDecision(ctx, followers);
  return fourthHandDecision(ctx, followers);
}

// ---------------------------------------------------------------------------
// Endgame search
// ---------------------------------------------------------------------------

/**
 * The search's private, mutable working state.
 *
 * The engine proper is allocation-light on purpose and so is this: the search
 * plays a card by splicing it out of its OWN copy of the hands and puts it back
 * on the way out, rather than building a new position per node. Nothing here
 * ever escapes `endgameDecision`, so the module stays pure from the outside.
 */
interface SearchEnv {
  /** Nodes left in the budget; the search aborts when it hits zero. */
  nodes: number;
  hands: Hands;
  trick: PlayedCard[];
  ourSide: Side;
  trump: Strain;
  /**
   * Card index -> seat index of whoever still holds it, -1 when the card is
   * gone. Kept up to date by `playAndSolve` as it plays and unplays, so a node
   * never has to rebuild it.
   */
  owner: Int8Array;
}

/** One group of cards that are interchangeable in the current layout. */
interface EqualGroup {
  rep: Card;
  members: Card[];
}

/** Suit order used to index the search's 52-entry owner table. */
const SUIT_INDEX: Readonly<Record<Suit, number>> = { C: 0, D: 1, H: 2, S: 3 };
/** Seat order, matching `SEATS`, used as the values in the owner table. */
const SEAT_INDEX: Readonly<Record<Seat, number>> = { N: 0, E: 1, S: 2, W: 3 };

/** Dense 0..51 index of a card, for the owner table. */
function cardIndex(card: Card): number {
  return SUIT_INDEX[suitOf(card)] * 13 + (rankValue(card) - 2);
}

/**
 * Reduces a set of playable cards to one representative per run of touching
 * cards, counting only the cards still held by somebody as separators. Two
 * cards with nothing live between them win exactly the same tricks, so the
 * search only needs to try the cheaper one.
 */
function equalGroups(cards: readonly Card[], live: ReadonlySet<Card>): EqualGroup[] {
  const groups: EqualGroup[] = [];
  for (const suit of SUITS) {
    const holding = sortDesc(cards.filter((c) => suitOf(c) === suit));
    let current: Card[] = [];
    for (let i = 0; i < holding.length; i++) {
      if (current.length === 0) {
        current = [holding[i]];
        continue;
      }
      const previous = current[current.length - 1];
      let touching = true;
      for (let rank = rankValue(holding[i]) + 1; rank < rankValue(previous); rank++) {
        if (live.has(makeCard(suit, RANK_CHARS[rank - 2]))) {
          touching = false;
          break;
        }
      }
      if (touching) current.push(holding[i]);
      else {
        groups.push({ rep: current[current.length - 1], members: current });
        current = [holding[i]];
      }
    }
    if (current.length > 0) groups.push({ rep: current[current.length - 1], members: current });
  }
  return groups;
}

/** Every card still in somebody's hand. */
function liveCards(hands: Hands): Set<Card> {
  const live = new Set<Card>();
  for (const seat of SEATS) for (const card of hands[seat]) live.add(card);
  return live;
}

/**
 * The cards a seat may legally play (Law 44 again - follow suit if you can),
 * reduced to one representative per run of touching cards. Reads the owner
 * table rather than rebuilding anything, so a node costs a handful of array
 * lookups and one allocation for the result.
 */
function searchMoves(env: SearchEnv, seat: Seat): Card[] {
  const hand = env.hands[seat];
  if (hand.length === 0) return [];

  let playable: Card[] = hand;
  if (env.trick.length > 0) {
    const led = suitOf(env.trick[0].card);
    const followers: Card[] = [];
    for (const card of hand) if (suitOf(card) === led) followers.push(card);
    if (followers.length > 0) playable = followers;
  }
  if (playable.length === 1) return [playable[0]];

  const mine = SEAT_INDEX[seat];
  const moves: Card[] = [];
  for (const card of playable) {
    // Drop the card when the next live card below it in the suit is also ours:
    // the two win exactly the same tricks, so only the cheaper one is tried.
    const base = cardIndex(card);
    const floor = base - (rankValue(card) - 2); // the deuce of the same suit
    let redundant = false;
    for (let index = base - 1; index >= floor; index--) {
      const holder = env.owner[index];
      if (holder < 0) continue;
      redundant = holder === mine;
      break;
    }
    if (!redundant) moves.push(card);
  }
  return moves.length > 0 ? moves : [playable[0]];
}

/**
 * Exhaustive alpha-beta over the remaining tricks, returning how many of them
 * our side takes with best play by everybody. Both partnerships are treated as
 * a single player, which is what makes this a plain two-player zero-sum search.
 */
function solve(env: SearchEnv, toPlay: Seat, leader: Seat, alphaIn: number, betaIn: number): number {
  if (env.nodes <= 0) throw BUDGET_EXHAUSTED;
  env.nodes -= 1;

  const moves = searchMoves(env, toPlay);
  if (moves.length === 0) return 0;

  const maximising = sideOf(toPlay) === env.ourSide;
  let alpha = alphaIn;
  let beta = betaIn;
  let best = maximising ? -1 : 99;

  for (const card of moves) {
    const value = playAndSolve(env, toPlay, leader, card, alpha, beta);
    if (maximising) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break;
  }
  return best;
}

/**
 * Plays one card into the working position, recurses, and undoes the move
 * exactly. The card goes back at the index it came from, so the hands are
 * bit-for-bit what they were before the call.
 */
function playAndSolve(
  env: SearchEnv,
  seat: Seat,
  leader: Seat,
  card: Card,
  alpha: number,
  beta: number,
): number {
  const hand = env.hands[seat];
  const at = hand.indexOf(card);
  if (at < 0) return 0;
  const index = cardIndex(card);
  hand.splice(at, 1);
  env.owner[index] = -1;
  env.trick.push({ seat, card });

  let value: number;
  if (env.trick.length === 4) {
    const winner = trickWinner({ leader, cards: env.trick }, env.trump);
    const gain = sideOf(winner) === env.ourSide ? 1 : 0;
    const finished = env.trick;
    env.trick = [];
    // The window shifts by the trick just banked, because the child answers
    // "tricks from here on" while this node answers "gain + that".
    value = gain + solve(env, winner, winner, alpha - gain, beta - gain);
    env.trick = finished;
  } else {
    value = solve(env, nextSeat(seat), leader, alpha, beta);
  }

  env.trick.pop();
  env.owner[index] = SEAT_INDEX[seat];
  hand.splice(at, 0, card);
  return value;
}

/**
 * Invents a full layout for the cards we cannot see, giving the highest of them
 * to the opponents: the search then answers "what still works even if the cards
 * lie as badly as they can", which is the right question for a robot that must
 * never claim knowledge it does not have. Returns null when the deal does not
 * add up (bad `known` data), so the caller falls back to the heuristics.
 */
function determinize(ctx: Ctx): Hands | null {
  const hands: Hands = { N: [], E: [], S: [], W: [] };
  hands[ctx.seat] = [...ctx.hand];
  const hidden: Seat[] = [];
  for (const seat of SEATS) {
    if (seat === ctx.seat) continue;
    const cards = ctx.visible[seat];
    if (cards !== undefined) hands[seat] = [...cards];
    else hidden.push(seat);
  }
  if (hidden.length === 0) return hands;

  const opponents = hidden.filter((s) => sideOf(s) !== ctx.ourSide);
  const partners = hidden.filter((s) => sideOf(s) === ctx.ourSide);
  const needed = hidden.reduce((sum, s) => sum + ctx.remaining[s], 0);
  const pool = [...ctx.unseen].sort((a, b) => {
    const byRank = rankValue(b) - rankValue(a);
    return byRank !== 0 ? byRank : SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b));
  });
  if (needed !== pool.length) return null;

  let index = 0;
  // Opponents first and round robin, so both of them end up strong.
  let progress = true;
  while (index < pool.length && progress) {
    progress = false;
    for (const seat of opponents) {
      if (hands[seat].length >= ctx.remaining[seat] || index >= pool.length) continue;
      hands[seat].push(pool[index]);
      index += 1;
      progress = true;
    }
  }
  for (const seat of partners) {
    while (hands[seat].length < ctx.remaining[seat] && index < pool.length) {
      hands[seat].push(pool[index]);
      index += 1;
    }
  }
  if (index !== pool.length) return null;
  return hands;
}

/** What the endgame search found. */
interface EndgameResult {
  card: Card;
  /** Tricks our side takes from here with this card, worst case. */
  tricks: number;
  /** Tricks still to be played. */
  tricksLeft: number;
  /** False when `card` is the yardstick card the caller passed in. */
  improved: boolean;
}

/**
 * Solves the four-card ending against the invented worst-case layout.
 *
 * `yardstick` is the card the caller would otherwise play: it is searched first
 * with a full window to get its exact value, and every other candidate is then
 * searched with the window opened only above that score - a card that cannot
 * beat the yardstick is of no interest, and cutting it off early is what keeps
 * the root to a single full-width search.
 *
 * Returns null when the search does not apply (not advanced, more than four
 * cards left, or `known` does not add up) or when it would exceed its node
 * budget, in which case the caller keeps its heuristic choice.
 */
function endgameBest(ctx: Ctx, yardstick: Card): EndgameResult | null {
  if (ctx.level !== 'advanced') return null;
  let tricksLeft = 0;
  for (const seat of SEATS) tricksLeft = Math.max(tricksLeft, ctx.remaining[seat]);
  if (tricksLeft === 0 || tricksLeft > ENDGAME_MAX_CARDS) return null;

  const layout = determinize(ctx);
  if (layout === null) return null;

  const groups = equalGroups(ctx.legal, liveCards(layout));
  if (groups.length === 0) return null;
  const representativeOf = new Map<Card, Card>();
  for (const group of groups) {
    for (const member of group.members) representativeOf.set(member, group.rep);
  }

  const owner = new Int8Array(52).fill(-1);
  for (const seat of SEATS) for (const card of layout[seat]) owner[cardIndex(card)] = SEAT_INDEX[seat];
  const env: SearchEnv = {
    nodes: ENDGAME_NODE_BUDGET,
    hands: layout,
    trick: [...ctx.trickCards],
    ourSide: ctx.ourSide,
    trump: ctx.strain,
    owner,
  };

  const baseline = representativeOf.get(yardstick) ?? groups[0].rep;
  let bestCard = baseline;
  let bestValue: number;
  try {
    bestValue = playAndSolve(env, ctx.seat, ctx.leader, baseline, -1, 99);
    for (const group of groups) {
      const card = group.rep;
      if (card === baseline) continue;
      const value = playAndSolve(env, ctx.seat, ctx.leader, card, bestValue, 99);
      if (value > bestValue) {
        bestValue = value;
        bestCard = card;
      }
    }
  } catch (error) {
    if (error !== BUDGET_EXHAUSTED) throw error;
    return null;
  }
  return { card: bestCard, tricks: bestValue, tricksLeft, improved: bestCard !== baseline };
}

/**
 * Refines an already-chosen card once every hand is down to four cards or
 * fewer, overriding the heuristic only when the search finds a strictly better
 * card. When the heuristic was already optimal this returns null so that the
 * player is shown the bridge reason rather than a bare search score.
 */
function endgameDecision(ctx: Ctx, heuristic: Decision): Decision | null {
  const result = endgameBest(ctx, heuristic.card);
  if (result === null || !result.improved) return null;
  return decision(
    result.card,
    `endgame search: this takes ${result.tricks} of the last ${result.tricksLeft} tricks even in the worst layout`,
  );
}

// ---------------------------------------------------------------------------
// Levels and dispatch
// ---------------------------------------------------------------------------

/**
 * The beginner: follows suit, takes a trick when a cheap card takes it, and is
 * otherwise happy to throw a low card. The choice between the two lowest cards
 * is made by hashing the position, which gives the human opponent some variety
 * without introducing any real randomness into the engine.
 */
function beginnerDecision(ctx: Ctx): Decision {
  if (ctx.position > 0 && !ctx.partnerWinning) {
    const winners = ctx.legal.filter((c) => wouldWin(ctx, c)).sort((a, b) => rankValue(a) - rankValue(b));
    if (winners.length > 0) {
      return decision(winners[0], 'wins the trick with the cheapest card that does it');
    }
  }
  const sorted = [...ctx.legal].sort((a, b) => {
    const byRank = rankValue(a) - rankValue(b);
    return byRank !== 0 ? byRank : SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b));
  });
  const pick = sorted[positionHash(ctx) % Math.min(2, sorted.length)];
  return decision(pick, 'plays a low card');
}

/** Runs the full heuristic ladder for an intermediate or advanced robot. */
function heuristicDecision(ctx: Ctx): Decision {
  if (ctx.position === 0) {
    const lead =
      (ctx.isOpeningLead && !ctx.declaring ? openingLeadDecision(ctx) : null) ??
      (ctx.declaring ? declarerLeadDecision(ctx) : defenderLeadDecision(ctx)) ??
      openingLeadDecision(ctx);
    if (lead !== null) return lead;
    return decision(lowestCard(ctx.legal), 'no plan available, so we lead a low card');
  }
  const follow = followDecision(ctx);
  if (follow !== null) return follow;
  return decision(lowestCard(ctx.legal), 'no plan available, so we play a low card');
}

/** The whole decision, including the endgame refinement. Never throws. */
function decide(args: ChooseCardArgs): Decision {
  const ctx = buildContext(args);
  if (ctx.legal.length === 1) return decision(ctx.legal[0], 'the only legal card');
  if (ctx.level === 'beginner') return beginnerDecision(ctx);
  const heuristic = heuristicDecision(ctx);
  const refined = endgameDecision(ctx, heuristic);
  return refined ?? heuristic;
}

/**
 * `decide` behind a safety net. A robot that throws would take the whole table
 * down with it, so any failure - and any heuristic that somehow produced a card
 * outside the legal set - degrades to the first legal card.
 */
function decideSafe(args: ChooseCardArgs): Decision {
  let legal: Card[];
  try {
    legal = safeLegalCards(args);
  } catch {
    legal = [...args.hand];
  }
  const fallback: Card | null =
    legal.length > 0 ? legal[0] : args.hand.length > 0 ? args.hand[0] : null;
  if (fallback === null) {
    throw new Error('chooseCard: the hand is empty, so there is no card to play');
  }
  try {
    const chosen = decide(args);
    if (legal.length === 0 || legal.includes(chosen.card)) return chosen;
    return decision(fallback, 'fallback: the heuristics produced no legal card');
  } catch {
    return decision(fallback, 'fallback: the first legal card');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Picks the card this seat plays. The result is ALWAYS a member of
 * `legalCards(hand, play)`, so the follow-suit obligation of Law 44 can never
 * be broken by a robot, and the function is a pure function of its arguments:
 * the same position always yields the same card.
 */
export function chooseCard(args: ChooseCardArgs): Card {
  return decideSafe(args).card;
}

/**
 * The one-line reason for the card `chooseCard` would pick from the very same
 * position - for the post-mortem, the "why did the robot do that?" tooltip and
 * for tests that want to assert on the rule rather than the card.
 */
export function explainCard(args: ChooseCardArgs): string {
  return decideSafe(args).why;
}

/**
 * The opening lead only (Law 41A: declarer's left-hand opponent leads to trick
 * one). Returns null when the position is not an opening lead or when no
 * leading rule fits.
 */
export function chooseOpeningLead(args: ChooseCardArgs): Card | null {
  const ctx = buildContext(args);
  if (!ctx.isOpeningLead) return null;
  return openingLeadDecision(ctx)?.card ?? null;
}

/**
 * The card to play to a trick somebody else led: second hand low, third hand
 * high, fourth hand cheapest winner, and ruff or discard when void. Returns
 * null when this seat is on lead.
 */
export function chooseFollow(args: ChooseCardArgs): Card | null {
  const ctx = buildContext(args);
  return followDecision(ctx)?.card ?? null;
}

/**
 * The least valuable card to throw away. Returns null unless this seat is void
 * in the suit led and therefore actually discarding (Law 44 permits any card
 * once you cannot follow suit).
 */
export function chooseDiscard(args: ChooseCardArgs): Card | null {
  const ctx = buildContext(args);
  if (ctx.position === 0 || ctx.led === null) return null;
  if (ctx.legal.some((c) => suitOf(c) === ctx.led)) return null;
  return discardFrom(ctx, ctx.legal).card;
}

/**
 * Declarer's plan when the declaring side is on lead: draw trumps, finesse,
 * cash winners, develop the long suit. Returns null for any other position.
 */
export function chooseDeclarerPlay(args: ChooseCardArgs): Card | null {
  const ctx = buildContext(args);
  if (!ctx.declaring || ctx.position !== 0) return null;
  return declarerLeadDecision(ctx)?.card ?? null;
}

/**
 * The exhaustive four-card endgame. Returns the card that maximises our tricks
 * against the worst layout of the hidden hands, or null when the position still
 * has more than four cards per hand, the visible cards do not add up, or the
 * search would exceed its node budget.
 */
export function endgameSearch(args: ChooseCardArgs): Card | null {
  const ctx = buildContext(args);
  if (ctx.legal.length === 0) return null;
  return endgameBest(ctx, ctx.legal[0])?.card ?? null;
}
