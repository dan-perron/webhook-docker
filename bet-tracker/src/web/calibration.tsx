import type {
  ReliabilityBin,
  SportCalibration,
} from '../tracker/calibration.js';

// Settled-tab calibration: a Brier table (per sport and all) and one
// reliability chart per sport (predicted vs observed win rate, 10% bins, 95%
// Wilson whiskers, the diagonal = perfectly calibrated). Hover/tap a point
// for its numbers (public/app.js); each chart has a table view.

const SPORT_LABEL: Record<string, string> = {
  all: 'All sports',
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  mlb: 'MLB',
  soccer: 'Soccer',
  mma: 'UFC',
};
const label = (s: string) => SPORT_LABEL[s] ?? s;
const pct0 = (p: number) => `${Math.round(p * 100)}%`;
const legsText = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

// Plot geometry (viewBox units; the SVG scales to the card width).
const W = 240;
const H = 200;
const L = 34;
const R = 10;
const T = 10;
const B = 30;
const x = (p: number) => L + p * (W - L - R);
const y = (p: number) => H - B - p * (H - T - B);

function tip(b: ReliabilityBin) {
  return `${pct0(b.lo)}–${pct0(b.hi)} predicted (avg ${pct0(b.meanPredicted)}): won ${pct0(b.observed)} of ${legsText(b.legs)} legs, 95% range ${pct0(b.ciLow)}–${pct0(b.ciHigh)}`;
}

function ReliabilityChart({ c }: { c: SportCalibration }) {
  const ticks = [0, 0.5, 1];
  return (
    <svg
      class="reliability"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label(c.sport)} reliability: predicted vs observed win rate`}
    >
      {[0.25, 0.5, 0.75].map((g) => (
        <>
          <line class="grid" x1={x(0)} x2={x(1)} y1={y(g)} y2={y(g)} />
          <line class="grid" x1={x(g)} x2={x(g)} y1={y(0)} y2={y(1)} />
        </>
      ))}
      <line class="axis" x1={x(0)} x2={x(1)} y1={y(0)} y2={y(0)} />
      <line class="axis" x1={x(0)} x2={x(0)} y1={y(0)} y2={y(1)} />
      <line class="diag" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
      {ticks.map((t) => (
        <>
          <text class="tick" x={x(t)} y={H - B + 14} text-anchor="middle">
            {pct0(t)}
          </text>
          <text class="tick" x={L - 6} y={y(t) + 4} text-anchor="end">
            {pct0(t)}
          </text>
        </>
      ))}
      <text class="axis-label" x={x(0.5)} y={H - 2} text-anchor="middle">
        Predicted
      </text>
      <text
        class="axis-label"
        x={10}
        y={y(0.5)}
        text-anchor="middle"
        transform={`rotate(-90 10 ${y(0.5)})`}
      >
        Won
      </text>
      {c.bins.map((b) => (
        <g class="pt" data-tip={tip(b)} tabindex="0">
          <line
            class="whisker"
            x1={x(b.meanPredicted)}
            x2={x(b.meanPredicted)}
            y1={y(b.ciLow)}
            y2={y(b.ciHigh)}
          />
          <circle
            class="dot"
            cx={x(b.meanPredicted)}
            cy={y(b.observed)}
            r="4.5"
          />
          <circle
            class="hit"
            cx={x(b.meanPredicted)}
            cy={y(b.observed)}
            r="14"
          />
        </g>
      ))}
    </svg>
  );
}

function BinTable({ c }: { c: SportCalibration }) {
  return (
    <details class="bins">
      <summary>Table</summary>
      <table>
        <thead>
          <tr>
            <th>Predicted</th>
            <th>Legs</th>
            <th>Avg predicted</th>
            <th>Won</th>
            <th>95% range</th>
          </tr>
        </thead>
        <tbody>
          {c.bins.map((b) => (
            <tr>
              <td>
                {pct0(b.lo)}–{pct0(b.hi)}
              </td>
              <td>{legsText(b.legs)}</td>
              <td>{pct0(b.meanPredicted)}</td>
              <td>{pct0(b.observed)}</td>
              <td>
                {pct0(b.ciLow)}–{pct0(b.ciHigh)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function Calibration({ report }: { report: SportCalibration[] }) {
  if (report.length === 0) {
    return (
      <section>
        <h2>Calibration</h2>
        <p class="empty">No settled legs with logged predictions yet.</p>
      </section>
    );
  }
  const sports = report.filter((c) => c.sport !== 'all');
  return (
    <section class="calibration">
      <h2>Calibration</h2>
      <div class="card">
        <table class="brier">
          <thead>
            <tr>
              <th>Sport</th>
              <th>Legs</th>
              <th>Brier</th>
              <th>Pregame</th>
              <th>Skill</th>
            </tr>
          </thead>
          <tbody>
            {report.map((c) => (
              <tr class={c.sport === 'all' ? 'all' : ''}>
                <td>{label(c.sport)}</td>
                <td>{c.legs}</td>
                <td>{c.brier.toFixed(3)}</td>
                <td>
                  {c.brierPregame == null ? '–' : c.brierPregame.toFixed(3)}
                </td>
                <td>
                  {c.skill == null
                    ? '–'
                    : `${c.skill >= 0 ? '+' : '−'}${Math.abs(Math.round(c.skill * 100))}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="foot">
          Brier = mean squared error of P(win): 0 is perfect, 0.250 is a coin
          flip. Skill = improvement over always predicting the base rate. Each
          settled leg counts once across its snapshots.
        </p>
      </div>
      <div class="multiples">
        {sports.map((c) => (
          <div class="card chart">
            <div class="label">
              {label(c.sport)} <span class="muted">· {c.legs} legs</span>
            </div>
            <ReliabilityChart c={c} />
            <BinTable c={c} />
          </div>
        ))}
      </div>
      <div id="tip" class="tip" role="status" hidden></div>
    </section>
  );
}
