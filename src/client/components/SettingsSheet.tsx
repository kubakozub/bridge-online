/**
 * SettingsSheet - a modal sheet with the table rules and the local look-and-feel.
 *
 * Two kinds of setting live here and they are deliberately kept apart:
 *   - *table rules* travel over the wire and affect everyone, so only a seated player may touch
 *     them (`canEdit`);
 *   - *local preferences* never leave this browser, so a spectator can still change them.
 *
 * The sheet is a hand-rolled modal rather than <dialog> so the focus trap, the Escape handling
 * and the bottom-sheet layout behave identically on every browser we support.
 */

import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { ScoringMode } from '../../engine/types';
import type { BotLevel, TableSettings } from '../../server/protocol';
import '../styles/panels.css';

export interface SettingsSheetProps {
  settings: TableSettings;
  canEdit: boolean;
  open: boolean;
  onClose: () => void;
  onChange: (patch: Partial<TableSettings>) => void;
  /** Purely local, per-browser preferences. */
  local: { theme: 'felt' | 'daylight'; deck: 'classic' | 'four-colour'; sound: boolean; hints: boolean };
  onLocalChange: (patch: Partial<SettingsSheetProps['local']>) => void;
}

// ---------------------------------------------------------------------------
// Option tables (Polish labels; the values stay in the protocol's own vocabulary)
// ---------------------------------------------------------------------------

const SCORING_OPTIONS: { value: ScoringMode; label: string }[] = [
  { value: 'duplicate', label: 'Turniejowy' },
  { value: 'imp', label: 'Na impy (względem zera)' },
];

const BOT_OPTIONS: { value: BotLevel; label: string }[] = [
  { value: 'beginner', label: 'Początkujący' },
  { value: 'intermediate', label: 'Średni' },
  { value: 'advanced', label: 'Zaawansowany' },
];

const THEME_OPTIONS: { value: 'felt' | 'daylight'; label: string }[] = [
  { value: 'felt', label: 'Sukno (ciemny)' },
  { value: 'daylight', label: 'Dzienny (jasny)' },
];

const DECK_OPTIONS: { value: 'classic' | 'four-colour'; label: string }[] = [
  { value: 'classic', label: 'Klasyczna' },
  { value: 'four-colour', label: 'Czterokolorowa' },
];

const CLOCK_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Bez limitu' },
  { value: 15, label: '15 sekund' },
  { value: 30, label: '30 sekund' },
  { value: 60, label: '1 minuta' },
  { value: 120, label: '2 minuty' },
];

const MAX_BOARDS = 64;

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

// ---------------------------------------------------------------------------
// Small building blocks (private to this sheet)
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

function Field({ label, hint, htmlFor, children }: FieldProps): JSX.Element {
  return (
    <div className="bo-field">
      <div className="bo-field__text">
        <label className="bo-field__label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint !== undefined ? <p className="bo-field__hint">{hint}</p> : null}
      </div>
      <div className="bo-field__control">{children}</div>
    </div>
  );
}

interface ToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}

function Toggle({ label, hint, checked, disabled, onToggle }: ToggleProps): JSX.Element {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className="bo-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
      />
    </Field>
  );
}

interface SegmentedProps<T extends string | number> {
  legend: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onPick: (next: T) => void;
}

function Segmented<T extends string | number>({
  legend,
  hint,
  value,
  options,
  disabled,
  onPick,
}: SegmentedProps<T>): JSX.Element {
  const name = useId();
  return (
    <fieldset className="bo-seg" disabled={disabled}>
      <legend className="bo-seg__legend">{legend}</legend>
      {hint !== undefined ? <p className="bo-field__hint">{hint}</p> : null}
      <div className="bo-seg__options">
        {options.map((option) => (
          <label className="bo-seg__option" key={String(option.value)}>
            <input
              className="bo-seg__radio"
              type="radio"
              name={name}
              value={String(option.value)}
              checked={option.value === value}
              disabled={disabled}
              onChange={() => onPick(option.value)}
            />
            <span className="bo-seg__label">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export function SettingsSheet({
  settings,
  canEdit,
  open,
  onClose,
  onChange,
  local,
  onLocalChange,
}: SettingsSheetProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const lockedId = useId();
  const boardsId = useId();
  const clockId = useId();

  // Move focus in on open and hand it back to the opener on close/unmount.
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

  // The page behind a modal must not scroll away under the reader's finger.
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

  const rulesHint = canEdit ? undefined : lockedId;

  return (
    <div className="bo-scrim" onMouseDown={handleScrimDown} onKeyDown={handleKeyDown}>
      <div
        className="bo-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="bo-sheet__head">
          <h2 className="bo-sheet__title" id={titleId}>
            Ustawienia
          </h2>
          <button type="button" className="bo-icon-btn" onClick={onClose} aria-label="Zamknij ustawienia">
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="bo-sheet__body">
          <section className="bo-sheet__group" aria-describedby={rulesHint}>
            <h3 className="bo-sheet__group-title">Zasady stołu</h3>
            {!canEdit ? (
              <p className="bo-sheet__note" id={lockedId}>
                Zasady stołu może zmieniać tylko gracz siedzący przy stole.
              </p>
            ) : null}

            <Segmented
              legend="Rodzaj zapisu"
              value={settings.scoringMode}
              options={SCORING_OPTIONS}
              disabled={!canEdit}
              onPick={(scoringMode) => onChange({ scoringMode })}
            />

            <Field
              label="Liczba rozdań"
              hint="0 oznacza grę bez limitu."
              htmlFor={boardsId}
            >
              <input
                id={boardsId}
                className="bo-number"
                type="number"
                min={0}
                max={MAX_BOARDS}
                step={1}
                inputMode="numeric"
                value={settings.boardCount}
                disabled={!canEdit}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  const next = Number.isFinite(parsed) ? Math.min(MAX_BOARDS, Math.max(0, parsed)) : 0;
                  onChange({ boardCount: next });
                }}
              />
            </Field>

            <Segmented
              legend="Poziom robotów"
              value={settings.botLevel}
              options={BOT_OPTIONS}
              disabled={!canEdit}
              onPick={(botLevel) => onChange({ botLevel })}
            />

            <Field label="Czas na ruch" htmlFor={clockId}>
              <select
                id={clockId}
                className="bo-select"
                value={String(settings.turnSeconds)}
                disabled={!canEdit}
                onChange={(event) => onChange({ turnSeconds: Number(event.target.value) })}
              >
                {CLOCK_OPTIONS.map((option) => (
                  <option value={String(option.value)} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <Toggle
              label="Cofanie ruchów"
              hint="Gracz może poprosić przeciwników o cofnięcie ostatniego ruchu."
              checked={settings.allowUndo}
              disabled={!canEdit}
              onToggle={(allowUndo) => onChange({ allowUndo })}
            />

            <Toggle
              label="Automatyczne dokładanie"
              hint="Gdy zostaje jedna dozwolona karta, dokładamy ją za Ciebie."
              checked={settings.autoPlaySingleton}
              disabled={!canEdit}
              onToggle={(autoPlaySingleton) => onChange({ autoPlaySingleton })}
            />

            <Toggle
              label="Stół prywatny"
              hint="Dołączyć może tylko osoba, która zna kod stołu."
              checked={settings.isPrivate}
              disabled={!canEdit}
              onToggle={(isPrivate) => onChange({ isPrivate })}
            />
          </section>

          <section className="bo-sheet__group">
            <h3 className="bo-sheet__group-title">Wygląd i wygoda</h3>
            <p className="bo-sheet__note">Te ustawienia zapisujemy tylko w tej przeglądarce.</p>

            <Segmented
              legend="Motyw"
              value={local.theme}
              options={THEME_OPTIONS}
              disabled={false}
              onPick={(theme) => onLocalChange({ theme })}
            />

            <Segmented
              legend="Talia"
              hint="Czterokolorowa talia ułatwia odróżnienie kierów od kar."
              value={local.deck}
              options={DECK_OPTIONS}
              disabled={false}
              onPick={(deck) => onLocalChange({ deck })}
            />

            <Toggle
              label="Dźwięki"
              checked={local.sound}
              disabled={false}
              onToggle={(sound) => onLocalChange({ sound })}
            />

            <Toggle
              label="Podpowiedzi robota"
              hint="Podświetlamy karty i odzywki sugerowane przez robota."
              checked={local.hints}
              disabled={false}
              onToggle={(hints) => onLocalChange({ hints })}
            />

            <Toggle
              label="Licznik punktów honorowych"
              hint="Ustawienie stołu: pokazuje sumę PH Twojej ręki."
              checked={settings.showHcp}
              disabled={!canEdit}
              onToggle={(showHcp) => onChange({ showHcp })}
            />
          </section>
        </div>

        <footer className="bo-sheet__foot">
          <button type="button" className="bo-panel-btn bo-panel-btn--primary" onClick={onClose}>
            Gotowe
          </button>
        </footer>
      </div>
    </div>
  );
}
