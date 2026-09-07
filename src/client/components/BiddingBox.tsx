import { useEffect, useState } from 'react';
import type { BidLevel, Call } from '../../engine/types';
import { STRAINS } from '../../engine/types';
import { CallText, describeCall } from './ContractBadge';
import '../styles/bidding.css';

export interface BiddingBoxProps {
  legal: Call[];
  onCall: (call: Call) => void;
  disabled?: boolean;
  hint?: Call | null;
  busy?: boolean;
  confirm?: boolean;
}
const levels: BidLevel[] = [1, 2, 3, 4, 5, 6, 7];

/** Large two-stage bidding box: level, then suit, with an explicit final confirmation. */
export function BiddingBox({legal, onCall, disabled = false, busy = false, confirm = true}: BiddingBoxProps): JSX.Element {
  const firstLevel = levels.find(n => STRAINS.some(s => legal.includes(`${n}${s}` as Call))) ?? 1;
  const [level, setLevel] = useState<BidLevel>(firstLevel);
  const [chosen, setChosen] = useState<Call | null>(null);
  const signature = legal.join(',');
  useEffect(() => { setLevel(firstLevel); setChosen(null); }, [signature, firstLevel]);
  const locked = disabled || busy;
  function choose(call: Call): void {
    if (locked || !legal.includes(call)) return;
    if (confirm) setChosen(call); else onCall(call);
  }
  return <div className="bo-easy-bid" role="group" aria-label="Licytacja" aria-busy={busy}>
    <div className="bo-easy-bid__levels" role="group" aria-label="Wybierz poziom kontraktu">
      {levels.map(n => <button type="button" key={n} aria-label={`Poziom ${n}: ${n + 6} lew`} aria-pressed={level === n}
        disabled={locked || !STRAINS.some(s => legal.includes(`${n}${s}` as Call))}
        onClick={() => {setLevel(n); setChosen(null);}}>{n}</button>)}
    </div>
    <div className="bo-easy-bid__suits" role="group" aria-label={`Wybierz kolor na poziomie ${level}`}>
      {STRAINS.map(s => { const call = `${level}${s}` as Call; return <button type="button" key={s} disabled={locked || !legal.includes(call)}
        aria-label={`Wybierz ${describeCall(call)}`} aria-pressed={chosen === call} onClick={() => choose(call)}><CallText call={call} /></button>; })}
    </div>
    <div className="bo-easy-bid__specials">
      {(['P','X','XX'] as Call[]).map(call => <button type="button" key={call} disabled={locked || !legal.includes(call)} aria-pressed={chosen === call}
        onClick={() => choose(call)}>{call === 'P' ? 'PAS' : call === 'X' ? 'Kontra' : 'Rekontra'}</button>)}
    </div>
    {confirm && <div className="bo-easy-bid__confirm">
      <span aria-live="polite">{chosen ? describeCall(chosen) : 'Wybierz poziom i kolor albo PAS.'}</span>
      <button type="button" disabled={locked || chosen === null || !legal.includes(chosen)} onClick={() => {if(chosen && legal.includes(chosen)){onCall(chosen);setChosen(null);}}}>
        {chosen ? 'Zatwierdź' : 'Zatwierdź odzywkę'}
      </button>
    </div>}
  </div>;
}
