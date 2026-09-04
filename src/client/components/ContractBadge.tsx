/**
 * The contract badge, plus the small shared vocabulary every bidding surface needs:
 * how a call is spoken in Polish, and how it is drawn (level + coloured suit glyph).
 *
 * BiddingBox and AuctionGrid both import from here, so the declension tables and the
 * glyph markup exist exactly once.
 */

import type { BidLevel, Call, Contract, Risk, Strain } from '../../engine/types';
import { parseBid } from '../../engine/auction';
import { SEAT_LABEL_PL, SEAT_LABEL_SHORT_PL, STRAIN_LABEL } from '../seats';
import { ART_VIEWBOX, type ArtId } from '../assets/artSprite';
import '../styles/bidding.css';
import '../styles/bidding-art.css';

// ---------------------------------------------------------------------------
// ArtFill - a sprite symbol stretched over the whole box of its parent
// ---------------------------------------------------------------------------

export interface ArtFillProps {
  id: ArtId;
  className?: string;
}

/**
 * Decorative background taken from the art sprite (Claude Design, pakiet 4). Unlike <Art/>,
 * which keeps the symbol's own proportions, this one is meant to sit behind content of any
 * shape - a 120x84 bidding chip on a button that is 3:1 on a laptop and 5:4 on a phone - so
 * it is drawn with `preserveAspectRatio="none"` and positioned `inset: 0` by bidding-art.css.
 * The parent supplies `position: relative`; the label stays on top by its own z-index.
 */
export function ArtFill({ id, className }: ArtFillProps): JSX.Element {
  return (
    <svg
      className={cx('bo-art-fill', className)}
      viewBox={ART_VIEWBOX[id]}
      preserveAspectRatio="none"
      focusable="false"
      aria-hidden="true"
    >
      <use href={`#${id}`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Polish vocabulary
// ---------------------------------------------------------------------------

/**
 * Polish counts the denomination with three different forms: one club, two/three/four
 * clubs, five+ clubs. Screen-reader output is unreadable without them, so every label
 * goes through this table.
 */
const STRAIN_NOUN_PL: Record<Strain, readonly [string, string, string]> = {
  C: ['trefl', 'trefle', 'trefli'],
  D: ['karo', 'kara', 'kar'],
  H: ['kier', 'kiery', 'kierów'],
  S: ['pik', 'piki', 'pików'],
  N: ['bez atu', 'bez atu', 'bez atu'],
};

function strainNounPl(level: BidLevel, strain: Strain): string {
  const forms = STRAIN_NOUN_PL[strain];
  if (level === 1) return forms[0];
  return level <= 4 ? forms[1] : forms[2];
}

/** Short forms used inside the auction record: "pas", "X", "XX". */
const SPECIAL_SHORT_PL: Record<'P' | 'X' | 'XX', string> = { P: 'pas', X: 'X', XX: 'XX' };

/** Full forms printed on the bidding cards themselves. */
const SPECIAL_LONG_PL: Record<'P' | 'X' | 'XX', string> = {
  P: 'PAS',
  X: 'KONTRA',
  XX: 'REKONTRA',
};

/** How the call is spoken: "3 bez atu", "4 piki", "pas", "kontra", "rekontra". */
export function describeCall(call: Call): string {
  if (call === 'P') return 'pas';
  if (call === 'X') return 'kontra';
  if (call === 'XX') return 'rekontra';
  const bid = parseBid(call);
  if (bid === null) return call;
  return `${bid.level} ${strainNounPl(bid.level, bid.strain)}`;
}

function riskPhrasePl(risk: Risk): string {
  if (risk === 'X') return ' z kontrą';
  if (risk === 'XX') return ' z rekontrą';
  return '';
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

// ---------------------------------------------------------------------------
// CallText - one call, drawn once
// ---------------------------------------------------------------------------

export interface CallTextProps {
  call: Call;
  /** Spell pass/double/redouble out in full ("KONTRA") instead of "X". */
  long?: boolean;
  className?: string;
}

/**
 * A single call: the level and its suit glyph, or a coloured pass/double/redouble chip.
 * The glyph is hidden from assistive tech and paired with the spoken Polish form, so a
 * cell of the auction record never reads out as "1 black club symbol".
 */
export function CallText({ call, long = false, className }: CallTextProps): JSX.Element {
  const bid = parseBid(call);
  const modifier = bid === null ? `bo-call--${call.toLowerCase()}` : `bo-call--${bid.strain}`;

  return (
    <span className={cx('bo-call', modifier, className)}>
      <span className="bo-call__visual" aria-hidden="true">
        {bid === null ? (
          (long ? SPECIAL_LONG_PL : SPECIAL_SHORT_PL)[call as 'P' | 'X' | 'XX']
        ) : (
          <>
            <span className="bo-call__level">{bid.level}</span>
            <span className="bo-call__glyph">{STRAIN_LABEL[bid.strain]}</span>
          </>
        )}
      </span>
      <span className="bo-bidding-sr">{describeCall(call)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ContractBadge
// ---------------------------------------------------------------------------

export interface ContractBadgeProps {
  contract: Contract | null;
  passedOut?: boolean;
  size?: 'sm' | 'md';
}

/** "4♠ x  rozgrywa W", or "Spasowane" when the board was passed out. */
export function ContractBadge({
  contract,
  passedOut = false,
  size = 'md',
}: ContractBadgeProps): JSX.Element {
  const base = cx('bo-contract', `bo-contract--${size}`);

  if (passedOut) {
    return <span className={cx(base, 'bo-contract--passed')}>Spasowane</span>;
  }
  if (contract === null) {
    return <span className={cx(base, 'bo-contract--empty')}>Brak kontraktu</span>;
  }

  const bid = `${contract.level}${contract.strain}` as Call;
  const spoken = `Kontrakt ${describeCall(bid)}${riskPhrasePl(contract.risk)}, rozgrywa ${
    SEAT_LABEL_PL[contract.declarer]
  }.`;

  return (
    <span className={cx(base, 'bo-contract--plated')}>
      {/* Brass plate behind the contract; the text and glyph stay on top of it. */}
      <ArtFill id="art-contract-plate" className="bo-contract__plate" />
      <span className="bo-contract__visual" aria-hidden="true">
        <CallText call={bid} />
        {contract.risk !== 'none' && (
          <span
            className={cx(
              'bo-contract__risk',
              contract.risk === 'X' ? 'bo-contract__risk--x' : 'bo-contract__risk--xx',
            )}
          >
            {contract.risk === 'X' ? 'x' : 'xx'}
          </span>
        )}
        <span className="bo-contract__by">rozgrywa {SEAT_LABEL_SHORT_PL[contract.declarer]}</span>
      </span>
      <span className="bo-bidding-sr">{spoken}</span>
    </span>
  );
}
