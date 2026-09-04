/**
 * Grafika z paczki Claude Design: logo, awatary, ikony, zetony, stany kart.
 *
 * Wszystko jest jednym sprite'em wstrzykiwanym do DOM (`ArtSpriteMount`, raz, w korzeniu
 * aplikacji), a kazde uzycie to `<svg><use href="#id"/></svg>`. To ten sam mechanizm co talia
 * w PlayingCard — i z tego samego powodu: rysunki biora kolory ze zmiennych CSS, ktore NIE
 * przenikaja do SVG ladowanego przez <img>. Inline dziedzicza kaskade strony, wiec jeden plik
 * dziala w obu motywach i z talia czterokolorowa.
 *
 * Zrodlem prawdy sa pliki w public/art; `artSprite.ts` generuje `node scripts/embed-art.mjs`.
 */

import { useEffect, type CSSProperties } from 'react';
import { ART_SPRITE, ART_VIEWBOX, type ArtId } from '../assets/artSprite';

// ---------------------------------------------------------------------------
// Sprite mount
// ---------------------------------------------------------------------------

let mounted = 0;

/**
 * Wstrzykuje sprite do dokumentu. Montowac raz, w korzeniu (App.tsx).
 *
 * Renderuje BEZWARUNKOWO. Pierwsza wersja robila "wybor wlasciciela" licznikiem w inicjalizatorze
 * useState — i w StrictMode, ktory wywoluje inicjalizator dwa razy, jedyny egzemplarz doliczal do
 * dwoch, uznawal, ze nie jest pierwszy, i renderowal pustke. Cala grafika znikala w trybie dev,
 * a na produkcji dzialala — najgorszy rodzaj bledu. Podwojny montaz to blad w kodzie, nie stan do
 * obslugi w locie: wystarczy go zglosic.
 */
export function ArtSpriteMount(): JSX.Element {
  useEffect(() => {
    mounted += 1;
    if (mounted > 1) {
      console.warn('[Art] ArtSpriteMount zamontowany wiecej niz raz — <use href> bedzie trafial losowo.');
    }
    return () => {
      mounted -= 1;
    };
  }, []);

  return (
    <div className="bo-art-sprite" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ART_SPRITE }} />
  );
}

// ---------------------------------------------------------------------------
// <Art/>
// ---------------------------------------------------------------------------

export interface ArtProps {
  id: ArtId;
  /** Opis dla czytnika ekranu. Bez niego grafika jest dekoracyjna (aria-hidden). */
  label?: string;
  className?: string;
  /** Szerokosc w px; wysokosc wynika z viewBox symbolu. */
  size?: number;
  style?: CSSProperties;
}

/** Pojedynczy symbol ze sprite'a, w jego wlasnych proporcjach. */
export function Art({ id, label, className, size, style }: ArtProps): JSX.Element {
  const viewBox = ART_VIEWBOX[id];
  const [, , w, h] = viewBox.split(/\s+/).map(Number);
  const sizeStyle: CSSProperties | undefined =
    size === undefined ? undefined : { inlineSize: `${size}px`, blockSize: `${(size * h) / w}px` };

  return (
    <svg
      className={className === undefined ? 'bo-art' : `bo-art ${className}`}
      viewBox={viewBox}
      style={style === undefined ? sizeStyle : { ...sizeStyle, ...style }}
      focusable="false"
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      <use href={`#${id}`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// <Icon/> — skrot dla icons.svg
// ---------------------------------------------------------------------------

export type IconName =
  | 'copy' | 'check' | 'share' | 'settings' | 'chat' | 'score' | 'undo' | 'claim' | 'leave'
  | 'sit' | 'robot' | 'sound-on' | 'sound-off' | 'theme-dark' | 'theme-light' | 'deck-two'
  | 'deck-four' | 'help' | 'close' | 'chevron' | 'clock' | 'wifi' | 'wifi-off' | 'crown'
  | 'eye' | 'next-board' | 'history' | 'hcp' | 'menu' | 'link';

export interface IconProps {
  name: IconName;
  /** Tylko gdy ikona stoi SAMA (bez tekstu obok). Ikona przy etykiecie jest dekoracyjna. */
  label?: string;
  className?: string;
  size?: number;
}

/**
 * Ikona liniowa z icons.svg. Rysowana `currentColor`, wiec bierze kolor tekstu przycisku,
 * w ktorym stoi — nie trzeba jej niczego przekazywac.
 */
export function Icon({ name, label, className, size = 18 }: IconProps): JSX.Element {
  return (
    <Art
      id={`icon-${name}` as ArtId}
      label={label}
      size={size}
      className={className === undefined ? 'bo-icon' : `bo-icon ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Awatary
// ---------------------------------------------------------------------------

const AVATAR_COUNT = 8;

/**
 * Stabilny awatar dla gracza: ten sam identyfikator zawsze dostaje ten sam obrazek, takze po
 * powrocie do stolu — bez tego partner "zmienialby twarz" przy kazdym polaczeniu.
 */
export function avatarIdFor(playerId: string): ArtId {
  let h = 0;
  for (let i = 0; i < playerId.length; i += 1) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
  const n = (h % AVATAR_COUNT) + 1;
  return `art-avatar-0${n}` as ArtId;
}

export type RobotLevel = 'beginner' | 'intermediate' | 'advanced';

export function robotIdFor(level: RobotLevel): ArtId {
  return `art-robot-${level}` as ArtId;
}
