/**
 * Scoreboard - the running match record.
 *
 * One row per played board: number (with vulnerability), contract, declarer, the result as a
 * coloured chip, the duplicate score in the column of the side that earned it, and - in IMP
 * scoring - the swing. Totals live in a sticky footer so they stay readable while the list
 * scrolls. Rows declared by the viewer's own side get a subtle tint.
 */

import type { MatchScore, ScoreLine, ScoringMode, Seat, Vulnerability } from '../../engine/types';
import { isVulnerable, sideOf } from '../../engine/deal';
import { SEAT_LABEL_PL, SEAT_LABEL_SHORT_PL } from '../seats';
import '../styles/panels.css';

export interface ScoreboardProps {
  score: MatchScore;
  mode: ScoringMode;
  viewer: Seat | null;
  boardCount: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MODE_LABEL_PL: Record<ScoringMode, string> = {
  duplicate: 'zapis turniejowy',
  imp: 'zapis na impy',
  rubber: 'zapis robrowy',
};

const VUL_LABEL_PL: Record<Vulnerability, string> = {
  None: 'nikt po partii',
  NS: 'NS po partii',
  EW: 'EW po partii',
  Both: 'obie strony po partii',
};

const scoreFormat = new Intl.NumberFormat('pl-PL');
const signedFormat = new Intl.NumberFormat('pl-PL', { signDisplay: 'exceptZero' });

/** Polish has three plural forms; picking the wrong one reads as broken machine translation. */
function pluralPl(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

function tricksPl(n: number): string {
  return `${n} ${pluralPl(n, 'lewa', 'lewy', 'lew')}`;
}

function resultText(relative: number | null): string {
  if (relative === null) return '—';
  if (relative === 0) return '=';
  return relative > 0 ? `+${relative}` : `−${Math.abs(relative)}`;
}

function resultLabel(relative: number | null): string {
  if (relative === null) return 'brak rozgrywki';
  if (relative === 0) return 'kontrakt wykonany dokładnie';
  const n = Math.abs(relative);
  return relative > 0
    ? `${n} ${pluralPl(n, 'nadróbka', 'nadróbki', 'nadróbek')}`
    : `${n} ${pluralPl(n, 'wpadka', 'wpadki', 'wpadek')}`;
}

function resultModifier(relative: number | null): string {
  if (relative === null) return 'bo-chip--none';
  if (relative < 0) return 'bo-chip--down';
  return relative > 0 ? 'bo-chip--over' : 'bo-chip--exact';
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ScoreRowProps {
  line: ScoreLine;
  showImps: boolean;
  own: boolean;
}

function ScoreRow({ line, showImps, own }: ScoreRowProps): JSX.Element {
  const nsScore = line.scoreNS > 0 ? line.scoreNS : null;
  const ewScore = line.scoreNS < 0 ? -line.scoreNS : null;

  return (
    <tr className={own ? 'bo-scoreboard__row bo-scoreboard__row--own' : 'bo-scoreboard__row'}>
      <th scope="row" className="bo-scoreboard__cell bo-scoreboard__cell--board">
        <span className="bo-scoreboard__number">{line.boardNumber}</span>
        <span className="bo-scoreboard__vul" aria-hidden="true">
          <span
            className="bo-scoreboard__vul-dot"
            data-on={isVulnerable('N', line.vulnerability) ? 'yes' : 'no'}
          />
          <span
            className="bo-scoreboard__vul-dot"
            data-on={isVulnerable('E', line.vulnerability) ? 'yes' : 'no'}
          />
        </span>
        <span className="bo-sr-only">, {VUL_LABEL_PL[line.vulnerability]}</span>
      </th>

      <td className="bo-scoreboard__cell bo-scoreboard__cell--contract">{line.contractLabel}</td>

      <td className="bo-scoreboard__cell bo-scoreboard__cell--declarer">
        {line.declarer ? (
          <>
            <span aria-hidden="true">{SEAT_LABEL_SHORT_PL[line.declarer]}</span>
            <span className="bo-sr-only">{SEAT_LABEL_PL[line.declarer]}</span>
          </>
        ) : (
          <span aria-hidden="true">{'—'}</span>
        )}
      </td>

      <td className="bo-scoreboard__cell bo-scoreboard__cell--result">
        <span className={`bo-chip ${resultModifier(line.resultRelative)}`} aria-hidden="true">
          {resultText(line.resultRelative)}
        </span>
        <span className="bo-sr-only">
          {resultLabel(line.resultRelative)}
          {line.tricksWon !== null ? `, wzięte lewy: ${tricksPl(line.tricksWon)}` : ''}
        </span>
      </td>

      <td className="bo-scoreboard__cell bo-scoreboard__cell--num">
        {nsScore !== null ? scoreFormat.format(nsScore) : <span aria-hidden="true">{'·'}</span>}
      </td>
      <td className="bo-scoreboard__cell bo-scoreboard__cell--num">
        {ewScore !== null ? scoreFormat.format(ewScore) : <span aria-hidden="true">{'·'}</span>}
      </td>

      {showImps ? (
        <td className="bo-scoreboard__cell bo-scoreboard__cell--num">
          {typeof line.imps === 'number' ? (
            <span
              className={
                line.imps > 0
                  ? 'bo-scoreboard__imp bo-scoreboard__imp--plus'
                  : line.imps < 0
                    ? 'bo-scoreboard__imp bo-scoreboard__imp--minus'
                    : 'bo-scoreboard__imp'
              }
            >
              {signedFormat.format(line.imps)}
            </span>
          ) : (
            <span aria-hidden="true">{'·'}</span>
          )}
        </td>
      ) : null}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

export function Scoreboard({ score, mode, viewer, boardCount }: ScoreboardProps): JSX.Element {
  const showImps = mode === 'imp';
  const viewerSide = viewer !== null ? sideOf(viewer) : null;
  const played = score.lines.length;

  const progress =
    boardCount > 0
      ? `Rozegrano ${played} z ${boardCount} ${pluralPl(boardCount, 'rozdania', 'rozdań', 'rozdań')}`
      : `Rozegrane rozdania: ${played}`;

  return (
    <section className="bo-scoreboard" aria-labelledby="bo-scoreboard-title">
      <header className="bo-scoreboard__head">
        <h2 className="bo-scoreboard__title" id="bo-scoreboard-title">
          Zapis
        </h2>
        <p className="bo-scoreboard__meta">
          {progress} {'·'} {MODE_LABEL_PL[mode]}
        </p>
      </header>

      {played === 0 ? (
        <p className="bo-scoreboard__empty">Nie rozegrano jeszcze żadnego rozdania.</p>
      ) : (
        <div className="bo-scoreboard__scroll">
          <table className="bo-scoreboard__table">
            <caption className="bo-sr-only">
              Zapis meczu, {MODE_LABEL_PL[mode]}. {progress}.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="bo-scoreboard__cell--board">
                  <span aria-hidden="true">Nr</span>
                  <span className="bo-sr-only">Numer rozdania i założenia</span>
                </th>
                <th scope="col">Kontrakt</th>
                <th scope="col">
                  <span aria-hidden="true">Rozgr.</span>
                  <span className="bo-sr-only">Rozgrywający</span>
                </th>
                <th scope="col">Wynik</th>
                <th
                  scope="col"
                  className={
                    viewerSide === 'NS'
                      ? 'bo-scoreboard__cell--num bo-scoreboard__col--own'
                      : 'bo-scoreboard__cell--num'
                  }
                >
                  NS
                  {viewerSide === 'NS' ? <span className="bo-sr-only"> (twoja linia)</span> : null}
                </th>
                <th
                  scope="col"
                  className={
                    viewerSide === 'EW'
                      ? 'bo-scoreboard__cell--num bo-scoreboard__col--own'
                      : 'bo-scoreboard__cell--num'
                  }
                >
                  EW
                  {viewerSide === 'EW' ? <span className="bo-sr-only"> (twoja linia)</span> : null}
                </th>
                {showImps ? (
                  <th scope="col" className="bo-scoreboard__cell--num">
                    IMP
                  </th>
                ) : null}
              </tr>
            </thead>

            <tbody>
              {score.lines.map((line) => (
                <ScoreRow
                  key={line.boardNumber}
                  line={line}
                  showImps={showImps}
                  own={
                    viewerSide !== null &&
                    line.declarer !== null &&
                    sideOf(line.declarer) === viewerSide
                  }
                />
              ))}
            </tbody>

            <tfoot>
              <tr>
                <th scope="row" colSpan={4} className="bo-scoreboard__total-label">
                  Razem
                </th>
                <td className="bo-scoreboard__cell--num bo-scoreboard__total">
                  {scoreFormat.format(score.totalNS)}
                </td>
                <td className="bo-scoreboard__cell--num bo-scoreboard__total">
                  {scoreFormat.format(score.totalEW)}
                </td>
                {showImps ? (
                  <td className="bo-scoreboard__cell--num bo-scoreboard__total">
                    <span aria-hidden="true">
                      {signedFormat.format(score.impsNS ?? 0)} : {signedFormat.format(score.impsEW ?? 0)}
                    </span>
                    <span className="bo-sr-only">
                      Impy: NS {score.impsNS ?? 0}, EW {score.impsEW ?? 0}
                    </span>
                  </td>
                ) : null}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
