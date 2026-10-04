// Live updates: the server pushes re-rendered summary/content HTML over SSE
// whenever the tracker changes anything. EventSource reconnects by itself.
// Times arrive as <time datetime data-fmt> and are shown in the device's
// time zone (same format as timeLabel in src/web/format.ts).
(() => {
  const script = document.currentScript;
  const eventsUrl = script && script.dataset.events;

  // Tell the server our time zone (it groups settled bets by *our* day).
  // Set before the SSE stream opens, so its first update uses it.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && script && tz !== script.dataset.tz) {
      document.cookie = `tz=${encodeURIComponent(tz)}; path=${script.dataset.base || '/'}; max-age=31536000; samesite=lax`;
    }
  } catch {
    /* keep the server's default zone */
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });

  const label = (d, kind) => {
    const time = timeFmt.format(d);
    if (kind === 'time') return time;
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return time;
    const days = (d - now) / 86400000;
    return days > -1 && days < 6
      ? `${weekdayFmt.format(d)} ${time}`
      : `${dateFmt.format(d)}, ${time}`;
  };

  const localize = (root) => {
    for (const el of root.querySelectorAll('time[data-fmt]')) {
      const d = new Date(el.getAttribute('datetime'));
      if (!isNaN(d)) el.textContent = label(d, el.dataset.fmt);
    }
  };

  localize(document);

  // Reliability-chart tooltips: hover, focus, or tap a point. Delegated so
  // they survive SSE re-renders.
  const showTip = (target) => {
    const pt = target && target.closest && target.closest('[data-tip]');
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (!pt) {
      tip.hidden = true;
      return;
    }
    tip.textContent = pt.dataset.tip;
    tip.hidden = false;
    const r = pt.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tip.offsetWidth - 8,
      Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
  };
  document.addEventListener('pointerover', (e) => showTip(e.target));
  document.addEventListener('focusin', (e) => showTip(e.target));
  document.addEventListener('click', (e) => showTip(e.target));
  window.addEventListener('scroll', () => showTip(null), { passive: true });

  if (!eventsUrl || !window.EventSource) return;

  const setConn = (state) => {
    const el = document.getElementById('conn');
    if (el) el.className = `conn ${state}`;
  };

  let failures = 0;
  const es = new EventSource(eventsUrl);
  es.addEventListener('update', (e) => {
    failures = 0;
    const { summary, content } = JSON.parse(e.data);
    document.getElementById('summary').innerHTML = summary;
    document.getElementById('content').innerHTML = content;
    localize(document);
    setConn('live');
  });
  es.addEventListener('open', () => setConn('live'));
  es.addEventListener('error', async () => {
    setConn('down');
    // An expired session redirects to /login: reload to show it.
    if (++failures >= 3) {
      try {
        const res = await fetch(location.href, { redirect: 'manual' });
        if (res.type === 'opaqueredirect') location.reload();
      } catch {
        /* offline; EventSource keeps retrying */
      }
    }
  });
})();
