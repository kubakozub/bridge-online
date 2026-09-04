/**
 * The live connection to one table.
 *
 * This hook is the whole client half of the protocol: it opens the WebSocket, says hello, keeps a
 * single authoritative `TableView` in state, and turns server notices into toasts.
 *
 * Reconnection is the part that actually matters. Two people on home wifi will drop the socket
 * several times during a rubber - a phone changing cell, a router hiccup, a laptop lid - and none
 * of that may cost them the match. So: exponential backoff with jitter from 500ms to 8s, an
 * automatic re-`hello` on every fresh socket (the server matches the seat by `playerId`), an
 * immediate retry when the browser reports the network is back, and a 25-second application-level
 * ping so intermediaries do not silently reap an idle connection.
 *
 * Two invariants keep the UI honest:
 *   - `state` frames older than the newest `rev` we have already applied are dropped, so an
 *     out-of-order broadcast can never rewind the table;
 *   - a malformed frame is logged and ignored, never thrown. A single bad byte on the wire must
 *     not take the game screen down.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionError, Seat } from '../../engine/types';
import type { ClientMessage, ServerMessage, TableView } from '../../server/protocol';
import { PROTOCOL_VERSION } from '../../server/protocol';
import type { Toast } from '../components/Toasts';
import type { Identity } from './identity';

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseTable {
  view: TableView | null;
  connected: boolean;
  /** 'connecting' | 'open' | 'reconnecting' | 'closed' */
  status: ConnectionStatus;
  toasts: Toast[];
  dismissToast: (id: string) => void;
  send: (msg: ClientMessage) => void;
  lastTrickWinner: Seat | null;
  /** Sygnał animacji zamiatania — null, dopóki trwa pauza na odczytanie lewy. */
  sweepWinner: Seat | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** First retry delay; doubles up to `BACKOFF_MAX_MS`. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

/** Keep-alive interval. Well under the 60s idle timeout most proxies use. */
const PING_INTERVAL_MS = 25_000;

/** Never keep more than this many notices on screen at once. */
const MAX_TOASTS = 4;

/** Awaryjne czasy, gdy arkusza stylów nie da się odczytać. */
const TRICK_HOLD_FALLBACK_MS = 1500;
const TRICK_SWEEP_FALLBACK_MS = 700;

/** Polish wording for every action error the engine can report. */
const ERROR_TEXT_PL: Record<ActionError['code'], string> = {
  WRONG_PHASE: 'Tego ruchu nie można teraz wykonać.',
  NOT_YOUR_TURN: 'To nie Twoja kolej.',
  ILLEGAL_CALL: 'Ta odzywka jest niedozwolona.',
  ILLEGAL_CARD: 'Tej karty nie można teraz zagrać.',
  NOT_YOUR_CARD: 'Nie masz tej karty w ręce.',
  MUST_FOLLOW_SUIT: 'Musisz dołożyć do koloru.',
  NO_CLAIM_PENDING: 'Nie ma teraz zapowiedzi do rozpatrzenia.',
  BAD_CLAIM: 'Takiej liczby lew nie można zapowiedzieć.',
  NOTHING_TO_UNDO: 'Nie ma czego cofnąć.',
};

const scoreFormat = new Intl.NumberFormat('pl-PL', { signDisplay: 'exceptZero' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Odczytuje czas z tokenu CSS (`120ms` albo `0.4s`); null, gdy nie da się go ustalić. */
function czasZTokenu(nazwa: string): number | null {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(nazwa).trim();
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value) && value > 0) return raw.endsWith('ms') ? value : value * 1000;
  } catch {
    // Brak dokumentu albo przeglądarka jeszcze nie liczy własności niestandardowych.
  }
  return null;
}

/** A parsed frame, or null when the payload was not a recognisable server message. */
function parseFrame(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as ServerMessage;
  return typeof message.t === 'string' ? message : null;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useTable(roomCode: string | null, identity: Identity): UseTable {
  const [view, setView] = useState<TableView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('closed');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastTrickWinner, setLastTrickWinner] = useState<Seat | null>(null);
  /** Zapala się dopiero PO pauzie — to on uruchamia animację zamiatania. */
  const [sweepWinner, setSweepWinner] = useState<Seat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const identityRef = useRef<Identity>(identity);
  const nameRef = useRef<string>(identity.name);
  const socketRef = useRef<WebSocket | null>(null);
  const revRef = useRef<number>(-1);
  const attemptRef = useRef<number>(0);
  const reconnectRef = useRef<number | null>(null);
  const pingRef = useRef<number | null>(null);
  const sweepRef = useRef<number | null>(null);
  const holdRef = useRef<number | null>(null);
  /** Set when the server told us to go away: stop retrying for good. */
  const stoppedRef = useRef<boolean>(false);
  const toastSeq = useRef<number>(0);

  // Declared before the connection effect so the ref is fresh by the time `hello` is sent.
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  const pushToast = useCallback((level: Toast['level'], text: string): void => {
    toastSeq.current += 1;
    const toast: Toast = { id: `bo-toast-${toastSeq.current}`, level, text };
    setToasts((previous) => [...previous.slice(-(MAX_TOASTS - 1)), toast]);
  }, []);

  const dismissToast = useCallback((id: string): void => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  // A rename while connected is a message, not a reconnection - the socket stays up.
  useEffect(() => {
    if (nameRef.current === identity.name) return;
    nameRef.current = identity.name;
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      const message: ClientMessage = { t: 'rename', name: identity.name };
      socket.send(JSON.stringify(message));
    }
  }, [identity.name]);

  useEffect(() => {
    if (roomCode === null) {
      setStatus('closed');
      return;
    }
    // Declared as `string` rather than relying on narrowing: `connect` is a hoisted function
    // declaration, so TypeScript will not carry the null check into it.
    const room: string = roomCode;

    // `cancelled` is the unmount guard; `stoppedRef` is the "server said no" guard.
    let cancelled = false;
    stoppedRef.current = false;
    revRef.current = -1;
    attemptRef.current = 0;
    setError(null);
    setView(null);

    function clearReconnect(): void {
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    }

    function clearPing(): void {
      if (pingRef.current !== null) {
        window.clearInterval(pingRef.current);
        pingRef.current = null;
      }
    }

    function clearSweep(): void {
      if (holdRef.current !== null) {
        window.clearTimeout(holdRef.current);
        holdRef.current = null;
      }
      if (sweepRef.current !== null) {
        window.clearTimeout(sweepRef.current);
        sweepRef.current = null;
      }
    }

    function scheduleReconnect(): void {
      if (cancelled || stoppedRef.current) return;
      clearReconnect();
      // 500, 1000, 2000, 4000, 8000, 8000, ... each multiplied by 0.6-1.0 so that two clients
      // dropped by the same outage do not come back in lockstep.
      const step = Math.min(attemptRef.current, 4);
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** step);
      const delay = Math.round(base * (0.6 + Math.random() * 0.4));
      attemptRef.current += 1;
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        connect();
      }, delay);
    }

    function handleState(next: TableView): void {
      if (typeof next.rev !== 'number' || !Number.isFinite(next.rev)) return;
      // Out-of-order guard: a late broadcast must never rewind the table.
      if (next.rev <= revRef.current) return;
      revRef.current = next.rev;
      setView(next);
      if (next.protocolVersion !== PROTOCOL_VERSION) {
        setError('Ta wersja aplikacji nie pasuje do serwera. Odśwież stronę.');
      }
    }

    /**
     * Zakończona lewa ma DWIE fazy i to jest tu istotne.
     *
     * Najpierw komplet czterech kart stoi nieruchomo (`--dur-trick-hold`), żeby dało się
     * odczytać, co dołożył ostatni gracz. Dopiero potem zapala się sygnał zamiatania i
     * karty zjeżdżają do zwycięzcy (`--dur-trick`).
     *
     * Rozdzielenie jest konieczne, a nie kosmetyczne: przejście CSS nie uruchomi się na
     * elemencie, który POWSTAJE już w stanie końcowym. Gdyby sygnał zamiatania szedł razem
     * z kartami, montowałyby się od razu przezroczyste — dokładnie tak było, karty siedziały
     * w DOM 1380 ms przy zerowej widoczności.
     */
    function handleTrickComplete(winner: Seat): void {
      clearSweep();
      setLastTrickWinner(winner); // faza 1: pokaż komplet, jeszcze bez zamiatania
      setSweepWinner(null);

      const hold = czasZTokenu('--dur-trick-hold') ?? TRICK_HOLD_FALLBACK_MS;
      const sweep = czasZTokenu('--dur-trick') ?? TRICK_SWEEP_FALLBACK_MS;

      holdRef.current = window.setTimeout(() => {
        holdRef.current = null;
        setSweepWinner(winner); // faza 2: atrybut pojawia się PO fakcie → przejście rusza
        sweepRef.current = window.setTimeout(() => {
          sweepRef.current = null;
          setLastTrickWinner(null);
          setSweepWinner(null);
        }, sweep);
      }, hold);
    }

    function handleFrame(raw: unknown): void {
      const message = parseFrame(raw);
      if (message === null) {
        console.warn('[bo] pominięto nieczytelną ramkę z serwera');
        return;
      }

      switch (message.t) {
        case 'state':
          handleState(message.view);
          break;
        case 'error':
          pushToast('error', ERROR_TEXT_PL[message.error.code] ?? message.error.message);
          break;
        case 'toast':
          pushToast(message.level, message.text);
          break;
        case 'pong':
          // The keep-alive round-tripped; nothing to do but be glad.
          break;
        case 'trickComplete':
          handleTrickComplete(message.winner);
          break;
        case 'boardComplete':
          pushToast(
            'info',
            message.result.passedOut
              ? 'Rozdanie spasowane — bez zapisu.'
              : `Rozdanie zakończone. Zapis NS: ${scoreFormat.format(message.result.scoreNS)}.`,
          );
          break;
        case 'kicked':
          stoppedRef.current = true;
          setError(message.reason);
          pushToast('error', message.reason);
          setStatus('closed');
          socketRef.current?.close(1000, 'kicked');
          break;
        default:
          break;
      }
    }

    function connect(): void {
      if (cancelled || stoppedRef.current) return;

      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${scheme}://${window.location.host}/api/table/${encodeURIComponent(room)}/ws`;
      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (cause) {
        console.warn('[bo] nie udało się otworzyć połączenia', cause);
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled || stoppedRef.current) {
          socket.close(1000, 'unmount');
          return;
        }
        attemptRef.current = 0;
        setStatus('open');
        setError(null);

        const me = identityRef.current;
        nameRef.current = me.name;
        const hello: ClientMessage = {
          t: 'hello',
          playerId: me.playerId,
          name: me.name,
          protocolVersion: PROTOCOL_VERSION,
        };
        socket.send(JSON.stringify(hello));

        clearPing();
        pingRef.current = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const ping: ClientMessage = { t: 'ping' };
          socket.send(JSON.stringify(ping));
        }, PING_INTERVAL_MS);
      });

      socket.addEventListener('message', (event) => {
        handleFrame(event.data as unknown);
      });

      socket.addEventListener('error', () => {
        // A 'close' always follows; the retry is scheduled from there so it happens exactly once.
      });

      socket.addEventListener('close', () => {
        clearPing();
        if (socketRef.current === socket) socketRef.current = null;
        if (cancelled || stoppedRef.current) {
          setStatus('closed');
          return;
        }
        setStatus('reconnecting');
        scheduleReconnect();
      });
    }

    /** The browser came back online: do not sit out the rest of the backoff. */
    function handleOnline(): void {
      if (cancelled || stoppedRef.current) return;
      const socket = socketRef.current;
      if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
      }
      clearReconnect();
      attemptRef.current = 0;
      connect();
    }

    window.addEventListener('online', handleOnline);
    connect();

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
      clearReconnect();
      clearPing();
      clearSweep();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, 'unmount');
    };
  }, [roomCode, identity.playerId, pushToast]);

  const send = useCallback(
    (message: ClientMessage): void => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        pushToast('warn', 'Brak połączenia ze stołem. Ponawiamy — spróbuj za chwilę.');
        return;
      }
      try {
        socket.send(JSON.stringify(message));
      } catch (cause) {
        console.warn('[bo] nie udało się wysłać wiadomości', cause);
        pushToast('error', 'Nie udało się wysłać ruchu. Spróbuj ponownie.');
      }
    },
    [pushToast],
  );

  return {
    view,
    connected: status === 'open',
    status,
    toasts,
    dismissToast,
    send,
    lastTrickWinner,
    sweepWinner,
    error,
  };
}
