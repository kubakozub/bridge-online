/**
 * Regresja: zapowiedź lewy przy stole z robotem wieszała rozdanie NA STAŁE.
 *
 * `pending` przy zapowiedzi to przeciwnicy zapowiadającego (Law 69), a roboty nigdy na nią nie
 * odpowiadały. Dopóki zapowiedź wisiała, silnik odrzucał każdą kartę przez WRONG_PHASE (Law 68D) —
 * plansza stała, nie dało się ani grać dalej, ani wycofać zapowiedzi, ani przejść do następnego
 * rozdania. W domyślnym układzie (dwoje ludzi + dwa roboty) trafiało się w to natychmiast.
 * Znalezione w audycie 31.08 na produkcji, stół 3TYQQC.
 *
 * Reguła po poprawce: robot przyjmuje zapowiedź tylko wtedy, gdy zapowiadający po prostu ODDAJE
 * resztę lew (nie trzeba wtedy niczego oceniać); w każdym innym przypadku odrzuca i gra toczy się
 * dalej. Przyjmowanie w ciemno pozwoliłoby zapowiedzieć 13 lew i wygrać rozdanie bez gry.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { TableDurableObject, setBotDelayForTests } from '../src/server/table';
import type { ClientMessage, ServerMessage, TableView } from '../src/server/protocol';
import { dummySeat } from '../src/engine/play';
import { legalCalls, seatToCall } from '../src/engine/auction';
import { sideOf } from '../src/engine/deal';
import type { Seat } from '../src/engine/types';

class FakeSocket {
  readonly sent: ServerMessage[] = [];
  private attachment: unknown = null;
  closed = false;
  send(d: string): void { this.sent.push(JSON.parse(d) as ServerMessage); }
  close(): void { this.closed = true; }
  serializeAttachment(v: unknown): void { this.attachment = v; }
  deserializeAttachment(): unknown { return this.attachment; }
  get view(): TableView {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const m = this.sent[i];
      if (m.t === 'state') return m.view;
    }
    throw new Error('brak ramki stanu');
  }
}
class FakeStorage {
  private readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    const v = this.map.get(k); return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T);
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

let ctx: FakeCtx;
let table: TableDurableObject;
const send = (ws: FakeSocket, msg: ClientMessage): Promise<void> =>
  table.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(msg));
async function connect(playerId: string, name: string): Promise<FakeSocket> {
  const ws = new FakeSocket();
  ctx.acceptWebSocket(ws);
  await send(ws, { t: 'hello', playerId, name, protocolVersion: 1 });
  return ws;
}

beforeAll(() => setBotDelayForTests(0));
beforeEach(() => {
  ctx = new FakeCtx();
  table = new TableDurableObject(
    ctx as unknown as DurableObjectState,
    { PUBLIC_APP_NAME: 'test' } as unknown as Env,
  );
});

/** Dwoje ludzi (N, S) + roboty (E, W), rozdanie doprowadzone do fazy rozgrywki. */
async function stolWFazieRozgrywki(): Promise<{ n: FakeSocket; s: FakeSocket }> {
  const n = await connect('p-n', 'Ala');
  const s = await connect('p-s', 'Bartek');
  await send(n, { t: 'sit', seat: 'N' });
  await send(s, { t: 'sit', seat: 'S' });
  await send(n, { t: 'addBot', seat: 'E' });
  await send(n, { t: 'addBot', seat: 'W' });
  await send(n, { t: 'start' });

  // Serwer NIE wysyła listy dozwolonych odzywek — klient liczy ją sam silnikiem, więc test robi
  // tak samo. Sterujemy tylko ludźmi (N, S); roboty ruszają się same, w tym samym wywołaniu.
  // Pierwsza odzywka musi być realna: cztery pasy to rozdanie spasowane, czyli zero rozgrywki.
  let pierwsza = true;
  for (let i = 0; i < 60; i += 1) {
    const v = n.view;
    if (v.phase !== 'auction' || !v.board) break;
    const naRuchu = seatToCall(v.board.auction, v.board.dealer);
    if (!naRuchu) break;
    if (naRuchu !== 'N' && naRuchu !== 'S') {
      await table.alarm().catch(() => undefined); // czekamy na robota
      continue;
    }
    const ws = naRuchu === 'N' ? n : s;
    const dozwolone = legalCalls(v.board.auction, v.board.dealer, naRuchu);
    const realna = dozwolone.find((c) => c !== 'P' && c !== 'X' && c !== 'XX');
    const wybor = pierwsza && realna ? realna : 'P';
    pierwsza = false;
    await send(ws, { t: 'call', call: wybor });
  }

  return { n, s };
}

/** Miejsce, z którego wolno zapowiadać: rozgrywający albo obrońca, nigdy dziadek. */
function ktoMozeZapowiadac(v: TableView, kandydaci: Seat[]): Seat | null {
  const c = v.board?.contract;
  if (!c) return null;
  const dziadek = dummySeat(c.declarer);
  return kandydaci.find((s) => s !== dziadek) ?? null;
}

describe('zapowiedź lewy przy stole z robotami nie wiesza rozdania', () => {
  it('robot odpowiada na zapowiedź — plansza nigdy nie zostaje z wiszącym pending', async () => {
    const { n, s } = await stolWFazieRozgrywki();
    if (n.view.phase !== 'play') return;

    const zapowiadajacy = ktoMozeZapowiadac(n.view, ['N', 'S']);
    expect(zapowiadajacy).not.toBeNull();
    const ws = zapowiadajacy === 'N' ? n : s;

    const play = n.view.board!.play!;
    const juzWziete = sideOf(zapowiadajacy!) === 'NS' ? play.tricksNS : play.tricksEW;

    // Zapowiedź wymagająca oceny: wszystkie pozostałe lewy.
    await send(ws, { t: 'claim', tricks: 13 - (play.tricksNS + play.tricksEW) + juzWziete });

    const po = ws.view;
    const wiszaca = po.board?.play?.claim ?? null;
    // Sedno regresji: po odpowiedzi robotów nie może zostać zapowiedź czekająca na robota.
    if (wiszaca) {
      const czekaBot = wiszaca.pending.some((seat) => po.occupants.find((o) => o.seat === seat)?.isBot);
      expect(czekaBot).toBe(false);
    } else {
      // Odrzucona (gramy dalej) albo przyjęta (rozdanie policzone) — oba stany są w porządku.
      expect(['play', 'review', 'finished']).toContain(po.phase);
    }
  });

  it('oddanie reszty lew robot przyjmuje — rozdanie się kończy', async () => {
    const { n, s } = await stolWFazieRozgrywki();
    expect(n.view.phase).toBe('play');

    const zapowiadajacy = ktoMozeZapowiadac(n.view, ['N', 'S']);
    const ws = zapowiadajacy === 'N' ? n : s;
    const play = n.view.board!.play!;
    const juzWziete = sideOf(zapowiadajacy!) === 'NS' ? play.tricksNS : play.tricksEW;

    // "Nie wezmę już nic" — na taką zgodę robot nie potrzebuje żadnej oceny sytuacji.
    await send(ws, { t: 'claim', tricks: juzWziete });

    const po = ws.view;
    // Po pełnej zgodzie silnik ZOSTAWIA zapis zapowiedzi (z pustą listą pytanych) i przechodzi
    // do podsumowania — to jego celowe zachowanie, nie pozostałość po zawieszeniu.
    expect(po.board?.play?.claim?.pending ?? []).toEqual([]);
    expect(['review', 'finished']).toContain(po.phase);
    expect(po.board?.result ?? null).not.toBeNull();
  });
});
