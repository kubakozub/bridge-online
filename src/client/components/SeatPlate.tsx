/**
 * SeatPlate - the nameplate that sits next to one seat's hand.
 *
 * It answers, at a glance, every question a player has about a seat: who is there, are they
 * connected, is it their turn, how much time is left, how many tricks they have taken, and what
 * their role on this board is (dealer / declarer / dummy). An empty seat turns into the two
 * actions that can fill it.
 */

import { useState } from 'react';
import type { Seat } from '../../engine/types';
import type { BotLevel, SeatOccupant } from '../../server/protocol';
import { SEAT_LABEL_PL, SEAT_LABEL_SHORT_PL, type TablePosition } from '../seats';
import '../styles/table.css';

export interface SeatPlateProps {
  seat: Seat;
  occupant: SeatOccupant | undefined;
  position: TablePosition;
  isYou: boolean;
  isDealer: boolean;
  isDeclarer: boolean;
  isDummy: boolean;
  isTurn: boolean;
  vulnerable: boolean;
  /** Seconds left on this player's clock, or null when untimed. */
  secondsLeft: number | null;
  tricksWon: number;
  onSit?: (seat: Seat) => void;
  onAddBot?: (seat: Seat) => void;
  onRemoveBot?: (seat: Seat) => void;
}

/** Connection lamp states: green, amber, grey. */
type ConnectionState = 'online' | 'idle' | 'offline';

/** A human who dropped out this recently is probably just reconnecting. */
const RECONNECT_GRACE_MS = 45_000;

/** Below this many seconds the countdown arc turns red. */
const CLOCK_DANGER_SECONDS = 10;

/** Geometry of the countdown arc, in the 36x36 user space of the badge overlay. */
const ARC_RADIUS = 15.5;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

const CONNECTION_LABEL_PL: Record<ConnectionState, string> = {
  online: 'połączony',
  idle: 'chwilowo rozłączony',
  offline: 'rozłączony',
};

const BOT_LEVEL_LABEL_PL: Record<BotLevel, string> = {
  beginner: 'początkujący',
  intermediate: 'średni',
  advanced: 'zaawansowany',
};

function connectionState(occupant: SeatOccupant): ConnectionState {
  if (occupant.connected) return 'online';
  if (occupant.isBot) return 'offline';
  return Date.now() - occupant.lastSeen < RECONNECT_GRACE_MS ? 'idle' : 'offline';
}

export function SeatPlate({
  seat,
  occupant,
  position,
  isYou,
  isDealer,
  isDeclarer,
  isDummy,
  isTurn,
  vulnerable,
  secondsLeft,
  tricksWon,
  onSit,
  onAddBot,
  onRemoveBot,
}: SeatPlateProps): JSX.Element {
  /**
   * The server only tells us how much time is left, never how much there was. We remember the
   * largest value seen since this seat's turn began and use it as the full arc, resetting as soon
   * as the turn moves on. Adjusting state during render is the supported way to derive state from
   * props without an extra commit.
   */
  const [turnTotal, setTurnTotal] = useState<number | null>(null);
  if (!isTurn || secondsLeft === null) {
    if (turnTotal !== null) setTurnTotal(null);
  } else if (turnTotal === null || secondsLeft > turnTotal) {
    setTurnTotal(secondsLeft);
  }

  const showClock = isTurn && secondsLeft !== null;
  const remaining =
    secondsLeft !== null && turnTotal !== null && turnTotal > 0
      ? Math.min(1, Math.max(0, secondsLeft / turnTotal))
      : 0;
  const lowOnTime = secondsLeft !== null && secondsLeft <= CLOCK_DANGER_SECONDS;

  const seatName = SEAT_LABEL_PL[seat];
  const connection = occupant ? connectionState(occupant) : 'offline';

  return (
    <div
      className="bo-seat"
      role="group"
      aria-label={`Miejsce ${seatName}`}
      data-position={position}
      data-turn={isTurn ? 'true' : 'false'}
      data-you={isYou ? 'true' : 'false'}
      data-vul={vulnerable ? 'true' : 'false'}
      data-empty={occupant ? 'false' : 'true'}
    >
      <span className="bo-seat__badge" title={seatName}>
        <span aria-hidden="true">{SEAT_LABEL_SHORT_PL[seat]}</span>
        <span className="bo-sr-only">{seatName}</span>
        {showClock ? (
          <svg
            className="bo-seat__arc"
            viewBox="0 0 36 36"
            data-low={lowOnTime ? 'true' : 'false'}
            aria-hidden="true"
            focusable="false"
          >
            <circle className="bo-seat__arc-track" cx="18" cy="18" r={ARC_RADIUS} />
            <circle
              className="bo-seat__arc-value"
              cx="18"
              cy="18"
              r={ARC_RADIUS}
              style={{
                strokeDasharray: ARC_CIRCUMFERENCE,
                strokeDashoffset: ARC_CIRCUMFERENCE * (1 - remaining),
              }}
            />
          </svg>
        ) : null}
      </span>

      {occupant ? (
        <>
          <span className="bo-seat__body">
            <span className="bo-seat__line">
              <span
                className="bo-seat__dot"
                data-conn={connection}
                title={CONNECTION_LABEL_PL[connection]}
                aria-hidden="true"
              />
              <span className="bo-seat__name" title={occupant.name}>
                {occupant.name}
              </span>
              <span className="bo-sr-only">{`, ${CONNECTION_LABEL_PL[connection]}`}</span>
            </span>

            <span className="bo-seat__tags">
              {isYou ? <span className="bo-seat__tag bo-seat__tag--you">Ty</span> : null}
              {occupant.isBot ? (
                <span
                  className="bo-seat__tag bo-seat__tag--bot"
                  title={
                    occupant.botLevel
                      ? `Robot, poziom: ${BOT_LEVEL_LABEL_PL[occupant.botLevel]}`
                      : 'Robot'
                  }
                >
                  robot
                </span>
              ) : null}
              {isDeclarer ? (
                <span className="bo-seat__tag bo-seat__tag--role">rozgrywający</span>
              ) : null}
              {isDummy ? <span className="bo-seat__tag bo-seat__tag--role">dziadek</span> : null}
              {vulnerable ? (
                <span className="bo-seat__tag bo-seat__tag--vul" title="Ta linia jest po partii">
                  po partii
                </span>
              ) : null}
            </span>
          </span>

          {isDealer ? (
            <span className="bo-seat__dealer" title="Rozdający">
              <span aria-hidden="true">R</span>
              <span className="bo-sr-only">Rozdający</span>
            </span>
          ) : null}

          {showClock && secondsLeft !== null ? (
            <span className="bo-seat__clock" data-low={lowOnTime ? 'true' : 'false'}>
              <span className="bo-sr-only">Pozostały czas: </span>
              {`${Math.max(0, Math.ceil(secondsLeft))} s`}
            </span>
          ) : null}

          <span className="bo-seat__tricks">
            <span className="bo-sr-only">Wzięte lewy: </span>
            {tricksWon}
          </span>

          {occupant.isBot && onRemoveBot ? (
            <button
              type="button"
              className="bo-seat__remove"
              onClick={() => onRemoveBot(seat)}
              aria-label={`Usuń robota z miejsca ${seatName}`}
              title="Usuń robota"
            >
              <span aria-hidden="true">×</span>
            </button>
          ) : null}
        </>
      ) : (
        <>
          <span className="bo-seat__body">
            <span className="bo-seat__name bo-seat__name--empty">Wolne miejsce</span>
          </span>
          <span className="bo-seat__actions">
            {onSit ? (
              <button
                type="button"
                className="bo-seat__action bo-seat__action--primary"
                onClick={() => onSit(seat)}
                aria-label={`Usiądź na miejscu ${seatName}`}
              >
                Usiądź
              </button>
            ) : null}
            {onAddBot ? (
              <button
                type="button"
                className="bo-seat__action"
                onClick={() => onAddBot(seat)}
                aria-label={`Dodaj robota na miejsce ${seatName}`}
              >
                Dodaj robota
              </button>
            ) : null}
          </span>
        </>
      )}
    </div>
  );
}
