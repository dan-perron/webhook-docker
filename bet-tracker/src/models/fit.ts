import type { Sport } from '../domain/types.js';
import { fitMarginModel } from './football.js';
import { fitMlb } from './mlb.js';
import { fitNhl } from './nhl.js';
import {
  isMarginSport,
  marginSigmasFor,
  type ModelParams,
  type Prior,
} from './prior.js';
import { fitSoccer } from './soccer.js';

// Fit each sport's model to the prior's main lines, so the pregame model
// reproduces the market's de-vigged moneyline, spread and total. Results are
// cached by their inputs: a pregame event re-fits only when its lines move.

const cache = new Map<string, Record<string, number>>();
const MAX_CACHE = 500;

function fitFor(
  sport: Sport,
  prior: Prior,
  params: ModelParams,
  postseason: boolean
): Record<string, number> {
  const key = JSON.stringify([
    sport,
    prior.homeWin,
    prior.draw,
    prior.spread,
    prior.totalLine,
    prior.expectedTotal,
    postseason,
  ]);
  const hit = cache.get(key);
  if (hit) return hit;
  let fit: Record<string, number>;
  if (isMarginSport(sport)) {
    const f = fitMarginModel(prior, sport, marginSigmasFor(sport, params));
    fit = { mean: f.mean, sigma: f.sigma, total: f.total };
  } else if (sport === 'mlb') fit = { ...fitMlb(prior) };
  else if (sport === 'nhl') fit = { ...fitNhl(prior, postseason) };
  else if (sport === 'soccer') fit = { ...fitSoccer(prior) };
  else fit = {};
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(key, fit);
  return fit;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function describe(sport: Sport, f: Record<string, number>): string {
  if (isMarginSport(sport))
    return `fit: margin ${r1(f.mean!)}, σ ${r1(f.sigma!)}, total ${r1(f.total!)}`;
  if (sport === 'mlb')
    return `fit: ${r2(f.total!)} runs, home share ${r2(f.share!)}, dispersion ${r2(f.dispersion!)}`;
  if (sport === 'nhl')
    return `fit: ${r2(f.home!)}/${r2(f.away!)} goals/60, empty-net x${r2(f.emptyNet!)}`;
  if (sport === 'soccer')
    return `fit: xG ${r2(f.home!)}/${r2(f.away!)}, rho ${r2(f.rho!)}`;
  return '';
}

/**
 * The prior with its sport model fitted (`fit`, and for margin sports the
 * fitted mean, σ and total). Priors saved before fitting existed (no
 * `markets`) keep the margin and σ they were frozen with.
 */
export function ensureFit(
  sport: Sport,
  prior: Prior,
  params: ModelParams,
  postseason = false
): Prior {
  if (prior.fit && Object.keys(prior.fit).length) return prior;
  if (!prior.markets && isMarginSport(sport) && prior.expectedMargin != null) {
    const fit = {
      mean: prior.expectedMargin,
      sigma: prior.marginSigma ?? marginSigmasFor(sport, params).marginSigma,
      total: prior.expectedTotal ?? 0,
    };
    return { ...prior, fit };
  }
  const fit = fitFor(sport, prior, params, postseason);
  const text = describe(sport, fit);
  return {
    ...prior,
    fit,
    ...(isMarginSport(sport)
      ? {
          expectedMargin: fit.mean!,
          marginSigma: fit.sigma!,
          expectedTotal: fit.total!,
        }
      : sport === 'mlb'
        ? { expectedTotal: fit.total! }
        : {}),
    detail: text ? `${prior.detail}; ${text}` : prior.detail,
  };
}
