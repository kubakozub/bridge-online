/**
 * ChatPanel - the table conversation.
 *
 * Two rules drive the design:
 *   1. Never inject markup. Every message body is rendered as a text node, so a player cannot
 *      smuggle HTML into someone else's client.
 *   2. Never yank the scroll position. New messages only auto-scroll when the reader is already
 *      pinned to the bottom; otherwise a "new messages" button appears and the reader decides.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, UIEvent } from 'react';
import type { Seat } from '../../engine/types';
import type { ChatMessage } from '../../server/protocol';
import { SEAT_LABEL_PL } from '../seats';
import '../styles/panels.css';

export interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  disabled?: boolean;
  yourSeat: Seat | null;
  unreadCount?: number;
}

/** Server-side cap; mirrored here so the input can show a live counter. */
const MAX_CHARS = 280;

/** How close to the bottom still counts as "pinned" (device pixels). */
const PIN_SLACK_PX = 32;

/** Show the character counter only once the writer is close to the limit. */
const COUNTER_VISIBLE_AT = 40;

const timeFormat = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });

function formatTime(ts: number): string {
  return Number.isFinite(ts) ? timeFormat.format(new Date(ts)) : '';
}

function machineTime(ts: number): string | undefined {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

export function ChatPanel({
  messages,
  onSend,
  disabled = false,
  yourSeat,
  unreadCount = 0,
}: ChatPanelProps): JSX.Element {
  const logRef = useRef<HTMLUListElement | null>(null);
  const pinnedRef = useRef(true);
  const [draft, setDraft] = useState('');
  const [hasNew, setHasNew] = useState(false);
  const inputId = useId();
  const counterId = useId();

  const scrollToEnd = useCallback((): void => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    pinnedRef.current = true;
    setHasNew(false);
  }, []);

  // Layout effect: adjust the scroll before the browser paints, so the log never visibly jumps.
  useLayoutEffect(() => {
    if (pinnedRef.current) {
      const log = logRef.current;
      if (log) log.scrollTop = log.scrollHeight;
    } else if (messages.length > 0) {
      setHasNew(true);
    }
  }, [messages]);

  // A resize (rotation, keyboard opening) must not strand a pinned reader mid-log.
  useEffect(() => {
    function onResize(): void {
      if (pinnedRef.current) {
        const log = logRef.current;
        if (log) log.scrollTop = log.scrollHeight;
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function handleScroll(event: UIEvent<HTMLUListElement>): void {
    const log = event.currentTarget;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= PIN_SLACK_PX;
    pinnedRef.current = atBottom;
    if (atBottom) setHasNew(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled) return;
    const text = draft.trim().slice(0, MAX_CHARS);
    if (text.length === 0) return;
    onSend(text);
    setDraft('');
    scrollToEnd();
  }

  const remaining = MAX_CHARS - draft.length;
  const canSend = !disabled && draft.trim().length > 0;

  return (
    <section className="bo-chat" aria-labelledby={`${inputId}-title`}>
      <header className="bo-chat__head">
        <h2 className="bo-chat__title" id={`${inputId}-title`}>
          Czat
        </h2>
        {unreadCount > 0 ? (
          <span className="bo-chat__badge">
            <span aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
            <span className="bo-sr-only">Nieprzeczytane wiadomości: {unreadCount}</span>
          </span>
        ) : null}
      </header>

      <div className="bo-chat__body">
        <ul
          className="bo-chat__log"
          ref={logRef}
          onScroll={handleScroll}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Historia rozmowy przy stole"
          tabIndex={0}
        >
          {messages.length === 0 ? (
            <li className="bo-chat__empty">Jeszcze nikt nic nie napisał. Zacznij rozmowę.</li>
          ) : (
            messages.map((message) => {
              const own = yourSeat !== null && message.seat === yourSeat;
              const className = message.system
                ? 'bo-chat__item bo-chat__item--system'
                : own
                  ? 'bo-chat__item bo-chat__item--own'
                  : 'bo-chat__item';

              return (
                <li className={className} key={message.id}>
                  {message.system ? (
                    <p className="bo-chat__system">
                      <span className="bo-sr-only">Komunikat systemowy: </span>
                      {message.text}
                    </p>
                  ) : (
                    <>
                      <p className="bo-chat__meta">
                        <span className="bo-chat__author">{message.name}</span>
                        <span className="bo-chat__seat">
                          {message.seat !== null ? SEAT_LABEL_PL[message.seat] : 'obserwator'}
                        </span>
                        <time className="bo-chat__time" dateTime={machineTime(message.ts)}>
                          {formatTime(message.ts)}
                        </time>
                      </p>
                      <p className="bo-chat__text">{message.text}</p>
                    </>
                  )}
                </li>
              );
            })
          )}
        </ul>

        {hasNew ? (
          <button type="button" className="bo-chat__jump" onClick={scrollToEnd}>
            Nowe wiadomości <span aria-hidden="true">↓</span>
          </button>
        ) : null}
      </div>

      <form className="bo-chat__form" onSubmit={handleSubmit}>
        <label className="bo-sr-only" htmlFor={inputId}>
          Napisz wiadomość do stołu
        </label>
        <input
          id={inputId}
          className="bo-chat__input"
          type="text"
          value={draft}
          maxLength={MAX_CHARS}
          autoComplete="off"
          disabled={disabled}
          aria-describedby={counterId}
          placeholder={disabled ? 'Czat jest wyłączony' : 'Napisz wiadomość…'}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="bo-panel-btn bo-panel-btn--primary" disabled={!canSend}>
          Wyślij
        </button>
        <p className="bo-chat__counter" id={counterId} aria-live="polite">
          {remaining <= COUNTER_VISIBLE_AT ? (
            <span className={remaining <= 0 ? 'bo-chat__counter-value is-full' : 'bo-chat__counter-value'}>
              Pozostało znaków: {remaining}
            </span>
          ) : (
            <span className="bo-sr-only">Limit {MAX_CHARS} znaków. Enter wysyła wiadomość.</span>
          )}
        </p>
      </form>
    </section>
  );
}
