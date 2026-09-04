/**
 * Robot tests.
 *
 * The bar for a robot is not "plays well" - it is "never wedges the table and never cheats".
 * These tests drive full boards with four robots and assert that every call and every card they
 * produce is legal, that auctions terminate, and that a robot only ever reasons from cards it is
 * entitled to see.
 */
import { describe, it, expect } from 'vitest';

import { applyAction, legalActionsFor, newGame, startBoard, whoseTurn } from '../src/engine/game';
import { chooseCall, explainCall } from '../src/bots/bidding';
import { chooseCard } from '../src/bots/play';
import { controllerOf, dummySeat } from '../src/engine/play';
import { isLegalCall } from '../src/engine/auction';
import type { BotLevel } from '../src/bots/bidding';
import type { Card, Seat } from '../src/engine/types';

const LEVELS: BotLevel[] = ['beginner', 'intermediate', 'advanced'];

/** Plays one complete board with four robots of the given level. */
function playBoard(boardNumber: number, level: BotLevel) {
  let state = startBoard(newGame(), boardNumber, `bot-seed-${level}-${boardNumber}`);
  let steps = 0;

  while (state.phase === 'auction' || state.phase === 'play') {
    steps += 1;
    if (steps > 400) throw new Error(`board ${boardNumber} did not terminate`);

    const turn = whoseTurn(state);
    if (!turn) throw new Error('no seat on turn');

    const board = state.board!;

    if (state.phase === 'auction') {
      const call = chooseCall({
        hand: board.hands[turn],
        auction: board.auction,
        dealer: board.dealer,
        seat: turn,
        vulnerability: board.vulnerability,
        level,
      });

      // The single most important robot invariant.
      expect(
        isLegalCall(board.auction, board.dealer, turn, call),
        `illegal call ${call} by ${turn} after [${board.auction.join(' ')}]`
      ).toBe(true);

      const result = applyAction(state, { kind: 'call', seat: turn, call });
      expect(result.ok, `engine rejected robot call ${call}`).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      state = result.value;
    } else {
      const play = board.play!;
      const contract = board.contract!;
      const actor = controllerOf(turn, contract);

      // A robot may look at its own hand and at dummy once dummy is down - nothing else.
      const known: Partial<Record<Seat, Card[]>> = { [turn]: board.hands[turn] };
      const dummy = dummySeat(contract.declarer);
      if (play.dummyRevealed) known[dummy] = board.hands[dummy];
      if (actor === contract.declarer) known[contract.declarer] = board.hands[contract.declarer];

      const card = chooseCard({
        hand: board.hands[turn],
        play,
        contract,
        seat: turn,
        known,
        level,
      });

      const legal = legalActionsFor(state, turn).cards;
      expect(legal, `robot played ${card} which is not legal for ${turn}`).toContain(card);

      const result = applyAction(state, { kind: 'play', seat: turn, card });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      state = result.value;
    }
  }

  return state;
}

describe('robots', () => {
  for (const level of LEVELS) {
    it(`plays 20 complete boards legally at level "${level}"`, () => {
      let contracts = 0;
      let passouts = 0;

      for (let boardNumber = 1; boardNumber <= 20; boardNumber += 1) {
        const state = playBoard(boardNumber, level);
        expect(state.phase).toBe('review');

        const board = state.board!;
        if (board.result?.passedOut) {
          passouts += 1;
        } else {
          contracts += 1;
          expect(board.play!.tricksNS + board.play!.tricksEW).toBe(13);
        }
      }

      expect(contracts + passouts).toBe(20);
      // A robot that passes every board is technically legal and completely useless.
      expect(contracts).toBeGreaterThan(8);
    });
  }

  it('keeps auctions to a sane length', () => {
    for (let boardNumber = 1; boardNumber <= 30; boardNumber += 1) {
      const state = playBoard(boardNumber, 'advanced');
      // Even a wild competitive auction should not run past a couple of dozen calls.
      expect(state.board!.auction.length).toBeLessThan(30);
    }
  });

  it('explains its bids in human-readable text', () => {
    const state = startBoard(newGame(), 1, 'explain-seed');
    const board = state.board!;
    const text = explainCall({
      hand: board.hands[board.dealer],
      auction: [],
      dealer: board.dealer,
      seat: board.dealer,
      vulnerability: board.vulnerability,
      level: 'advanced',
    });
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('opens 1NT on a balanced 15-17 count', () => {
    // 4-3-3-3 with 16 HCP: the textbook 1NT opening.
    const hand: Card[] = ['SA', 'SK', 'S4', 'S3', 'HA', 'H7', 'H6', 'DK', 'D8', 'D5', 'CQ', 'C9', 'C2'];
    const call = chooseCall({
      hand,
      auction: [],
      dealer: 'N',
      seat: 'N',
      vulnerability: 'None',
      level: 'advanced',
    });
    expect(call).toBe('1N');
  });

  it('passes a hand with no values', () => {
    const hand: Card[] = ['S8', 'S5', 'S3', 'H9', 'H7', 'H4', 'D8', 'D6', 'D3', 'C9', 'C7', 'C5', 'C2'];
    const call = chooseCall({
      hand,
      auction: [],
      dealer: 'N',
      seat: 'N',
      vulnerability: 'None',
      level: 'advanced',
    });
    expect(call).toBe('P');
  });
});
