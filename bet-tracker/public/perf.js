// "Profit vs. expected" on the bets page: cumulative actual profit (blue,
// last value marked) and cumulative EV at placement (orange) by settlement
// day, from <base>/api/performance-series. Units (1u = $10) or dollars;
// origin All / Recommended / Own. Refetched after live updates.
(() => {
  const root = document.getElementById('perf');
  const canvas = document.getElementById('perf-chart');
  if (!root || !canvas || !window.Chart) return;
  const api = root.dataset.api;
  const originSel = document.getElementById('perf-origin');
  const stats = document.getElementById('perf-stats');
  const empty = document.getElementById('perf-empty');
  const BLUE = '#2f81f7';
  const ORANGE = '#f0883e';

  let unit = localStorage.getItem('perf-unit') === 'usd' ? 'usd' : 'u';
  let series = null;
  let chart = null;
  let lastBody = '';

  const css = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const scale = () => (unit === 'u' ? series.unitDollars : 1);
  const fmt = (dollars) => {
    const v = dollars / scale();
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    const a = Math.abs(v);
    if (unit === 'u') return `${sign}${a.toFixed(a >= 100 ? 0 : 1)}u`;
    const digits = a >= 1000 ? 0 : 2;
    return `${sign}$${a.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  };
  const md = (date) => {
    const [, m, d] = date.split('-');
    return `${Number(m)}/${Number(d)}`;
  };

  const showStats = () => {
    stats.replaceChildren();
    const last = series.points.at(-1);
    if (!last) return;
    const gap = last.actual - last.expected;
    const item = (label, value, cls) => {
      const s = document.createElement('span');
      s.className = 'perf-stat';
      const l = document.createElement('span');
      l.className = 'muted';
      l.textContent = label;
      const v = document.createElement('b');
      v.textContent = value;
      if (cls) v.className = cls;
      s.append(l, v);
      stats.append(s);
    };
    item('Actual', fmt(last.actual), last.actual >= 0 ? 'pos' : 'neg');
    item('Expected', fmt(last.expected));
    item('Gap', fmt(gap), gap >= 0 ? 'pos' : 'neg');
    item('Bets', String(series.count));
  };

  const yTick = (v) =>
    unit === 'u' ? `${v}u` : `$${Number(v).toLocaleString()}`;

  const draw = () => {
    const pts = series.points;
    empty.hidden = pts.length > 0;
    canvas.parentElement.hidden = pts.length === 0;
    showStats();
    if (!pts.length) return;
    const k = scale();
    const last = pts.length - 1;
    const data = {
      labels: pts.map((p) => md(p.date)),
      datasets: [
        {
          label: 'Actual',
          data: pts.map((p) => p.actual / k),
          borderColor: BLUE,
          backgroundColor: BLUE,
          borderWidth: 2.5,
          tension: 0.25,
          pointRadius: pts.map((_, i) => (i === last ? 5 : 0)),
          pointHoverRadius: 5,
          pointBorderColor: css('--card'),
          pointBorderWidth: 2,
        },
        {
          label: 'Expected (EV at placement)',
          data: pts.map((p) => p.expected / k),
          borderColor: ORANGE,
          backgroundColor: ORANGE,
          borderWidth: 2,
          borderDash: [6, 4],
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    };
    if (chart) {
      chart.data = data;
      chart.update();
      return;
    }
    const muted = css('--muted');
    chart = new window.Chart(canvas, {
      type: 'line',
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: muted,
              boxWidth: 14,
              boxHeight: 2,
              padding: 12,
              font: { size: 12 },
            },
          },
          tooltip: {
            displayColors: false,
            padding: 10,
            callbacks: {
              title: (items) => series.points[items[0].dataIndex].date,
              label: () => null,
              afterBody: (items) => {
                const p = series.points[items[0].dataIndex];
                return [
                  `Actual: ${fmt(p.actual)}`,
                  `Expected: ${fmt(p.expected)}`,
                  `Gap: ${fmt(p.actual - p.expected)}`,
                  `Settled that day: ${p.betsSettled}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: muted,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: window.innerWidth < 500 ? 5 : 10,
            },
          },
          y: {
            grid: { color: css('--line') },
            border: { display: false },
            ticks: { color: muted, callback: yTick, maxTicksLimit: 6 },
          },
        },
      },
    });
  };

  const load = async () => {
    const q = originSel.value
      ? `?origin=${encodeURIComponent(originSel.value)}`
      : '';
    try {
      const res = await fetch(`${api}${q}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = await res.text();
      if (body === lastBody) return;
      lastBody = body;
      series = JSON.parse(body);
      draw();
    } catch {
      /* offline: keep the last chart */
    }
  };

  const setUnit = (u) => {
    unit = u;
    localStorage.setItem('perf-unit', u);
    for (const b of root.querySelectorAll('[data-perf-unit]'))
      b.setAttribute('aria-pressed', String(b.dataset.perfUnit === u));
    if (series) draw();
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-perf-unit]');
    if (b) setUnit(b.dataset.perfUnit);
  });
  originSel.addEventListener('change', () => {
    lastBody = '';
    load();
  });
  let timer = null;
  document.addEventListener('bets:update', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 2000);
  });
  // Follow light/dark changes.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (!chart || !series) return;
      chart.destroy();
      chart = null;
      draw();
    });

  setUnit(unit);
  load();
})();
