/**
 * Przeplywy stolu, ktorych nie pokrywal zaden test: cofanie ruchu, przejscie do nastepnego
 * rozdania i koniec meczu, wstanie od stolu w trakcie gry, zmiana imienia.
 *
 * To sa sciezki, na ktorych gra "sie psuje" w oczach gracza: cofniecie, ktore nic nie robi,
 * mecz, ktory nie chce sie skonczyc, robot, ktory nie przejmuje pustego krzesla. Kazdy test
 * patrzy wylacznie na to, co widzi klient (TableView), a nie na wnetrze obiektu.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { TableDurableObject, setBotDelayForTests } from '../src/server/table';
import type { ClientMessage, ServerMessage, TableView } from '../src/server/protocol';
import { legalCalls, seatToCall } from '../src/engine/auction';
import { effectiveController, legalCards } from '../src/engine/play';
import type { Card, Seat } from '../src/engine/types';

// ---------------------------------------------------------------------------
// Atrapa srodowiska Cloudflare (ta sama co w table.integration.test.ts)
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly sent: ServerMessage[] = [];
  private attachment: unknown = null;
  closed = false;
  send(data: string): void { this.sent.push(JSON.parse(data) as ServerMessage); }
  close(): void { this.closed = true; }
  serializeAttachment(value: unknown): void { this.attachment = value; }
  deserializeAttachment(): unknown { return this.attachment; }
  get view(): TableView {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const msg = this.sent[i];
      if (msg.t === 'state') return msg.view;
    }
    throw new Error('brak ramki stanu');
  }
  toasts(): string[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: 'toast' }> => m.t === 'toast').map((m) => m.text);
  }
}

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  async put(key: string, value: unknown): Promise<void> { this.map.set(key, JSON.parse(JSON.stringify(value))); }
  async deleteAll(): Promise<void> { this.map.clear(); }
  async setAlarm(time: number): Promise<void> { this.alarmAt = time; }
}

class FakeCtx {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  acceptWebSocket(ws: FakeSocket): void { this.sockets.push(ws); }
  getWebSockets(): FakeSocket[] { return this.sockets.filter((s) => !s.closed); }
}

interface Harness {
  table: TableDurableObject;
  ctx: FakeCtx;
  connect(playerId: string, name: string): Promise<FakeSocket>;
  send(ws: FakeSocket, msg: ClientMessage): Promise<void>;
}

function makeHarness(): Harness {
  const ctx = new FakeCtx();
  const table = new TableDurableObject(ctx as unknown as DurableObjectState, {} as unknown as Env);
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
  };
}

/**
 * Rozgrywa biezace rozdanie do fazy review. Ludzie graja pierwsza legalna karta / pasuja
 * (albo licytuja najtansza odzywke na starcie, zeby rozdanie nie bylo spasowane). Roboty ruszaja
 * same, inline, po kazdym ruchu czlowieka.
 */
async function playBoardToReview(h: Harness, humans: Partial<Record<Seat, FakeSocket>>, forceContract = true): Promise<void> {
  for (let step = 0; step < 400; step += 1) {
    const any = Object.values(humans)[0]!;
    const view = any.view;
    if (view.phase !== 'auction' && view.phase !== 'play') return;
    const board = view.board!;

    if (view.phase === 'auction') {
      const turn = seatToCall(board.auction, board.dealer);
      const ws = humans[turn];
      if (!ws) throw new Error(`robot na ${turn} nie ruszyl sie inline`);
      const legal = legalCalls(board.auction, board.dealer, turn);
      const bid = legal.find((c) => /^[1-7][CDHSN]$/.test(c));
      const call = forceContract && !board.auction.some((c) => c !== 'P') && bid ? bid : 'P';
      await h.send(ws, { t: 'call', call });
      continue;
    }

    const play = board.play!;
    const controller = controllerIn(view, play.turn);
    const ws = humans[controller];
    if (!ws) throw new Error(`robot ${controller} nie ruszyl sie inline`);
    const visible = ws.view.board!.hands.visible[play.turn] as Card[] | undefined;
    if (!visible) throw new Error(`${controller} nie widzi reki ${play.turn}`);
    await h.send(ws, { t: 'play', card: legalCards(visible, play)[0] });
  }
  throw new Error('rozdanie nie zakonczylo sie w 400 ruchach');
}

/**
 * Kto steruje karta z miejsca `turn` — wg TEJ SAMEJ reguly co serwer, lacznie z przejeciem
 * rozgrywki po robocie. Pierwsza wersja uzywala golego controllerOf i test byl losowo czerwony:
 * gdy robot zostal rozgrywajacym, a czlowiek dziadkiem, serwer oddawal reke czlowiekowi, a
 * atrapa czekala na ruch robota, ktory juz nie mial czym grac.
 */
function controllerIn(view: TableView, turn: Seat): Seat {
  const isBot = (seat: Seat): boolean => view.occupants.some((o) => o.seat === seat && o.isBot);
  return effectiveController(turn, view.board!.contract!, isBot, view.settings.takeOverBotDeclarer);
}

// ---------------------------------------------------------------------------

describe('cofanie ruchu', () => {
  let h: Harness;
  beforeAll(() => setBotDelayForTests(0));
  beforeEach(() => { h = makeHarness(); });

  it('cofa odzywke za zgoda ludzkiego przeciwnika', async () => {
    // N i E to ludzie (przeciwnicy), S i W roboty. Rozdanie 1 rozdaje N.
    const anna = await h.connect('p-anna', 'Anna');
    const ewa = await h.connect('p-ewa', 'Ewa');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(ewa, { t: 'sit', seat: 'E' });
    await h.send(anna, { t: 'start' });

    await h.send(anna, { t: 'call', call: '1C' });
    expect(anna.view.board!.auction).toEqual(['1C']);

    await h.send(anna, { t: 'requestUndo' });
    const req = ewa.view.undoRequest;
    expect(req).not.toBeNull();
    expect(req!.by).toBe('N');
    expect(req!.pending).toEqual(['E']);

    await h.send(ewa, { t: 'undoRespond', accept: true });
    expect(anna.view.undoRequest).toBeNull();
    expect(anna.view.board!.auction).toEqual([]);
    expect(anna.view.phase).toBe('auction');
  });

  it('odmowa przeciwnika zostawia stol bez zmian', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const ewa = await h.connect('p-ewa', 'Ewa');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(ewa, { t: 'sit', seat: 'E' });
    await h.send(anna, { t: 'start' });
    await h.send(anna, { t: 'call', call: '1C' });

    await h.send(anna, { t: 'requestUndo' });
    await h.send(ewa, { t: 'undoRespond', accept: false });

    expect(anna.view.undoRequest).toBeNull();
    expect(anna.view.board!.auction).toEqual(['1C']);
  });

  it('cofa WLASNY ostatni ruch gracza, a nie ostatni ruch przy stole (robotow)', async () => {
    // Tylko Anna jest czlowiekiem. Po jej 1C trzy roboty odzywaja sie inline, wiec ostatnim
    // ruchem przy stole jest ruch robota z W. Cofniecie, ktore zdejmuje ruch robota, jest dla
    // gracza bezuzyteczne: robot natychmiast ruszy ponownie i nic sie nie zmieni. Cofniecie ma
    // zdjac odzywke ANNY (i wszystko po niej), tak jak w kazdym programie do brydza.
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'start' });

    await h.send(anna, { t: 'call', call: '1C' });
    const auctionAfter = anna.view.board!.auction;
    expect(auctionAfter[0]).toBe('1C');
    expect(auctionAfter.length).toBeGreaterThanOrEqual(2); // roboty sie odezwaly

    // Brak ludzkich przeciwnikow => zgoda automatyczna, cofniecie od razu.
    await h.send(anna, { t: 'requestUndo' });
    expect(anna.view.undoRequest).toBeNull();
    expect(anna.view.board!.auction).toEqual([]);
    expect(seatToCall(anna.view.board!.auction, anna.view.board!.dealer)).toBe('N');
  });

  it('cofa zagrana karte i oddaje ja do reki', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const ewa = await h.connect('p-ewa', 'Ewa');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(ewa, { t: 'sit', seat: 'E' });
    await h.send(anna, { t: 'start' });
    const humans: Partial<Record<Seat, FakeSocket>> = { N: anna, E: ewa };

    // Anna otwiera 1C, potem oboje tylko pasuja; roboty (S, W) licytuja, co chca. Nie zgadujemy
    // przebiegu — pętla idzie, az stol wejdzie w rozgrywke.
    await h.send(anna, { t: 'call', call: '1C' });
    for (let i = 0; i < 40 && anna.view.phase === 'auction'; i += 1) {
      const b = anna.view.board!;
      const ws = humans[seatToCall(b.auction, b.dealer)];
      if (!ws) throw new Error('robot nie ruszyl sie inline');
      await h.send(ws, { t: 'call', call: 'P' });
    }
    expect(anna.view.phase).toBe('play');

    // Po wejsciu w rozgrywke roboty zagraly inline az do pierwszego ruchu czlowieka.
    const board = anna.view.board!;
    const play = board.play!;
    const owner = play.turn;
    const controller = controllerIn(anna.view, owner);
    const actor = humans[controller];
    expect(actor, `sterujacy ${controller} musi byc czlowiekiem`).toBeDefined();
    const opponent = controller === 'N' ? ewa : anna;

    const hand = actor!.view.board!.hands.visible[owner]!;
    const trickBefore = play.tricks[play.tricks.length - 1].cards.length;
    const card = legalCards(hand, play)[0];
    await h.send(actor!, { t: 'play', card });
    expect(actor!.view.board!.hands.visible[owner]).not.toContain(card);

    // Cofniecie: zgode daje ludzki przeciwnik, roboty nie glosuja.
    await h.send(actor!, { t: 'requestUndo' });
    expect(opponent.view.undoRequest).not.toBeNull();
    await h.send(opponent, { t: 'undoRespond', accept: true });

    const after = actor!.view.board!.play!;
    expect(actor!.view.board!.hands.visible[owner]).toContain(card);
    expect(after.turn).toBe(owner);
    expect(after.tricks[after.tricks.length - 1].cards).toHaveLength(trickBefore);
  });

  it('gdy cofanie jest wylaczone w ustawieniach, prosba jest ignorowana', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'setSettings', settings: { allowUndo: false } });
    await h.send(anna, { t: 'start' });
    await h.send(anna, { t: 'call', call: '1C' });
    const before = anna.view.board!.auction.slice();

    await h.send(anna, { t: 'requestUndo' });
    expect(anna.view.undoRequest).toBeNull();
    expect(anna.view.board!.auction).toEqual(before);
  });
});

describe('nastepne rozdanie i koniec meczu', () => {
  let h: Harness;
  beforeAll(() => setBotDelayForTests(0));
  beforeEach(() => { h = makeHarness(); });

  it('prowadzi mecz z dwoch rozdan do konca i wystawia wynik', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'setSettings', settings: { boardCount: 2 } });
    await h.send(anna, { t: 'start' });
    expect(anna.view.board!.boardNumber).toBe(1);

    await playBoardToReview(h, { N: anna, S: bartek });
    expect(anna.view.phase).toBe('review');
    expect(anna.view.score.lines).toHaveLength(1);

    await h.send(anna, { t: 'nextBoard' });
    expect(anna.view.phase).toBe('auction');
    expect(anna.view.board!.boardNumber).toBe(2);
    // Rozdanie 2 rozdaje E — zgodnie z rotacja, nie "zawsze N".
    expect(anna.view.board!.dealer).toBe('E');

    await playBoardToReview(h, { N: anna, S: bartek });
    expect(anna.view.score.lines).toHaveLength(2);

    // Po ostatnim rozdaniu "nastepne" konczy mecz zamiast rozdawac trzecie.
    await h.send(anna, { t: 'nextBoard' });
    expect(anna.view.phase).toBe('finished');
    expect(anna.view.finalMessage).toBeTruthy();
    expect(bartek.view.phase).toBe('finished');
    expect(bartek.view.finalMessage).toBe(anna.view.finalMessage);

    // Kolejne "nastepne" niczego nie psuje.
    await h.send(anna, { t: 'nextBoard' });
    expect(anna.view.phase).toBe('finished');
  });

  it('nie rozdaje nastepnego rozdania w trakcie gry', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'start' });
    const before = anna.view.board!.boardNumber;
    await h.send(anna, { t: 'nextBoard' });
    expect(anna.view.phase).toBe('auction');
    expect(anna.view.board!.boardNumber).toBe(before);
  });
});

describe('wstawanie od stolu i imie', () => {
  let h: Harness;
  beforeAll(() => setBotDelayForTests(0));
  beforeEach(() => { h = makeHarness(); });

  it('w poczekalni wstanie zwalnia krzeslo', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    expect(anna.view.yourSeat).toBe('N');
    await h.send(anna, { t: 'stand' });
    expect(anna.view.yourSeat).toBeNull();
    expect(anna.view.occupants.find((o) => o.seat === 'N')).toBeUndefined();
  });

  it('w trakcie rozdania wstanie oddaje krzeslo robotowi i gra idzie dalej', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(bartek, { t: 'sit', seat: 'S' });
    await h.send(anna, { t: 'start' });

    await h.send(anna, { t: 'stand' });
    const n = bartek.view.occupants.find((o) => o.seat === 'N')!;
    expect(n.isBot).toBe(true);
    expect(anna.view.yourSeat).toBeNull();
    expect(bartek.view.phase).toBe('auction');

    // Robot, ktory przejal N, musi sie odezwac, gdy przyjdzie jego kolej — stol nie moze stanac.
    // Rozdanie 1: rozdaje N, wiec to od razu jego ruch.
    expect(bartek.view.board!.auction.length).toBeGreaterThan(0);
  });

  it('zmiana imienia jest widoczna dla drugiego gracza', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    const bartek = await h.connect('p-bartek', 'Bartek');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'rename', name: 'Anna Nowak' });
    expect(bartek.view.occupants.find((o) => o.seat === 'N')!.name).toBe('Anna Nowak');
  });

  it('imie jest przycinane i oczyszczane, nie odrzucane', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'rename', name: '   Zbyt   dlugie imie gracza ktore przekracza limit dwudziestu czterech znakow   ' });
    const name = anna.view.occupants.find((o) => o.seat === 'N')!.name;
    expect(name.length).toBeLessThanOrEqual(24);
    expect(name).not.toMatch(/\s{2,}/);
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('zegar na ruch', () => {
  let h: Harness;
  beforeAll(() => setBotDelayForTests(0));
  beforeEach(() => { h = makeHarness(); });

  it('po uplywie czasu robot gra za czlowieka i stol nie staje', async () => {
    const anna = await h.connect('p-anna', 'Anna');
    await h.send(anna, { t: 'sit', seat: 'N' });
    await h.send(anna, { t: 'setSettings', settings: { turnSeconds: 5 } });
    await h.send(anna, { t: 'start' });

    // Rozdanie 1 rozdaje N (Anna): to jej ruch, wiec zegar musi byc uzbrojony.
    expect(anna.view.board!.auction).toEqual([]);
    expect(anna.view.turnDeadline).not.toBeNull();
    expect(h.ctx.storage.alarmAt).not.toBeNull();

    // Test nie moze przesunac zegara sciennego, wiec przesuwa termin w magazynie do przeszlosci
    // i kaze obiektowi przeczytac go na nowo — dokladnie tak, jak po wywlaszczeniu.
    const room = (await h.ctx.storage.get<Record<string, unknown>>('room'))!;
    room.turnDeadline = Date.now() - 1;
    await h.ctx.storage.put('room', room);
    (h.table as unknown as { room: unknown }).room = null;
    await h.table.alarm();

    const view = anna.view;
    // Ktos odezwal sie za N — i skoro roboty ruszaja inline, licytacja poszla dalej.
    expect(view.board!.auction.length).toBeGreaterThanOrEqual(1);
    expect(view.chat.some((m) => m.system && /Upłynął czas/.test(m.text))).toBe(true);
  });
});
