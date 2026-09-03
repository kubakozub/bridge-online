/**
 * Core domain types for contract bridge.
 *
 * Wire format == engine format on purpose: a card is the 2-character string
 * used in every bridge notation ("SA", "HT", "D9", "C2") and a call is the
 * standard auction token ("1S", "3N", "P", "X", "XX"). That means game state
 * can be sent over the WebSocket verbatim with no serialisation layer.
 */

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** Suits, ordered low -> high exactly as bridge ranks them. */
export type Suit = 'C' | 'D' | 'H' | 'S';

/** A denomination you can bid: the four suits plus No-Trump. */
export type Strain = Suit | 'N';

export type RankChar = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

/** e.g. "SA" (ace of spades), "HT" (ten of hearts), "C2" (two of clubs). */
export type Card = `${Suit}${RankChar}`;

/** Numeric rank: 2..14, where J=11, Q=12, K=13, A=14. */
export type RankValue = number;

export const SUITS: readonly Suit[] = ['C', 'D', 'H', 'S'] as const;
export const STRAINS: readonly Strain[] = ['C', 'D', 'H', 'S', 'N'] as const;
export const RANK_CHARS: readonly RankChar[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export type Seat = 'N' | 'E' | 'S' | 'W';
export type Side = 'NS' | 'EW';

/** Clockwise order of play, which is also the order used for the auction. */
export const SEATS: readonly Seat[] = ['N', 'E', 'S', 'W'] as const;

export type Vulnerability = 'None' | 'NS' | 'EW' | 'Both';

// ---------------------------------------------------------------------------
// Auction
// ---------------------------------------------------------------------------

export type BidLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A contract bid such as "1C" or "7N". */
export type Bid = `${BidLevel}${Strain}`;

/** Any legal auction token. */
export type Call = Bid | 'P' | 'X' | 'XX';

export type Risk = 'none' | 'X' | 'XX';

export interface Contract {
  level: BidLevel;
  strain: Strain;
  declarer: Seat;
  risk: Risk;
}

// ---------------------------------------------------------------------------
// Play
// ---------------------------------------------------------------------------

export interface PlayedCard {
  seat: Seat;
  card: Card;
}

export interface Trick {
  /** Seat that led to this trick. */
  leader: Seat;
  /** Cards in play order, starting with the leader. Length 0..4. */
  cards: PlayedCard[];
  /** Set once the trick has four cards. */
  winner?: Seat;
}

export interface ClaimState {
  /** Seat that claimed (declarer or a defender). */
  by: Seat;
  /** Total tricks the claimer says their side will take on the whole board. */
  tricks: number;
  /** Optional free-text explanation of the line of play. */
  statement?: string;
  /** Seats that still have to answer. Empty => everyone accepted. */
  pending: Seat[];
  /** Seats that rejected. Non-empty => claim withdrawn, play continues. */
  rejected: Seat[];
}

export interface PlayState {
  /** Completed tricks, plus the in-progress trick as the last element. */
  tricks: Trick[];
  /** Whose turn it is to play a card. */
  turn: Seat;
  /** Dummy's hand is public once the opening lead has been made. */
  dummyRevealed: boolean;
  tricksNS: number;
  tricksEW: number;
  claim: ClaimState | null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface BoardResult {
  contract: Contract | null;
  /** Tricks won by declarer's side. null when the board was passed out. */
  tricksWon: number | null;
  /** Tricks relative to the contract: +1 = one overtrick, -2 = down two. */
  resultRelative: number | null;
  /** Duplicate score from North-South's point of view (can be negative). */
  scoreNS: number;
  /** True when the auction was four passes. */
  passedOut: boolean;
}

// ---------------------------------------------------------------------------
// Board / deal
// ---------------------------------------------------------------------------

export type Hands = Record<Seat, Card[]>;

export interface Board {
  boardNumber: number;
  dealer: Seat;
  vulnerability: Vulnerability;
  hands: Hands;
  /** Calls in order, starting with the dealer. */
  auction: Call[];
  contract: Contract | null;
  play: PlayState | null;
  result: BoardResult | null;
  /** Deterministic seed used to shuffle this board, for reproducibility. */
  seed: string;
}

export type Phase = 'lobby' | 'auction' | 'play' | 'review' | 'finished';

// ---------------------------------------------------------------------------
// Actions (the only ways game state can change)
// ---------------------------------------------------------------------------

export type GameAction =
  | { kind: 'deal'; boardNumber: number; seed: string }
  | { kind: 'call'; seat: Seat; call: Call }
  | { kind: 'play'; seat: Seat; card: Card }
  | { kind: 'claim'; seat: Seat; tricks: number; statement?: string }
  | { kind: 'claimRespond'; seat: Seat; accept: boolean }
  | { kind: 'undo'; toActionIndex: number }
  | { kind: 'nextBoard'; seed: string };

export interface ActionError {
  code:
    | 'WRONG_PHASE'
    | 'NOT_YOUR_TURN'
    | 'ILLEGAL_CALL'
    | 'ILLEGAL_CARD'
    | 'NOT_YOUR_CARD'
    | 'MUST_FOLLOW_SUIT'
    | 'NO_CLAIM_PENDING'
    | 'BAD_CLAIM'
    | 'NOTHING_TO_UNDO';
  message: string;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ScoringMode = 'duplicate' | 'imp' | 'rubber';

export interface ScoreLine {
  boardNumber: number;
  contractLabel: string;
  declarer: Seat | null;
  tricksWon: number | null;
  resultRelative: number | null;
  scoreNS: number;
  /** IMP swing vs. a datum / opponent score, when scoringMode === 'imp'. */
  imps?: number;
  vulnerability: Vulnerability;
}

export interface MatchScore {
  lines: ScoreLine[];
  totalNS: number;
  totalEW: number;
  impsNS?: number;
  impsEW?: number;
}
