/**
 * TrickArea - the middle of the table.
 *
 * While a trick is in progress each card is laid on the side of the player who contributed it, so
 * "who played what" needs no legend. When the trick is complete the four cards slide off toward
 * the winner: that motion is a pure CSS transition keyed on a `data-winner` attribute, which keeps
 * the timing (and `prefers-reduced-motion`) in the stylesheet where the tokens live.
 *
 * Between tricks - before the opening lead, or after a trick has been swept away - the same space
 * shows the board's identity card: number, dealer, vulnerability and contract.
 */

import type { Card, RankChar, Seat, Strain, Suit, Trick, Vulnerability } from '../../engine/types';
import { isVulnerable } from '../../engine/deal';
import { CARD_VIEWBOX } from '../assets/cardSprite';
import { positionOf, SEAT_LABEL_PL, SEAT_LABEL_SHORT_PL, STRAIN_LABEL, SUIT_NAME_PL } from '../seats';
import '../styles/table.css';

export interface TrickAreaProps {
  trick: Trick | null;
  viewer: Seat | null;
  trump: Strain | null;
  /** Set while the completed trick is being shown before it is swept away. */
  winner?: Seat | null;
  contractLabel?: string;
  vulnerability: Vulnerability;
  boardNumber: number;
  dealer: Seat;
}

/** Card names as a Polish bridge player says them: "as pik", "dziesiątka kier". */
const RANK_NAME_PL: Record<RankChar, string> = {
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

const VULNERABILITY_LABEL_PL: Record<Vulnerability, string> = {
  None: 'obie linie przed partią',
  NS: 'NS po partii',
  EW: 'EW po partii',
  Both: 'obie linie po partii',
};

/** Corners of the vulnerability square, split by its diagonals into four seat triangles. */
const VUL_QUADRANT: Record<Seat, string> = {
  N: '0,0 40,0 20,20',
  E: '40,0 40,40 20,20',
  S: '40,40 0,40 20,20',
  W: '0,40 0,0 20,20',
};

/** Where the seat letter sits inside its quadrant. */
const VUL_LETTER_POS: Record<Seat, { x: number; y: number }> = {
  N: { x: 20, y: 9.5 },
  E: { x: 31, y: 23.5 },
  S: { x: 20, y: 37 },
  W: { x: 9, y: 23.5 },
};

function cardNamePl(card: Card): string {
  const suit = card.charAt(0) as Suit;
  const rank = card.charAt(1) as RankChar;
  return `${RANK_NAME_PL[rank]} ${SUIT_NAME_PL[suit]}`;
}

export function TrickArea({
  trick,
  viewer,
  trump,
  winner,
  contractLabel,
  vulnerability,
  boardNumber,
  dealer,
}: TrickAreaProps): JSX.Element {
  const played = trick?.cards ?? [];

  /**
   * `data-winner` uruchamia ANIMACJĘ zamiatania, więc nie może pochodzić z samej lewy.
   *
   * Ukończona lewa niesie już pole `winner`, więc `winner ?? trick?.winner` ustawiało
   * atrybut JUŻ PRZY PIERWSZYM MALOWANIU: karty montowały się od razu w stanie końcowym
   * (`opacity: 0`), a przejście CSS nie ma wtedy od czego wystartować. Efekt: karta
   * czwartego gracza była w DOM, ale niewidoczna — zmierzone 1380 ms obecności przy
   * zerowej widoczności. Zamiatamy więc wyłącznie na wyraźny sygnał od `useTable`,
   * który przychodzi dopiero po pauzie na odczytanie.
   */
  const sweptTo = winner ?? null;

  /** Podpis „Lewę bierze…" ma sens już w trakcie pauzy, więc bierze też dane z lewy. */
  const zwyciezcaLewy = winner ?? trick?.winner ?? null;

  if (played.length === 0) {
    return (
      <div className="bo-trick-area" role="group" aria-label="Środek stołu">
        <div className="bo-board">
          <p className="bo-board__number">{`Rozdanie ${boardNumber}`}</p>
          <div className="bo-board__body">
            <svg
              className="bo-board__vul"
              viewBox="0 0 40 40"
              role="img"
              aria-label={`Założenia: ${VULNERABILITY_LABEL_PL[vulnerability]}`}
              focusable="false"
            >
              {(Object.keys(VUL_QUADRANT) as Seat[]).map((quadrantSeat) => (
                <polygon
                  key={quadrantSeat}
                  className="bo-board__vul-quadrant"
                  points={VUL_QUADRANT[quadrantSeat]}
                  data-vul={isVulnerable(quadrantSeat, vulnerability) ? 'true' : 'false'}
                />
              ))}
              {(Object.keys(VUL_LETTER_POS) as Seat[]).map((quadrantSeat) => (
                <text
                  key={quadrantSeat}
                  className="bo-board__vul-letter"
                  x={VUL_LETTER_POS[quadrantSeat].x}
                  y={VUL_LETTER_POS[quadrantSeat].y}
                  textAnchor="middle"
                >
                  {SEAT_LABEL_SHORT_PL[quadrantSeat]}
                </text>
              ))}
            </svg>

            <dl className="bo-board__facts">
              <dt>Rozdaje</dt>
              <dd>{SEAT_LABEL_PL[dealer]}</dd>
              <dt>Założenia</dt>
              <dd>{VULNERABILITY_LABEL_PL[vulnerability]}</dd>
              {contractLabel ? (
                <>
                  <dt>Kontrakt</dt>
                  <dd className="bo-board__contract">{contractLabel}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bo-trick-area" role="group" aria-label="Środek stołu">
      <div
        className="bo-trick"
        data-winner={sweptTo ? positionOf(viewer, sweptTo) : undefined}
        data-swept={sweptTo ? 'true' : 'false'}
      >
        {trump ? (
          <span className="bo-trick__trump" data-strain={trump} aria-hidden="true">
            {STRAIN_LABEL[trump]}
          </span>
        ) : null}

        {played.map(({ seat, card }) => (
          <span key={card} className="bo-trick__slot" data-pos={positionOf(viewer, seat)}>
            <svg
              className="bo-trick__card"
              viewBox={CARD_VIEWBOX}
              role="img"
              aria-label={`${SEAT_LABEL_PL[seat]}: ${cardNamePl(card)}`}
              focusable="false"
            >
              <use href={`#card-${card}`} />
            </svg>
          </span>
        ))}

        {/* aria-live: kto wziął lewę, to informacja krytyczna dla osoby niewidomej — bez niej nie da
            się liczyć lew ani prowadzić rozgrywki, choć mechanicznie gra jest w pełni dostępna. */}
        <p className="bo-trick__winner" role="status" aria-live="polite" hidden={!zwyciezcaLewy}>
          {zwyciezcaLewy ? `Lewę bierze: ${SEAT_LABEL_PL[zwyciezcaLewy]}` : ''}
        </p>
      </div>
    </div>
  );
}
