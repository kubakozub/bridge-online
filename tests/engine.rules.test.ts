/**
 * Rules tests for the bridge engine.
 *
 * The scoring and declarer-determination cases below are taken from the Laws of Duplicate
 * Bridge; if one of them fails the product is wrong, not the test.
 */
import { describe, it, expect } from 'vitest';

import {
  FULL_DECK,
  hcp,
  isBalanced,
  makeRng,
  parseCard,
  shape,
  shuffle,
  sortHand,
  suitLengths,
  handsToPbn,
  pbnToHands,
} from '../src/engine/cards';
import {
  dealBoard,
  dealerForBoard,
  isVulnerable,
  nextSeat,
  partnerOf,
  sideOf,
  vulnerabilityForBoard,
} from '../src/engine/deal';
import {
  bidRank,
  deriveContract,
  isAuctionClosed,
  isLegalCall,
  isPassedOut,
  legalCalls,
  seatToCall,
} from '../src/engine/auction';
import { legalCards, openingLeader, startPlay, trickWinner, dummySeat } from '../src/engine/play';
import { scoreContract, impsFromDiff } from '../src/engine/scoring';
import type { Call, Card, Contract, Seat, Trick } from '../src/engine/types';

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

describe('cards', () => {
  it('has a 52-card deck with no duplicates', () => {
    expect(FULL_DECK).toHaveLength(52);
    expect(new Set(FULL_DECK).size).toBe(52);
  });

  it('counts Milton Work high-card points', () => {
    expect(hcp(['SA', 'SK', 'SQ', 'SJ'])).toBe(10);
    expect(hcp(['S2', 'H3', 'D4', 'C5'])).toBe(0);
    // A full deck holds exactly 40 HCP.
    expect(hcp([...FULL_DECK])).toBe(40);
  });

  it('recognises balanced shapes', () => {
    const h4333: Card[] = ['SA', 'SK', 'SQ', 'SJ', 'HA', 'HK', 'HQ', 'DA', 'DK', 'DQ', 'CA', 'CK', 'CQ'];
    expect(shape(h4333)).toEqual([4, 3, 3, 3]);
    expect(isBalanced(h4333)).toBe(true);

    const h7321: Card[] = ['SA', 'SK', 'SQ', 'SJ', 'ST', 'S9', 'S8', 'HA', 'HK', 'HQ', 'DA', 'DK', 'CA'];
    expect(isBalanced(h7321)).toBe(false);
  });

  it('sorts a hand into suit groups', () => {
    const sorted = sortHand(['C2', 'SA', 'H5', 'SK', 'DQ']);
    const suits = sorted.map((c) => c[0]);
    // Every suit occupies one contiguous run.
    const runs = suits.filter((s, i) => s !== suits[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it('parses tolerant card notations', () => {
    expect(parseCard('S10')).toBe('ST');
    expect(parseCard('sa')).toBe('SA');
    expect(parseCard('zz')).toBeNull();
  });

  it('shuffles deterministically from a seed', () => {
    const a = shuffle(FULL_DECK, makeRng('seed-1'));
    const b = shuffle(FULL_DECK, makeRng('seed-1'));
    const c = shuffle(FULL_DECK, makeRng('seed-2'));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(52);
  });

  it('round-trips a deal through PBN', () => {
    const board = dealBoard(1, 'pbn-seed');
    const pbn = handsToPbn(board.hands, board.dealer);
    const back = pbnToHands(pbn);
    expect(back).not.toBeNull();
    for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) {
      expect(new Set(back![seat])).toEqual(new Set(board.hands[seat]));
    }
  });
});

// ---------------------------------------------------------------------------
// Board metadata
// ---------------------------------------------------------------------------

describe('board metadata', () => {
  it('rotates the dealer every board', () => {
    expect(dealerForBoard(1)).toBe('N');
    expect(dealerForBoard(2)).toBe('E');
    expect(dealerForBoard(3)).toBe('S');
    expect(dealerForBoard(4)).toBe('W');
    expect(dealerForBoard(5)).toBe('N');
    expect(dealerForBoard(17)).toBe('N');
  });

  it('follows the 16-board vulnerability cycle', () => {
    const expected = [
      'None', 'NS', 'EW', 'Both',
      'NS', 'EW', 'Both', 'None',
      'EW', 'Both', 'None', 'NS',
      'Both', 'None', 'NS', 'EW',
    ];
    expected.forEach((vul, i) => {
      expect(vulnerabilityForBoard(i + 1)).toBe(vul);
    });
    // The cycle repeats.
    expect(vulnerabilityForBoard(17)).toBe('None');
    expect(vulnerabilityForBoard(32)).toBe('EW');
  });

  it('maps vulnerability onto seats', () => {
    expect(isVulnerable('N', 'NS')).toBe(true);
    expect(isVulnerable('S', 'NS')).toBe(true);
    expect(isVulnerable('E', 'NS')).toBe(false);
    expect(isVulnerable('W', 'Both')).toBe(true);
    expect(isVulnerable('W', 'None')).toBe(false);
  });

  it('knows partnerships and rotation', () => {
    expect(partnerOf('N')).toBe('S');
    expect(partnerOf('E')).toBe('W');
    expect(sideOf('N')).toBe('NS');
    expect(sideOf('W')).toBe('EW');
    expect(nextSeat('N')).toBe('E');
    expect(nextSeat('W')).toBe('N');
    expect(nextSeat('N', 2)).toBe('S');
  });

  it('deals 13 cards to each seat with no overlap', () => {
    const board = dealBoard(7, 'deal-seed');
    const all: Card[] = [];
    for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) {
      expect(board.hands[seat]).toHaveLength(13);
      all.push(...board.hands[seat]);
    }
    expect(new Set(all).size).toBe(52);
    expect(board.dealer).toBe(dealerForBoard(7));
    expect(board.vulnerability).toBe(vulnerabilityForBoard(7));
  });
});

// ---------------------------------------------------------------------------
// Auction
// ---------------------------------------------------------------------------

describe('auction', () => {
  it('ranks bids in the standard order', () => {
    expect(bidRank('1C')).toBeLessThan(bidRank('1D'));
    expect(bidRank('1S')).toBeLessThan(bidRank('1N'));
    expect(bidRank('1N')).toBeLessThan(bidRank('2C'));
    expect(bidRank('7N')).toBe(34);
  });

  it('tracks whose turn it is', () => {
    expect(seatToCall([], 'N')).toBe('N');
    expect(seatToCall(['P'], 'N')).toBe('E');
    expect(seatToCall(['P', 'P', 'P'], 'N')).toBe('W');
    expect(seatToCall(['P', '1S', 'P', 'P'], 'W')).toBe('W');
  });

  it('rejects a bid that does not outrank the standing bid', () => {
    expect(isLegalCall(['1S'], 'N', 'E', '1H')).toBe(false);
    expect(isLegalCall(['1S'], 'N', 'E', '2H')).toBe(true);
    expect(isLegalCall(['1S'], 'N', 'E', '1N')).toBe(true);
  });

  it('only allows a double against the opponents', () => {
    // N opened 1S; E may double.
    expect(isLegalCall(['1S'], 'N', 'E', 'X')).toBe(true);
    // ... but S may not double their own partner.
    expect(isLegalCall(['1S', 'P'], 'N', 'S', 'X')).toBe(false);
    // Nothing to double before a bid.
    expect(isLegalCall([], 'N', 'N', 'X')).toBe(false);
    // No double of an already-doubled contract.
    expect(isLegalCall(['1S', 'X'], 'N', 'S', 'X')).toBe(false);
  });

  it('allows a redouble only by the doubled side', () => {
    // N 1S, E X -> S may redouble.
    expect(isLegalCall(['1S', 'X'], 'N', 'S', 'XX')).toBe(true);
    // W may not redouble their partner's double.
    expect(isLegalCall(['1S', 'X'], 'N', 'W', 'XX')).toBe(false);
    // No redouble without a double.
    expect(isLegalCall(['1S'], 'N', 'E', 'XX')).toBe(false);
  });

  it('closes after three passes following a bid', () => {
    expect(isAuctionClosed(['1S', 'P', 'P'])).toBe(false);
    expect(isAuctionClosed(['1S', 'P', 'P', 'P'])).toBe(true);
    expect(isAuctionClosed(['P', 'P', 'P'])).toBe(false);
    expect(isAuctionClosed(['P', 'P', 'P', 'P'])).toBe(true);
    expect(isPassedOut(['P', 'P', 'P', 'P'])).toBe(true);
  });

  it('never offers an illegal call in legalCalls', () => {
    const auction: Call[] = ['1S', 'X'];
    for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) {
      for (const call of legalCalls(auction, 'N', seat)) {
        expect(isLegalCall(auction, 'N', seat, call)).toBe(true);
      }
    }
  });

  it('names the declarer as the FIRST of the partnership to bid the strain', () => {
    // N: 1H, E: P, S: 2H, W: P, N: 4H, all pass.
    // North bid hearts first, so North declares even though North also made the final bid.
    const a: Call[] = ['1H', 'P', '2H', 'P', '4H', 'P', 'P', 'P'];
    expect(deriveContract(a, 'N')).toEqual<Contract>({
      level: 4,
      strain: 'H',
      declarer: 'N',
      risk: 'none',
    });

    // S bids hearts first, N raises to game -> South declares.
    const b: Call[] = ['1C', 'P', '1H', 'P', '4H', 'P', 'P', 'P'];
    expect(deriveContract(b, 'N')?.declarer).toBe('S');

    // Doubled contract keeps the risk.
    const c: Call[] = ['1N', 'X', 'P', 'P', 'P'];
    const contract = deriveContract(c, 'N');
    expect(contract?.risk).toBe('X');
    expect(contract?.declarer).toBe('N');
  });

  it('returns null for a passed-out auction', () => {
    expect(deriveContract(['P', 'P', 'P', 'P'], 'N')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------

describe('play', () => {
  const contract: Contract = { level: 4, strain: 'S', declarer: 'S', risk: 'none' };

  it('leads from declarer left-hand opponent and reveals the right dummy', () => {
    expect(openingLeader('S')).toBe('W');
    expect(dummySeat('S')).toBe('N');
    const play = startPlay(contract);
    expect(play.turn).toBe('W');
    expect(play.tricks).toHaveLength(1);
    expect(play.tricks[0].leader).toBe('W');
  });

  it('forces following suit when possible', () => {
    const play = startPlay(contract);
    play.tricks[0].cards = [{ seat: 'W', card: 'HA' }];
    const hand: Card[] = ['H2', 'H5', 'SA', 'DK'];
    expect(legalCards(hand, play).sort()).toEqual(['H2', 'H5']);
  });

  it('allows any card when void in the suit led', () => {
    const play = startPlay(contract);
    play.tricks[0].cards = [{ seat: 'W', card: 'HA' }];
    const hand: Card[] = ['SA', 'DK', 'C3'];
    expect(legalCards(hand, play).sort()).toEqual(['C3', 'DK', 'SA']);
  });

  it('awards the trick to the highest trump, else the highest card of the suit led', () => {
    const noTrump: Trick = {
      leader: 'W',
      cards: [
        { seat: 'W', card: 'H5' },
        { seat: 'N', card: 'HK' },
        { seat: 'E', card: 'H2' },
        { seat: 'S', card: 'HA' },
      ],
    };
    expect(trickWinner(noTrump, 'N')).toBe('S');

    const ruffed: Trick = {
      leader: 'W',
      cards: [
        { seat: 'W', card: 'HA' },
        { seat: 'N', card: 'H3' },
        { seat: 'E', card: 'S2' }, // a ruff beats the ace
        { seat: 'S', card: 'H4' },
      ],
    };
    expect(trickWinner(ruffed, 'S')).toBe('E');

    const overruff: Trick = {
      leader: 'W',
      cards: [
        { seat: 'W', card: 'HA' },
        { seat: 'N', card: 'S5' },
        { seat: 'E', card: 'S9' },
        { seat: 'S', card: 'H4' },
      ],
    };
    expect(trickWinner(overruff, 'S')).toBe('E');
  });
});

// ---------------------------------------------------------------------------
// Scoring - the numbers every club player can recite
// ---------------------------------------------------------------------------

describe('scoring', () => {
  const c = (level: number, strain: string, risk = 'none'): Contract =>
    ({ level, strain, declarer: 'S', risk } as Contract);

  it('scores part-scores', () => {
    expect(scoreContract(c(2, 'H'), 8, false)).toBe(110); // 60 + 50 part-score
    expect(scoreContract(c(2, 'H'), 9, false)).toBe(140); // + one overtrick
    expect(scoreContract(c(1, 'N'), 7, false)).toBe(90); // 40 + 50
    expect(scoreContract(c(3, 'C'), 9, false)).toBe(110); // 60 + 50
  });

  it('scores games', () => {
    expect(scoreContract(c(4, 'S'), 10, false)).toBe(420); // 120 + 300
    expect(scoreContract(c(4, 'S'), 10, true)).toBe(620); // 120 + 500
    expect(scoreContract(c(3, 'N'), 9, false)).toBe(400); // 100 + 300
    expect(scoreContract(c(3, 'N'), 9, true)).toBe(600);
    expect(scoreContract(c(5, 'D'), 11, true)).toBe(600); // 100 + 500
  });

  it('scores slams', () => {
    expect(scoreContract(c(6, 'S'), 12, false)).toBe(980); // 180 + 300 + 500
    expect(scoreContract(c(6, 'S'), 12, true)).toBe(1430); // 180 + 500 + 750
    expect(scoreContract(c(7, 'N'), 13, true)).toBe(2220); // 220 + 500 + 1500
    expect(scoreContract(c(7, 'N'), 13, false)).toBe(1520); // 220 + 300 + 1000
  });

  it('scores doubled contracts with the insult bonus', () => {
    // 4S doubled, making exactly: 240 trick score -> game, + 50 insult.
    expect(scoreContract(c(4, 'S', 'X'), 10, false)).toBe(590);
    expect(scoreContract(c(4, 'S', 'X'), 10, true)).toBe(790);
    // 1NT doubled making: 80 trick score (still a part-score) + 50 + 50 insult.
    expect(scoreContract(c(1, 'N', 'X'), 7, false)).toBe(180);
    // Doubled overtricks: 100 each non-vulnerable, 200 each vulnerable.
    expect(scoreContract(c(4, 'S', 'X'), 11, false)).toBe(690);
    expect(scoreContract(c(4, 'S', 'X'), 11, true)).toBe(990);
  });

  it('scores redoubled contracts', () => {
    // 1NT redoubled making = 160 trick score -> game bonus, + 100 insult.
    expect(scoreContract(c(1, 'N', 'XX'), 7, false)).toBe(560);
  });

  it('scores undertricks', () => {
    expect(scoreContract(c(4, 'S'), 9, false)).toBe(-50);
    expect(scoreContract(c(4, 'S'), 9, true)).toBe(-100);
    expect(scoreContract(c(4, 'S'), 7, false)).toBe(-150); // three down
    expect(scoreContract(c(4, 'S'), 7, true)).toBe(-300);
  });

  it('scores doubled undertricks on the standard ladder', () => {
    // Non-vulnerable doubled: 100, 300, 500, 800, 1100 ...
    expect(scoreContract(c(4, 'S', 'X'), 9, false)).toBe(-100);
    expect(scoreContract(c(4, 'S', 'X'), 8, false)).toBe(-300);
    expect(scoreContract(c(4, 'S', 'X'), 7, false)).toBe(-500);
    expect(scoreContract(c(4, 'S', 'X'), 6, false)).toBe(-800);
    expect(scoreContract(c(4, 'S', 'X'), 5, false)).toBe(-1100);
    // Vulnerable doubled: 200, 500, 800, 1100 ...
    expect(scoreContract(c(4, 'S', 'X'), 9, true)).toBe(-200);
    expect(scoreContract(c(4, 'S', 'X'), 8, true)).toBe(-500);
    expect(scoreContract(c(4, 'S', 'X'), 7, true)).toBe(-800);
    // Redoubled is exactly twice the doubled penalty.
    expect(scoreContract(c(4, 'S', 'XX'), 9, false)).toBe(-200);
    expect(scoreContract(c(4, 'S', 'XX'), 9, true)).toBe(-400);
  });

  it('converts score differences to IMPs', () => {
    expect(impsFromDiff(0)).toBe(0);
    expect(impsFromDiff(10)).toBe(0);
    expect(impsFromDiff(20)).toBe(1);
    expect(impsFromDiff(90)).toBe(3);
    expect(impsFromDiff(420)).toBe(9);
    expect(impsFromDiff(1100)).toBe(15);
    expect(impsFromDiff(4000)).toBe(24);
    expect(impsFromDiff(99_999)).toBe(24);
    // The sign is carried through, so callers can pass an NS-minus-EW difference
    // straight in and read the answer off as NS's IMP swing.
    expect(impsFromDiff(-420)).toBe(-9);
    expect(impsFromDiff(-20)).toBe(-1);
    expect(impsFromDiff(-99_999)).toBe(-24);
  });
});
