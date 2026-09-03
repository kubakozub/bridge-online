/**
 * The auction record: the printed W-N-E-S table every bridge player already knows how to
 * read. Column order is fixed whoever deals - the dealer is found by the "R" marker in the
 * header, exactly as on a hand record - and the layout comes straight from `auctionRows`,
 * so the client never re-derives the shape of the auction.
 */

import { useEffect, useRef } from 'react';
import { auctionRows, isAuctionClosed, lastContractBid } from '../../engine/auction';
import type { Call, Seat } from '../../engine/types';
import { SEAT_LABEL_PL, SEAT_LABEL_SHORT_PL } from '../seats';
import { CallText } from './ContractBadge';
import '../styles/bidding.css';

/** Printed auctions always run West, North, East, South - see `auctionRows`. */
const COLUMNS: readonly Seat[] = ['W', 'N', 'E', 'S'];

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

export interface AuctionGridProps {
  auction: Call[];
  dealer: Seat;
  viewer: Seat | null;
  /** Highlight the call that is currently being made. */
  pending?: boolean;
  compact?: boolean;
}

export function AuctionGrid({
  auction,
  dealer,
  viewer,
  pending = false,
  compact = false,
}: AuctionGridProps): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);

  const closed = isAuctionClosed(auction);
  const showPending = pending && !closed;

  // Flat cell index of the first call: the dealer's calls line up under the dealer.
  const start = Math.max(0, COLUMNS.indexOf(dealer));
  const rows: (Call | null)[][] = auctionRows(auction, dealer).map((row) => [...row]);

  // The call being made goes in the next empty cell, which may need a fresh row.
  const pendingCell = showPending ? start + auction.length : -1;
  if (showPending) {
    const pendingRow = Math.floor(pendingCell / COLUMNS.length);
    while (rows.length <= pendingRow) rows.push([null, null, null, null]);
  }

  const finalBid = closed ? lastContractBid(auction) : null;
  const contractCell = finalBid === null ? -1 : start + finalBid.index;
  const contractRow =
    contractCell < 0 ? -1 : Math.floor(contractCell / COLUMNS.length);

  // A growing auction always scrolls to the newest call; never move the page itself.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [auction.length, showPending]);

  return (
    <div className={cx('bo-auction', compact && 'bo-auction--compact')}>
      <div className="bo-auction__scroll" ref={scroller} tabIndex={0}>
        <table className="bo-auction__table">
          <caption className="bo-bidding-sr">
            Przebieg licytacji. Rozdaje {SEAT_LABEL_PL[dealer]}.
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((seat) => {
                const isDealer = seat === dealer;
                const isViewer = seat === viewer;
                return (
                  <th
                    key={seat}
                    scope="col"
                    className={cx('bo-auction__head', isViewer && 'bo-auction__head--you')}
                  >
                    <span aria-hidden="true">
                      {SEAT_LABEL_SHORT_PL[seat]}
                      {isDealer && <span className="bo-auction__dealer">R</span>}
                    </span>
                    <span className="bo-bidding-sr">
                      {SEAT_LABEL_PL[seat]}
                      {isDealer ? ', rozdający' : ''}
                      {isViewer ? ', Twoje miejsce' : ''}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="bo-auction__empty" colSpan={COLUMNS.length}>
                  Licytacja jeszcze się nie zaczęła
                </td>
              </tr>
            )}
            {rows.map((cells, row) => (
              <tr
                key={row}
                className={cx('bo-auction__row', row === contractRow && 'bo-auction__row--final')}
              >
                {cells.map((call, col) => {
                  const cell = row * COLUMNS.length + col;
                  const isContract = cell === contractCell;
                  const isPending = cell === pendingCell;
                  return (
                    <td
                      key={col}
                      className={cx(
                        'bo-auction__cell',
                        isContract && 'bo-auction__cell--contract',
                        isPending && 'bo-auction__cell--pending',
                      )}
                    >
                      {call !== null && <CallText call={call} />}
                      {call === null && isPending && (
                        <>
                          <span className="bo-auction__waiting" aria-hidden="true">
                            •••
                          </span>
                          <span className="bo-bidding-sr">Czeka na odzywkę</span>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
