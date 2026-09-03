/**
 * A single playing card, the suit glyph, and the sprite host they both need.
 *
 * Every card on the table is one `<use href="#card-XX">` pointing into the generated sprite,
 * so the whole deck costs a single parse and recolours itself from the tokens (`--card-face`,
 * `--suit-heart`, ...). Nothing here hard-codes a colour, a shadow or a pixel size: geometry
 * comes from `--card-w` in tokens.css, via the `--bo-card-w` local in cards.css.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { CARD_SPRITE, CARD_VIEWBOX } from '../assets/cardSprite';
import { rankChar, suitOf } from '../../engine/cards';
import type { Card, RankChar, Suit } from '../../engine/types';
import { SUIT_NAME_PL } from '../seats';
import '../styles/cards.css';

/** Coordinate system of the `suit-*` symbols in the generated sprite. */
const SUIT_VIEWBOX = '0 0 100 100';

/** Nominative: what the card *is*. Used for `role="img"` labels. */
const RANK_NAME_PL: Readonly<Record<RankChar, string>> = {
  '2': 'dwójka',
  '3': 'trójka',
  '4': 'czwórka',
  '5': 'piątka',
  '6': 'szóstka',
  '7': 'siódemka',
  '8': 'ósemka',
  '9': 'dziewiątka',
  T: 'dziesiątka',
  J: 'walet',
  Q: 'dama',
  K: 'król',
  A: 'as',
};

/** Accusative: what you *play*. "Zagraj asa pik", "Zagraj damę kier". */
const RANK_ACCUSATIVE_PL: Readonly<Record<RankChar, string>> = {
  '2': 'dwójkę',
  '3': 'trójkę',
  '4': 'czwórkę',
  '5': 'piątkę',
  '6': 'szóstkę',
  '7': 'siódemkę',
  '8': 'ósemkę',
  '9': 'dziewiątkę',
  T: 'dziesiątkę',
  J: 'waleta',
  Q: 'damę',
  K: 'króla',
  A: 'asa',
};

/** Card sizes, all derived from the `--card-w` clamp token. */
export type CardSize = 'xs' | 'sm' | 'md' | 'lg';

// ---------------------------------------------------------------------------
// Sprite host
// ---------------------------------------------------------------------------

/**
 * Ownership of the single sprite node. Rendering `<CardSpriteMount />` more than once is safe:
 * the first mount owns the markup and later ones render an empty div. If the owner unmounts,
 * the next claimant is promoted, so the sprite exists for exactly as long as one mount does.
 */
type SpriteClaim = (isOwner: boolean) => void;
const spriteClaims: SpriteClaim[] = [];

function claimSprite(claim: SpriteClaim): () => void {
  spriteClaims.push(claim);
  claim(spriteClaims[0] === claim);
  return () => {
    const index = spriteClaims.indexOf(claim);
    if (index < 0) return;
    spriteClaims.splice(index, 1);
    if (index === 0 && spriteClaims.length > 0) spriteClaims[0](true);
  };
}

/**
 * Injects the generated card sprite into the document exactly once. Mount it high in the tree
 * (once, at the app root, is enough) - every `<use href="#card-XX">` in the app depends on it.
 */
export function CardSpriteMount(): JSX.Element {
  // Optimistic: the very first instance renders the sprite on its first paint, so cards are
  // never blank for a frame. The effect below settles ownership if there is a tie.
  const [isOwner, setIsOwner] = useState<boolean>(() => spriteClaims.length === 0);

  useEffect(() => claimSprite(setIsOwner), []);

  // The `__html` is always passed (empty when not the owner) so React reliably clears the node
  // of a demoted instance instead of leaving stale duplicate ids behind.
  return (
    <div
      className="bo-card-sprite"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: isOwner ? CARD_SPRITE : '' }}
    />
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Polish name of a card in the nominative: "as pik", "dziesiątka kier", "dwójka trefl". */
export function cardAriaLabel(card: Card): string {
  return `${RANK_NAME_PL[rankChar(card)]} ${SUIT_NAME_PL[suitOf(card)]}`;
}

/** Polish name in the accusative, for an action label: "asa pik", "damę kier". */
function cardAccusative(card: Card): string {
  return `${RANK_ACCUSATIVE_PL[rankChar(card)]} ${SUIT_NAME_PL[suitOf(card)]}`;
}

// ---------------------------------------------------------------------------
// Suit glyph
// ---------------------------------------------------------------------------

export interface SuitGlyphProps {
  /** A suit, or 'N' for No-Trump - which is drawn as the Polish text "BA". */
  suit: Suit | 'N';
  /** Draw in `currentColor` instead of the suit colour (for accent-coloured chips). */
  mono?: boolean;
  className?: string;
  /** Explicit size in pixels. Omitted, the glyph is 1em and follows the surrounding text. */
  size?: number;
}

/** The four suit pips, or "BA" for bez atu. */
export function SuitGlyph({ suit, mono = false, className, size }: SuitGlyphProps): JSX.Element {
  const sizeStyle: CSSProperties | undefined =
    size === undefined ? undefined : { inlineSize: `${size}px`, blockSize: `${size}px` };

  if (suit === 'N') {
    return (
      <span
        className={joinClasses('bo-suit', 'bo-suit--nt', className)}
        style={size === undefined ? undefined : { fontSize: `${size}px` }}
        role="img"
        aria-label="bez atu"
      >
        BA
      </span>
    );
  }

  return (
    <svg
      className={joinClasses('bo-suit', mono ? 'bo-suit--mono' : null, className)}
      style={sizeStyle}
      viewBox={SUIT_VIEWBOX}
      role="img"
      aria-label={SUIT_NAME_PL[suit]}
      focusable="false"
    >
      <use href={`#suit-${suit}${mono ? '-mono' : ''}`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Playing card
// ---------------------------------------------------------------------------

export interface PlayingCardProps {
  /** The card to draw; `null` renders the back. */
  card: Card | null;
  faceDown?: boolean;
  size?: CardSize;
  /** Legal to play right now: raised, pointer cursor. */
  playable?: boolean;
  /** Illegal right now: desaturated and not clickable (still focusable, for the roving fan). */
  dimmed?: boolean;
  selected?: boolean;
  onSelect?: (card: Card) => void;
  className?: string;
  style?: CSSProperties;
  tabIndex?: number;
}

/**
 * One card. Renders a real `<button>` when it can be selected and a plain `<div role="img">`
 * otherwise, so nothing lands in the tab order that cannot be acted on.
 */
export function PlayingCard({
  card,
  faceDown = false,
  size = 'md',
  playable = false,
  dimmed = false,
  selected,
  onSelect,
  className,
  style,
  tabIndex,
}: PlayingCardProps): JSX.Element {
  const showsBack = faceDown || card === null;
  const symbolId = showsBack ? '#card-back' : `#card-${card}`;

  const classes = joinClasses(
    'bo-card',
    `bo-card--${size}`,
    showsBack ? 'bo-card--back' : null,
    playable ? 'is-playable' : null,
    dimmed ? 'is-dimmed' : null,
    selected === true ? 'is-selected' : null,
    className,
  );

  const face = (
    <svg className="bo-card__face" viewBox={CARD_VIEWBOX} aria-hidden="true" focusable="false">
      <use href={symbolId} />
    </svg>
  );

  if (!showsBack && card !== null && onSelect !== undefined) {
    return (
      <button
        type="button"
        className={classes}
        style={style}
        tabIndex={tabIndex}
        aria-label={`Zagraj ${cardAccusative(card)}`}
        aria-disabled={dimmed ? true : undefined}
        aria-pressed={selected}
        onClick={() => {
          if (!dimmed) onSelect(card);
        }}
      >
        {face}
      </button>
    );
  }

  return (
    <div
      className={classes}
      style={style}
      tabIndex={tabIndex}
      role="img"
      aria-label={showsBack ? 'Zakryta karta' : cardAriaLabel(card as Card)}
    >
      {face}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinClasses(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
