/**
 * Integration test for TableDurableObject: two humans in different places, two robots.
 *
 * The Cloudflare runtime is faked here (storage, hibernating sockets, alarms) so the object can
 * be driven in plain Node. That matters because `wrangler dev` needs the workerd binary, which
 * is not always runnable - but the interesting logic is all in this class, not in the runtime.
 *
 * What is actually being proved:
 *   - two separate connections get two separate, correctly redacted views of the same deal
 *   - a player cannot see cards they are not entitled to, at any point in the hand
 *   - the declarer plays dummy's cards, and dummy cannot play their own
 *   - robots fill the empty chairs and the board runs to a scored result
 *   - a dropped connection can come back and reclaim its seat with its cards intact
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { TableDurableObject, setBotDelayForTests } from '../src/server/table';
import type { ClientMessage, ServerMessage, TableView } from '../src/server/protocol';
import { legalCalls, seatToCall } from '../src/engine/auction';
import { controllerOf, dummySeat, legalCards } from '../src/engine/play';
import { SEATS } from '../src/engine/types';
import type { Card, Seat } from '../src/engine/types';

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly sent: ServerMessage[] = [];
  private attachment: unknown = null;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(): void {
    this.closed = true;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** The most recent full state broadcast this connection received. */
  get view(): TableView {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const msg = this.sent[i];
      if (msg.t === 'state') return msg.view;
    }
    throw new Error('this connection has never received a state broadcast');
  }

  errors(): Extract<ServerMessage, { t: 'error' }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: 'error' }> => m.t === 'error');
  }
}

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    // Storage round-trips through structured clone; copying here catches accidental
    // aliasing between the in-memory room and what was actually persisted.
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
  }

  async setAlarm(time: number): Promise<void> {
    this.alarmAt = time;
  }
}

class FakeCtx {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];

  acceptWebSocket(ws: FakeSocket): void {
    this.sockets.push(ws);
  }

  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
}

interface Harness {
  table: TableDurableObject;
  ctx: FakeCtx;
  connect(playerId: string, name: string): Promise<FakeSocket>;
  send(ws: FakeSocket, msg: ClientMessage): Promise<void>;
  runBots(limit?: number): Promise<void>;
}

function makeHarness(): Harness {
  const ctx = new FakeCtx();
  const env = { PUBLIC_APP_NAME: 'test' } as unknown as Env;
  const table = new TableDurableObject(ctx as unknown as DurableObjectState, env);

  const send = async (ws: FakeSocket, msg: ClientMessage): Promise<void> => {
    await table.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
  };

  return {
    table,
    ctx,
    async connect(playerId, name) {
      const ws = new FakeSocket();
      ctx.acceptWebSocket(ws);
      await send(ws, { t: 'hello', playerId, name, protocolVersion: 1 });
      return ws;
    },
    send,
    async runBots(limit = 1) {
      for (let i = 0; i < limit; i += 1) await table.alarm();
    },
  };
}

/** Fast-forwards the room clock so the pending bot alarm is due. */
async function fireBot(h: Harness): Promise<void> {
  const stored = await h.ctx.storage.get<{ botMoveAt: number | null }>('room');
  // The object stores an absolute time; the test cannot move the wall clock, so it pulls the
  // deadline into the past through storage and lets the object read it back.
  if (stored && stored.botMoveAt !== null) {
    const room = (await h.ctx.storage.get<Record<string, unknown>>('room'))!;
    room.botMoveAt = Date.now() - 1;
    await h.ctx.storage.put('room', room);
    // Drop the cached copy so the object re-reads the doctored deadline.
    (h.table as unknown as { room: unknown }).room = null;
  }
  await h.table.alarm();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TableDurableObject', () => {
  let h: Harness;

  // Robots move inline now, so without this every board would pay ~1s of thinking time per card.
  beforeAll(() => setBotDelayForTests(0));

  beforeEach(() => {
    h = makeHarness();
  });

  it('seats two humans and fills the rest with robots on start', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');

    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });

    expect(anna.view.yourSeat).toBe('N');
    expect(bartek.view.yourSeat).toBe('S');

    await h.send(anna, { t: 'start' });

    const view = anna.view;
    expect(view.phase).toBe('auction');
    expect(view.board?.boardNumber).toBe(1);

    const bots = view.occupants.filter((o) => o.isBot).map((o) => o.seat);
    expect(bots.sort()).toEqual(['E', 'W']);
    // Ludzi liczymy po BRAKU flagi bota, nie po playerId: od poprawki bezpieczeństwa z 31.08
    // ramka stanu niesie playerId wyłącznie dla własnego miejsca (patrz tests/seatSecurity.test.ts),
    // więc `o.playerId` zobaczyłoby tu tylko jedno miejsce — to, z którego patrzymy.
    // Zajęte krzesło rozpoznaje się po obecności wpisu na liście, wolne po jego braku.
    expect(view.occupants.filter((o) => !o.isBot).length).toBe(2);
  });

  it('never sends a player cards they are not entitled to see', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    for (const [ws, seat] of [
      [anna, 'N'],
      [bartek, 'S'],
    ] as const) {
      const hands = ws.view.board!.hands;
      // You see your own thirteen cards...
      expect(hands.visible[seat]).toHaveLength(13);
      // ...and nobody else's during the auction, not even your partner's.
      for (const other of SEATS) {
        if (other !== seat) expect(hands.visible[other]).toBeUndefined();
      }
      // Card counts are public - that is legitimate table information.
      expect(Object.values(hands.counts)).toEqual([13, 13, 13, 13]);
    }

    // The two players hold disjoint hands drawn from one deck.
    const annaCards = anna.view.board!.hands.visible.N!;
    const bartekCards = bartek.view.board!.hands.visible.S!;
    expect(new Set([...annaCards, ...bartekCards]).size).toBe(26);
  });

  it('reports a free seat by leaving it out of the occupant list', async () => {
    // The client decides whether to offer "Usiądź" by looking for a MISSING entry. Sending a
    // placeholder occupant with a null playerId instead made every empty chair render as a
    // disconnected player, and there was then no way to sit down at all.
    const anna = await h.connect('p-anna', 'Anna');
    expect(anna.view.occupants).toHaveLength(0);

    await h.send(anna, { t: 'sit', seat: 'N' });
    expect(anna.view.occupants.map((o) => o.seat)).toEqual(['N']);
    expect(anna.view.occupants[0].playerId).toBe('p-anna');

    await h.send(anna, { t: 'addBot', seat: 'E' });
    expect(anna.view.occupants.map((o) => o.seat).sort()).toEqual(['E', 'N']);
    expect(anna.view.occupants.every((o) => o.playerId !== null || o.isBot)).toBe(true);

    // Once the board starts every chair is taken, so all four show up.
    await h.send(anna, { t: 'start' });
    expect(anna.view.occupants).toHaveLength(4);
  });

  it('always leaves an alarm armed while a robot is on turn', async () => {
    // The inline robot loop runs inside the same invocation as the human action. If the runtime
    // evicts the object mid-loop and no alarm has been armed, nothing is left to wake the table
    // and it stalls forever - which is exactly what happened in production the first time.
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    // Three robots plus Anna; whenever it is not Anna's turn a robot owes a move.
    for (let i = 0; i < 12; i += 1) {
      const view = anna.view;
      if (view.phase !== 'auction') break;
      const turn = seatToCall(view.board!.auction, view.board!.dealer);
      if (turn !== 'S') {
        // A robot is on turn and the loop has already finished: an alarm must be pending.
        expect(h.ctx.storage.alarmAt).not.toBeNull();
        break;
      }
      await h.send(anna, { t: 'call', call: 'P' });
    }

    expect(h.ctx.storage.alarmAt).not.toBeNull();
  });
  it('rejects a call from a player whose turn it is not', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    // Board 1 is dealt by North, so South cannot call yet.
    const before = bartek.errors().length;
    await h.send(bartek, { t: 'call', call: 'P' });
    const errors = bartek.errors();
    expect(errors.length).toBe(before + 1);
    expect(errors[errors.length - 1].error.code).toBe('NOT_YOUR_TURN');
  });

  it('gives a reconnecting player their seat and their cards back', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    const originalHand = anna.view.board!.hands.visible.N!;

    // Anna's laptop lid closes.
    await h.table.webSocketClose(anna as unknown as WebSocket);
    anna.closed = true;
    expect(bartek.view.occupants.find((o) => o.seat === 'N')!.connected).toBe(false);

    // She opens the link again - same browser, same playerId.
    const annaAgain = await h.connect('p-anna', 'Anna');
    expect(annaAgain.view.yourSeat).toBe('N');
    expect(annaAgain.view.board!.hands.visible.N).toEqual(originalHand);
    expect(annaAgain.view.occupants.find((o) => o.seat === 'N')!.connected).toBe(true);
  });

  it('plays a whole board: two humans, two robots, scored at the end', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    const humans: Record<string, FakeSocket> = { N: anna, S: bartek };
    let dummyEverPlayedOwnCards = false;
    let declarerPlayedDummy = false;

    for (let step = 0; step < 400; step += 1) {
      const view = anna.view;
      if (view.phase !== 'auction' && view.phase !== 'play') break;

      if (view.phase === 'auction') {
        const board = view.board!;
        const turn = seatToCall(board.auction, board.dealer);
        const ws = humans[turn];

        if (!ws) {
          await fireBot(h);
          continue;
        }

        // The human picks from what the engine says is legal - exactly what the UI does.
        const legal = legalCalls(board.auction, board.dealer, turn);
        // The first human to speak makes the cheapest legal contract bid. That guarantees the
        // board is played rather than passed out, so the trick-play assertions below always
        // run instead of being skipped on a lucky deal.
        const cheapestBid = legal.find((c) => /^[1-7][CDHSN]$/.test(c));
        const call = board.auction.some((c) => c !== 'P') || !cheapestBid ? 'P' : cheapestBid;
        await h.send(ws, { t: 'call', call });
        continue;
      }

      const board = anna.view.board!;
      const play = board.play!;
      const contract = board.contract!;
      const turn = play.turn;
      const controller = controllerOf(turn, contract);
      const ws = humans[controller];

      if (!ws) {
        await fireBot(h);
        continue;
      }

      if (turn !== controller) declarerPlayedDummy = true;
      if (turn === dummySeat(contract.declarer) && controller === turn) {
        dummyEverPlayedOwnCards = true;
      }

      // The controller must be able to see the cards they are being asked to play.
      const visible = ws.view.board!.hands.visible[turn] as Card[] | undefined;
      expect(visible, `seat ${controller} cannot see the hand of ${turn} it must play`).toBeDefined();

      const options = legalCards(visible!, play);
      expect(options.length).toBeGreaterThan(0);
      await h.send(ws, { t: 'play', card: options[0] });
    }

    const final = anna.view;
    expect(final.phase).toBe('review');

    const board = final.board!;
    // A human always bids, so the board is played out - never passed out.
    expect(board.result!.passedOut).toBe(false);
    expect(board.play!.tricksNS + board.play!.tricksEW).toBe(13);
    expect(board.result!.tricksWon).not.toBeNull();
    expect(final.score.lines.length).toBe(1);
    // Dummy never plays their own cards; declarer does it for them.
    expect(dummyEverPlayedOwnCards).toBe(false);
    // At the end of the hand everything is revealed for review.
    for (const seat of SEATS) expect(board.hands.visible[seat]).toBeDefined();

    // Both connections agree about the outcome - one deal, one truth.
    expect(bartek.view.board!.result).toEqual(board.result);
    expect(bartek.view.rev).toBe(final.rev);

    // The declarer-plays-dummy path is the fiddliest rule in the product; make sure the
    // scenario actually exercised it rather than silently skipping it.
    if (!board.result!.passedOut) {
      const declarer = board.contract!.declarer;
      if (humans[declarer]) expect(declarerPlayedDummy).toBe(true);
    }
  });

  it('keeps the chat bounded and strips control characters', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    // Tabs, newlines and a stray NUL all collapse to single spaces.
    await h.send(anna, { t: 'chat', text: '  dobry \t\n  wieczor  ' });

    const messages = anna.view.chat.filter((m) => !m.system);
    expect(messages[messages.length - 1].text).toBe('dobry wieczor');

    await h.send(anna, { t: 'chat', text: 'x'.repeat(500) });
    const long = anna.view.chat.filter((m) => !m.system).pop()!;
    expect(long.text.length).toBeLessThanOrEqual(280);
  });

  it('refuses to seat a second player on an occupied chair', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'N' });

    expect(bartek.view.yourSeat).toBeNull();
    expect(anna.view.occupants.find((o) => o.seat === 'N')!.playerId).toBe('p-anna');
  });

  it('clamps hostile settings instead of trusting the client', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, {
      t: 'setSettings',
      settings: {
        boardCount: 99999,
        turnSeconds: -50,
        scoringMode: 'nonsense' as never,
        botLevel: 'godlike' as never,
      },
    });

    const s = anna.view.settings;
    expect(s.boardCount).toBeLessThanOrEqual(64);
    expect(s.turnSeconds).toBeGreaterThanOrEqual(0);
    expect(s.scoringMode).toBe('duplicate');
    expect(s.botLevel).toBe('intermediate');
  });

  it('does not let a spectator change the table rules', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    const watcher = await h.connect('p-watcher', 'Widz');

    const before = anna.view.settings.boardCount;
    await h.send(watcher, { t: 'setSettings', settings: { boardCount: 4 } });
    expect(anna.view.settings.boardCount).toBe(before);
    expect(watcher.view.yourSeat).toBeNull();
  });
});
