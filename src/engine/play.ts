/**
 * The card-play phase: who leads, which cards are legal, who wins a trick,
 * how a trick count grows, who is allowed to see which hand, and claims.
 *
 * Everything here is pure: no input is mutated, nothing is read from the
 * clock or the network, and every function returns brand-new state. The
 * caller (the Durable Object) is responsible for persistence and for phase
 * transitions; this module only knows the Laws.
 */

import type {
  ActionError,
  ActionResult,
  Card,
  Contract,
  Hands,
  PlayState,
  PlayedCard,
  RankChar,
  RankValue,
  Seat,
  Side,
  Strain,
  Suit,
  Trick,
} from './types';
import { RANK_CHARS, SEATS, SUITS } from './types';

/** Number of tricks in a bridge board: 13 cards each, four hands. */
const TRICKS_PER_BOARD = 13;

// ---------------------------------------------------------------------------
// Internal helpers (not exported: card primitives live with the card module)
// ---------------------------------------------------------------------------

/** The suit character of a card token, e.g. "HT" -> "H". */
function suitOf(card: Card): Suit {
  return card.charAt(0) as Suit;
}

/** Numeric rank of a card token, 2..14 (J=11, Q=12, K=13, A=14). */
function rankValue(card: Card): RankValue {
  const index = RANK_CHARS.indexOf(card.charAt(1) as RankChar);
  if (index < 0) throw new Error(`rankValue: "${card}" is not a card token`);
  return index + 2;
}

/** Runtime guard for data that crossed the wire already cast to `Card`. */
function isCardToken(value: string): boolean {
  return (
    value.length === 2 &&
    (SUITS as readonly string[]).includes(value.charAt(0)) &&
    (RANK_CHARS as readonly string[]).includes(value.charAt(1))
  );
}

/** The next seat clockwise, which is also the next seat to play. */
function nextSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 1) % SEATS.length];
}

/** The partnership a seat belongs to. */
function sideOf(seat: Seat): Side {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

/** Shallow-copies every hand so the caller's `Hands` is never touched. */
function cloneHands(hands: Hands): Hands {
  return { N: [...hands.N], E: [...hands.E], S: [...hands.S], W: [...hands.W] };
}

function fail<T>(code: ActionError['code'], message: string): ActionResult<T> {
  return { ok: false, error: { code, message } };
}

/** Tricks that have actually been quitted (four cards played). */
function completedTrickCount(play: PlayState): number {
  let n = 0;
  for (const trick of play.tricks) if (trick.cards.length === 4) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * The seat that makes the opening lead: the defender on declarer's left.
 *
 * Law 41A (Opening Lead): the player to declarer's left leads to trick one,
 * before dummy's hand is faced.
 */
export function openingLeader(declarer: Seat): Seat {
  return nextSeat(declarer);
}

/** Declarer's partner, i.e. the seat that becomes dummy for this contract. */
export function dummySeat(declarer: Seat): Seat {
  return SEATS[(SEATS.indexOf(declarer) + 2) % SEATS.length];
}

/**
 * Who physically plays a seat's cards.
 *
 * Law 45F / Law 43: dummy takes no part in the play - declarer names and
 * plays every card from dummy's hand - so dummy's seat is controlled by
 * declarer. Every other seat controls itself.
 */
export function controllerOf(seat: Seat, contract: Contract): Seat {
  return seat === dummySeat(contract.declarer) ? contract.declarer : seat;
}

// ---------------------------------------------------------------------------
// Starting and inspecting the play
// ---------------------------------------------------------------------------

/**
 * Builds the initial play state for a contract: one empty trick led by the
 * opening leader, no tricks won yet, dummy still concealed.
 *
 * Law 41B/41D: dummy's hand is spread only after the opening lead is faced,
 * so `dummyRevealed` starts false and flips on the first card played.
 */
export function startPlay(contract: Contract): PlayState {
  const leader = openingLeader(contract.declarer);
  return {
    tricks: [{ leader, cards: [] }],
    turn: leader,
    dummyRevealed: false,
    tricksNS: 0,
    tricksEW: 0,
    claim: null,
  };
}

/**
 * The trick currently being played - the last element of `play.tricks`.
 * Once the board is over this is the thirteenth (completed) trick.
 *
 * Throws if the state has no tricks at all, which can only happen if a
 * `PlayState` was built by something other than `startPlay`.
 */
export function currentTrick(play: PlayState): Trick {
  if (play.tricks.length === 0) {
    throw new Error('currentTrick: PlayState has no tricks; build it with startPlay()');
  }
  return play.tricks[play.tricks.length - 1];
}

/** True once all thirteen tricks of the board have been decided. */
export function isPlayComplete(play: PlayState): boolean {
  return (
    completedTrickCount(play) >= TRICKS_PER_BOARD ||
    play.tricksNS + play.tricksEW >= TRICKS_PER_BOARD
  );
}

/** Tricks won so far by one partnership. */
export function tricksTaken(play: PlayState, side: Side): number {
  return side === 'NS' ? play.tricksNS : play.tricksEW;
}

/** A copy of the cards a seat still holds. */
export function remainingCards(hands: Hands, seat: Seat): Card[] {
  return [...hands[seat]];
}

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

/**
 * The cards from `hand` that may legally be played to the current trick.
 *
 * Law 44 (Obligation to Follow Suit): a player must follow to the suit led
 * if he holds a card of that suit; only when void may he play any card.
 * The leader to a trick may lead anything.
 *
 * Returns a new array; order follows the order of `hand`.
 */
export function legalCards(hand: Card[], play: PlayState): Card[] {
  const trick = currentTrick(play);
  // Board over (or a malformed, over-full trick): nothing is playable.
  if (trick.cards.length >= 4) return [];
  if (trick.cards.length === 0) return [...hand];
  const led = suitOf(trick.cards[0].card);
  const followers = hand.filter((card) => suitOf(card) === led);
  return followers.length > 0 ? followers : [...hand];
}

/**
 * Whether a specific card may be played to the current trick.
 * Checks the follow-suit obligation and that the card is actually held;
 * it does NOT check whose turn it is - `playCard` does that.
 */
export function isLegalPlay(hand: Card[], play: PlayState, card: Card): boolean {
  return legalCards(hand, play).includes(card);
}

// ---------------------------------------------------------------------------
// Resolving tricks
// ---------------------------------------------------------------------------

/**
 * The seat that wins a trick.
 *
 * Law 44 (Winner of the Trick): a trick containing a trump is won by the
 * highest trump played to it; otherwise it is won by the highest card of the
 * suit led. Cards of any other suit are discards and can never win, which is
 * why ruffing beats even the ace of the suit led.
 *
 * `trump` is the contract strain; 'N' (no-trump) means no card is a trump.
 * Evaluates the cards actually present, so it also answers "who is winning"
 * for a part-played trick. Throws on an empty trick.
 */
export function trickWinner(trick: Trick, trump: Strain): Seat {
  if (trick.cards.length === 0) {
    throw new Error('trickWinner: the trick has no cards');
  }
  const led = suitOf(trick.cards[0].card);
  const trumpSuit: Suit | null = trump === 'N' ? null : trump;
  const trumped = trumpSuit !== null && trick.cards.some((pc) => suitOf(pc.card) === trumpSuit);
  const deciding: Suit = trumped && trumpSuit !== null ? trumpSuit : led;

  let bestSeat: Seat | null = null;
  let bestRank = -1;
  for (const played of trick.cards) {
    if (suitOf(played.card) !== deciding) continue;
    const rank = rankValue(played.card);
    if (rank > bestRank) {
      bestRank = rank;
      bestSeat = played.seat;
    }
  }
  // Unreachable: the led suit is present by construction, and the trump suit
  // is only chosen as `deciding` when some card of it was played.
  if (bestSeat === null) throw new Error('trickWinner: no card of the deciding suit');
  return bestSeat;
}

// ---------------------------------------------------------------------------
// Playing a card
// ---------------------------------------------------------------------------

/**
 * Plays one card and returns brand-new state: the next `PlayState`, the next
 * `Hands` (with the card removed from `seat`), and the trick that was just
 * completed, if any.
 *
 * `seat` is the seat that OWNS the card, which for dummy's cards is dummy and
 * not declarer (Law 45F - declarer plays them, but they leave dummy's hand);
 * use `controllerOf` at the transport layer to decide who is allowed to send
 * the action.
 *
 * Validates: the play is still running, it is `seat`'s turn, `seat` holds the
 * card, and the follow-suit obligation of Law 44. On the fourth card the trick
 * is resolved, the winning side's trick count goes up and - unless all
 * thirteen tricks are in - a fresh trick is opened for the winner to lead
 * (Law 44, Lead to the Next Trick). Dummy is revealed as soon as the opening
 * lead is out (Law 41).
 */
export function playCard(
  play: PlayState,
  hands: Hands,
  seat: Seat,
  card: Card,
  trump: Strain,
): ActionResult<{ play: PlayState; hands: Hands; trickCompleted: Trick | null }> {
  if (play.tricks.length === 0) {
    return fail('WRONG_PHASE', 'The play has not started yet.');
  }
  if (isPlayComplete(play)) {
    return fail('WRONG_PHASE', 'The play is over: all 13 tricks have been decided.');
  }
  const trick = currentTrick(play);
  if (trick.cards.length >= 4) {
    return fail('WRONG_PHASE', 'The current trick is already complete.');
  }
  if (!isCardToken(card)) {
    return fail('ILLEGAL_CARD', `"${card}" is not a card.`);
  }
  if (seat !== play.turn) {
    return fail('NOT_YOUR_TURN', `It is ${play.turn} to play, not ${seat}.`);
  }

  const hand = hands[seat];
  const cardIndex = hand.indexOf(card);
  if (cardIndex < 0) {
    return fail('NOT_YOUR_CARD', `${seat} does not hold ${card}.`);
  }
  if (!isLegalPlay(hand, play, card)) {
    // Only reachable with at least one card already on the trick.
    const led = suitOf(trick.cards[0].card);
    return fail('MUST_FOLLOW_SUIT', `${seat} still holds ${led} and must follow suit.`);
  }

  const nextHands = cloneHands(hands);
  nextHands[seat] = [...hand.slice(0, cardIndex), ...hand.slice(cardIndex + 1)];

  const played: PlayedCard = { seat, card };
  const earlierTricks = play.tricks.slice(0, play.tricks.length - 1);
  const cards: PlayedCard[] = [...trick.cards, played];

  if (cards.length < 4) {
    const nextPlay: PlayState = {
      tricks: [...earlierTricks, { leader: trick.leader, cards }],
      turn: nextSeat(seat),
      dummyRevealed: true,
      tricksNS: play.tricksNS,
      tricksEW: play.tricksEW,
      claim: play.claim,
    };
    return { ok: true, value: { play: nextPlay, hands: nextHands, trickCompleted: null } };
  }

  const winner = trickWinner({ leader: trick.leader, cards }, trump);
  const completed: Trick = { leader: trick.leader, cards, winner };
  const winnerSide = sideOf(winner);
  const playedTricks = [...earlierTricks, completed];
  const boardOver = playedTricks.length >= TRICKS_PER_BOARD;

  const nextPlay: PlayState = {
    // The last trick of the board stays as the final element; otherwise the
    // winner of the trick leads to the next one.
    tricks: boardOver ? playedTricks : [...playedTricks, { leader: winner, cards: [] }],
    turn: winner,
    dummyRevealed: true,
    tricksNS: play.tricksNS + (winnerSide === 'NS' ? 1 : 0),
    tricksEW: play.tricksEW + (winnerSide === 'EW' ? 1 : 0),
    claim: play.claim,
  };
  return { ok: true, value: { play: nextPlay, hands: nextHands, trickCompleted: completed } };
}

// ---------------------------------------------------------------------------
// Visibility (used to redact state per recipient)
// ---------------------------------------------------------------------------

/**
 * Whether `viewer` may see `owner`'s cards. Used to redact every broadcast.
 *
 * You always see your own hand. Dummy's hand becomes public - to opponents,
 * to declarer and to spectators alike - only once the opening lead has been
 * faced (Law 41D, dummy spread after the opening lead); before that even
 * declarer must not see it. `viewer === null` is a spectator, who therefore
 * sees dummy and nothing else. Everything else stays hidden.
 */
export function canSeeHand(
  viewer: Seat | null,
  owner: Seat,
  play: PlayState | null,
  contract: Contract | null,
): boolean {
  if (viewer !== null && viewer === owner) return true;
  if (contract === null || play === null) return false;
  if (owner !== dummySeat(contract.declarer)) return false;
  return play.dummyRevealed;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Checks that a claim is arithmetically possible.
 *
 * Law 68A: a claim is a statement by DECLARER OR A DEFENDER that his side
 * will win a stated number of tricks - dummy takes no part in the play
 * (Law 43) and may not claim. The number claimed is the side's total for the
 * whole board, so it can never be fewer than the tricks that side has already
 * quitted, nor more than those plus every trick still undecided.
 */
export function validateClaim(
  play: PlayState,
  contract: Contract,
  seat: Seat,
  tricks: number,
): ActionResult<true> {
  if (seat === dummySeat(contract.declarer)) {
    return fail('BAD_CLAIM', 'Dummy may not claim; only declarer or a defender can (Law 68A).');
  }
  if (!Number.isInteger(tricks)) {
    return fail('BAD_CLAIM', `A claim must be a whole number of tricks, got ${tricks}.`);
  }
  const side = sideOf(seat);
  const alreadyWon = tricksTaken(play, side);
  const undecided = Math.max(0, TRICKS_PER_BOARD - (play.tricksNS + play.tricksEW));
  const maximum = alreadyWon + undecided;
  if (tricks < alreadyWon || tricks > maximum) {
    return fail(
      'BAD_CLAIM',
      `${side} can only claim between ${alreadyWon} and ${maximum} tricks, not ${tricks}.`,
    );
  }
  return { ok: true, value: true };
}

/**
 * Fast-forwards the board as if the claim had been agreed by everyone:
 * the claiming side is credited with `claimedTricks` and the opponents with
 * the rest (Law 69A - an agreed claim stands and play ceases).
 *
 * The trick history is left exactly as it was, because the remaining cards
 * were never actually played; `isPlayComplete` reports true from the trick
 * counts alone. `contract` is accepted for symmetry with `validateClaim` and
 * to keep the call site self-documenting. Returns a new state; the input is
 * untouched.
 */
export function applyClaim(
  play: PlayState,
  contract: Contract,
  claimerSide: Side,
  claimedTricks: number,
): PlayState {
  void contract;
  const claimed = Math.min(TRICKS_PER_BOARD, Math.max(0, Math.trunc(claimedTricks)));
  const tricksNS = claimerSide === 'NS' ? claimed : TRICKS_PER_BOARD - claimed;
  return {
    tricks: [...play.tricks],
    turn: play.turn,
    dummyRevealed: play.dummyRevealed,
    tricksNS,
    tricksEW: TRICKS_PER_BOARD - tricksNS,
    claim: play.claim,
  };
}
