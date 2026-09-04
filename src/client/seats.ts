/**
 * Seat geometry for the client.
 *
 * The table is always drawn from the viewer's point of view: whoever you are, you sit at the
 * bottom. Every component that positions something around the table goes through this module so
 * the rotation logic exists in exactly one place.
 */

import type { Seat, Strain, Suit } from '../engine/types';

export type TablePosition = 'bottom' | 'left' | 'top' | 'right';

const CLOCKWISE: Seat[] = ['N', 'E', 'S', 'W'];

/**
 * Where `seat` should be drawn when `viewer` is looking at the table.
 * A spectator gets the traditional view with South at the bottom.
 */
export function positionOf(viewer: Seat | null, seat: Seat): TablePosition {
  const anchor = viewer ?? 'S';
  const offset = (CLOCKWISE.indexOf(seat) - CLOCKWISE.indexOf(anchor) + 4) % 4;
  return (['bottom', 'left', 'top', 'right'] as const)[offset];
}

/** Inverse of {@link positionOf}: which seat currently occupies a screen position. */
export function seatAt(viewer: Seat | null, position: TablePosition): Seat {
  const anchor = viewer ?? 'S';
  const offset = ['bottom', 'left', 'top', 'right'].indexOf(position);
  return CLOCKWISE[(CLOCKWISE.indexOf(anchor) + offset) % 4];
}

/** All four seats in screen order, starting from the viewer. */
export function seatsForViewer(viewer: Seat | null): { seat: Seat; position: TablePosition }[] {
  return (['bottom', 'left', 'top', 'right'] as const).map((position) => ({
    seat: seatAt(viewer, position),
    position,
  }));
}

/** Hands on the left and right of the screen are drawn as vertical fans. */
export function orientationOf(position: TablePosition): 'horizontal' | 'vertical' {
  return position === 'left' || position === 'right' ? 'vertical' : 'horizontal';
}

export const SEAT_LABEL_PL: Record<Seat, string> = {
  N: 'Północ',
  E: 'Wschód',
  S: 'Południe',
  W: 'Zachód',
};

export const SEAT_LABEL_SHORT_PL: Record<Seat, string> = { N: 'N', E: 'E', S: 'S', W: 'W' };

export const STRAIN_LABEL: Record<Strain, string> = {
  C: '♣',
  D: '♦',
  H: '♥',
  S: '♠',
  N: 'BA',
};

export const SUIT_NAME_PL: Record<Suit, string> = {
  C: 'trefl',
  D: 'karo',
  H: 'kier',
  S: 'pik',
};

/** True when the two seats are partners. */
export function isPartnership(a: Seat, b: Seat): boolean {
  return (a === 'N' || a === 'S') === (b === 'N' || b === 'S');
}
