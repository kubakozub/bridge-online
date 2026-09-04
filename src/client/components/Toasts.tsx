/**
 * Toasts - transient notices ("Zachód rozłączony", "Nie możesz teraz zagrać").
 *
 * The list itself is owned by the caller; this component only renders it, announces it politely
 * and asks for a dismissal once a toast has had its four seconds. Timers are kept per id in a
 * ref, so a newly arriving toast never restarts the clock of the ones already on screen, and
 * hovering or focusing the stack pauses the countdown (WCAG 2.2.1 - "Pause, Stop, Hide").
 */

import { useEffect, useRef, useState } from 'react';
import '../styles/panels.css';

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface ToastsProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

/** How long a toast stays on screen before it dismisses itself. */
const AUTO_DISMISS_MS = 4000;

const LEVEL_PREFIX_PL: Record<Toast['level'], string> = {
  info: 'Informacja',
  warn: 'Ostrzeżenie',
  error: 'Błąd',
};

const LEVEL_GLYPH: Record<Toast['level'], string> = {
  info: 'i',
  warn: '!',
  error: '×',
};

export function Toasts({ toasts, onDismiss }: ToastsProps): JSX.Element {
  const timers = useRef(new Map<string, number>());
  const [paused, setPaused] = useState(false);

  // Keep the latest callback without letting a new function identity restart every timer.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const handles = timers.current;

    // Drop timers for toasts the caller has already removed.
    for (const [id, handle] of handles) {
      if (!toasts.some((toast) => toast.id === id)) {
        window.clearTimeout(handle);
        handles.delete(id);
      }
    }

    if (paused) {
      for (const handle of handles.values()) window.clearTimeout(handle);
      handles.clear();
      return;
    }

    for (const toast of toasts) {
      if (handles.has(toast.id)) continue;
      const handle = window.setTimeout(() => {
        handles.delete(toast.id);
        dismissRef.current(toast.id);
      }, AUTO_DISMISS_MS);
      handles.set(toast.id, handle);
    }
  }, [toasts, paused]);

  // Unmounting mid-countdown must not leave a timer holding a stale callback.
  useEffect(() => {
    const handles = timers.current;
    return () => {
      for (const handle of handles.values()) window.clearTimeout(handle);
      handles.clear();
    };
  }, []);

  return (
    <div
      className="bo-toasts"
      role="status"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Powiadomienia"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {toasts.map((toast) => (
        <div className={`bo-toast bo-toast--${toast.level}`} key={toast.id}>
          <span className="bo-toast__glyph" aria-hidden="true">
            {LEVEL_GLYPH[toast.level]}
          </span>
          <p className="bo-toast__text">
            <span className="bo-sr-only">{LEVEL_PREFIX_PL[toast.level]}: </span>
            {toast.text}
          </p>
          <button
            type="button"
            className="bo-toast__close"
            onClick={() => onDismiss(toast.id)}
            aria-label="Zamknij powiadomienie"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
