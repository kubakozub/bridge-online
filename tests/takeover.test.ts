/**
 * Przejęcie rozgrywki po robocie.
 *
 * Reguła istnieje, bo prawo brydżowe zostawia dziadka bez ani jednej decyzji: kartami dziadka gra
 * rozgrywający. Przy stole z robotami oznacza to, że gracz, któremu partner-robot został
 * rozgrywającym, przez całe rozdanie tylko patrzy.
 *
 * Najważniejszy jest tu przypadek NEGATYWNY: przejęcie wolno stosować wyłącznie do strony
 * rozgrywającej. Gdyby objęło obronę, gracz dostałby do ręki zakryte karty partnera-robota —
 * czyli zamiast naprawić grę, zepsułby ją i to w sposób nieodwracalny dla rozdania.
 */
import { describe, it, expect } from 'vitest';

import { controllerOf, dummySeat, effectiveController } from '../src/engine/play';
import type { Contract, Seat } from '../src/engine/types';

/** Rozgrywa N, więc dziadkiem jest S, a obrońcami E i W. */
const CONTRACT: Contract = { level: 4, strain: 'H', declarer: 'N', risk: 'none' };

/** Zestaw miejsc zajętych przez roboty. */
const botsAt = (...seats: Seat[]) => (seat: Seat): boolean => seats.includes(seat);

describe('effectiveController', () => {
  it('bez przejęcia zachowuje się dokładnie jak controllerOf', () => {
    for (const turn of ['N', 'E', 'S', 'W'] as Seat[]) {
      expect(effectiveController(turn, CONTRACT, botsAt('N', 'E', 'W'), false)).toBe(
        controllerOf(turn, CONTRACT),
      );
    }
  });

  it('oddaje człowiekowi-dziadkowi obie ręce strony rozgrywającej', () => {
    // N = robot rozgrywający, S = człowiek dziadek.
    const isBot = botsAt('N', 'E', 'W');

    // Kartami dziadka gra teraz człowiek (S), a nie robot-rozgrywający.
    expect(effectiveController('S', CONTRACT, isBot, true)).toBe('S');
    // I ręką samego rozgrywającego też.
    expect(effectiveController('N', CONTRACT, isBot, true)).toBe('S');
  });

  it('NIE oddaje graczowi kart obrońcy-robota', () => {
    // To jest przypadek, dla którego ten test istnieje. S jest obrońcą (rozgrywa E),
    // jego partnerem jest robot N. Gracz nie może dostać kart partnera z obrony.
    const contractEW: Contract = { level: 3, strain: 'N', declarer: 'E', risk: 'none' };
    const isBot = botsAt('N', 'E', 'W');

    expect(effectiveController('N', contractEW, isBot, true)).toBe('N');
    expect(effectiveController('S', contractEW, isBot, true)).toBe('S');
    // Dziadkiem jest W (partner rozgrywającego E) — steruje nim rozgrywający, nie gracz.
    expect(dummySeat(contractEW.declarer)).toBe('W');
    expect(effectiveController('W', contractEW, isBot, true)).toBe('E');
  });

  it('nie zmienia nic, gdy rozgrywającym jest człowiek', () => {
    // S rozgrywa, N to robot-dziadek: normalna reguła, człowiek i tak gra obiema rękami.
    const contractS: Contract = { level: 2, strain: 'S', declarer: 'S', risk: 'none' };
    const isBot = botsAt('N', 'E', 'W');

    expect(effectiveController('N', contractS, isBot, true)).toBe('S');
    expect(effectiveController('S', contractS, isBot, true)).toBe('S');
  });

  it('nie przejmuje, gdy dziadek też jest robotem', () => {
    // Stół obserwowany: wszyscy czterej to roboty. Nie ma komu przejąć.
    const isBot = botsAt('N', 'E', 'S', 'W');
    expect(effectiveController('S', CONTRACT, isBot, true)).toBe('N');
    expect(effectiveController('N', CONTRACT, isBot, true)).toBe('N');
  });

  it('nie rusza obrońców niezależnie od ustawienia', () => {
    const isBot = botsAt('N', 'E', 'W');
    for (const allow of [false, true]) {
      // E i W bronią; każdy gra własnymi kartami.
      expect(effectiveController('E', CONTRACT, isBot, allow)).toBe('E');
      expect(effectiveController('W', CONTRACT, isBot, allow)).toBe('W');
    }
  });

  it('nigdy nie wskazuje miejsca spoza strony, do której należy karta', () => {
    // Własność ogólna: sterujący musi być albo samym miejscem, albo jego partnerem.
    const partnerOf = (s: Seat): Seat => (({ N: 'S', S: 'N', E: 'W', W: 'E' }) as Record<Seat, Seat>)[s];
    const contracts: Contract[] = (['N', 'E', 'S', 'W'] as Seat[]).map((declarer) => ({
      level: 4,
      strain: 'S',
      declarer,
      risk: 'none',
    }));

    for (const contract of contracts) {
      for (const bots of [botsAt('N', 'E', 'W'), botsAt('E', 'W'), botsAt(), botsAt('N', 'E', 'S', 'W')]) {
        for (const turn of ['N', 'E', 'S', 'W'] as Seat[]) {
          const ctrl = effectiveController(turn, contract, bots, true);
          expect([turn, partnerOf(turn)]).toContain(ctrl);
        }
      }
    }
  });
});
