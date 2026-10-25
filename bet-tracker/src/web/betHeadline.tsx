import { home } from '../util/url.js';
import { signedUsd } from './format.js';

/** Realized P/L today plus the current net EV of every open ticket. */
export function BetHeadline({
  settledToday,
  openEV,
}: {
  settledToday: number;
  openEV: number;
}) {
  const estimate =
    (Math.round(settledToday * 100) + Math.round(openEV * 100)) / 100;
  const breakdown = `Settled today: ${signedUsd(settledToday)} · Open EV: ${signedUsd(openEV)}`;
  return (
    <a
      id="bet-headline"
      class="daily-bet-result"
      href={`${home}?tab=settled`}
      title={breakdown}
      aria-label={`Today plus EV: ${signedUsd(estimate)}. ${breakdown}. View settled results.`}
      data-settled-today={settledToday}
      data-open-ev={openEV}
      data-total-estimate={estimate}
    >
      <span class="k">Today + EV</span>
      <span class={`v ${estimate >= 0 ? 'pos' : 'neg'}`}>
        {signedUsd(estimate)}
      </span>
    </a>
  );
}
