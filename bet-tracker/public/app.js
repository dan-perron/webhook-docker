// Live updates: the server pushes re-rendered summary/content HTML over SSE
// whenever the tracker changes anything. EventSource reconnects by itself.
// Times arrive as <time datetime data-fmt> and are shown in the device's
// time zone (same format as timeLabel in src/web/format.ts).
(() => {
  const script = document.currentScript;
  const eventsUrl = script && script.dataset.events;

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
