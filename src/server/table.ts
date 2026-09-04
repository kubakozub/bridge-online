/**
 * TableDurableObject - one instance per room code, and the single source of truth for a table.
 *
 * Why a Durable Object: two people in two cities need one authoritative copy of the deal. A DO
 * gives us exactly one instance per room, globally, with strongly consistent storage attached -
 * so there is no way for the two browsers to disagree about who holds the ace of spades.
 *
 * Cards are redacted per recipient before every broadcast. The full hands never leave this
 * object, which means a player cannot read their opponent's cards out of the network tab.
 *
 * Robot moves are played inline, in the same invocation as the human action that preceded them.
 * The first cut drove them off the DO alarm instead, which was tidier but unplayable: alarm
 * latency is measured in seconds, so a three-pass auction took most of a minute. The alarm is
 * still here for everything that genuinely is a timer - turn clocks, covering for a player who
 * dropped out, sweeping idle rooms - and as a fallback if an invocation ends mid-sequence.
 */

import {
  applyAction,
  legalActionsFor,
  newGame,
  startBoard,
  whoseTurn,
  type GameState,
} from '../engine/game';
import { buildMatchScore, scoreLineFromBoard } from '../engine/scoring';
import { contractLabel } from '../engine/auction';
import { canSeeHand, dummySeat, effectiveController } from '../engine/play';
import { isVulnerable, partnerOf, sideOf } from '../engine/deal';
import { randomSeed } from '../engine/cards';
import type {
  ActionError,
  Board,
  Call,
  Card,
  ScoreLine,
  Seat,
  Vulnerability,
} from '../engine/types';
import { SEATS } from '../engine/types';

import { chooseCall } from '../bots/bidding';
import { chooseCard } from '../bots/play';

import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  type BotLevel,
  type ChatMessage,
  type ClientMessage,
  type RedactedHands,
  type SeatOccupant,
  type ServerMessage,
  type TableSettings,
  type TableView,
  type UndoRequest,
} from './protocol';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How long a robot "thinks" before it acts, so the table does not feel like a spreadsheet. */
const BOT_DELAY_MS = { min: 700, max: 1500 };

/**
 * How many robot moves are played inline after a human acts.
 *
 * Robots used to move one-per-alarm, but Durable Object alarms carry several seconds of latency,
 * which made a three-pass auction take the best part of a minute. Playing the consecutive robot
 * moves inside the same invocation keeps them at their intended ~1s pace. The cap bounds how
 * long a single invocation can run; anything beyond it is picked up by the alarm as before.
 */
const MAX_INLINE_BOT_MOVES = 4;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Overrides the robot pacing. Only tests use this - a suite that plays hundreds of boards cannot
 * afford a second of thinking time per card.
 */
let botDelayOverrideMs: number | null = null;

export function setBotDelayForTests(ms: number | null): void {
  botDelayOverrideMs = ms;
}

function botThinkingTime(): number {
  if (botDelayOverrideMs !== null) return botDelayOverrideMs;
  return BOT_DELAY_MS.min + Math.random() * (BOT_DELAY_MS.max - BOT_DELAY_MS.min);
}

/** A disconnected player is covered by a robot after this long, so the game does not stall. */
const TAKEOVER_AFTER_MS = 45_000;

/** Rooms with nobody connected are swept after this long. */
const IDLE_ROOM_TTL_MS = 3 * 60 * 60 * 1000;

/** Keeps the chat log bounded - this is a card game, not a message board. */
const CHAT_LIMIT = 200;

/**
 * Ile wiadomosci czatu jedzie w ramce STANU.
 *
 * Cala historia szla w KAZDEJ ramce, a stan rozsyla sie po kazdej karcie. Zmierzone w audycie:
 * przy zapelnionym czacie ramka rosla z 690 B do 69 684 B, a jeden klient dostal 5,94 MB w 176
 * ramkach — wzmocnienie 89x. Serwer trzyma nadal CHAT_LIMIT wpisow, ale rozsyla tylko ogon.
 */
const CHAT_IN_VIEW = 30;

/** Limit tempa czatu na gracza: jedna wiadomosc na 500 ms i nie wiecej niz 20 na minute. */
const CHAT_MIN_GAP_MS = 500;
const CHAT_PER_MINUTE = 20;

/** Nazwy miejsc po polsku do komunikatów systemowych. Serwer nie importuje nic z src/client. */
const NAZWA_MIEJSCA: Record<Seat, string> = {
  N: 'Północ',
  E: 'Wschód',
  S: 'Południe',
  W: 'Zachód',
};

const MAX_CHAT_LENGTH = 280;
const MAX_NAME_LENGTH = 24;

// ---------------------------------------------------------------------------
// Persisted room shape
// ---------------------------------------------------------------------------

interface Room {
  roomCode: string;
  createdAt: number;
  settings: TableSettings;
  occupants: Record<Seat, SeatOccupant>;
  game: GameState;
  chat: ChatMessage[];
  undoRequest: UndoRequest | null;
  rev: number;
  /** Board number currently in play (or about to be dealt). */
  boardNumber: number;
  /** Epoch ms at which the seat on turn runs out of time; null when untimed. */
  turnDeadline: number | null;
  /** Miejsce, dla którego liczy się turnDeadline — bez tego zegar nie odnawia się przy zmianie gracza. */
  turnDeadlineSeat: Seat | null;
  /** Epoch ms at which the robot on turn should act. */
  botMoveAt: number | null;
  lastActivity: number;
  finalMessage?: string;
}

interface SocketMeta {
  playerId: string;
  name: string;
}

function emptyOccupant(seat: Seat): SeatOccupant {
  return { seat, playerId: null, name: '', isBot: false, connected: false, lastSeen: 0 };
}

function freshRoom(roomCode: string, now: number, settings?: Partial<TableSettings>): Room {
  return {
    roomCode,
    createdAt: now,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    occupants: {
      N: emptyOccupant('N'),
      E: emptyOccupant('E'),
      S: emptyOccupant('S'),
      W: emptyOccupant('W'),
    },
    game: newGame(),
    chat: [],
    undoRequest: null,
    rev: 0,
    boardNumber: 0,
    turnDeadline: null,
    turnDeadlineSeat: null,
    botMoveAt: null,
    lastActivity: now,
  };
}

/**
 * Czy to naprawde jedno z czterech miejsc przy stole.
 *
 * `msg.seat` przychodzi od klienta i trafial wprost jako indeks obiektu (`room.occupants[msg.seat]`),
 * bez zadnego sprawdzenia. Ramki z seat:"__proto__", "constructor" czy "toString" nie rzucaly bledem —
 * przypisanie wykonywalo sie na kluczu spoza SEATS. Dzis nic z tego nie wynikalo, bo widok filtruje
 * przez SEATS, ale to jedyne miejsce, gdzie string od gracza indeksuje obiekt, wiec zamykamy je u zrodla.
 */
function isSeat(value: unknown): value is Seat {
  return typeof value === 'string' && (SEATS as readonly string[]).includes(value);
}

function clean(text: string, max: number): string {
  // Control characters are stripped; the client renders text nodes, so nothing here can
  // become markup. Trimming to a hard cap keeps one player from flooding the other.
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// The object
// ---------------------------------------------------------------------------

export class TableDurableObject implements DurableObject {
  private room: Room | null = null;

  /** Guards against two overlapping inline robot loops racing each other. */
  private botLoopRunning = false;

  /** Znaczniki czasu ostatnich wiadomosci czatu na gracza (tylko w pamieci — limit tempa). */
  private readonly czatOstatnie = new Map<string, number[]>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  // -- storage ---------------------------------------------------------------

  private async load(roomCode = 'UNKNOWN'): Promise<Room> {
    if (this.room) return this.room;
    const stored = await this.ctx.storage.get<Room>('room');
    this.room = stored ?? freshRoom(roomCode, Date.now());
    return this.room;
  }

  private async save(): Promise<void> {
    if (this.room) await this.ctx.storage.put('room', this.room);
  }

  // -- HTTP ------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get('room') ?? 'UNKNOWN';
    const room = await this.load(roomCode);
    room.roomCode = roomCode;

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Hibernation: the runtime can evict this object between messages and revive it on the
      // next frame, which is what makes an idle table free to keep open.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ playerId: '', name: '' } satisfies SocketMeta);

      room.lastActivity = Date.now();
      await this.save();
      await this.scheduleAlarm();

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/info')) {
      return Response.json({
        roomCode: room.roomCode,
        exists: room.boardNumber > 0 || this.seatedCount(room) > 0,
        phase: room.game.phase,
        occupants: SEATS.filter(
          (seat) => room.occupants[seat].playerId !== null || room.occupants[seat].isBot
        ).map((seat) => ({
          seat,
          name: room.occupants[seat].name,
          isBot: room.occupants[seat].isBot,
          connected: room.occupants[seat].connected,
        })),
        settings: room.settings,
        spectatorCount: this.spectatorCount(room),
      });
    }

    if (url.pathname.endsWith('/settings') && request.method === 'POST') {
      const patch = (await request.json()) as Partial<TableSettings>;
      room.settings = this.sanitiseSettings({ ...room.settings, ...patch });
      await this.save();
      // Bez alarmu nie ma kto zamiesc pokoju: jedyne deleteAll siedzi w alarm(), a ta sciezka
      // (POST /api/tables z ustawieniami) zapisywala storage i nigdy nic nie planowala. Kazde
      // 'Utworz stol', po ktorym nikt nie wszedl, zostawalo w pamieci na zawsze.
      await this.scheduleAlarm();
      return Response.json({ ok: true, settings: room.settings });
    }

    return new Response('Not found', { status: 404 });
  }

  // -- WebSocket lifecycle ---------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // A malformed frame is ignored, never fatal.
    }

    const room = await this.load();
    room.lastActivity = Date.now();

    try {
      await this.handle(ws, room, msg);
    } catch (err) {
      console.error('table: handler failed', err);
      this.sendTo(ws, { t: 'toast', level: 'error', text: 'Coś poszło nie tak przy stole.' });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.markDisconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.markDisconnected(ws);
  }

  private async markDisconnected(ws: WebSocket): Promise<void> {
    const room = await this.load();
    const meta = this.metaOf(ws);
    if (!meta.playerId) return;

    // Another tab of the same player may still be connected.
    const stillHere = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && this.metaOf(other).playerId === meta.playerId);
    if (stillHere) return;

    for (const seat of SEATS) {
      const occupant = room.occupants[seat];
      if (occupant.playerId === meta.playerId) {
        occupant.connected = false;
        occupant.lastSeen = Date.now();
      }
    }

    await this.save();
    await this.broadcast(room);
    await this.scheduleAlarm();
  }

  // -- Message handling ------------------------------------------------------

  private async handle(ws: WebSocket, room: Room, msg: ClientMessage): Promise<void> {
    const meta = this.metaOf(ws);

    if (msg.t === 'hello') {
      const playerId = clean(msg.playerId, 64);
      const name = clean(msg.name, MAX_NAME_LENGTH) || 'Gracz';
      ws.serializeAttachment({ playerId, name } satisfies SocketMeta);

      // Reconnect: if this player already owns a seat, hand it straight back. This is what
      // lets someone close the laptop lid mid-rubber and pick up where they left off.
      for (const seat of SEATS) {
        const occupant = room.occupants[seat];
        if (occupant.playerId === playerId) {
          occupant.connected = true;
          occupant.name = name;
          occupant.isBot = false;
          occupant.lastSeen = Date.now();
        }
      }

      await this.save();
      await this.broadcast(room);
      await this.scheduleAlarm();
      return;
    }

    if (!meta.playerId) {
      this.sendTo(ws, { t: 'error', error: { code: 'WRONG_PHASE', message: 'Najpierw hello.' } });
      return;
    }

    const seat = this.seatOfPlayer(room, meta.playerId);

    switch (msg.t) {
      case 'ping':
        // Heartbeat ma też PODTRZYMYWAĆ harmonogram: to często jedyny ruch na stole, na którym
        // ktoś się rozłączył, a bez przeliczenia alarmu przejęcie miejsca przez robota nie ruszy.
        this.sendTo(ws, { t: 'pong', now: Date.now() });
        await this.scheduleAlarm();
        return;

      case 'rename': {
        const name = clean(msg.name, MAX_NAME_LENGTH) || 'Gracz';
        ws.serializeAttachment({ ...meta, name } satisfies SocketMeta);
        if (seat) room.occupants[seat].name = name;
        break;
      }

      case 'sit': {
        if (!isSeat(msg.seat)) return;
        if (seat) break; // already seated
        const target = room.occupants[msg.seat];
        if (target.playerId || (target.isBot && room.game.phase !== 'lobby')) {
          this.sendTo(ws, { t: 'toast', level: 'warn', text: 'To miejsce jest już zajęte.' });
          return;
        }
        room.occupants[msg.seat] = {
          seat: msg.seat,
          playerId: meta.playerId,
          name: meta.name,
          isBot: false,
          connected: true,
          lastSeen: Date.now(),
        };
        this.systemMessage(room, `${meta.name} siada na miejscu ${msg.seat}.`);
        break;
      }

      case 'stand': {
        if (!seat) break;
        if (room.game.phase !== 'lobby' && room.game.phase !== 'review') {
          // Leaving mid-board would strand the other three; a robot takes the chair instead.
          room.occupants[seat] = {
            seat,
            playerId: null,
            name: this.botName(room.settings.botLevel),
            isBot: true,
            botLevel: room.settings.botLevel,
            connected: true,
            lastSeen: Date.now(),
          };
          this.systemMessage(room, `${meta.name} wstaje od stołu — miejsce ${seat} przejmuje robot.`);
        } else {
          room.occupants[seat] = emptyOccupant(seat);
          this.systemMessage(room, `${meta.name} wstaje od stołu.`);
        }
        break;
      }

      case 'addBot': {
        // Widz bez miejsca mogl obsadzic krzesla robotami i wystartowac partie, zanim doszedl
        // partner — a po starcie 'sit' odrzuca miejsce bota, wiec spozniony czlowiek nie mial juz
        // gdzie usiasc. 'setSettings' mial tego straznika od poczatku; tu go brakowalo.
        if (!seat || !isSeat(msg.seat)) return;
        const target = room.occupants[msg.seat];
        if (target.playerId) return;
        const level = msg.level ?? room.settings.botLevel;
        room.occupants[msg.seat] = {
          seat: msg.seat,
          playerId: null,
          name: this.botName(level),
          isBot: true,
          botLevel: level,
          connected: true,
          lastSeen: Date.now(),
        };
        break;
      }

      case 'removeBot': {
        if (!seat || !isSeat(msg.seat)) return;
        const target = room.occupants[msg.seat];
        if (!target.isBot || room.game.phase !== 'lobby') return;
        room.occupants[msg.seat] = emptyOccupant(msg.seat);
        break;
      }

      case 'setSettings': {
        if (!seat) return; // spectators do not change the rules
        room.settings = this.sanitiseSettings({ ...room.settings, ...msg.settings });
        break;
      }

      case 'start': {
        if (!seat) return; // partie rozpoczyna ktos, kto przy niej siedzi
        if (room.game.phase !== 'lobby') return;
        if (this.humanCount(room) === 0) {
          this.sendTo(ws, { t: 'toast', level: 'warn', text: 'Najpierw usiądź przy stole.' });
          return;
        }
        // Any chair still empty when the deal starts is taken by a robot, so a pair of humans
        // can play immediately instead of waiting for four people.
        for (const s of SEATS) {
          if (!room.occupants[s].playerId && !room.occupants[s].isBot) {
            room.occupants[s] = {
              seat: s,
              playerId: null,
              name: this.botName(room.settings.botLevel),
              isBot: true,
              botLevel: room.settings.botLevel,
              connected: true,
              lastSeen: Date.now(),
            };
          }
        }
        room.boardNumber = 1;
        room.game = startBoard(room.game, 1, randomSeed());
        room.undoRequest = null;
        this.systemMessage(room, 'Rozdanie 1 — licytacja.');
        break;
      }

      case 'call': {
        if (!seat) return;
        const turn = whoseTurn(room.game);
        if (turn !== seat) {
          this.sendTo(ws, {
            t: 'error',
            error: { code: 'NOT_YOUR_TURN', message: 'To nie twoja kolej.' },
          });
          return;
        }
        if (!this.applyOrReport(ws, room, { kind: 'call', seat, call: msg.call })) return;
        break;
      }

      case 'play': {
        if (!seat) return;
        const owner = this.cardOwnerForActor(room, seat);
        if (!owner) {
          this.sendTo(ws, {
            t: 'error',
            error: { code: 'NOT_YOUR_TURN', message: 'To nie twoja kolej.' },
          });
          return;
        }
        if (!this.applyOrReport(ws, room, { kind: 'play', seat: owner, card: msg.card })) return;
        break;
      }

      case 'claim': {
        if (!seat) return;
        if (!this.applyOrReport(ws, room, { kind: 'claim', seat, tricks: msg.tricks, statement: msg.statement })) {
          return;
        }
        this.systemMessage(
          room,
          `${meta.name} zapowiada ${msg.tricks} ${msg.tricks === 1 ? 'lewę' : 'lew'}.`
        );
        this.respondToClaimForBots(room);
        break;
      }

      case 'claimRespond': {
        if (!seat) return;
        if (!this.applyOrReport(ws, room, { kind: 'claimRespond', seat, accept: msg.accept })) return;
        this.systemMessage(room, msg.accept ? `${meta.name} akceptuje zapowiedź.` : `${meta.name} odrzuca zapowiedź.`);
        break;
      }

      case 'requestUndo': {
        if (!seat || !room.settings.allowUndo) return;
        const target = this.undoTargetIndex(room, seat);
        if (target === null) {
          this.sendTo(ws, {
            t: 'error',
            error: { code: 'NOTHING_TO_UNDO', message: 'Nie ma czego cofnąć.' },
          });
          return;
        }
        // Only the opponents need to agree - your own partner has no reason to object, and
        // robots always agree, so a pair of humans is never blocked by an empty chair.
        const opponents = SEATS.filter(
          (s) => sideOf(s) !== sideOf(seat) && !room.occupants[s].isBot && room.occupants[s].playerId
        );
        room.undoRequest = {
          by: seat,
          toActionIndex: target,
          description: 'Cofnięcie ostatniego własnego ruchu',
          pending: opponents,
        };
        if (opponents.length === 0) await this.resolveUndo(room, true);
        else this.systemMessage(room, `${meta.name} prosi o cofnięcie ruchu.`);
        break;
      }

      case 'undoRespond': {
        if (!seat || !room.undoRequest) return;
        if (!room.undoRequest.pending.includes(seat)) return;
        if (!msg.accept) {
          room.undoRequest = null;
          this.systemMessage(room, `${meta.name} nie zgadza się na cofnięcie.`);
          break;
        }
        room.undoRequest.pending = room.undoRequest.pending.filter((s) => s !== seat);
        if (room.undoRequest.pending.length === 0) await this.resolveUndo(room, true);
        break;
      }

      case 'nextBoard': {
        if (room.game.phase !== 'review') return;
        if (
          room.settings.boardCount > 0 &&
          room.boardNumber >= room.settings.boardCount
        ) {
          room.game = { ...room.game, phase: 'finished' };
          room.finalMessage = this.finalMessage(room);
          break;
        }
        room.boardNumber += 1;
        const dealt = applyAction(room.game, { kind: 'nextBoard', seed: randomSeed() });
        if (dealt.ok) room.game = dealt.value;
        room.undoRequest = null;
        this.systemMessage(room, `Rozdanie ${room.boardNumber} — licytacja.`);
        break;
      }

      case 'chat': {
        const text = clean(msg.text, MAX_CHAT_LENGTH);
        if (!text) return;
        // Bez limitu jeden uczestnik mogl zdlawic stol: kazda wiadomosc to pelny zapis pokoju do
        // storage i pelny re-broadcast stanu do wszystkich gniazd (zmierzone ~44 wiadomosci/s).
        if (!this.czatDozwolony(meta.playerId)) {
          this.sendTo(ws, { t: 'toast', level: 'warn', text: 'Zwolnij trochę z czatem.' });
          return;
        }
        this.pushChat(room, {
          id: crypto.randomUUID(),
          seat,
          name: meta.name,
          text,
          ts: Date.now(),
          system: false,
        });
        break;
      }
    }

    await this.save();
    // Uzbrojenie zegara i alarmu PRZED rozeslaniem stanu. Wczesniej ramka szla pierwsza i niosla
    // turnDeadline z POPRZEDNIEJ tury (albo null): odliczanie przy plakietce pokazywalo nie to,
    // co trzeba, a klient dowiadywal sie o terminie dopiero z nastepnej ramki. Przy okazji alarm
    // jest uzbrojony, zanim ruszy petla robotow — wywlaszczenie w jej trakcie nie zostawia stolu
    // bez niczego, co by go obudzilo.
    await this.scheduleAlarm();
    await this.broadcast(room);
    await this.runInlineBotTurns(room);
    await this.scheduleAlarm();
  }

  // -- Engine plumbing -------------------------------------------------------

  /** Applies an action, reporting a rejection back to the one player who caused it. */
  /**
   * Odpowiada na zapowiedź za każdego robota, którego o nią zapytano.
   *
   * Bez tego zapowiedź przy stole z robotem wieszała rozdanie NA STAŁE: `pending` to przeciwnicy
   * zapowiadającego, roboty nigdy nie odpowiadały, a przy wiszącej zapowiedzi silnik odrzuca każdą
   * kartę przez WRONG_PHASE (Law 68D). W domyślnym układzie — dwoje ludzi i dwa roboty — trafiało
   * się w to natychmiast; jedynym wyjściem było założenie nowego stołu. Odtworzone w audycie 31.08.
   *
   * Robot ODRZUCA zapowiedź, chyba że zapowiadający po prostu oddaje resztę lew (claimed równe temu,
   * co jego strona już wzięła) — na taką zgodę nie trzeba żadnej oceny sytuacji. To wybór świadomie
   * ostrożny: przyjmowanie w ciemno pozwoliłoby zapowiedzieć 13 lew i wygrać rozdanie bez gry, a po
   * odrzuceniu rozgrywka wraca do normalnego trybu i nikt nic nie traci (Law 68D). Zapowiedzi między
   * dwojgiem ludzi działają bez zmian.
   */
  private respondToClaimForBots(room: Room): void {
    // Pętla, bo pytanych może być dwoje (zapowiedź rozgrywającego idzie do obu obrońców).
    for (let krok = 0; krok < SEATS.length; krok += 1) {
      const play = room.game.board?.play;
      const claim = play?.claim;
      if (!claim || claim.pending.length === 0) return;

      const seat = claim.pending.find((s) => room.occupants[s].isBot);
      if (!seat) return; // zostali sami ludzie — czekamy na nich

      const oddajeReszte = claim.tricks === (sideOf(claim.by) === 'NS' ? play!.tricksNS : play!.tricksEW);
      const before = room.game;
      const result = applyAction(before, { kind: 'claimRespond', seat, accept: oddajeReszte });
      if (!result.ok) return; // nie wieszamy stołu na własnym błędzie
      room.game = result.value;
      this.afterAction(room, before);
      this.systemMessage(
        room,
        oddajeReszte
          ? `Robot (${NAZWA_MIEJSCA[seat]}) przyjmuje zapowiedź.`
          : `Robot (${NAZWA_MIEJSCA[seat]}) nie przyjmuje zapowiedzi — gramy dalej.`
      );
    }
  }

  /** Czy gracz moze teraz napisac na czacie (limit tempa, wylacznie w pamieci obiektu). */
  private czatDozwolony(playerId: string): boolean {
    const teraz = Date.now();
    const historia = (this.czatOstatnie.get(playerId) ?? []).filter((t) => teraz - t < 60_000);
    if (historia.length >= CHAT_PER_MINUTE) return false;
    if (historia.length && teraz - historia[historia.length - 1] < CHAT_MIN_GAP_MS) return false;
    historia.push(teraz);
    this.czatOstatnie.set(playerId, historia);
    return true;
  }

  private applyOrReport(
    ws: WebSocket,
    room: Room,
    action: Parameters<typeof applyAction>[1]
  ): boolean {
    const before = room.game;
    const result = applyAction(before, action);
    if (!result.ok) {
      this.sendTo(ws, { t: 'error', error: result.error });
      return false;
    }
    room.game = result.value;
    this.afterAction(room, before);
    return true;
  }

  /** Housekeeping that has to happen after any successful action. */
  private afterAction(room: Room, before: GameState): void {
    room.undoRequest = null;

    const board = room.game.board;
    const prevPlay = before.board?.play;
    const play = board?.play;

    // A trick just completed - tell the clients so they can animate the sweep.
    if (play && prevPlay) {
      const prevDone = prevPlay.tricks.filter((t) => t.cards.length === 4).length;
      const nowDone = play.tricks.filter((t) => t.cards.length === 4).length;
      if (nowDone > prevDone) {
        const winner = play.tricks[nowDone - 1].winner;
        if (winner) this.broadcastRaw({ t: 'trickComplete', winner, rev: room.rev + 1 });
      }
    }

    // The board finished.
    if (before.phase !== 'review' && room.game.phase === 'review' && board?.result) {
      this.broadcastRaw({ t: 'boardComplete', result: board.result, rev: room.rev + 1 });
      this.systemMessage(room, this.boardSummary(board));

      if (room.settings.boardCount > 0 && room.boardNumber >= room.settings.boardCount) {
        room.game = { ...room.game, phase: 'finished' };
        room.finalMessage = this.finalMessage(room);
      }
    }
  }

  private boardSummary(board: Board): string {
    if (board.result?.passedOut) return `Rozdanie ${board.boardNumber}: spasowane.`;
    const label = contractLabel(board.contract);
    const rel = board.result?.resultRelative ?? 0;
    const relText = rel === 0 ? 'dokładnie' : rel > 0 ? `+${rel}` : `${rel}`;
    return `Rozdanie ${board.boardNumber}: ${label}, ${relText} (NS ${board.result?.scoreNS ?? 0}).`;
  }

  private finalMessage(room: Room): string {
    const score = buildMatchScore(room.game.boardsPlayed, room.settings.scoringMode);
    if (score.totalNS === score.totalEW) return `Remis: ${score.totalNS} : ${score.totalEW}.`;
    const winner = score.totalNS > score.totalEW ? 'NS' : 'EW';
    return `Koniec meczu. Wygrywa ${winner} ${Math.max(score.totalNS, score.totalEW)} : ${Math.min(score.totalNS, score.totalEW)}.`;
  }

  /**
   * Which seat's cards this actor may play right now.
   *
   * Declarer plays dummy's cards, so when it is dummy's turn the action comes from declarer's
   * socket but the card belongs to dummy. Dummy themselves may never play.
   */
  /**
   * Kto steruje kartami z miejsca `turn` — z regula przejecia rozgrywki po robocie.
   *
   * WSZYSTKIE miejsca decydujace o sterowaniu musza wolac to samo, inaczej robot i czlowiek
   * biliby sie o te sama karte: jeden uwazalby, ze to jego kolej, drugi tak samo.
   */
  private controllerFor(room: Room, turn: Seat): Seat {
    const board = room.game.board;
    if (!board?.contract || !board.play) return turn;
    return effectiveController(
      turn,
      board.contract,
      (seat) => room.occupants[seat].isBot,
      room.settings.takeOverBotDeclarer,
    );
  }

  private cardOwnerForActor(room: Room, actor: Seat): Seat | null {
    const board = room.game.board;
    if (!board?.play || !board.contract) return null;
    const turn = board.play.turn;
    return this.controllerFor(room, turn) === actor ? turn : null;
  }

  /**
   * Indeks w historii, do ktorego cofamy: ostatni WLASNY ruch gracza, a nie ostatni ruch przy stole.
   *
   * Pierwsza wersja brala ostatnia akcje w ogole. Poniewaz roboty odpowiadaja inline, zaraz po
   * ruchu czlowieka ostatnia akcja jest zawsze ruch robota — cofniecie zdejmowalo ruch robota,
   * robot natychmiast ruszal ponownie i dla gracza nic sie nie zmienialo. Cofniecie ma zdjac
   * ruch PROSZACEGO i wszystko, co po nim nastapilo; roboty zagraja od nowa.
   *
   * "Wlasny" liczy sie przez sterujacego, nie wlasciciela karty: rozgrywajacy cofa zagranie z
   * reki dziadka, a po przejeciu rozgrywki dziadek-czlowiek cofa zagranie z reki rozgrywajacego.
   *
   * Skan zatrzymuje sie na granicy rozdania (deal / nextBoard). Bez tego prosba o cofniecie zaraz
   * po "Nastepne rozdanie" — zanim ktokolwiek sie odezwal — cofnelaby POPRZEDNIE rozdanie do
   * srodka rozgrywki.
   */
  private undoTargetIndex(room: Room, requester: Seat): number | null {
    const history = room.game.history;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const action = history[i];
      if (action.kind === 'deal' || action.kind === 'nextBoard') return null;
      if (action.kind === 'call' && action.seat === requester) return i;
      if (action.kind === 'play' && this.controllerFor(room, action.seat) === requester) return i;
    }
    return null;
  }

  private async resolveUndo(room: Room, accepted: boolean): Promise<void> {
    const request = room.undoRequest;
    room.undoRequest = null;
    if (!accepted || !request) return;

    const result = applyAction(room.game, { kind: 'undo', toActionIndex: request.toActionIndex });
    if (result.ok) {
      room.game = result.value;
      this.systemMessage(room, 'Ruch cofnięty.');
    }
  }

  // -- Robots ----------------------------------------------------------------

  private botName(level: BotLevel): string {
    const names: Record<BotLevel, string> = {
      beginner: 'Robot (nowicjusz)',
      intermediate: 'Robot',
      advanced: 'Robot (zaawansowany)',
    };
    return names[level];
  }

  /**
   * Plays out the consecutive robot moves that follow a human action, pausing between them so
   * the table reads like people thinking rather than a log dump.
   *
   * Awaited by the caller: an un-awaited promise is not guaranteed to survive the end of the
   * invocation, and a robot that stops halfway through an auction strands the humans. After the
   * cap, `scheduleAlarm` carries on where this left off.
   */
  private async runInlineBotTurns(room: Room): Promise<void> {
    if (this.botLoopRunning) return;
    this.botLoopRunning = true;

    try {
      for (let i = 0; i < MAX_INLINE_BOT_MOVES; i += 1) {
        if (this.botSeatToAct(room) === null) return;

        // Re-arm the fallback alarm BEFORE every sleep. The runtime may evict this object while
        // the loop is waiting, and an eviction between "human acted" and "alarm scheduled" used
        // to wedge the table permanently: nothing was left to wake it up.
        await this.scheduleAlarm();

        await sleep(botThinkingTime());

        // A human may have acted while this was sleeping, so re-check before moving.
        if (this.botSeatToAct(room) === null) return;
        if (!this.makeBotMove(room)) return;

        room.botMoveAt = null;
        // Nastepne miejsce moze byc czlowiekiem z zegarem — jego termin ma byc juz w tej ramce.
        await this.scheduleAlarm();
        await this.broadcast(room);
      }
    } catch (err) {
      console.error('table: inline bot loop failed', err);
    } finally {
      this.botLoopRunning = false;
    }
  }

  /** The seat a robot must act for right now, if any. */
  private botSeatToAct(room: Room): Seat | null {
    const turn = whoseTurn(room.game);
    if (!turn) return null;

    const board = room.game.board;
    // Kartami dziadka gra rozgrywajacy, a przy przejeciu — czlowiek-dziadek zamiast robota.
    const actor = this.controllerFor(room, turn);
    const occupant = room.occupants[actor];

    if (occupant.isBot) return turn;

    // Cover for a human who dropped out mid-board, so the other player is not stuck.
    if (!occupant.connected && Date.now() - occupant.lastSeen > TAKEOVER_AFTER_MS) return turn;

    return null;
  }

  private makeBotMove(room: Room): boolean {
    const turn = whoseTurn(room.game);
    const board = room.game.board;
    if (!turn || !board) return false;

    const actor = this.controllerFor(room, turn);
    const level: BotLevel = room.occupants[actor].botLevel ?? room.settings.botLevel;
    const before = room.game;

    if (room.game.phase === 'auction') {
      let call: Call;
      try {
        call = chooseCall({
          hand: board.hands[turn],
          auction: board.auction,
          dealer: board.dealer,
          seat: turn,
          vulnerability: board.vulnerability,
          level,
        });
      } catch (err) {
        console.error('bot bidding failed, passing', err);
        call = 'P';
      }

      let result = applyAction(room.game, { kind: 'call', seat: turn, call });
      if (!result.ok) {
        // A robot must never wedge the table: fall back to the first legal call.
        const legal = legalActionsFor(room.game, turn).calls;
        result = applyAction(room.game, { kind: 'call', seat: turn, call: legal[0] ?? 'P' });
      }
      if (!result.ok) return false;
      room.game = result.value;
      this.afterAction(room, before);
      return true;
    }

    if (room.game.phase === 'play' && board.play && board.contract) {
      const known: Partial<Record<Seat, Card[]>> = { [turn]: board.hands[turn] };
      const dummy = dummySeat(board.contract.declarer);
      if (board.play.dummyRevealed) known[dummy] = board.hands[dummy];
      // Declarer sees both of their own hands.
      if (actor === board.contract.declarer) known[board.contract.declarer] = board.hands[board.contract.declarer];

      let card: Card;
      try {
        card = chooseCard({
          hand: board.hands[turn],
          play: board.play,
          contract: board.contract,
          seat: turn,
          known,
          level,
        });
      } catch (err) {
        console.error('bot play failed, using first legal card', err);
        card = legalActionsFor(room.game, turn).cards[0];
      }

      let result = applyAction(room.game, { kind: 'play', seat: turn, card });
      if (!result.ok) {
        const legal = legalActionsFor(room.game, turn).cards;
        if (!legal.length) return false;
        result = applyAction(room.game, { kind: 'play', seat: turn, card: legal[0] });
      }
      if (!result.ok) return false;
      room.game = result.value;
      this.afterAction(room, before);
      return true;
    }

    return false;
  }

  // -- Alarm: robot pacing, turn clocks, idle sweep --------------------------

  private async scheduleAlarm(): Promise<void> {
    const room = await this.load();
    const now = Date.now();

    const botSeat = this.botSeatToAct(room);
    room.botMoveAt = botSeat
      ? room.botMoveAt ?? now + BOT_DELAY_MS.min + Math.random() * (BOT_DELAY_MS.max - BOT_DELAY_MS.min)
      : null;

    // Turn clock, for human seats only.
    //
    // Zegar liczy się DLA KONKRETNEGO MIEJSCA. Wcześniej `room.turnDeadline ?? …` ustawiał
    // termin raz i nie odnawiał go przy zmianie gracza, więc drugi człowiek z rzędu dostawał
    // resztkę czasu poprzednika (zmierzone w audycie: 1,0 s zamiast 10 s) i robot odbierał mu ruch.
    const turn = whoseTurn(room.game);
    if (turn && !botSeat && room.settings.turnSeconds > 0) {
      if (room.turnDeadline === null || room.turnDeadlineSeat !== turn) {
        room.turnDeadline = now + room.settings.turnSeconds * 1000;
        room.turnDeadlineSeat = turn;
      }
    } else if (!turn || botSeat) {
      room.turnDeadline = null;
      room.turnDeadlineSeat = null;
    }

    // Przejęcie miejsca przez robota po rozłączeniu.
    //
    // botSeatToAct() zwraca miejsce dopiero PO upływie TAKEOVER_AFTER_MS, więc dopóki próg nie
    // minął, botMoveAt jest null i nic nie budzi Durable Objectu — stół stał w miejscu do czasu,
    // aż ktoś przypadkiem wysłał wiadomość. Dokładamy własny kandydat: moment, w którym próg minie.
    const turnActor =
      turn ? this.controllerFor(room, turn) : turn;
    const opuszczone = turnActor ? room.occupants[turnActor] : null;
    const przejecieO =
      opuszczone && !opuszczone.isBot && !opuszczone.connected && opuszczone.playerId !== null
        ? opuszczone.lastSeen + TAKEOVER_AFTER_MS
        : null;

    const candidates = [room.botMoveAt, room.turnDeadline, przejecieO, room.lastActivity + IDLE_ROOM_TTL_MS]
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));

    await this.save();
    if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  async alarm(): Promise<void> {
    const room = await this.load();
    const now = Date.now();

    // Sweep an abandoned room so storage does not accumulate forever.
    if (this.ctx.getWebSockets().length === 0 && now - room.lastActivity > IDLE_ROOM_TTL_MS) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }

    let changed = false;

    // A robot (or a stand-in for a missing player) acts.
    if (room.botMoveAt !== null && now >= room.botMoveAt) {
      room.botMoveAt = null;
      if (this.botSeatToAct(room) !== null) changed = this.makeBotMove(room) || changed;
    }

    // A human ran out of time: play for them rather than freezing the table.
    if (room.turnDeadline !== null && now >= room.turnDeadline) {
      room.turnDeadline = null;
      const turn = whoseTurn(room.game);
      if (turn) {
        this.systemMessage(room, `Upłynął czas — za ${turn} zagrał robot.`);
        changed = this.makeBotMove(room) || changed;
      }
    }

    if (changed) {
      room.rev += 1;
      await this.scheduleAlarm();
      await this.save();
      await this.broadcastState(room);
    }

    // Chain any further robot moves here rather than waiting for another alarm: alarm latency is
    // measured in seconds, which is far too slow to sit through between two robot passes.
    await this.runInlineBotTurns(room);

    await this.scheduleAlarm();
  }

  // -- Chat ------------------------------------------------------------------

  private pushChat(room: Room, message: ChatMessage): void {
    room.chat.push(message);
    if (room.chat.length > CHAT_LIMIT) room.chat = room.chat.slice(-CHAT_LIMIT);
  }

  private systemMessage(room: Room, text: string): void {
    this.pushChat(room, {
      id: crypto.randomUUID(),
      seat: null,
      name: 'Stół',
      text,
      ts: Date.now(),
      system: true,
    });
  }

  // -- Views + broadcast -----------------------------------------------------

  private metaOf(ws: WebSocket): SocketMeta {
    const attached = ws.deserializeAttachment() as SocketMeta | null;
    return attached ?? { playerId: '', name: '' };
  }

  private seatOfPlayer(room: Room, playerId: string): Seat | null {
    return SEATS.find((s) => room.occupants[s].playerId === playerId) ?? null;
  }

  private seatedCount(room: Room): number {
    return SEATS.filter((s) => room.occupants[s].playerId || room.occupants[s].isBot).length;
  }

  private humanCount(room: Room): number {
    return SEATS.filter((s) => room.occupants[s].playerId).length;
  }

  private spectatorCount(room: Room): number {
    const seated = new Set(SEATS.map((s) => room.occupants[s].playerId).filter(Boolean));
    const watching = new Set(
      this.ctx
        .getWebSockets()
        .map((ws) => this.metaOf(ws).playerId)
        .filter((id) => id && !seated.has(id))
    );
    return watching.size;
  }

  /** Builds the hand view one specific seat is entitled to see. */
  private redactHands(room: Room, viewer: Seat | null): RedactedHands {
    const board = room.game.board!;
    const visible: RedactedHands['visible'] = {};
    const counts = {} as RedactedHands['counts'];

    for (const seat of SEATS) {
      counts[seat] = board.hands[seat].length;
      // Kto przejal rozgrywke po robocie, MUSI widziec reke rozgrywajacego — inaczej dostalby
      // prawo zagrania karty, ktorej nie widzi.
      const przejal =
        board.contract !== null &&
        viewer !== null &&
        seat === board.contract.declarer &&
        this.controllerFor(room, board.contract.declarer) === viewer;

      const allowed =
        viewer === seat ||
        przejal ||
        canSeeHand(viewer, seat, board.play, board.contract) ||
        room.game.phase === 'review' ||
        room.game.phase === 'finished';
      if (allowed) visible[seat] = board.hands[seat];
    }

    return { visible, counts };
  }

  private viewFor(room: Room, playerId: string): TableView {
    const seat = this.seatOfPlayer(room, playerId);
    const board = room.game.board;

    const lines: ScoreLine[] = room.game.boardsPlayed;

    return {
      protocolVersion: PROTOCOL_VERSION,
      roomCode: room.roomCode,
      yourSeat: seat,
      yourPlayerId: playerId,
      phase: room.game.phase,
      settings: room.settings,
      // Only seats that are actually taken. A free chair is expressed by its ABSENCE from this
      // list - that is what lets the client offer "Usiądź" on it. Sending a placeholder with a
      // null playerId instead would make every empty seat render as a disconnected player.
      occupants: SEATS.map((s) => room.occupants[s])
        .filter((occupant) => occupant.playerId !== null || occupant.isBot)
        // BEZPIECZEŃSTWO: nigdy nie wysyłamy CUDZEGO playerId.
        //
        // playerId jest jedynym sekretem wiążącym gracza z miejscem: `hello` z cudzym
        // identyfikatorem oddaje przy nim miejsce razem z kartami. Dopóki ten identyfikator
        // jechał w ramce stanu do wszystkich, każdy przy stole — i każdy widz, któremu
        // przekazano link — mógł go odczytać, otworzyć drugie gniazdo i przejąć czyjąś rękę.
        // Odtworzone na produkcji podczas audytu 31.08.
        //
        // Własne miejsce dostaje swój playerId (klient i tak zna go z localStorage);
        // pozostałe miejsca są tu widziane wyłącznie po nazwie i stanie połączenia.
        // Klient nigdzie nie czyta occupant.playerId, a wolne krzesło rozpoznaje po BRAKU
        // wpisu na liście — dlatego nulowanie pola nie zmienia niczego w interfejsie.
        .map((occupant) => (occupant.seat === seat ? occupant : { ...occupant, playerId: null })),
      spectatorCount: this.spectatorCount(room),
      board: board
        ? {
            boardNumber: board.boardNumber,
            dealer: board.dealer,
            vulnerability: board.vulnerability,
            hands: this.redactHands(room, seat),
            auction: board.auction,
            contract: board.contract,
            play: board.play,
            result: board.result,
          }
        : null,
      score: buildMatchScore(lines, room.settings.scoringMode),
      // Tylko ogon historii — patrz CHAT_IN_VIEW. Swiezo podlaczony klient dostaje ostatnie 30
      // wiadomosci, co w kartach w zupelnosci wystarcza.
      chat: room.chat.slice(-CHAT_IN_VIEW),
      undoRequest: room.undoRequest,
      now: Date.now(),
      turnDeadline: room.turnDeadline,
      rev: room.rev,
      finalMessage: room.finalMessage,
    };
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket died between the check and the send; the close handler will tidy up.
    }
  }

  private broadcastRaw(msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) this.sendTo(ws, msg);
  }

  private async broadcastState(room: Room): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (!meta.playerId) continue;
      this.sendTo(ws, { t: 'state', view: this.viewFor(room, meta.playerId) });
    }
  }

  private async broadcast(room: Room): Promise<void> {
    room.rev += 1;
    await this.save();
    await this.broadcastState(room);
  }

  // -- Settings --------------------------------------------------------------

  private sanitiseSettings(settings: TableSettings): TableSettings {
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(n)));
    return {
      scoringMode: ['duplicate', 'imp', 'rubber'].includes(settings.scoringMode)
        ? settings.scoringMode
        : 'duplicate',
      botLevel: ['beginner', 'intermediate', 'advanced'].includes(settings.botLevel)
        ? settings.botLevel
        : 'intermediate',
      boardCount: clamp(settings.boardCount ?? 8, 0, 64),
      turnSeconds: clamp(settings.turnSeconds ?? 0, 0, 300),
      allowUndo: Boolean(settings.allowUndo),
      autoPlaySingleton: Boolean(settings.autoPlaySingleton),
      showHcp: Boolean(settings.showHcp),
      takeOverBotDeclarer: Boolean(settings.takeOverBotDeclarer),
      isPrivate: Boolean(settings.isPrivate),
    };
  }
}
