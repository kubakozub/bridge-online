/**
 * TableFelt - the physical table: a wooden rail around a rounded rectangle of felt.
 *
 * It is a pure layout shell. It knows nothing about bridge; it only places five slots - the four
 * hands around the edge, each with its nameplate, plus whatever belongs in the middle (the trick
 * area during play, the auction grid during bidding). The caller has already rotated the seats
 * into screen positions with `seatsForViewer`, so "bottom" here always means "nearest the viewer".
 */

import type { ReactNode } from 'react';
import '../styles/table.css';

export interface TableFeltProps {
  /** Goes in the middle of the table: the trick area, or the auction. */
  children?: ReactNode;
  bottom: ReactNode;
  left: ReactNode;
  top: ReactNode;
  right: ReactNode;
  plates: { bottom: ReactNode; left: ReactNode; top: ReactNode; right: ReactNode };
}

export function TableFelt({
  children,
  bottom,
  left,
  top,
  right,
  plates,
}: TableFeltProps): JSX.Element {
  return (
    <div className="bo-felt">
      <div className="bo-felt__rail">
        <div className="bo-felt__surface">
          <div className="bo-felt__area bo-felt__area--top">
            <div className="bo-felt__plate">{plates.top}</div>
            <div className="bo-felt__hand">{top}</div>
          </div>

          <div className="bo-felt__area bo-felt__area--left">
            <div className="bo-felt__plate">{plates.left}</div>
            <div className="bo-felt__hand">{left}</div>
          </div>

          <div className="bo-felt__center">{children}</div>

          <div className="bo-felt__area bo-felt__area--right">
            <div className="bo-felt__plate">{plates.right}</div>
            <div className="bo-felt__hand">{right}</div>
          </div>

          <div className="bo-felt__area bo-felt__area--bottom">
            <div className="bo-felt__hand">{bottom}</div>
            <div className="bo-felt__plate">{plates.bottom}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
