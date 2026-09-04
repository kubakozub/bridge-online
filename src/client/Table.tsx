/**
 * The game screen: everything that happens once you are at a table.
 *
 * The single rule this file exists to get right is Law 45F - **declarer plays dummy**. Exactly one
 * hand on screen is ever interactive, and which one it is comes from `controllerOf(turn, contract)`:
 * normally your own hand, but when you are declarer and it is dummy's turn, dummy's hand lights up
 * and your own goes quiet. Everything else here is composition.
 *
 * Layout is two columns on a desktop (table + rail) and one column on a phone, where the rail
 * becomes a bottom sheet. The felt itself is rotated for the viewer by `seatsForViewer`, so "bottom"
 * always means "you".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Call, Card, Seat } from '../engine/types';
import { SEATS } from '../engine/types';
import { hcp } from '../engine/cards';
import { isVulnerable, sideOf } from '../engine/deal';
import { legalCalls, seatToCall } from '../engine/auction';
import { dummySeat, effectiveController, legalCards } from '../engine/play';
import { DEFAULT_SETTINGS } from '../server/protocol';
import type { SeatOccupant, TableSettings } from '../server/protocol';
import { orientationOf, seatsForViewer, SEAT_LABEL_PL, type TablePosition } from './seats';
import { Art, Icon } from './components/Art';
import { AuctionGrid } from './components/AuctionGrid';
import { BiddingBox } from './components/BiddingBox';
import { ChatPanel } from './components/ChatPanel';
import { ClaimDialog } from './components/ClaimDialog';
import { ContractBadge } from './components/ContractBadge';
import { Hand } from './components/Hand';
import { Scoreboard } from './components/Scoreboard';
import { SeatPlate } from './components/SeatPlate';
import { SettingsSheet } from './components/SettingsSheet';
import { TableFelt } from './components/TableFelt';
import { Toasts } from './components/Toasts';
import { TrickArea } from './components/TrickArea';
import { trickToShow } from './trickView';
import { loadIdentity, loadLocalPrefs, saveLocalPrefs, type LocalPrefs } from './net/identity';
import { useTable, type ConnectionStatus } from './net/useTable';
import './styles/app.css';
import './styles/shell-art.css';

export interface TableProps {
  roomCode: string;
}

/** The two panels the rail can show; settings open as a modal instead. */
type RailTab = 'score' | 'chat';

/** A bridge board is thirteen tricks; used for the claim range. */
const TRICKS_PER_BOARD = 13;

/** Below this width the rail becomes a bottom sheet. Mirrors the 900px breakpoint in app.css. */
const WIDE_QUERY = '(min-width: 900px)';

/** "Ręka Wschodu" needs the genitive; `SEAT_LABEL_PL` is nominative. */
const SEAT_GENITIVE_PL: Record<Seat, string> = {
  N: 'Północy',
  E: 'Wschodu',
  S: 'Południa',
  W: 'Zachodu',
};

const STATUS_LABEL_PL: Record<ConnectionStatus, string> = {
  connecting: 'Łączenie…',
  open: 'Połączono',
  reconnecting: 'Ponawiam połączenie…',
  closed: 'Rozłączono',
};

const DEFAULT_POSITIONS: Record<TablePosition, Seat> = {
  bottom: 'S',
  left: 'W',
  top: 'N',
  right: 'E',
};

/** Polish counts in three forms; "2 osób" is the classic machine-translation tell. */
function pluralPl(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10;
  const lastTwo = n % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Reactive `matchMedia`, so the rail can behave as a sheet on a phone and a column on a desktop. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** Best-effort clipboard write; the caller decides what to say about it. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or an insecure context: fall through.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function Table({ roomCode }: TableProps): JSX.Element {
  const identity = useMemo(() => loadIdentity(), []);
  const [prefs, setPrefs] = useState<LocalPrefs>(() => loadLocalPrefs());
  const { view, status, toasts, dismissToast, send, lastTrickWinner, sweepWinner, error } = useTable(
    roomCode,
    identity,
  );

  const isWide = useMediaQuery(WIDE_QUERY);
  const [tab, setTab] = useState<RailTab>('score');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auctionOpen, setAuctionOpen] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimDismissed, setClaimDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [seenChat, setSeenChat] = useState(0);
  const [clockTick, setClockTick] = useState(0);

  const copyTimer = useRef<number | null>(null);
  const clockOffset = useRef<number>(0);
  const tablistRef = useRef<HTMLDivElement | null>(null);

  // ---- derived view -------------------------------------------------------

  const settings: TableSettings = view?.settings ?? DEFAULT_SETTINGS;
  const board = view?.board ?? null;
  const phase = view?.phase ?? 'lobby';
  const yourSeat = view?.yourSeat ?? null;
  const contract = board?.contract ?? null;
  const play = board?.play ?? null;
  const dummy = contract !== null ? dummySeat(contract.declarer) : null;
  const occupants: SeatOccupant[] = view?.occupants ?? [];

  const occupantAt = useCallback(
    (seat: Seat): SeatOccupant | undefined => occupants.find((entry) => entry.seat === seat),
    [occupants],
  );

  const seatToBid =
    board !== null && phase === 'auction' ? seatToCall(board.auction, board.dealer) : null;
  const yourTurnToCall = seatToBid !== null && seatToBid === yourSeat;

  /**
   * The hand you are allowed to touch right now, or null. This is the declarer-plays-dummy rule:
   * `controllerOf` maps dummy's seat to declarer, so a declarer on turn for dummy gets dummy's fan.
   */
  const controlledSeat: Seat | null = useMemo(() => {
    if (phase !== 'play' || play === null || contract === null || yourSeat === null) return null;
    // Ta sama regula co na serwerze (effectiveController), lacznie z przejeciem rozgrywki po
    // robocie. Gdyby klient liczyl to inaczej, podswietlalby reke, ktorej serwer nie pozwoli zagrac.
    const isBot = (seat: Seat): boolean =>
      occupants.some((entry) => entry.seat === seat && entry.isBot);
    return effectiveController(play.turn, contract, isBot, settings.takeOverBotDeclarer) === yourSeat
      ? play.turn
      : null;
  }, [phase, play, contract, yourSeat, occupants, settings.takeOverBotDeclarer]);

  const controlledHand: Card[] | undefined =
    controlledSeat !== null ? board?.hands.visible[controlledSeat] : undefined;

  const legalPlays: Card[] = useMemo(() => {
    if (controlledSeat === null || controlledHand === undefined) return [];
    if (play === null || play.tricks.length === 0) return [];
    // Dopoki zapowiedz nie jest rozstrzygnieta, gra jest zawieszona (Law 68D) i serwer odrzuca
    // KAZDA karte. Bez tego interfejs klamal: karty swiecily sie jako grywalne, klikniecie
    // konczylo sie bledem lecacym tylko do konsoli, a gracz nie widzial zadnego komunikatu.
    if (play.claim !== null) return [];
    return legalCards(controlledHand, play);
  }, [controlledSeat, controlledHand, play]);

  const legalBids: Call[] = useMemo(() => {
    if (board === null || yourSeat === null || !yourTurnToCall) return [];
    return legalCalls(board.auction, board.dealer, yourSeat);
  }, [board, yourSeat, yourTurnToCall]);

  const yourHand: Card[] | undefined = yourSeat !== null ? board?.hands.visible[yourSeat] : undefined;

  // ---- turn clock ---------------------------------------------------------

  // The server sends its own `now`, so we can render a countdown without trusting the local clock.
  useEffect(() => {
    if (view !== null) clockOffset.current = view.now - Date.now();
  }, [view]);

  const turnDeadline = view?.turnDeadline ?? null;
  useEffect(() => {
    if (turnDeadline === null) return;
    const handle = window.setInterval(() => setClockTick((value) => value + 1), 500);
    return () => window.clearInterval(handle);
  }, [turnDeadline]);

  const secondsLeft = useMemo<number | null>(() => {
    void clockTick;
    if (turnDeadline === null) return null;
    return Math.max(0, (turnDeadline - (Date.now() + clockOffset.current)) / 1000);
  }, [turnDeadline, clockTick]);

  // ---- chat unread --------------------------------------------------------

  const chatCount = view?.chat.length ?? 0;
  const railOpen = isWide || sheetOpen;
  const chatVisible = railOpen && tab === 'chat';

  useEffect(() => {
    if (chatVisible) setSeenChat(chatCount);
  }, [chatVisible, chatCount]);

  const unreadChat = Math.max(0, chatCount - seenChat);

  // ---- actions ------------------------------------------------------------

  const onPlayCard = useCallback((card: Card) => send({ t: 'play', card }), [send]);
  const onMakeCall = useCallback((call: Call) => send({ t: 'call', call }), [send]);
  const onSit = useCallback((seat: Seat) => send({ t: 'sit', seat }), [send]);
  const onAddBot = useCallback(
    (seat: Seat) => send({ t: 'addBot', seat, level: settings.botLevel }),
    [send, settings.botLevel],
  );
  const onRemoveBot = useCallback((seat: Seat) => send({ t: 'removeBot', seat }), [send]);

  const shareUrl = `${window.location.origin}${window.location.pathname}#/t/${roomCode}`;

  const onCopyLink = useCallback((): void => {
    void copyText(shareUrl).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 2000);
    });
  }, [shareUrl]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const onLeave = useCallback((): void => {
    window.location.hash = '#/';
  }, []);

  /** Fills the empty seats with robots and starts the match in one gesture. */
  const onStart = useCallback((): void => {
    for (const seat of SEATS) {
      if (occupants.every((entry) => entry.seat !== seat)) {
        send({ t: 'addBot', seat, level: settings.botLevel });
      }
    }
    send({ t: 'start' });
  }, [occupants, send, settings.botLevel]);

  const onLocalChange = useCallback((patch: Partial<LocalPrefs>): void => {
    setPrefs(saveLocalPrefs(patch));
  }, []);

  const onSettingsChange = useCallback(
    (patch: Partial<TableSettings>): void => send({ t: 'setSettings', settings: patch }),
    [send],
  );

  // ---- claims and undo ----------------------------------------------------

  const claim = play?.claim ?? null;
  const claimKey =
    claim !== null ? `${claim.by}:${claim.tricks}:${claim.pending.join('')}` : null;
  const mustRespondToClaim =
    claim !== null && yourSeat !== null && claim.pending.includes(yourSeat);
  const respondOpen = mustRespondToClaim && claimDismissed !== claimKey;
  const claimDialogOpen = respondOpen || claimOpen;

  const yourSide = yourSeat !== null ? sideOf(yourSeat) : null;
  const yourTricks =
    play === null || yourSide === null ? 0 : yourSide === 'NS' ? play.tricksNS : play.tricksEW;
  const undecidedTricks =
    play === null ? TRICKS_PER_BOARD : Math.max(0, TRICKS_PER_BOARD - (play.tricksNS + play.tricksEW));

  const canClaim =
    phase === 'play' && yourSeat !== null && contract !== null && yourSeat !== dummy && claim === null;

  const onCloseClaim = useCallback((): void => {
    if (respondOpen) setClaimDismissed(claimKey);
    setClaimOpen(false);
  }, [claimKey, respondOpen]);

  const undoRequest = view?.undoRequest ?? null;
  const undoNeedsYou =
    undoRequest !== null && yourSeat !== null && undoRequest.pending.includes(yourSeat);
  const canRequestUndo =
    settings.allowUndo &&
    yourSeat !== null &&
    undoRequest === null &&
    (phase === 'auction' || phase === 'play');

  // ---- rail tabs ----------------------------------------------------------

  const onTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const container = tablistRef.current;
    if (container === null) return;
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (tabs.length === 0) return;
    const active = tabs.findIndex((element) => element === document.activeElement);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(Math.max(0, active) + delta + tabs.length) % tabs.length];
    event.preventDefault();
    next.focus();
    next.click();
  }, []);

  const selectTab = useCallback(
    (next: RailTab): void => {
      if (!isWide && sheetOpen && tab === next) {
        setSheetOpen(false);
        return;
      }
      setTab(next);
      setSheetOpen(true);
    },
    [isWide, sheetOpen, tab],
  );

  // ---- seat geometry ------------------------------------------------------

  const seatByPosition = useMemo<Record<TablePosition, Seat>>(() => {
    const map: Record<TablePosition, Seat> = { ...DEFAULT_POSITIONS };
    for (const entry of seatsForViewer(yourSeat)) map[entry.position] = entry.seat;
    return map;
  }, [yourSeat]);

  function tricksFor(seat: Seat): number {
    if (play === null) return 0;
    return sideOf(seat) === 'NS' ? play.tricksNS : play.tricksEW;
  }

  function renderHand(position: TablePosition): JSX.Element {
    const seat = seatByPosition[position];
    const visible = board?.hands.visible[seat];
    const count = board?.hands.counts[seat] ?? 0;
    const interactive = seat === controlledSeat;
    const mine = seat === yourSeat;

    return (
      <Hand
        cards={visible ?? []}
        count={count}
        faceDown={visible === undefined}
        orientation={orientationOf(position)}
        legal={interactive ? legalPlays : undefined}
        interactive={interactive}
        onPlay={interactive ? onPlayCard : undefined}
        size={position === 'bottom' ? 'md' : 'sm'}
        compact={position === 'left' || position === 'right'}
        trump={contract?.strain}
        label={`Ręka ${SEAT_GENITIVE_PL[seat]}${mine ? ' — Twoja' : ''}`}
      />
    );
  }

  function renderPlate(position: TablePosition): JSX.Element {
    const seat = seatByPosition[position];
    const occupant = occupantAt(seat);
    const isTurn =
      phase === 'play' ? play?.turn === seat : phase === 'auction' ? seatToBid === seat : false;
    const seatIsFree = occupant === undefined;

    return (
      <SeatPlate
        seat={seat}
        occupant={occupant}
        position={position}
        isYou={seat === yourSeat}
        isDealer={board?.dealer === seat}
        isDeclarer={contract?.declarer === seat}
        isDummy={dummy === seat}
        isTurn={isTurn}
        vulnerable={board !== null && isVulnerable(seat, board.vulnerability)}
        secondsLeft={isTurn ? secondsLeft : null}
        tricksWon={tricksFor(seat)}
        onSit={seatIsFree && yourSeat === null ? onSit : undefined}
        onAddBot={seatIsFree && phase === 'lobby' ? onAddBot : undefined}
        onRemoveBot={occupant?.isBot === true && phase === 'lobby' ? onRemoveBot : undefined}
      />
    );
  }

  // ---- centre of the table ------------------------------------------------

  function renderCentre(): JSX.Element {
    if (board === null || phase === 'lobby') {
      const humans = occupants.filter((entry) => !entry.isBot).length;
      const free = SEATS.filter((seat) => occupants.every((entry) => entry.seat !== seat));
      return (
        <div className="bo-centre-card">
          <Art id="art-empty-table" className="bo-centre-card__art" />
          <h2 className="bo-centre-card__title">Poczekalnia</h2>
          <p className="bo-centre-card__text">
            {yourSeat === null
              ? 'Usiądź na wolnym miejscu, żeby zagrać. Możesz też tylko obserwować.'
              : 'Zaproś drugą osobę linkiem do stołu. Wolne miejsca zajmą roboty.'}
          </p>
          <p className="bo-centre-card__meta">
            {`Przy stole: ${humans} ${pluralPl(humans, 'osoba', 'osoby', 'osób')} · ` +
              `wolne ${pluralPl(free.length, 'miejsce', 'miejsca', 'miejsc')}: ${free.length}`}
          </p>
          <button
            type="button"
            className="bo-btn bo-btn--primary"
            onClick={onStart}
            disabled={humans < 1 || yourSeat === null}
          >
            {free.length > 0 ? 'Rozpocznij — roboty zajmą resztę' : 'Rozpocznij grę'}
          </button>
          {humans < 1 ? (
            <p className="bo-centre-card__meta">Ktoś musi najpierw usiąść przy stole.</p>
          ) : null}
        </div>
      );
    }

    if (phase === 'auction') {
      // On a wide screen the bidding box sits in the middle of the table, because bidding is
      // done while looking at your own hand and putting the box below the felt would force a
      // scroll before every call. A phone has no room in the middle, so there the box docks
      // under the table instead (see the action bar below).
      return (
        <div className="bo-centre-auction">
          <AuctionGrid
            auction={board.auction}
            dealer={board.dealer}
            viewer={yourSeat}
            pending
            compact
          />
          {/* Komunikat o turze musi istnieć TAKŻE dla gracza, który ma się odezwać. Wcześniej
              renderował się wyłącznie w gałęzi oczekiwania, więc czytnik ekranu mówił „Licytuje:
              Wschód", „Licytuje: Południe", a gdy przychodziła kolej użytkownika — cisza. */}
          {/* Gracz NA RUCHU widzi pudelko odzywek, wiec komunikat jest mu wzrokowo zbedny — i dokladal
              ~40 px wysokosci tam, gdzie walczylem o kazdy piksel. Zostaje jednak w drzewie dla czytnika
              ekranu, bo to jedyne miejsce, gdzie pada informacja "Twoja kolej". */}
          <p
            className={
              yourTurnToCall ? 'bo-centre-auction__wait bo-visually-hidden' : 'bo-centre-auction__wait'
            }
            role="status"
            aria-live="polite"
            hidden={seatToBid === null}
          >
            {seatToBid === null
              ? ''
              : yourTurnToCall
                ? 'Twoja kolej — zalicytuj.'
                : `Licytuje: ${SEAT_LABEL_PL[seatToBid]}`}
          </p>
          {isWide && yourTurnToCall ? (
            <BiddingBox legal={legalBids} onCall={onMakeCall} hint={null} />
          ) : null}
        </div>
      );
    }

    if (phase === 'review' || phase === 'finished') {
      const result = board.result;
      return (
        <div className="bo-centre-card">
          <h2 className="bo-centre-card__title">{`Rozdanie ${board.boardNumber} zakończone`}</h2>
          <ContractBadge contract={board.contract} passedOut={result?.passedOut ?? false} />
          {result !== null && !result.passedOut ? (
            <p className="bo-centre-card__text">
              {`Wzięte lewy: ${result.tricksWon ?? 0}. Zapis dla NS: ${result.scoreNS}.`}
            </p>
          ) : (
            <p className="bo-centre-card__text">Nikt nie licytował — rozdanie bez zapisu.</p>
          )}
          {view?.finalMessage !== undefined ? (
            <p className="bo-centre-card__meta">{view.finalMessage}</p>
          ) : null}
        </div>
      );
    }

    // Reguła (i powód, dla którego nie wystarczy ostatni element) siedzi w trickView.ts
    // — jest testowana jednostkowo, bo to był realny błąd: czwarta karta nie pojawiała
    // się ani na moment.
    const shownTrick =
      play === null ? null : trickToShow({ tricks: play.tricks, lastTrickWinner });

    return (
      <TrickArea
        trick={shownTrick}
        viewer={yourSeat}
        trump={contract?.strain ?? null}
        winner={sweepWinner}
        vulnerability={board.vulnerability}
        boardNumber={board.boardNumber}
        dealer={board.dealer}
      />
    );
  }

  // ---- connecting / fatal screens ----------------------------------------

  const header = (
    <header className="bo-topbar">
      <a className="bo-topbar__brand" href="#/">
        <Art id="art-logo-mark" size={26} className="bo-topbar__logo" /> Bridge Online
      </a>

      <p className="bo-topbar__code">
        <span className="bo-visually-hidden">Kod stołu: </span>
        <span className="bo-code">{roomCode}</span>
      </p>

      <button type="button" className="bo-btn bo-btn--ghost bo-btn--sm" onClick={onCopyLink}>
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'Skopiowano' : 'Kopiuj link'}
      </button>

      <p className="bo-pill" data-status={status}>
        <span className="bo-pill__dot" aria-hidden="true" />
        {STATUS_LABEL_PL[status]}
      </p>

      {board !== null ? (
        <p className="bo-topbar__board">
          {`Rozdanie ${board.boardNumber}`}
          {settings.boardCount > 0 ? ` z ${settings.boardCount}` : ''}
        </p>
      ) : null}

      <button type="button" className="bo-btn bo-btn--ghost bo-btn--sm bo-topbar__leave" onClick={onLeave}>
        <Icon name="leave" />
        Opuść stół
      </button>
    </header>
  );

  if (view === null) {
    return (
      <div className="bo-app">
        {header}
        <main className="bo-stage bo-stage--single">
          <div className="bo-centre-card bo-centre-card--standalone" role="status">
            <h2 className="bo-centre-card__title">
              {error !== null ? 'Nie można wejść do stołu' : 'Łączenie ze stołem…'}
            </h2>
            <p className="bo-centre-card__text">
              {error ?? `Szukamy stołu o kodzie ${roomCode}. To zwykle chwila.`}
            </p>
            <a className="bo-btn bo-btn--ghost" href="#/">
              Wróć na stronę główną
            </a>
          </div>
        </main>
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  // ---- the full screen ----------------------------------------------------

  return (
    // `--table` przykrywa cala wysokosc okna: stol ma wypelniac ekran, a nie plywac
    // w pustym suknie z paskiem przewijania pod spodem.
    <div className="bo-app bo-app--table">
      {header}

      {error !== null ? (
        <p className="bo-banner bo-banner--error" role="alert">
          {error}
        </p>
      ) : null}

      {undoNeedsYou && undoRequest !== null ? (
        <div className="bo-banner bo-banner--ask" role="alert">
          <span>{`Prośba o cofnięcie: ${undoRequest.description}`}</span>
          <span className="bo-banner__actions">
            <button
              type="button"
              className="bo-btn bo-btn--sm"
              onClick={() => send({ t: 'undoRespond', accept: false })}
            >
              Odmawiam
            </button>
            <button
              type="button"
              className="bo-btn bo-btn--primary bo-btn--sm"
              onClick={() => send({ t: 'undoRespond', accept: true })}
            >
              Zgadzam się
            </button>
          </span>
        </div>
      ) : null}

      <main className="bo-stage">
        <section className="bo-table-column" aria-label="Stół">
          {/* Ekran stolu nie mial ZADNEGO naglowka — jedyne h2 siedzialy w bocznym panelu ("Zapis",
              "Czat"), wiec uzytkownik czytnika ekranu nie mogl skoczyc do samej gry skrotem po
              naglowkach. Wizualnie nie zmienia sie nic: naglowek jest dostepny tylko dla czytnika. */}
          <h1 className="bo-visually-hidden">
            {contract !== null
              ? `Stół ${roomCode} — rozdanie ${board?.boardNumber ?? 1}`
              : `Stół ${roomCode}`}
          </h1>
          {/* Pasek nad stolem istnieje w KAZDEJ fazie rozdania i ma stala wysokosc. Wczesniej
              pojawial sie dopiero po zawarciu kontraktu, wiec sukno w licytacji bylo wyzsze niz w
              rozgrywce — a ze karta skaluje sie wysokoscia sukna, caly stol skakal w chwili
              zawarcia kontraktu. Jedna wysokosc paska = jedna wysokosc sukna = jedna karta. */}
          {board !== null ? (
            <div className="bo-hud">
              {contract !== null ? (
                <button
                  type="button"
                  className="bo-hud__toggle"
                  aria-expanded={auctionOpen}
                  aria-controls="bo-auction-panel"
                  onClick={() => setAuctionOpen((open) => !open)}
                >
                  <ContractBadge contract={contract} size="sm" />
                  <span className="bo-hud__hint bo-hud__hint--icon">
                    <Icon name="history" size={16} />
                    {auctionOpen ? 'Ukryj licytację' : 'Pokaż licytację'}
                  </span>
                </button>
              ) : (
                <div className="bo-hud__toggle bo-hud__toggle--static" role="status">
                  <span className="bo-hud__status">
                    {phase === 'auction'
                      ? `Licytacja — rozdaje ${SEAT_LABEL_PL[board.dealer]}`
                      : 'Rozdanie spasowane'}
                  </span>
                </div>
              )}
              <div id="bo-auction-panel" className="bo-hud__auction" hidden={contract === null || !auctionOpen}>
                <AuctionGrid
                  auction={board?.auction ?? []}
                  dealer={board?.dealer ?? 'N'}
                  viewer={yourSeat}
                  compact
                />
              </div>
            </div>
          ) : null}

          <TableFelt
            bottom={renderHand('bottom')}
            left={renderHand('left')}
            top={renderHand('top')}
            right={renderHand('right')}
            plates={{
              bottom: renderPlate('bottom'),
              left: renderPlate('left'),
              top: renderPlate('top'),
              right: renderPlate('right'),
            }}
          >
            {renderCentre()}
          </TableFelt>

          <div className="bo-actions">
            {/* On a wide screen the bidding box is in the centre of the felt; on a phone the
                centre is far too small for a 7x5 ladder, so it docks here instead. */}
            {!isWide && phase === 'auction' && yourTurnToCall ? (
              <BiddingBox legal={legalBids} onCall={onMakeCall} hint={null} />
            ) : null}

            {/* Linia statusu istnieje ZAWSZE, gdy jest rozdanie — o stalej wysokosci. Wczesniej
                renderowala sie tylko w rozgrywce i tylko w turze gracza, wiec pasek akcji zmienial
                wysokosc miedzy fazami I w srodku rozgrywki przy kazdej zmianie ruchu, a razem z nim
                sukno i wielkosc karty. Tresc jest przy okazji uzyteczna: mowi, czyj jest ruch. */}
            {board !== null ? (
              <p className="bo-actions__wait" aria-live="polite">
                {phase === 'auction'
                  ? yourTurnToCall
                    ? 'Twoja kolej — zalicytuj.'
                    : seatToBid !== null
                      ? `Licytuje: ${SEAT_LABEL_PL[seatToBid]}`
                      : ' '
                  : phase === 'play' && play !== null
                    ? controlledSeat !== null
                      ? controlledSeat === yourSeat
                        ? 'Twoja kolej — zagraj kartę.'
                        : controlledSeat === dummy
                          ? `Zagraj kartą dziadka (${SEAT_LABEL_PL[controlledSeat]}).`
                          : `Zagraj kartą rozgrywającego (${SEAT_LABEL_PL[controlledSeat]}).`
                      : `Gra: ${SEAT_LABEL_PL[play.turn]}`
                    : phase === 'review'
                      ? 'Rozdanie zakończone.'
                      : ' '}
              </p>
            ) : null}

            <div className="bo-actions__row">
              {settings.showHcp && yourHand !== undefined && yourHand.length > 0 ? (
                <p className="bo-tag">
                  <span className="bo-visually-hidden">Punkty honorowe Twojej ręki: </span>
                  {`PH ${hcp(yourHand)}`}
                </p>
              ) : null}

              {canClaim ? (
                <button
                  type="button"
                  className="bo-btn bo-btn--sm"
                  onClick={() => setClaimOpen(true)}
                >
                  <Icon name="claim" />
                  Zapowiedz lewy
                </button>
              ) : null}

              {canRequestUndo ? (
                <button
                  type="button"
                  className="bo-btn bo-btn--sm"
                  onClick={() => send({ t: 'requestUndo' })}
                >
                  <Icon name="undo" />
                  Cofnij
                </button>
              ) : null}

              {phase === 'review' ? (
                <button
                  type="button"
                  className="bo-btn bo-btn--primary bo-btn--sm"
                  onClick={() => send({ t: 'nextBoard' })}
                >
                  <Icon name="next-board" />
                  Następne rozdanie
                </button>
              ) : null}

              {phase === 'finished' ? (
                <a className="bo-btn bo-btn--primary bo-btn--sm" href="#/">
                  Zakończ i wróć
                </a>
              ) : null}

              {yourSeat !== null && phase === 'lobby' ? (
                <button type="button" className="bo-btn bo-btn--sm" onClick={() => send({ t: 'stand' })}>
                  Wstań od stołu
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="bo-rail" data-open={sheetOpen ? 'true' : 'false'} aria-label="Panel stołu">
          <div className="bo-rail__bar">
            <div
              className="bo-rail__tablist"
              role="tablist"
              aria-label="Panele stołu"
              ref={tablistRef}
              onKeyDown={onTabKeyDown}
            >
              <button
                type="button"
                role="tab"
                id="bo-tab-score"
                className="bo-rail__tab"
                aria-selected={tab === 'score'}
                aria-controls="bo-panel-score"
                tabIndex={tab === 'score' ? 0 : -1}
                onClick={() => selectTab('score')}
              >
                <Icon name="score" />
                Wynik
              </button>
              <button
                type="button"
                role="tab"
                id="bo-tab-chat"
                className="bo-rail__tab"
                aria-selected={tab === 'chat'}
                aria-controls="bo-panel-chat"
                tabIndex={tab === 'chat' ? 0 : -1}
                onClick={() => selectTab('chat')}
              >
                <Icon name="chat" />
                Czat
                {unreadChat > 0 ? (
                  <span className="bo-rail__badge">
                    <span aria-hidden="true">{unreadChat > 9 ? '9+' : unreadChat}</span>
                    <span className="bo-visually-hidden">{`, nieprzeczytane: ${unreadChat}`}</span>
                  </span>
                ) : null}
              </button>
            </div>

            <button
              type="button"
              className="bo-rail__tab bo-rail__tab--plain"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" />
              Ustawienia
            </button>
          </div>

          <div className="bo-rail__panel">
            <div
              role="tabpanel"
              id="bo-panel-score"
              aria-labelledby="bo-tab-score"
              hidden={tab !== 'score'}
              className="bo-rail__tabpanel"
            >
              <Scoreboard
                score={view.score}
                mode={settings.scoringMode}
                viewer={yourSeat}
                boardCount={settings.boardCount}
              />
            </div>
            <div
              role="tabpanel"
              id="bo-panel-chat"
              aria-labelledby="bo-tab-chat"
              hidden={tab !== 'chat'}
              className="bo-rail__tabpanel"
            >
              <ChatPanel
                messages={view.chat}
                onSend={(text) => send({ t: 'chat', text })}
                yourSeat={yourSeat}
                unreadCount={unreadChat}
              />
            </div>
          </div>
        </aside>
      </main>

      <SettingsSheet
        settings={settings}
        canEdit={yourSeat !== null}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChange={onSettingsChange}
        local={prefs}
        onLocalChange={onLocalChange}
      />

      <ClaimDialog
        open={claimDialogOpen}
        mode={respondOpen ? 'respond' : 'make'}
        minTricks={yourTricks}
        maxTricks={yourTricks + undecidedTricks}
        claim={claim}
        onClaim={(tricks, statement) => {
          send({ t: 'claim', tricks, statement });
          setClaimOpen(false);
        }}
        onRespond={(accept) => {
          send({ t: 'claimRespond', accept });
          setClaimDismissed(claimKey);
        }}
        onClose={onCloseClaim}
      />

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
