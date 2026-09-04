/**
 * The authoritative game state machine.
 *
 * This is the ONLY module the Durable Object talks to. It owns the phase
 * transitions (lobby -> auction -> play -> review) and delegates every rule of
 * bridge to the specialist modules: `deal` for board metadata, `auction` for
 * legality of calls and for the declarer rule, `play` for the follow-suit
 * obligation, trick resolution and claims, and `scoring` for Law 77.
 *
 * PURITY: every function here is a pure function of its arguments. Nothing is
 * mutated (inputs included), there is no clock, no ambient randomness and no
 * I/O; the only source of randomness is the caller-supplied `seed` string,
 * which `deal` turns into a deterministic shuffle. That is what makes
 * `replay(state.history)` reproduce a game exactly, which is in turn what makes
 * undo, crash recovery and bug reports work.
 *
 * SERIALISABILITY: `GameState` is plain JSON - objects, arrays, strings,
 * numbers, booleans and null. No Map, Set, class instance or Date, so the
 * Durable Object can persist it and the protocol can ship it verbatim.
 *
 * ERRORS: `applyAction` never throws. Bad input - wrong phase, wrong turn, a
 * card the player does not hold, a nonsense token off the wire - comes back as
 * `{ ok: false, error }` with a code from `ActionError`.
 */

import type {
  ActionError,
  ActionResult,
  Board,
  Call,
  Card,
  ClaimState,
  Contract,
  GameAction,
  Phase,
  PlayState,
  ScoreLine,
  Seat,
} from './types';
import { dealBoard, nextSeat, seatsInOrderFrom, sideOf } from './deal';
import {
  deriveContract,
  isAuctionClosed,
  isLegalCall,
  isPassedOut,
  legalCalls,
  seatToCall,
} from './auction';
import {
  applyClaim,
  dummySeat,
  isPlayComplete,
  legalCards,
  playCard,
  startPlay,
  validateClaim,
} from './play';
import { scoreBoard, scoreLineFromBoard } from './scoring';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Everything the engine knows about a table. Fully serialisable with
 * `JSON.stringify`, and fully reconstructible from `history` alone.
 */
export interface GameState {
  phase: Phase;
  board: Board | null;
  boardsPlayed: ScoreLine[];
  /** Every action applied, in order - the undo log. */
  history: GameAction[];
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function fail<T>(code: ActionError['code'], message: string): ActionResult<T> {
  return { ok: false, error: { code, message } };
}

/** Runtime guard for a seat token that arrived over the wire already cast. */
function isSeat(value: unknown): value is Seat {
  return value === 'N' || value === 'E' || value === 'S' || value === 'W';
}

/** A fresh, empty legal-action set. New object each time, so callers may keep it. */
function noActions(): { calls: Call[]; cards: Card[] } {
  return { calls: [], cards: [] };
}

/**
 * Builds the successor state and appends `action` to the log.
 *
 * The history is copied rather than pushed to, which is what keeps
 * `applyAction` pure: the caller's previous state stays valid and is still a
 * correct snapshot of the game at that point.
 */
function withAction(
  state: GameState,
  action: GameAction,
  patch: { phase: Phase; board: Board | null; boardsPlayed?: ScoreLine[] },
): GameState {
  return {
    phase: patch.phase,
    board: patch.board,
    boardsPlayed: patch.boardsPlayed ?? state.boardsPlayed,
    history: [...state.history, action],
  };
}

/**
 * Freezes a finished board: computes its `BoardResult` and the scoreboard row.
 * Returns a new `Board`; the input is untouched.
 */
function settleBoard(board: Board): { board: Board; line: ScoreLine } {
  const settled: Board = { ...board, result: scoreBoard(board) };
  return { board: settled, line: scoreLineFromBoard(settled) };
}

/** Board number to deal next: one past the board on the table, else one past the log. */
function nextBoardNumber(state: GameState): number {
  if (state.board !== null) return state.board.boardNumber + 1;
  return state.boardsPlayed.length + 1;
}

/**
 * Ends the board on an agreed claim (Law 69A: an acquiesced claim stands and
 * play ceases). The claimed tricks are credited to the claimer's side and the
 * rest to their opponents; the cards that were never played simply stay in the
 * hands, because they were never played.
 */
function finishWithClaim(
  state: GameState,
  action: GameAction,
  board: Board,
  contract: Contract,
  play: PlayState,
  agreed: ClaimState,
): ActionResult<GameState> {
  const settledPlay = applyClaim(
    { ...play, claim: agreed },
    contract,
    sideOf(agreed.by),
    agreed.tricks,
  );
  const { board: settled, line } = settleBoard({ ...board, play: settledPlay });
  return {
    ok: true,
    value: withAction(state, action, {
      phase: 'review',
      board: settled,
      boardsPlayed: [...state.boardsPlayed, line],
    }),
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A brand-new table: nobody has dealt yet, no boards played, empty undo log. */
export function newGame(): GameState {
  return { phase: 'lobby', board: null, boardsPlayed: [], history: [] };
}

/**
 * Deals a specific board number with a specific seed and opens the auction.
 *
 * A convenience wrapper around the `deal` action, for the Durable Object's
 * "start the match" path. Because it returns a plain `GameState` it cannot
 * report an error: if a deal is not legal right now (a board is already in the
 * auction or being played) the state comes back unchanged. Call `applyAction`
 * with a `deal` action directly when you need to know why.
 */
export function startBoard(state: GameState, boardNumber: number, seed: string): GameState {
  const result = applyAction(state, { kind: 'deal', boardNumber, seed });
  return result.ok ? result.value : state;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Deals a fresh board and opens the auction. Legal only between boards, so
 * that a live auction or play can never be silently thrown away.
 */
function handleDeal(
  state: GameState,
  action: GameAction & { kind: 'deal' },
): ActionResult<GameState> {
  if (state.phase !== 'lobby' && state.phase !== 'review') {
    return fail('WRONG_PHASE', `Cannot deal during the ${state.phase} phase.`);
  }
  const board = dealBoard(action.boardNumber, action.seed);
  return { ok: true, value: withAction(state, action, { phase: 'auction', board }) };
}

/**
 * Applies one call.
 *
 * Turn order and legality (sufficiency of a bid, Law 18C; the double and
 * redouble rules of Law 19) are auction.ts's business. When the call closes the
 * auction (Law 22A) this also performs the phase transition:
 *
 * - Four passes = passed out (Law 22A1): no contract, no play, both sides score
 *   zero, and the board goes straight to review as a scored result.
 * - Otherwise the contract is derived - including the subtle declarer rule, the
 *   player who FIRST bid the winning denomination for the winning side - and
 *   the play begins with the opening lead by declarer's LHO (Law 41A).
 */
function handleCall(
  state: GameState,
  action: GameAction & { kind: 'call' },
): ActionResult<GameState> {
  if (state.phase !== 'auction' || state.board === null) {
    return fail('WRONG_PHASE', `There is no auction in progress (phase ${state.phase}).`);
  }
  const board = state.board;
  if (isAuctionClosed(board.auction)) {
    return fail('WRONG_PHASE', 'The auction is already closed.');
  }
  const onTurn = seatToCall(board.auction, board.dealer);
  if (!isSeat(action.seat) || onTurn !== action.seat) {
    return fail('NOT_YOUR_TURN', `It is ${onTurn} to call, not ${String(action.seat)}.`);
  }
  if (!isLegalCall(board.auction, board.dealer, action.seat, action.call)) {
    return fail('ILLEGAL_CALL', `${action.seat} may not call ${String(action.call)} here.`);
  }

  const auction: Call[] = [...board.auction, action.call];

  if (!isAuctionClosed(auction)) {
    return {
      ok: true,
      value: withAction(state, action, { phase: 'auction', board: { ...board, auction } }),
    };
  }

  if (isPassedOut(auction)) {
    const { board: settled, line } = settleBoard({
      ...board,
      auction,
      contract: null,
      play: null,
    });
    return {
      ok: true,
      value: withAction(state, action, {
        phase: 'review',
        board: settled,
        boardsPlayed: [...state.boardsPlayed, line],
      }),
    };
  }

  const contract = deriveContract(auction, board.dealer);
  if (contract === null) {
    // Unreachable: a closed auction that is not passed out always contains a
    // contract bid. Reported rather than thrown so a table can never crash.
    return fail('ILLEGAL_CALL', 'The auction closed but no contract could be derived.');
  }

  return {
    ok: true,
    value: withAction(state, action, {
      phase: 'play',
      board: { ...board, auction, contract, play: startPlay(contract) },
    }),
  };
}

/**
 * Plays one card.
 *
 * `action.seat` is the seat that OWNS the card, never the seat that sent the
 * message. Under Law 43 dummy takes no part in the play and declarer names and
 * plays dummy's cards (Law 45F), so the transport layer must map a message from
 * declarer onto the dummy seat with `controllerOf` before calling this; the
 * engine only checks that the card belongs to the seat whose turn it is.
 *
 * A card may not be played while a claim is outstanding: Law 68D suspends play
 * from the moment of a claim until it is agreed or withdrawn.
 *
 * When the thirteenth trick is quitted the board is scored, its row is pushed
 * onto the scoreboard, and the phase becomes 'review'.
 */
function handlePlay(
  state: GameState,
  action: GameAction & { kind: 'play' },
): ActionResult<GameState> {
  if (state.phase !== 'play' || state.board === null) {
    return fail('WRONG_PHASE', `There is no play in progress (phase ${state.phase}).`);
  }
  const board = state.board;
  const contract = board.contract;
  const play = board.play;
  if (contract === null || play === null) {
    return fail('WRONG_PHASE', 'The board has no contract to play.');
  }
  if (play.claim !== null) {
    return fail('WRONG_PHASE', 'Play is suspended while a claim is outstanding (Law 68D).');
  }
  if (!isSeat(action.seat)) {
    return fail('NOT_YOUR_TURN', `"${String(action.seat)}" is not a seat.`);
  }

  const played = playCard(play, board.hands, action.seat, action.card, contract.strain);
  if (!played.ok) return played;

  const nextBoard: Board = {
    ...board,
    hands: played.value.hands,
    play: played.value.play,
  };

  if (!isPlayComplete(played.value.play)) {
    return { ok: true, value: withAction(state, action, { phase: 'play', board: nextBoard }) };
  }

  const { board: settled, line } = settleBoard(nextBoard);
  return {
    ok: true,
    value: withAction(state, action, {
      phase: 'review',
      board: settled,
      boardsPlayed: [...state.boardsPlayed, line],
    }),
  };
}

/**
 * Records a claim and opens the poll.
 *
 * Law 68A: only declarer or a defender may claim - dummy takes no part in the
 * play (Law 43) - and the number claimed is that side's total for the whole
 * board. `validateClaim` enforces both.
 *
 * Law 69: a claim is settled by the opponents' acquiescence, so `pending` is
 * the claimer's opponents, minus dummy (who has no say). A claim by declarer is
 * therefore put to both defenders; a claim by a defender is put to declarer
 * alone. The poll is ordered from the claimer's left-hand opponent, the usual
 * direction for going round the table.
 */
function handleClaim(
  state: GameState,
  action: GameAction & { kind: 'claim' },
): ActionResult<GameState> {
  if (state.phase !== 'play' || state.board === null) {
    return fail('WRONG_PHASE', `There is no play in progress (phase ${state.phase}).`);
  }
  const board = state.board;
  const contract = board.contract;
  const play = board.play;
  if (contract === null || play === null) {
    return fail('WRONG_PHASE', 'The board has no contract to claim in.');
  }
  if (play.claim !== null) {
    return fail('BAD_CLAIM', 'A claim is already outstanding.');
  }
  if (isPlayComplete(play)) {
    return fail('WRONG_PHASE', 'The play is over; there is nothing left to claim.');
  }
  if (!isSeat(action.seat)) {
    return fail('BAD_CLAIM', `"${String(action.seat)}" is not a seat.`);
  }

  const checked = validateClaim(play, contract, action.seat, action.tricks);
  if (!checked.ok) return checked;

  const dummy = dummySeat(contract.declarer);
  const claimerSide = sideOf(action.seat);
  const pending = seatsInOrderFrom(nextSeat(action.seat)).filter(
    (seat) => sideOf(seat) !== claimerSide && seat !== dummy,
  );

  const claim: ClaimState = {
    by: action.seat,
    tricks: action.tricks,
    statement: action.statement,
    pending,
    rejected: [],
  };

  // Defensive: `validateClaim` already refuses a claim by dummy, so there is
  // always at least one opponent to ask. If there somehow were none, an
  // unopposed claim is agreed at once rather than left hanging for ever.
  if (pending.length === 0) {
    return finishWithClaim(state, action, board, contract, play, claim);
  }

  return {
    ok: true,
    value: withAction(state, action, {
      phase: 'play',
      board: { ...board, play: { ...play, claim } },
    }),
  };
}

/**
 * Answers an outstanding claim.
 *
 * Law 69A: once every opponent has acquiesced the claim stands, the tricks are
 * awarded as claimed and the board is scored. A single rejection withdraws the
 * claim and play resumes exactly where it stopped - the turn, the part-played
 * trick and every hand are untouched - which is why the claim is cleared to
 * null rather than half-kept: a claim carrying an unanswered objection must
 * never be mistaken by the scorer for an agreed one.
 */
function handleClaimRespond(
  state: GameState,
  action: GameAction & { kind: 'claimRespond' },
): ActionResult<GameState> {
  if (state.phase !== 'play' || state.board === null) {
    return fail('WRONG_PHASE', `There is no play in progress (phase ${state.phase}).`);
  }
  const board = state.board;
  const contract = board.contract;
  const play = board.play;
  if (contract === null || play === null) {
    return fail('WRONG_PHASE', 'The board has no contract.');
  }
  const claim = play.claim;
  if (claim === null) {
    return fail('NO_CLAIM_PENDING', 'There is no claim to answer.');
  }
  if (!isSeat(action.seat) || !claim.pending.includes(action.seat)) {
    return fail('NO_CLAIM_PENDING', `${String(action.seat)} was not asked to answer this claim.`);
  }

  if (!action.accept) {
    return {
      ok: true,
      value: withAction(state, action, {
        phase: 'play',
        board: { ...board, play: { ...play, claim: null } },
      }),
    };
  }

  const pending = claim.pending.filter((seat) => seat !== action.seat);
  const answered: ClaimState = { ...claim, pending };

  if (pending.length > 0) {
    return {
      ok: true,
      value: withAction(state, action, {
        phase: 'play',
        board: { ...board, play: { ...play, claim: answered } },
      }),
    };
  }

  return finishWithClaim(state, action, board, contract, play, answered);
}

/**
 * Rewinds the game by replaying the log from the start up to (but excluding)
 * `toActionIndex`.
 *
 * The engine deliberately does NOT ask whether an undo is allowed: agreement
 * between the players is a table matter (the Laws leave a withdrawn card to the
 * director), so the Durable Object collects consent and only then sends this.
 *
 * The undo action is not itself appended to the log - the rewound state's
 * history IS the truncated prefix. That keeps the invariant that
 * `replay(state.history)` always reproduces `state`, and keeps `toActionIndex`
 * meaning the same thing before and after.
 */
function handleUndo(
  state: GameState,
  action: GameAction & { kind: 'undo' },
): ActionResult<GameState> {
  const target = action.toActionIndex;
  if (!Number.isInteger(target) || target < 0) {
    return fail('NOTHING_TO_UNDO', `"${String(target)}" is not a valid action index.`);
  }
  if (state.history.length === 0) {
    return fail('NOTHING_TO_UNDO', 'Nothing has happened yet.');
  }
  if (target >= state.history.length) {
    return fail(
      'NOTHING_TO_UNDO',
      `Action index ${target} is at or past the end of the log (${state.history.length}).`,
    );
  }
  return replay(state.history.slice(0, target));
}

/**
 * Deals the next board of the match. Legal only from 'review', i.e. once the
 * board on the table has been scored.
 *
 * The board number is one past the board just finished, so dealer and
 * vulnerability keep advancing through the Law 2 cycle.
 */
function handleNextBoard(
  state: GameState,
  action: GameAction & { kind: 'nextBoard' },
): ActionResult<GameState> {
  if (state.phase !== 'review') {
    return fail('WRONG_PHASE', `The next board can only be dealt from review, not ${state.phase}.`);
  }
  const board = dealBoard(nextBoardNumber(state), action.seed);
  return { ok: true, value: withAction(state, action, { phase: 'auction', board }) };
}

// ---------------------------------------------------------------------------
// The single mutation entry point
// ---------------------------------------------------------------------------

/**
 * Applies one action and returns the resulting state, or an error.
 *
 * This is the ONLY way game state changes. It is pure: the input state is never
 * mutated, and the action is appended to `history` only on success, so a
 * rejected action leaves no trace and the log stays a faithful record of the
 * game that was actually played.
 *
 * It never throws. Anything unusable - an unknown action kind, a seat or card
 * token that is not one, a wrong phase, a wrong turn - comes back as
 * `{ ok: false, error }`.
 */
export function applyAction(state: GameState, action: GameAction): ActionResult<GameState> {
  if (action === null || typeof action !== 'object') {
    return fail('WRONG_PHASE', 'Not an action.');
  }
  switch (action.kind) {
    case 'deal':
      return handleDeal(state, action);
    case 'call':
      return handleCall(state, action);
    case 'play':
      return handlePlay(state, action);
    case 'claim':
      return handleClaim(state, action);
    case 'claimRespond':
      return handleClaimRespond(state, action);
    case 'undo':
      return handleUndo(state, action);
    case 'nextBoard':
      return handleNextBoard(state, action);
    default:
      // Exhaustive today; still handled, because actions arrive off a network.
      return fail('WRONG_PHASE', `Unknown action "${String((action as { kind?: unknown }).kind)}".`);
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The seat that must act next: the seat to call during the auction, the seat to
 * play a card during the play, and null in every other phase.
 *
 * During the play this is the seat that OWNS the next card, which may be dummy;
 * use `controllerOf` from play.ts to turn that into the player who is allowed
 * to send it (Law 45F - declarer plays dummy's cards). A pending claim does not
 * change whose turn it is, so play can resume unchanged if the claim is
 * rejected, even though no card is legal meanwhile.
 */
export function whoseTurn(state: GameState): Seat | null {
  const board = state.board;
  if (board === null) return null;
  if (state.phase === 'auction') {
    return isAuctionClosed(board.auction) ? null : seatToCall(board.auction, board.dealer);
  }
  if (state.phase === 'play') {
    if (board.play === null || isPlayComplete(board.play)) return null;
    return board.play.turn;
  }
  return null;
}

/**
 * Everything `seat` may legally do right now, for the bidding box, the card
 * highlighting and the bots.
 *
 * At most one list is ever non-empty. `cards` is the cards held by `seat`
 * itself, so to drive dummy's play ask for the dummy seat, not for declarer
 * (Law 45F: declarer plays them, but they leave dummy's hand). Both lists are
 * empty when it is not this seat's turn, when a claim is outstanding (Law 68D
 * suspends play), or between boards.
 */
export function legalActionsFor(state: GameState, seat: Seat): { calls: Call[]; cards: Card[] } {
  if (!isSeat(seat)) return noActions();
  const board = state.board;
  if (board === null) return noActions();

  if (state.phase === 'auction') {
    return { calls: legalCalls(board.auction, board.dealer, seat), cards: [] };
  }

  if (state.phase === 'play') {
    const play = board.play;
    if (play === null || play.claim !== null || isPlayComplete(play)) return noActions();
    if (play.turn !== seat) return noActions();
    return { calls: [], cards: legalCards(board.hands[seat], play) };
  }

  return noActions();
}

/**
 * Whether the match has run its course: `boardCount` boards have been scored.
 *
 * A `boardCount` of 0 (or anything not a positive number) means "play forever",
 * matching `TableSettings.boardCount`, so it never ends the match. A state that
 * has already been moved to the 'finished' phase is over regardless - that
 * transition belongs to the Durable Object, which is the only layer that knows
 * the table's settings.
 */
export function isMatchOver(state: GameState, boardCount: number): boolean {
  if (state.phase === 'finished') return true;
  if (!Number.isFinite(boardCount) || boardCount <= 0) return false;
  return state.boardsPlayed.length >= Math.trunc(boardCount);
}

/**
 * Rebuilds a game by applying an action log to a fresh state.
 *
 * This is the engine's determinism guarantee made executable: because dealing
 * is seeded and every rule is a pure function, replaying the same actions
 * always yields the same game. Used by undo, by crash recovery and by tests.
 * The first action that does not apply aborts the replay and its error is
 * returned, so a corrupted log fails loudly instead of producing a plausible
 * but wrong position. The input array is not mutated.
 */
export function replay(actions: GameAction[]): ActionResult<GameState> {
  let state = newGame();
  for (const action of actions) {
    const result = applyAction(state, action);
    if (!result.ok) return result;
    state = result.value;
  }
  return { ok: true, value: state };
}
