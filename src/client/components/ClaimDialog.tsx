/**
 * ClaimDialog - claiming tricks (Law 68) and answering someone else's claim.
 *
 * 'make'    : pick the total number of tricks your side will take and, optionally, say how.
 * 'respond' : read the claim and either accept it or send the play back to the table.
 *
 * The number is entered with a slider *and* plain +/- buttons: a slider alone is unusable with a
 * screen reader on some platforms, and buttons alone are slow when the range is thirteen wide.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { ClaimState, Seat } from '../../engine/types';
import { SEAT_LABEL_PL } from '../seats';
import '../styles/panels.css';

export interface ClaimDialogProps {
  open: boolean;
  mode: 'make' | 'respond';
  maxTricks: number;
  minTricks: number;
  claim: ClaimState | null;
  onClaim: (tricks: number, statement?: string) => void;
  onRespond: (accept: boolean) => void;
  onClose: () => void;
}

/** Free-text explanations stay short enough to read at a glance. */
const MAX_STATEMENT = 240;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function pluralPl(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

function tricksPl(n: number): string {
  return `${n} ${pluralPl(n, 'lewa', 'lewy', 'lew')}`;
}

function seatList(seats: readonly Seat[]): string {
  return seats.map((seat) => SEAT_LABEL_PL[seat]).join(', ');
}

export function ClaimDialog({
  open,
  mode,
  maxTricks,
  minTricks,
  claim,
  onClaim,
  onRespond,
  onClose,
}: ClaimDialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const sliderId = useId();
  const statementId = useId();

  const low = Math.min(minTricks, maxTricks);
  const high = Math.max(minTricks, maxTricks);

  // Suwak startuje od DOLNEGO konca, nie od gornego. Wczesniej okno otwieralo sie na maksimum,
  // wiec dwa klikniecia bez czytania zapowiadaly wszystkie pozostale lewy — a przyjeta zapowiedz
  // konczy rozdanie. Zapowiadajacy ma swiadomie podniesc liczbe, ktora deklaruje.
  const [tricks, setTricks] = useState<number>(() => clamp(low, low, high));
  const [statement, setStatement] = useState('');

  // Reopening the dialog must never inherit the previous claim's numbers or wording.
  useEffect(() => {
    if (!open) return;
    setTricks(clamp(low, low, high));
    setStatement('');
  }, [open, mode, low, high]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel !== null ? focusableIn(panel)[0] : undefined;
    (first ?? panel)?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return <></>;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (panel === null) return;
    const items = focusableIn(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleScrimDown(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  const step = (delta: number): void => setTricks((current) => clamp(current + delta, low, high));

  return (
    <div className="bo-scrim" onMouseDown={handleScrimDown} onKeyDown={handleKeyDown}>
      <div
        className="bo-sheet bo-sheet--dialog bo-claim"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="bo-sheet__head">
          <h2 className="bo-sheet__title" id={titleId}>
            {mode === 'make' ? 'Zapowiedź wzięcia lew' : 'Zapowiedź przeciwnika'}
          </h2>
          <button type="button" className="bo-icon-btn" onClick={onClose} aria-label="Zamknij okno zapowiedzi">
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        {mode === 'make' ? (
          <>
            <div className="bo-sheet__body">
              <p className="bo-claim__lead">
                Ile lew weźmie Twoja strona w całym rozdaniu? Po akceptacji przeciwników rozdanie
                kończy się bez dalszej rozgrywki.
              </p>

              <div className="bo-claim__picker">
                <button
                  type="button"
                  className="bo-icon-btn bo-claim__step"
                  onClick={() => step(-1)}
                  disabled={tricks <= low}
                  aria-label="Zmniejsz liczbę lew o jedną"
                >
                  <span aria-hidden="true">−</span>
                </button>

                <output className="bo-claim__value" htmlFor={sliderId}>
                  <span className="bo-claim__value-number" aria-hidden="true">
                    {tricks}
                  </span>
                  <span className="bo-claim__value-unit" aria-hidden="true">
                    {pluralPl(tricks, 'lewa', 'lewy', 'lew')}
                  </span>
                  <span className="bo-sr-only">Zapowiadasz {tricksPl(tricks)}</span>
                </output>

                <button
                  type="button"
                  className="bo-icon-btn bo-claim__step"
                  onClick={() => step(1)}
                  disabled={tricks >= high}
                  aria-label="Zwiększ liczbę lew o jedną"
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>

              <label className="bo-sr-only" htmlFor={sliderId}>
                Liczba zapowiadanych lew
              </label>
              <input
                id={sliderId}
                className="bo-claim__slider"
                type="range"
                min={low}
                max={high}
                step={1}
                value={tricks}
                aria-valuetext={tricksPl(tricks)}
                onChange={(event) => setTricks(clamp(Number(event.target.value), low, high))}
              />
              <p className="bo-claim__range" aria-hidden="true">
                <span>{low}</span>
                <span>{high}</span>
              </p>

              <label className="bo-field__label bo-claim__label" htmlFor={statementId}>
                Wyjaśnienie rozgrywki (opcjonalnie)
              </label>
              <textarea
                id={statementId}
                className="bo-textarea"
                rows={3}
                maxLength={MAX_STATEMENT}
                value={statement}
                placeholder="np. Ściągam atu, potem wszystkie kiery od góry."
                onChange={(event) => setStatement(event.target.value)}
              />
            </div>

            <footer className="bo-sheet__foot">
              <button type="button" className="bo-panel-btn" onClick={onClose}>
                Anuluj
              </button>
              <button
                type="button"
                className="bo-panel-btn bo-panel-btn--primary"
                onClick={() => onClaim(tricks, statement.trim() === '' ? undefined : statement.trim())}
              >
                Zapowiedz {tricksPl(tricks)}
              </button>
            </footer>
          </>
        ) : claim === null ? (
          <>
            <div className="bo-sheet__body">
              <p className="bo-claim__lead">Nie ma teraz żadnej zapowiedzi do rozpatrzenia.</p>
            </div>
            <footer className="bo-sheet__foot">
              <button type="button" className="bo-panel-btn bo-panel-btn--primary" onClick={onClose}>
                Zamknij
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="bo-sheet__body">
              <p className="bo-claim__lead">
                <strong>{SEAT_LABEL_PL[claim.by]}</strong> zapowiada, że jego strona weźmie{' '}
                <strong>{tricksPl(claim.tricks)}</strong> w tym rozdaniu.
              </p>

              {claim.statement !== undefined && claim.statement.trim() !== '' ? (
                <blockquote className="bo-claim__statement">
                  <span className="bo-sr-only">Wyjaśnienie: </span>
                  {claim.statement}
                </blockquote>
              ) : (
                <p className="bo-claim__note">Zapowiedź bez wyjaśnienia rozgrywki.</p>
              )}

              {claim.pending.length > 0 ? (
                <p className="bo-claim__note">Czekamy na odpowiedź: {seatList(claim.pending)}.</p>
              ) : null}
              {claim.rejected.length > 0 ? (
                <p className="bo-claim__note bo-claim__note--warn">
                  Zapowiedź odrzucona przez: {seatList(claim.rejected)}.
                </p>
              ) : null}

              <p className="bo-claim__note">
                Odrzucenie zapowiedzi wraca do normalnej rozgrywki — nikt nie traci przez to lew.
              </p>
            </div>

            <footer className="bo-sheet__foot">
              <button type="button" className="bo-panel-btn bo-panel-btn--danger" onClick={() => onRespond(false)}>
                Odrzuć
              </button>
              <button
                type="button"
                className="bo-panel-btn bo-panel-btn--primary"
                onClick={() => onRespond(true)}
              >
                Akceptuj
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
