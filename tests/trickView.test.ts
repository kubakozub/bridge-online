/**
 * Regresja: karta czwartego gracza znikała, zanim dało się ją zobaczyć.
 *
 * Silnik, kończąc lewę, dokłada następną — pustą — w tym samym stanie, w którym
 * przychodzi czwarta karta. Ekran rysował `tricks[tricks.length - 1]`, więc czwarta
 * karta nie pojawiała się ani na moment. Te testy pilnują reguły, która to naprawia.
 */

import { describe, expect, it } from 'vitest';
import { applyAction, legalActionsFor, newGame, startBoard, whoseTurn } from '../src/engine/game';
import type { Seat, Trick } from '../src/engine/types';
import { trickToShow } from '../src/client/trickView';

function expectOk(result: ReturnType<typeof applyAction>) {
  if (!result.ok) throw new Error(`akcja odrzucona: ${result.error.code}`);
  return result.value;
}

const pelna: Trick = {
  leader: 'N',
  winner: 'E',
  cards: [
    { seat: 'N', card: 'SA' },
    { seat: 'E', card: 'S2' },
    { seat: 'S', card: 'S3' },
    { seat: 'W', card: 'S4' },
  ],
};

const nowaPusta: Trick = { leader: 'E', cards: [] };

const wToku: Trick = {
  leader: 'N',
  cards: [
    { seat: 'N', card: 'HA' },
    { seat: 'E', card: 'H2' },
  ],
};

describe('trickToShow', () => {
  it('w oknie zamiatania pokazuje ostatnią PEŁNĄ lewę, nie świeżo otwartą pustą', () => {
    const wynik = trickToShow({ tricks: [pelna, nowaPusta], lastTrickWinner: 'E' });
    expect(wynik).toBe(pelna);
    expect(wynik?.cards).toHaveLength(4);
  });

  it('po zamiataniu wraca do bieżącej (pustej) lewy, żeby nie zamrozić starych kart', () => {
    expect(trickToShow({ tricks: [pelna, nowaPusta], lastTrickWinner: null })).toBe(nowaPusta);
  });

  it('lewę w toku pokazuje zawsze, niezależnie od okna zamiatania', () => {
    expect(trickToShow({ tricks: [pelna, wToku], lastTrickWinner: 'E' })).toBe(wToku);
    expect(trickToShow({ tricks: [pelna, wToku], lastTrickWinner: null })).toBe(wToku);
  });

  it('ostatnia lewa rozdania zostaje na macie (silnik nie dokłada wtedy pustej)', () => {
    expect(trickToShow({ tricks: [pelna], lastTrickWinner: 'E' })).toBe(pelna);
  });

  it('przed pierwszym wistem nie ma czego pokazywać', () => {
    expect(trickToShow({ tricks: [], lastTrickWinner: null })).toBeNull();
  });

  it('pierwsza lewa rozdania nie sięga do nieistniejącej poprzedniej', () => {
    expect(trickToShow({ tricks: [nowaPusta], lastTrickWinner: 'E' })).toBe(nowaPusta);
  });
});

// ---------------------------------------------------------------------------
// Założenie, na którym stoi cała poprawka — sprawdzone na ŻYWYM silniku
// ---------------------------------------------------------------------------

describe('założenie: silnik od razu otwiera następną lewę', () => {
  it('po czwartej karcie ostatnim elementem jest PUSTA lewa, a trickToShow i tak pokazuje komplet', () => {
    // licytacja: N otwiera 1BA, reszta pasuje → gramy
    let state = startBoard(newGame(), 1, 'brydz-2026-08-31');
    // rozdaje N przy rozdaniu 1, wiec N otwiera; reszta pasuje
    state = expectOk(applyAction(state, { kind: 'call', seat: 'N', call: '1N' }));
    for (const seat of ['E', 'S', 'W'] as Seat[]) {
      state = expectOk(applyAction(state, { kind: 'call', seat, call: 'P' }));
    }
    expect(state.phase).toBe('play');

    // cztery kolejne legalne karty = jedna pełna lewa
    for (let i = 0; i < 4; i += 1) {
      const seat = whoseTurn(state) as Seat;
      const { cards } = legalActionsFor(state, seat);
      expect(cards.length).toBeGreaterThan(0);
      state = expectOk(applyAction(state, { kind: 'play', seat, card: cards[0] }));
    }

    const tricks = state.board!.play!.tricks;
    const ostatni = tricks[tricks.length - 1];

    // To jest właśnie pułapka: naiwne `tricks.at(-1)` daje lewę BEZ ANI JEDNEJ karty.
    expect(ostatni.cards).toHaveLength(0);

    // A reguła ekranu pokazuje komplet czterech kart, więc widać, co dołożył ostatni gracz.
    const pokazana = trickToShow({ tricks, lastTrickWinner: ostatni.leader });
    expect(pokazana?.cards).toHaveLength(4);
    expect(pokazana).toBe(tricks[tricks.length - 2]);
  });
});
