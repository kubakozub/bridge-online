/**
 * The landing screen: pick a name, make a table, or join one with a six-character code.
 *
 * The whole product is one sentence - "brydż dla dwóch osób w dwóch różnych miejscach, roboty
 * siadają na wolnych krzesłach" - so the hero says exactly that and the two buttons below it are
 * the only decisions anyone has to make.
 *
 * The join field is deliberately forgiving: people paste whatever their partner sent them, which is
 * usually a whole URL. `extractRoomCode` pulls the code out of a link, a "#/t/ABC123" fragment or a
 * bare code, and upper-cases it, so the paste just works.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ScoringMode } from '../engine/types';
import { DEFAULT_SETTINGS } from '../server/protocol';
import type {
  BotLevel,
  CreateTableRequest,
  CreateTableResponse,
  TableSettings,
} from '../server/protocol';
import {
  loadIdentity,
  loadLocalPrefs,
  MAX_NAME_LENGTH,
  saveIdentity,
  saveLocalPrefs,
  type DeckName,
  type LocalPrefs,
  type ThemeName,
} from './net/identity';
import { Art } from './components/Art';
import './styles/app.css';
import './styles/shell-art.css';

/** Room codes are six characters; the input never grows past that. */
const ROOM_CODE_LENGTH = 6;

/**
 * Tryby zapisu OFEROWANE graczowi.
 *
 * 'rubber' zostal zdjety z listy: buildMatchScore nie ma dla niego wlasnej galezi, wiec liczyl sie
 * identycznie jak turniejowy — bez podzialu nad/pod kreska, bez liczenia partii i bez premii za
 * robra. Etykieta obiecywala co innego, niz strona pokazywala. Kod rubberScoreSummary zostaje
 * w silniku; opcja wroci, kiedy zostanie do niego podpieta.
 *
 * 'imp' liczy impy wzgledem datum 0, bo przy jednym stole nie ma drugiego wyniku do porownania —
 * stad etykieta mowi to wprost, zamiast udawac zapis meczowy.
 */
const SCORING_OPTIONS: { value: ScoringMode; label: string }[] = [
  { value: 'duplicate', label: 'Turniejowy' },
  { value: 'imp', label: 'Na impy (względem zera)' },
];

const BOT_OPTIONS: { value: BotLevel; label: string }[] = [
  { value: 'beginner', label: 'Początkujący' },
  { value: 'intermediate', label: 'Średni' },
  { value: 'advanced', label: 'Zaawansowany' },
];

const BOARD_OPTIONS: { value: number; label: string }[] = [
  { value: 4, label: '4 rozdania' },
  { value: 8, label: '8 rozdań' },
  { value: 16, label: '16 rozdań' },
  { value: 0, label: 'Bez limitu' },
];

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'felt', label: 'Sukno' },
  { value: 'daylight', label: 'Dzienny' },
];

const DECK_OPTIONS: { value: DeckName; label: string }[] = [
  { value: 'classic', label: 'Klasyczna' },
  { value: 'four-colour', label: 'Czterokolorowa' },
];

/**
 * Pulls a room code out of anything a partner might send: a full share link, a bare fragment, or
 * the code on its own. Everything that is not a letter or a digit is dropped.
 */
function extractRoomCode(raw: string): string {
  const trimmed = raw.trim();
  const fromLink = /[#/]t\/([a-z0-9]+)/i.exec(trimmed);
  const source = fromLink !== null ? fromLink[1] : trimmed;
  return source.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, ROOM_CODE_LENGTH);
}

/** Best-effort clipboard write. Returns false where the API is unavailable or refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Insecure context or a denied permission: the link is on screen and selectable anyway.
  }
  return false;
}

function shareUrlFor(roomCode: string): string {
  return `${window.location.origin}${window.location.pathname}#/t/${roomCode}`;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

export function Lobby(): JSX.Element {
  const nameId = useId();
  const codeId = useId();
  const scoringId = useId();
  const boardsId = useId();
  const botId = useId();
  const linkId = useId();

  const [name, setName] = useState<string>(() => loadIdentity().name);
  const [prefs, setPrefs] = useState<LocalPrefs>(() => loadLocalPrefs());
  const [code, setCode] = useState('');
  const [settings, setSettings] = useState<TableSettings>(DEFAULT_SETTINGS);
  const [created, setCreated] = useState<CreateTableResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyTimer = useRef<number | null>(null);
  const createdRef = useRef<HTMLDivElement | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // Move the reader to the share link the moment the table exists; it is the only thing that
  // matters on the screen at that point.
  useEffect(() => {
    if (created !== null) createdRef.current?.focus();
  }, [created]);

  const commitName = useCallback((next: string): void => {
    const saved = saveIdentity({ name: next });
    setName(saved.name);
  }, []);

  const changePrefs = useCallback((patch: Partial<LocalPrefs>): void => {
    setPrefs(saveLocalPrefs(patch));
  }, []);

  const createTable = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const payload: CreateTableRequest = { name: name.trim(), settings };
      const response = await fetch('/api/tables', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as CreateTableResponse;
      if (typeof data.roomCode !== 'string' || data.roomCode.length === 0) {
        throw new Error('brak kodu stołu w odpowiedzi');
      }
      setCreated(data);
    } catch (cause) {
      console.warn('[bo] nie udało się utworzyć stołu', cause);
      setFailure('Nie udało się utworzyć stołu. Sprawdź połączenie i spróbuj ponownie.');
    } finally {
      setBusy(false);
    }
  }, [name, settings]);

  const onCreateSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      void createTable();
    },
    [createTable],
  );

  const onJoinSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const clean = extractRoomCode(code);
      if (clean.length === 0) {
        setFailure('Wpisz kod stołu albo wklej link od partnera.');
        return;
      }
      setFailure(null);
      window.location.hash = `#/t/${clean}`;
    },
    [code],
  );

  const link = created !== null ? (created.joinUrl || shareUrlFor(created.roomCode)) : '';

  const onCopyLink = useCallback((): void => {
    if (link.length === 0) return;
    void copyText(link).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 2000);
    });
  }, [link]);

  return (
    <div className="bo-app bo-app--lobby">
      <header className="bo-topbar">
        <span className="bo-topbar__brand">
          <Art id="art-logo-mark" size={26} className="bo-topbar__logo" /> Bridge Online
        </span>
        <div className="bo-topbar__prefs">
          <SegmentedToggle
            legend="Motyw"
            value={prefs.theme}
            options={THEME_OPTIONS}
            onPick={(theme) => changePrefs({ theme })}
          />
          <SegmentedToggle
            legend="Talia"
            value={prefs.deck}
            options={DECK_OPTIONS}
            onPick={(deck) => changePrefs({ deck })}
          />
        </div>
      </header>

      <main className="bo-lobby">
        <section className="bo-hero">
          <Art id="art-logo-full" label="Bridge Online" className="bo-hero__logo" />
          <h1 className="bo-hero__title">Brydż dla dwojga</h1>
          <p className="bo-hero__lead">
            Zagraj pełne rozdanie z drugą osobą, choćby była na drugim końcu Polski — licytacja
            i rozgrywka jak przy stole, a wolne krzesła zajmują roboty.
          </p>
        </section>

        {failure !== null ? (
          <p className="bo-banner bo-banner--error" role="alert">
            {failure}
          </p>
        ) : null}

        <div className="bo-lobby__grid">
          <section className="bo-lobby-card" aria-labelledby={`${nameId}-heading`}>
            <h2 className="bo-lobby-card__title" id={`${nameId}-heading`}>
              Twoje imię przy stole
            </h2>
            <label className="bo-label" htmlFor={nameId}>
              Jak mamy Cię nazywać?
            </label>
            <input
              id={nameId}
              className="bo-input"
              type="text"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="nickname"
              onChange={(event) => setName(event.target.value)}
              onBlur={(event) => commitName(event.target.value)}
            />
            <p className="bo-lobby-card__hint">
              Zapisujemy je tylko w tej przeglądarce — nie zakładamy żadnego konta.
            </p>
          </section>

          <section className="bo-lobby-card" aria-labelledby={`${codeId}-heading`}>
            <h2 className="bo-lobby-card__title" id={`${codeId}-heading`}>
              Dołącz do stołu
            </h2>
            <form className="bo-form" onSubmit={onJoinSubmit}>
              <label className="bo-label" htmlFor={codeId}>
                Kod stołu albo link od partnera
              </label>
              <input
                id={codeId}
                className="bo-input bo-input--code"
                type="text"
                value={code}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="K7QM2P"
                aria-describedby={`${codeId}-hint`}
                onChange={(event) => setCode(extractRoomCode(event.target.value))}
                onPaste={(event) => {
                  event.preventDefault();
                  setCode(extractRoomCode(event.clipboardData.getData('text')));
                }}
              />
              <p className="bo-lobby-card__hint" id={`${codeId}-hint`}>
                Możesz wkleić cały adres — wyłuskamy z niego kod.
              </p>
              <button type="submit" className="bo-btn bo-btn--primary" disabled={code.length === 0}>
                Dołącz do stołu
              </button>
            </form>
          </section>

          <section className="bo-lobby-card bo-lobby-card--wide" aria-labelledby={`${scoringId}-heading`}>
            <h2 className="bo-lobby-card__title" id={`${scoringId}-heading`}>
              Utwórz nowy stół
            </h2>
            <form className="bo-form" onSubmit={onCreateSubmit}>
              <div className="bo-form__row">
                <span className="bo-form__cell">
                  <label className="bo-label" htmlFor={scoringId}>
                    Rodzaj zapisu
                  </label>
                  <select
                    id={scoringId}
                    className="bo-input"
                    value={settings.scoringMode}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        scoringMode: event.target.value as ScoringMode,
                      }))
                    }
                  >
                    {SCORING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </span>

                <span className="bo-form__cell">
                  <label className="bo-label" htmlFor={boardsId}>
                    Długość meczu
                  </label>
                  <select
                    id={boardsId}
                    className="bo-input"
                    value={String(settings.boardCount)}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        boardCount: Number(event.target.value),
                      }))
                    }
                  >
                    {BOARD_OPTIONS.map((option) => (
                      <option key={option.value} value={String(option.value)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </span>

                <span className="bo-form__cell">
                  <label className="bo-label" htmlFor={botId}>
                    Poziom robotów
                  </label>
                  <select
                    id={botId}
                    className="bo-input"
                    value={settings.botLevel}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        botLevel: event.target.value as BotLevel,
                      }))
                    }
                  >
                    {BOT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </span>
              </div>

              <button type="submit" className="bo-btn bo-btn--primary" disabled={busy}>
                {busy ? 'Tworzę stół…' : 'Utwórz stół'}
              </button>
            </form>

            {created !== null ? (
              <div
                className="bo-share"
                ref={createdRef}
                tabIndex={-1}
                role="group"
                aria-label="Stół gotowy"
              >
                <p className="bo-share__lead">
                  Stół gotowy. Wyślij ten link partnerowi, a potem wejdź do środka.
                </p>
                <label className="bo-visually-hidden" htmlFor={linkId}>
                  Link do stołu
                </label>
                <div className="bo-share__row">
                  <input id={linkId} className="bo-input" type="text" value={link} readOnly />
                  <button type="button" className="bo-btn bo-btn--sm" onClick={onCopyLink}>
                    {copied ? 'Skopiowano' : 'Kopiuj'}
                  </button>
                </div>
                <p className="bo-share__code">
                  <span className="bo-visually-hidden">Kod stołu: </span>
                  <span className="bo-code">{created.roomCode}</span>
                </p>
                <a className="bo-btn bo-btn--primary" href={`#/t/${created.roomCode}`}>
                  Przejdź do stołu
                </a>
              </div>
            ) : null}
          </section>

          <section className="bo-lobby-card bo-lobby-card--wide" aria-labelledby="bo-howto-heading">
            <h2 className="bo-lobby-card__title" id="bo-howto-heading">
              Jak grać
            </h2>
            <ol className="bo-howto">
              <li>
                Najpierw licytacja: kolejno, zgodnie z ruchem wskazówek zegara, deklarujecie ile lew
                weźmiecie i w jakim kolorze — aż trzy osoby z rzędu spasują.
              </li>
              <li>
                Potem rozgrywka: do każdej lewy każdy dokłada jedną kartę, trzeba dołożyć do koloru,
                a lewę bierze najwyższa karta koloru wyjścia albo najwyższy atu.
              </li>
              <li>
                Rozgrywający gra też kartami dziadka — ręką partnera, odkrytą po pierwszym wyjściu —
                i musi wziąć tyle lew, ile obiecał w licytacji.
              </li>
            </ol>
          </section>
        </div>
      </main>

      <footer className="bo-lobby__foot">
        <p>Wszystko dzieje się w przeglądarce i na jednym serwerze brzegowym. Bez kont, bez reklam.</p>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A tiny radio group, used for the two look-and-feel toggles in the header
// ---------------------------------------------------------------------------

export interface SegmentedToggleProps<T extends string> {
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onPick: (next: T) => void;
}

function SegmentedToggle<T extends string>({
  legend,
  value,
  options,
  onPick,
}: SegmentedToggleProps<T>): JSX.Element {
  const name = useId();
  return (
    <fieldset className="bo-toggle">
      <legend className="bo-visually-hidden">{legend}</legend>
      {options.map((option) => (
        <label className="bo-toggle__option" key={option.value}>
          <input
            className="bo-toggle__radio"
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onPick(option.value)}
          />
          <span className="bo-toggle__label">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
