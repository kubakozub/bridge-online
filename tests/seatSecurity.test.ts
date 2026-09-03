/**
 * Regresja bezpieczeństwa: przejęcie cudzego miejsca przez podszycie się pod playerId.
 *
 * Znalezione w audycie 31.08 i odtworzone NA PRODUKCJI. Mechanizm był taki:
 * serwer rozsyłał w ramce stanu pełne obiekty `occupants`, razem z `playerId` każdego gracza.
 * playerId jest jedynym sekretem wiążącym człowieka z miejscem — `hello` z cudzym identyfikatorem
 * oddaje przy nim miejsce razem z kartami (i słusznie: na tym stoi wznawianie gry po zerwaniu
 * połączenia). Wystarczyło więc odczytać cudzy identyfikator z własnej ramki, otworzyć drugie
 * gniazdo i przedstawić się jako przeciwnik, żeby zobaczyć jego rękę.
 *
 * Te testy pilnują obu połówek: że identyfikator nie wycieka ORAZ że wznawianie nadal działa.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { TableDurableObject, setBotDelayForTests } from '../src/server/table';
import type { ClientMessage, ServerMessage, TableView } from '../src/server/protocol';

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
      const m = this.sent[i];
      if (m.t === 'state') return m.view;
    }
    throw new Error('to połączenie nie dostało ani jednej ramki stanu');
  }
}

class FakeStorage {
  private readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    const v = this.map.get(k);
    return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
  }
  async put(k: string, v: unknown): Promise<void> { this.map.set(k, JSON.parse(JSON.stringify(v))); }
  async deleteAll(): Promise<void> { this.map.clear(); }
  async setAlarm(t: number): Promise<void> { this.alarmAt = t; }
}

class FakeCtx {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  acceptWebSocket(ws: FakeSocket): void { this.sockets.push(ws); }
  getWebSockets(): FakeSocket[] { return this.sockets.filter((s) => !s.closed); }
}

function makeHarness() {
  const ctx = new FakeCtx();
  const table = new TableDurableObject(
    ctx as unknown as DurableObjectState,
    { PUBLIC_APP_NAME: 'test' } as unknown as Env,
  );
  const send = (ws: FakeSocket, msg: ClientMessage): Promise<void> =>
    table.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
  return {
    ctx,
    send,
    async connect(playerId: string, name: string): Promise<FakeSocket> {
      const ws = new FakeSocket();
      ctx.acceptWebSocket(ws);
      await send(ws, { t: 'hello', playerId, name, protocolVersion: 1 });
      return ws;
    },
  };
}

beforeAll(() => setBotDelayForTests(0));

describe('miejsce przy stole nie da się przejąć przez ramkę stanu', () => {
  it('ramka stanu NIE zawiera cudzych playerId', async () => {
    const h = makeHarness();
    const ofiara = await h.connect('sekret-ofiary', 'Ofiara');
    await h.send(ofiara, { t: 'sit', seat: 'N' });
    const napastnik = await h.connect('id-napastnika', 'Napastnik');
    await h.send(napastnik, { t: 'sit', seat: 'S' });

    const widok = napastnik.view;

    // 1) Napastnik widzi oba zajęte miejsca — interfejs nie traci informacji…
    expect(widok.occupants.map((o) => o.seat).sort()).toEqual(['N', 'S']);
    expect(widok.occupants.find((o) => o.seat === 'N')?.name).toBe('Ofiara');

    // 2) …ale identyfikator ofiary nie pada w niej ani razu.
    const cudzy = widok.occupants.find((o) => o.seat === 'N');
    expect(cudzy?.playerId).toBeNull();
    expect(JSON.stringify(widok)).not.toContain('sekret-ofiary');

    // 3) Własny identyfikator zostaje — klient i tak zna go z localStorage.
    expect(widok.occupants.find((o) => o.seat === 'S')?.playerId).toBe('id-napastnika');
    expect(widok.yourPlayerId).toBe('id-napastnika');
  });

  it('widz z samym linkiem też nie dostaje żadnego playerId', async () => {
    const h = makeHarness();
    const gracz = await h.connect('sekret-gracza', 'Gracz');
    await h.send(gracz, { t: 'sit', seat: 'N' });
    const widz = await h.connect('id-widza', 'Widz'); // nigdy nie siada

    expect(widz.view.yourSeat).toBeNull();
    expect(JSON.stringify(widz.view)).not.toContain('sekret-gracza');
    expect(widz.view.occupants.every((o) => o.playerId === null)).toBe(true);
  });

  it('wznawianie po zerwaniu połączenia nadal działa — poprawka niczego nie zabrała', async () => {
    const h = makeHarness();
    const gracz = await h.connect('sekret-gracza', 'Gracz');
    await h.send(gracz, { t: 'sit', seat: 'E' });

    // to samo urządzenie wraca nowym gniazdem, z tym samym identyfikatorem z localStorage
    const powrot = await h.connect('sekret-gracza', 'Gracz');
    expect(powrot.view.yourSeat).toBe('E');
    expect(powrot.view.occupants.find((o) => o.seat === 'E')?.connected).toBe(true);
  });
});
