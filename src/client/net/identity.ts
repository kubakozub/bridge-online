/**
 * Who you are on this machine, and how this machine likes the game to look.
 *
 * There are no accounts: a player is a random `playerId` kept in `localStorage`, which is what
 * lets you close the tab mid-rubber, come back, and drop straight into your seat. The friendly
 * name travels with it so partner sees "Kasia" instead of a UUID.
 *
 * Local preferences (theme, deck, sound, hints) never reach the server - they are per browser, and
 * applying them means stamping `data-theme` / `data-deck` on `<html>` so tokens.css can swap
 * palettes. Every storage access is wrapped: Safari in private mode throws on `setItem`, and a
 * card game must not die because of it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Identity {
  /** Stable per-browser id; the server keys seats off this. */
  playerId: string;
  /** Display name shown on the nameplate and in chat. */
  name: string;
}

export type ThemeName = 'felt' | 'daylight';
export type DeckName = 'classic' | 'four-colour';

/** Exactly the shape `SettingsSheet`'s `local` prop expects. */
export interface LocalPrefs {
  theme: ThemeName;
  deck: DeckName;
  sound: boolean;
  hints: boolean;
  largeCards: boolean;
  confirmMoves: boolean;
  calm: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_KEY = 'bo.identity';
const PREFS_KEY = 'bo.prefs';

/** Long enough for "Bartek z Krakowa", short enough for a nameplate. */
export const MAX_NAME_LENGTH = 24;

export const DEFAULT_PREFS: LocalPrefs = {
  theme: 'daylight',
  deck: 'classic',
  sound: true,
  hints: false,
  largeCards: true,
  confirmMoves: true,
  calm: true,
};

const THEMES: readonly ThemeName[] = ['felt', 'daylight'];
const DECKS: readonly DeckName[] = ['classic', 'four-colour'];

// ---------------------------------------------------------------------------
// Storage plumbing
// ---------------------------------------------------------------------------

/**
 * Reads and parses a key, or null. Never throws: storage can be disabled entirely, and the stored
 * JSON can be anything at all if a previous version of the app wrote it.
 */
function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Writes a key, silently giving up when storage is unavailable or full. */
function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing, a full quota, or storage blocked by policy. The in-memory cache below
    // still keeps the session coherent, which is all that matters for one sitting.
  }
}

/** Narrows an unknown parsed value to a plain object we can read fields off. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function pickString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function pickBoolean(source: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  if (source === null) return fallback;
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function pickOption<T extends string>(
  source: Record<string, unknown> | null,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = pickString(source, key);
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** A random id, degrading gracefully where `crypto.randomUUID` is missing (older Safari, http://). */
function randomPlayerId(): string {
  const source: Crypto | undefined = globalThis.crypto;
  if (source !== undefined && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "Gracz 4821" - friendly, Polish, and unlikely to collide at a four-seat table. */
function defaultName(): string {
  return `Gracz ${1000 + Math.floor(Math.random() * 9000)}`;
}

/** Trims, collapses runs of whitespace and caps the length; empty input falls back to a default. */
export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : defaultName();
}

/**
 * Cached so that `loadIdentity()` returns the *same* player id everywhere in the app, even when
 * `localStorage` is unavailable and nothing can be persisted between calls.
 */
let identityCache: Identity | null = null;

/** The identity for this browser, creating and persisting one on first run. */
export function loadIdentity(): Identity {
  if (identityCache !== null) return identityCache;

  const stored = asRecord(readJson(IDENTITY_KEY));
  const playerId = pickString(stored, 'playerId');
  const name = pickString(stored, 'name');

  const identity: Identity = {
    playerId: playerId ?? randomPlayerId(),
    name: name !== null ? sanitizeName(name) : defaultName(),
  };

  identityCache = identity;
  if (playerId === null || name === null) writeJson(IDENTITY_KEY, identity);
  return identity;
}

/** Merges a patch into the stored identity and returns the new value. */
export function saveIdentity(patch: Partial<Identity>): Identity {
  const current = loadIdentity();
  const next: Identity = {
    playerId: patch.playerId !== undefined && patch.playerId.length > 0 ? patch.playerId : current.playerId,
    name: patch.name !== undefined ? sanitizeName(patch.name) : current.name,
  };
  identityCache = next;
  writeJson(IDENTITY_KEY, next);
  return next;
}

// ---------------------------------------------------------------------------
// Local preferences
// ---------------------------------------------------------------------------

/** Stamps the preferences onto `<html>`, which is where tokens.css picks the palette up. */
function applyPrefs(prefs: LocalPrefs): void {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.deck = prefs.deck;
  root.dataset.cards = prefs.largeCards ? "large" : "standard";
  root.dataset.calm = String(prefs.calm);
}

let prefsCache: LocalPrefs | null = null;

/** The local look-and-feel preferences, applied to the document as a side effect. */
export function loadLocalPrefs(): LocalPrefs {
  if (prefsCache !== null) {
    applyPrefs(prefsCache);
    return prefsCache;
  }

  const stored = asRecord(readJson(PREFS_KEY));
  const prefs: LocalPrefs = {
    theme: pickOption(stored, 'theme', THEMES, DEFAULT_PREFS.theme),
    deck: pickOption(stored, 'deck', DECKS, DEFAULT_PREFS.deck),
    sound: pickBoolean(stored, 'sound', DEFAULT_PREFS.sound),
    hints: pickBoolean(stored, 'hints', DEFAULT_PREFS.hints),
    largeCards: pickBoolean(stored, 'largeCards', DEFAULT_PREFS.largeCards),
    confirmMoves: pickBoolean(stored, 'confirmMoves', DEFAULT_PREFS.confirmMoves),
    calm: pickBoolean(stored, 'calm', DEFAULT_PREFS.calm),
  };

  prefsCache = prefs;
  applyPrefs(prefs);
  return prefs;
}

/** Merges a patch into the local preferences, persists, re-applies and returns the new value. */
export function saveLocalPrefs(patch: Partial<LocalPrefs>): LocalPrefs {
  const next: LocalPrefs = { ...loadLocalPrefs(), ...patch };
  prefsCache = next;
  writeJson(PREFS_KEY, next);
  applyPrefs(next);
  return next;
}
