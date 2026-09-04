/**
 * Wire protocol between the browser client and the TableDurableObject.
 *
 * The server is authoritative. Clients send `ClientMessage`s; the server
 * answers with `ServerMessage`s. Every state broadcast is *redacted per
 * recipient* - a player only ever receives the cards they are entitled to see
 * (their own hand, and dummy once the opening lead is out).
 */

import type {
  Board,
  Call,
  Card,
  MatchScore,
  Phase,
  Seat,
  ScoringMode,
  Vulnerability,
  Contract,
  PlayState,
  BoardResult,
  ActionError,
} from '../engine/types';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Occupants
// ---------------------------------------------------------------------------

export type BotLevel = 'beginner' | 'intermediate' | 'advanced';

export interface SeatOccupant {
  seat: Seat;
  /** Stable per-browser identity; absent for bots. */
  playerId: string | null;
  name: string;
  isBot: boolean;
  botLevel?: BotLevel;
  connected: boolean;
  /** Milliseconds since epoch of the last message from this player. */
  lastSeen: number;
}

export interface TableSettings {
  scoringMode: ScoringMode;
  botLevel: BotLevel;
  /** Number of boards in the match; 0 = play forever. */
  boardCount: number;
  /** Seconds per turn; 0 = untimed. */
  turnSeconds: number;
  /** Allow undo requests during play. */
  allowUndo: boolean;
  /** Auto-play the last card when a player has only one legal option. */
  autoPlaySingleton: boolean;
  /** Show a running count of high-card points for your own hand. */
  showHcp: boolean;
  /** Table is only joinable by someone who has the room code. */
  isPrivate: boolean;
  /**
   * Gdy rozgrywajacym zostanie ROBOT, a dziadkiem czlowiek — czlowiek przejmuje rozgrywke i gra
   * obiema rekami strony rozgrywajacej.
   *
   * Bez tego gracz, ktory wypadnie na dziadka przy robocie-partnerze, nie ma przez cale rozdanie
   * ani jednej decyzji: prawo brydzowe mowi, ze dziadek nie dotyka wlasnych kart. Formalnie
   * poprawne, ale przy stole z robotami po prostu nie ma w co grac.
   */
  takeOverBotDeclarer: boolean;
}

export const DEFAULT_SETTINGS: TableSettings = {
  scoringMode: 'duplicate',
  botLevel: 'intermediate',
  boardCount: 8,
  turnSeconds: 0,
  allowUndo: true,
  autoPlaySingleton: false,
  showHcp: true,
  isPrivate: false,
  takeOverBotDeclarer: true,
};

// ---------------------------------------------------------------------------
// The view a single client receives
// ---------------------------------------------------------------------------

/** Hands, redacted: a seat maps either to its cards or to just a card count. */
export interface RedactedHands {
  /** Cards the viewer is allowed to see, per seat. */
  visible: Partial<Record<Seat, Card[]>>;
  /** How many cards each seat still holds - always visible to everyone. */
  counts: Record<Seat, number>;
}

export interface BoardView {
  boardNumber: number;
  dealer: Seat;
  vulnerability: Vulnerability;
  hands: RedactedHands;
  auction: Call[];
  contract: Contract | null;
  play: PlayState | null;
  result: BoardResult | null;
}

export interface ChatMessage {
  id: string;
  seat: Seat | null;
  name: string;
  text: string;
  ts: number;
  /** System notices ("West claimed 11 tricks") render differently. */
  system: boolean;
}

export interface UndoRequest {
  by: Seat;
  toActionIndex: number;
  description: string;
  pending: Seat[];
}

export interface TableView {
  protocolVersion: number;
  roomCode: string;
  /** The seat this client currently occupies; null while spectating. */
  yourSeat: Seat | null;
  yourPlayerId: string;
  phase: Phase;
  settings: TableSettings;
  occupants: SeatOccupant[];
  spectatorCount: number;
  board: BoardView | null;
  score: MatchScore;
  chat: ChatMessage[];
  undoRequest: UndoRequest | null;
  /** Server clock, so clients can render turn timers without drift. */
  now: number;
  /** Epoch ms when the current turn expires; null when untimed. */
  turnDeadline: number | null;
  /** Monotonic revision - clients drop out-of-order broadcasts. */
  rev: number;
  /** Set when the match is over. */
  finalMessage?: string;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'hello'; playerId: string; name: string; protocolVersion: number }
  | { t: 'sit'; seat: Seat }
  | { t: 'stand' }
  | { t: 'rename'; name: string }
  | { t: 'setSettings'; settings: Partial<TableSettings> }
  | { t: 'addBot'; seat: Seat; level?: BotLevel }
  | { t: 'removeBot'; seat: Seat }
  | { t: 'start' }
  | { t: 'call'; call: Call }
  | { t: 'play'; card: Card }
  | { t: 'claim'; tricks: number; statement?: string }
  | { t: 'claimRespond'; accept: boolean }
  | { t: 'requestUndo' }
  | { t: 'undoRespond'; accept: boolean }
  | { t: 'nextBoard' }
  | { t: 'chat'; text: string }
  | { t: 'ping' };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { t: 'state'; view: TableView }
  | { t: 'error'; error: ActionError }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'pong'; now: number }
  /** Fired right after a trick completes so the client can animate before clearing. */
  | { t: 'trickComplete'; winner: Seat; rev: number }
  | { t: 'boardComplete'; result: BoardResult; rev: number }
  | { t: 'kicked'; reason: string };

// ---------------------------------------------------------------------------
// REST payloads (lobby)
// ---------------------------------------------------------------------------

export interface CreateTableRequest {
  name?: string;
  settings?: Partial<TableSettings>;
}

export interface CreateTableResponse {
  roomCode: string;
  joinUrl: string;
}

export interface TableInfoResponse {
  roomCode: string;
  exists: boolean;
  phase: Phase;
  occupants: { seat: Seat; name: string; isBot: boolean; connected: boolean }[];
  settings: TableSettings;
  spectatorCount: number;
}
