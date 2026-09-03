/**
 * A fanned hand of cards.
 *
 * The fan is pure CSS: overlapping negative margins driven by `--hand-overlap`, so the layout
 * costs nothing at 13 cards and scales with the `--card-w` clamp from 360px to 1440px.
 *
 * Keyboard model: the hand is a single tab stop (roving tabindex). Arrow keys walk along the
 * fan - Left/Right for a horizontal hand, Up/Down for a vertical one - Home/End jump to the
 * ends, and Enter or Space plays the focused card through the native `<button>` activation.
 * Cards that are illegal right now stay focusable but are marked `aria-disabled`, so a screen
 * reader user can still read a holding they are not allowed to play from.
 */

import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, useEffect } from 'react';
import { sortHand, suitOf } from '../../engine/cards';
import type { Card, Strain } from '../../engine/types';
import { PlayingCard, type CardSize } from './PlayingCard';
import '../styles/cards.css';

/** `style` plus the CSS custom properties this component sets (`--bo-i`, the fan index). */
type CardVars = CSSProperties & Record<string, string | number>;

export interface HandProps {
  /** The cards to draw. Re-sorted with `sortHand` so the suit gaps always land correctly. */
  cards: Card[];
  /** How many backs to draw when `faceDown`. Defaults to `cards.length`. */
  count?: number;
  faceDown?: boolean;
  orientation: 'horizontal' | 'vertical';
  /** Cards playable right now; `undefined` means none are. */
  legal?: Card[];
  interactive?: boolean;
  onPlay?: (card: Card) => void;
  size?: CardSize;
  /** Draw the fan compressed, for the two side seats. */
  compact?: boolean;
  /** Optional trump suit - used only for sorting order. */
  trump?: Strain;
  /** Screen-reader group label, e.g. "Ręka Wschodu". */
  label?: string;
  /** Small gap between suits (default true when face up). */
  showSuitGaps?: boolean;
}

/** Polish for "n zakrytych kart", with the 1 / 2-4 / 5+ plural forms. */
function faceDownCountPl(n: number): string {
  const lastTwo = n % 100;
  const last = n % 10;
  if (n === 1) return '1 zakryta karta';
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return `${n} zakryte karty`;
  return `${n} zakrytych kart`;
}

function joinClasses(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

/** Focuses the card button inside a fan item, if that item has one. */
function focusItem(item: HTMLLIElement | null): void {
  item?.querySelector('button')?.focus();
}

export function Hand({
  cards,
  count,
  faceDown = false,
  orientation,
  legal,
  interactive = false,
  onPlay,
  size = 'md',
  compact = false,
  trump,
  label,
  showSuitGaps,
}: HandProps): JSX.Element {
  const ordered = useMemo(() => sortHand(cards, trump), [cards, trump]);
  const legalSet = useMemo(() => new Set<Card>(legal ?? []), [legal]);

  const canInteract = interactive && !faceDown && onPlay !== undefined;
  const withGaps = (showSuitGaps ?? true) && !faceDown;

  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const activeIndex = ordered.length === 0 ? 0 : Math.min(focusIndex, ordered.length - 1);

  /**
   * Po zagraniu karty jej przycisk znika z drzewa, a focus spada na <body>.
   *
   * Dla osoby grajacej sama klawiatura znaczylo to piec nacisniec Tab z powrotem do reki PRZY
   * KAZDEJ KARCIE — okolo 65 dodatkowych Tabow na rozdanie i ponad 500 na osmiorozdaniowy mecz.
   * Uzytkownik czytnika ekranu tracil przy tym kontekst. Przywracamy focus na kolejna karte,
   * ale WYLACZNIE wtedy, gdy naprawde przepadl (activeElement to <body>) — inaczej odbieralibysmy
   * go komus, kto celowo przeszedl do pudelka odzywek albo do czatu.
   */
  const poprzedniaDlugosc = useRef(ordered.length);
  useEffect(() => {
    const bylo = poprzedniaDlugosc.current;
    poprzedniaDlugosc.current = ordered.length;
    if (!canInteract || ordered.length === 0 || ordered.length >= bylo) return;
    const aktywny = document.activeElement;
    if (aktywny !== null && aktywny !== document.body) return;
    const cel = Math.min(focusIndex, ordered.length - 1);
    focusItem(itemRefs.current[cel]);
  }, [ordered.length, canInteract, focusIndex]);

  const moveFocus = useCallback((next: number, last: number) => {
    if (last < 0) return;
    const clamped = Math.max(0, Math.min(next, last));
    setFocusIndex(clamped);
    focusItem(itemRefs.current[clamped]);
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (!canInteract || ordered.length === 0) return;
      const back = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
      const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';

      let target: number | null = null;
      if (event.key === back) target = activeIndex - 1;
      else if (event.key === forward) target = activeIndex + 1;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = ordered.length - 1;
      if (target === null) return;

      event.preventDefault();
      moveFocus(target, ordered.length - 1);
    },
    [activeIndex, canInteract, moveFocus, ordered.length, orientation],
  );

  const rootClasses = joinClasses(
    'bo-hand',
    `bo-hand--${orientation}`,
    `bo-hand--${size}`,
    compact ? 'bo-hand--compact' : null,
    faceDown ? 'bo-hand--facedown' : null,
  );

  const backCount = faceDown ? Math.max(0, count ?? cards.length) : 0;
  let groupLabel = label;
  if (faceDown) {
    const counted = faceDownCountPl(backCount);
    groupLabel = label === undefined ? counted : `${label}: ${counted}`;
  }

  return (
    <div className={rootClasses}>
      <ul className="bo-hand__cards" role="group" aria-label={groupLabel} onKeyDown={handleKeyDown}>
        {faceDown
          ? Array.from({ length: backCount }, (_unused, index) => (
              <li
                key={index}
                className="bo-hand__item"
                style={{ '--bo-i': index } as CardVars}
                aria-hidden="true"
              >
                <PlayingCard card={null} faceDown size={size} />
              </li>
            ))
          : ordered.map((card, index) => {
              const isLegal = legalSet.has(card);
              const startsSuit = index > 0 && suitOf(card) !== suitOf(ordered[index - 1]);
              return (
                <li
                  key={card}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  className={joinClasses(
                    'bo-hand__item',
                    withGaps && startsSuit ? 'bo-hand__item--gap' : null,
                  )}
                  style={{ '--bo-i': index } as CardVars}
                  onFocus={() => setFocusIndex(index)}
                >
                  <PlayingCard
                    card={card}
                    size={size}
                    playable={canInteract && isLegal}
                    dimmed={canInteract && !isLegal}
                    onSelect={canInteract ? onPlay : undefined}
                    tabIndex={canInteract ? (index === activeIndex ? 0 : -1) : undefined}
                  />
                </li>
              );
            })}
      </ul>
    </div>
  );
}
