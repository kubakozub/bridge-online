/**
 * Która lewa ma być widoczna na macie.
 *
 * Silnik, kończąc lewę, w TYM SAMYM stanie dokłada już następną — pustą:
 *
 *   tricks: boardOver ? playedTricks : [...playedTricks, { leader: winner, cards: [] }]
 *
 * Gdyby ekran rysował po prostu ostatni element tablicy, karta dołożona przez
 * czwartego gracza nie pojawiłaby się ani na moment: przychodzi tą samą ramką,
 * która ją zastępuje pustą lewą. Animacja zamiatania też nie miałaby czego
 * zamiatać. Dlatego dopóki trwa okno zamiatania (`lastTrickWinner` jest ustawiony,
 * patrz `--dur-trick-hold` + `--dur-trick`), pokazujemy ostatnią PEŁNĄ lewę.
 */

import type { Trick } from '../engine/types';

export interface TrickViewInput {
  tricks: readonly Trick[];
  /** Zwycięzca zakończonej lewy — ustawiony tylko na czas pokazywania kompletu. */
  lastTrickWinner: unknown;
}

export function trickToShow({ tricks, lastTrickWinner }: TrickViewInput): Trick | null {
  if (tricks.length === 0) return null;
  const last = tricks[tricks.length - 1];
  if (lastTrickWinner !== null && last.cards.length === 0 && tricks.length > 1) {
    return tricks[tricks.length - 2];
  }
  return last;
}
