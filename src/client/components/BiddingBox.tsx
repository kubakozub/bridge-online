/**
 * The bidding box: the whole ladder of 35 contract bids plus pass, double and redouble.
 *
 * Like a physical bidding box, insufficient bids stay on display - struck through and
 * marked `aria-disabled` rather than removed - so a beginner can see the ranking of the
 * denominations and where the auction currently stands.
 *
 * Keyboard model: one roving tab stop. Arrow keys move a cursor across the ladder,
 * Home/End jump within a row, and Enter/Space fire the button natively. The container is
 * a plain `group` rather than an ARIA `grid` on purpose: every cell is a real <button>,
 * which is what a screen reader user actually wants to hear here ("Zalicytuj 3 bez atu,
 * przycisk"), and the grid roles would have to overwrite that.
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { STRAINS } from '../../engine/types';
import type { BidLevel, Call } from '../../engine/types';
import type { ArtId } from '../assets/artSprite';
import { ArtFill, CallText, describeCall } from './ContractBadge';
import '../styles/bidding.css';
import '../styles/bidding-art.css';

const LEVELS: readonly BidLevel[] = [1, 2, 3, 4, 5, 6, 7];
const SPECIALS: readonly Call[] = ['P', 'X', 'XX'];

/** Pass / double / redouble are drawn as their own coloured cards from the art sprite. */
const SPECIAL_ART: Record<'P' | 'X' | 'XX', ArtId> = {
  P: 'art-call-pass',
  X: 'art-call-double',
  XX: 'art-call-redouble',
};

/**
 * Which sprite symbol sits behind a bidding button. A contract bid is one chip template in
 * three states; "unavailable" wins over "hint" so a locked box never shows a highlighted chip.
 */
function chipArtFor(call: Call, enabled: boolean, isHint: boolean): ArtId {
  if (call === 'P' || call === 'X' || call === 'XX') return SPECIAL_ART[call];
  if (!enabled) return 'bid-chip-disabled';
  if (isHint) return 'bid-chip-hint';
  return 'bid-chip';
}

/** rows[r][c]: seven rows of five bids (C D H S BA), then pass / double / redouble. */
const ROWS: readonly (readonly Call[])[] = [
  ...LEVELS.map((level) => STRAINS.map((strain) => `${level}${strain}` as Call)),
  SPECIALS,
];

type Cursor = { row: number; col: number };

function callImperativePl(call: Call): string {
  if (call === 'P') return 'Spasuj';
  if (call === 'X') return 'Zalicytuj kontrę';
  if (call === 'XX') return 'Zalicytuj rekontrę';
  return `Zalicytuj ${describeCall(call)}`;
}

/** Start the cursor on the cheapest legal call, which is where a player looks first. */
function initialCursor(legal: readonly Call[]): Cursor {
  for (let row = 0; row < ROWS.length; row++) {
    for (let col = 0; col < ROWS[row].length; col++) {
      if (legal.includes(ROWS[row][col])) return { row, col };
    }
  }
  return { row: 0, col: 0 };
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

export interface BiddingBoxProps {
  legal: Call[];
  onCall: (call: Call) => void;
  disabled?: boolean;
  /** Highlight the bid the robot would make - only when the "podpowiedzi" setting is on. */
  hint?: Call | null;
  busy?: boolean;
}

export function BiddingBox({
  legal,
  onCall,
  disabled = false,
  hint = null,
  busy = false,
}: BiddingBoxProps): JSX.Element {
  const hintId = useId();
  const legalCalls = useMemo(() => new Set<Call>(legal), [legal]);
  const [cursor, setCursor] = useState<Cursor>(() => initialCursor(legal));
  const buttons = useRef<(HTMLButtonElement | null)[][]>([]);

  const locked = disabled || busy;

  const registerButton = useCallback((row: number, col: number) => {
    return (element: HTMLButtonElement | null): void => {
      if (buttons.current[row] === undefined) buttons.current[row] = [];
      buttons.current[row][col] = element;
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      let { row, col } = cursor;
      switch (event.key) {
        case 'ArrowRight':
          col += 1;
          break;
        case 'ArrowLeft':
          col -= 1;
          break;
        case 'ArrowDown':
          row += 1;
          break;
        case 'ArrowUp':
          row -= 1;
          break;
        case 'Home':
          col = 0;
          break;
        case 'End':
          col = ROWS[cursor.row].length - 1;
          break;
        default:
          return;
      }
      row = Math.min(Math.max(row, 0), ROWS.length - 1);
      col = Math.min(Math.max(col, 0), ROWS[row].length - 1);
      event.preventDefault();
      setCursor({ row, col });
      buttons.current[row]?.[col]?.focus();
    },
    [cursor],
  );

  return (
    <div
      className={cx('bo-bidbox', busy && 'bo-bidbox--busy')}
      role="group"
      aria-label="Pudełko licytacyjne"
      aria-describedby={hintId}
      aria-busy={busy || undefined}
      onKeyDown={handleKeyDown}
    >
      <p id={hintId} className="bo-bidding-sr">
        Poruszaj się strzałkami, zatwierdź klawiszem Enter. Odzywki niedostępne są
        przekreślone.
      </p>

      {ROWS.map((cells, row) => {
        const special = row === ROWS.length - 1;
        return (
          <div
            key={special ? 'specials' : `level-${LEVELS[row]}`}
            className={cx('bo-bidbox__row', special && 'bo-bidbox__row--special')}
          >
            {cells.map((call, col) => {
              const enabled = !locked && legalCalls.has(call);
              const isHint = hint === call;
              const label = `${callImperativePl(call)}${
                enabled ? '' : ', odzywka niedostępna'
              }${isHint ? '. Podpowiedź robota' : ''}`;

              return (
                <button
                  key={call}
                  ref={registerButton(row, col)}
                  type="button"
                  className={cx(
                    'bo-bid',
                    special ? `bo-bid--${call.toLowerCase()}` : 'bo-bid--contract',
                    isHint && 'bo-bid--hint',
                  )}
                  aria-disabled={!enabled}
                  aria-label={label}
                  tabIndex={cursor.row === row && cursor.col === col ? 0 : -1}
                  onFocus={() => setCursor({ row, col })}
                  onClick={() => {
                    if (enabled) onCall(call);
                  }}
                >
                  <ArtFill id={chipArtFor(call, enabled, isHint)} className="bo-bid__art" />
                  <CallText call={call} long={special} className="bo-call--plain" />
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
