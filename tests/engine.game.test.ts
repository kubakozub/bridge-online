/**
 * State-machine tests: drive `applyAction` through complete boards.
 *
 * The fuzz test is the important one. It plays hundreds of full boards with random *legal*
 * actions and asserts the invariants that must hold at every step - card conservation, turn
 * order, follow-suit, trick counts. A rules bug anywhere in the engine shows up here.
 */
import { describe, it, expect } from 'vitest';

import {
  applyAction,
  legalActionsFor,
  newGame,
  replay,
  startBoard,
  whoseTurn,
  type GameState,
} from '../src/engine/game';
import type { GameAction, Seat, Card, Call, Trick } from '../src/engine/types';
import { makeRng } from '../src/engine/cards';
import { dummySeat } from '../src/engine/play';
import { partnerOf, nextSeat } from '../src/engine/deal';

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];

/** Picks a random element with the supplied RNG so failures reproduce from the seed. */
function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

function expectOk(result: ReturnType<typeof applyAction>): GameState {
  if (!result.ok) {
    throw new Error(`action rejected: ${result.error.code} - ${result.error.message}`);
  }
  return result.value;
}

/** Every card dealt must still be somewhere: in a hand or on the table. */
function assertCardConservation(state: GameState): void {
  const board = state.board;
  if (!board) return;

  const inHands: Card[] = SEATS.flatMap((s) => board.hands[s]);
  const onTable: Card[] = board.play
    ? board.play.tricks.flatMap((t: Trick) => t.cards.map((c) => c.card))
    : [];
  const all = [...inHands, ...onTable];

  expect(all).toHaveLength(52);
  expect(new Set(all).size).toBe(52);
}

describe('game state machine', () => {
  it('starts in the lobby with no board', () => {
    const state = newGame();
    expect(state.phase).toBe('lobby');
    expect(state.board).toBeNull();
    expect(state.history).toHaveLength(0);
  });

  it('deals into the auction phase', () => {
    const state = startBoard(newGame(), 1, 'seed');
    expect(state.phase).toBe('auction');
    expect(state.board?.boardNumber).toBe(1);
    expect(whoseTurn(state)).toBe('N'); // board 1 is dealt by North
    assertCardConservation(state);
  });

  it('rejects a call from the wrong seat', () => {
    const state = startBoard(newGame(), 1, 'seed');
    const wrong = applyAction(state, { kind: 'call', seat: 'E', call: 'P' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('NOT_YOUR_TURN');
  });

  it('rejects an insufficient bid', () => {
    let state = startBoard(newGame(), 1, 'seed');
    state = expectOk(applyAction(state, { kind: 'call', seat: 'N', call: '2H' }));
    const bad = applyAction(state, { kind: 'call', seat: 'E', call: '1S' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('ILLEGAL_CALL');
  });

  it('goes straight to review when the board is passed out', () => {
    let state = startBoard(newGame(), 1, 'seed');
    for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) {
      state = expectOk(applyAction(state, { kind: 'call', seat, call: 'P' }));
    }
    expect(state.phase).toBe('review');
    expect(state.board?.result?.passedOut).toBe(true);
    expect(state.board?.result?.scoreNS).toBe(0);
    expect(state.boardsPlayed).toHaveLength(1);
  });

  it('moves into play with the correct declarer and opening leader', () => {
    let state = startBoard(newGame(), 1, 'seed');
    const calls: [Seat, Call][] = [
      ['N', '1S'],
      ['E', 'P'],
      ['S', 'P'],
      ['W', 'P'],
    ];
    for (const [seat, call] of calls) {
      state = expectOk(applyAction(state, { kind: 'call', seat, call }));
    }
    expect(state.phase).toBe('play');
    expect(state.board?.contract?.declarer).toBe('N');
    expect(state.board?.contract?.strain).toBe('S');
    expect(state.board?.play?.turn).toBe('E'); // left of declarer
    assertCardConservation(state);
  });

  it('replays its own history to the same state', () => {
    let state = startBoard(newGame(), 3, 'replay-seed');
    const rng = makeRng('replay-actions');
    for (let i = 0; i < 12 && state.phase !== 'review'; i += 1) {
      const turn = whoseTurn(state);
      if (!turn) break;
      const { calls, cards } = legalActionsFor(state, turn);
      const action: GameAction =
        state.phase === 'auction'
          ? { kind: 'call', seat: turn, call: pick(calls, rng) }
          : { kind: 'play', seat: turn, card: pick(cards, rng) };
      state = expectOk(applyAction(state, action));
    }

    const replayed = replay(state.history);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.phase).toBe(state.phase);
      expect(replayed.value.board?.auction).toEqual(state.board?.auction);
      expect(replayed.value.board?.hands).toEqual(state.board?.hands);
    }
  });
});

describe('full-board fuzz', () => {
  it('plays 150 complete boards with random legal actions and never breaks an invariant', () => {
    let contractsPlayed = 0;
    let passedOut = 0;

    for (let boardNumber = 1; boardNumber <= 150; boardNumber += 1) {
      const rng = makeRng(`fuzz-${boardNumber}`);
      let state = startBoard(newGame(), boardNumber, `fuzz-seed-${boardNumber}`);

      let guard = 0;
      while (state.phase !== 'review' && state.phase !== 'finished') {
        guard += 1;
        expect(guard).toBeLessThan(500); // an auction + 52 cards can never need this many

        const turn = whoseTurn(state);
        expect(turn).not.toBeNull();
        const seat = turn as Seat;

        const { calls, cards } = legalActionsFor(state, seat);

        if (state.phase === 'auction') {
          expect(calls.length).toBeGreaterThan(0);
          // Bias towards passing so auctions terminate instead of climbing to 7NT.
          const call = rng() < 0.55 && calls.includes('P') ? 'P' : pick(calls, rng);
          state = expectOk(applyAction(state, { kind: 'call', seat, call }));
        } else {
          expect(cards.length).toBeGreaterThan(0);

          const board = state.board!;
          const play = board.play!;
          const trick = play.tricks[play.tricks.length - 1];

          // Follow-suit must be enforced by legalActionsFor, not just by playCard.
          if (trick.cards.length > 0) {
            const led = trick.cards[0].card[0];
            const hasLed = board.hands[seat].some((c) => c[0] === led);
            if (hasLed) {
              expect(cards.every((c) => c[0] === led)).toBe(true);
            }
          }

          const card = pick(cards, rng);
          expect(board.hands[seat]).toContain(card);
          state = expectOk(applyAction(state, { kind: 'play', seat, card }));
          assertCardConservation(state);
        }
      }

      const board = state.board!;
      const result = board.result!;

      if (result.passedOut) {
        passedOut += 1;
        expect(result.scoreNS).toBe(0);
        expect(board.auction).toEqual(['P', 'P', 'P', 'P']);
      } else {
        contractsPlayed += 1;
        const play = board.play!;

        // All 52 cards played, 13 tricks resolved, counts add up.
        expect(play.tricksNS + play.tricksEW).toBe(13);
        expect(play.tricks.filter((t) => t.cards.length === 4)).toHaveLength(13);
        expect(SEATS.every((s) => board.hands[s].length === 0)).toBe(true);

        // Every trick has four cards from four distinct seats, led by the previous winner.
        play.tricks.forEach((trick, i) => {
          expect(new Set(trick.cards.map((c) => c.seat)).size).toBe(4);
          expect(trick.winner).toBeDefined();
          if (i > 0) expect(trick.leader).toBe(play.tricks[i - 1].winner);
        });

        // Declarer's side trick count matches the recorded result.
        const declarerSide = board.contract!.declarer === 'N' || board.contract!.declarer === 'S';
        expect(result.tricksWon).toBe(declarerSide ? play.tricksNS : play.tricksEW);
        expect(result.resultRelative).toBe(result.tricksWon! - (board.contract!.level + 6));

        // The opening lead came from the seat on declarer's left, so the leader is a
        // defender and their partner is the other defender.
        expect(play.tricks[0].leader).toBe(nextSeat(board.contract!.declarer));
        expect(play.tricks[0].leader).not.toBe(dummySeat(board.contract!.declarer));
        expect(partnerOf(play.tricks[0].leader)).not.toBe(board.contract!.declarer);
      }
    }

    // Sanity: the fuzz actually exercised real contracts, not only pass-outs.
    expect(contractsPlayed).toBeGreaterThan(40);
    expect(contractsPlayed + passedOut).toBe(150);
  });
});
