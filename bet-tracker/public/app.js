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

  const freshen = () => {
    for (const el of document.querySelectorAll('[data-watch-checked]')) {
      const at = Date.parse(el.dataset.watchChecked);
      if (Number.isFinite(at) && Date.now() - at <= 2 * 3600000) continue;
      const availability = el.querySelector('.watch-availability');
      if (availability) {
        availability.textContent = 'OTA ?';
        availability.setAttribute('aria-label', 'Local coverage unconfirmed');
        availability.className = 'watch-availability unknown';
      }
      const summary = el.querySelector('summary');
      if (summary) summary.title = 'Watch: local coverage unconfirmed';
      const location = el.querySelector('.watch-location');
      if (location) location.textContent = 'Local coverage unconfirmed';
      const streams = el.querySelector('.watch-streams');
      if (streams) streams.hidden = true;
      const note = el.querySelector('.watch-note');
      if (note)
        note.textContent =
          'Coverage information is old. Check the NFL game guide for the latest assignment.';
    }
    for (const el of document.querySelectorAll('[data-freshness]')) {
      const at = Date.parse(el.dataset.freshness);
      if (!Number.isFinite(at)) {
        el.textContent = 'Waiting for update';
        el.classList.remove('stale');
        el.hidden = false;
        continue;
      }
      const age = Math.max(0, Math.floor((Date.now() - at) / 1000));
      const stale = age > Number(el.dataset.staleAfter);
      const label =
        age < 10
          ? 'just now'
          : age < 60
            ? `${age}s ago`
            : age < 3600
              ? `${Math.floor(age / 60)}m ago`
              : age < 86400
                ? `${Math.floor(age / 3600)}h ago`
                : `${Math.floor(age / 86400)}d ago`;
      el.textContent = `Updated ${label}${stale ? ' · stale data' : ''}`;
      el.classList.toggle('stale', stale);
      if (el.dataset.staleOnly === 'true') el.hidden = !stale;
    }
  };

  // Keep disclosures and the sport selection stable across full SSE renders.
  const detailsState = new Map();
  let selectedSport = 'all';
  const filterGames = () => {
    const controls = [...document.querySelectorAll('[data-sport-filter]')];
    if (!controls.some((el) => el.dataset.sportFilter === selectedSport))
      selectedSport = 'all';
    for (const el of controls)
      el.setAttribute(
        'aria-pressed',
        String(el.dataset.sportFilter === selectedSport)
      );
    for (const el of document.querySelectorAll('.game[data-sport]'))
      el.hidden = selectedSport !== 'all' && el.dataset.sport !== selectedSport;
    for (const section of document.querySelectorAll('[data-game-section]')) {
      const count = section.querySelectorAll('.game:not([hidden])').length;
      section.hidden = count === 0;
      section.querySelector('h2').textContent =
        `${section.dataset.title} (${count})`;
    }
  };
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-sport-filter]');
    if (!button) return;
    selectedSport = button.dataset.sportFilter;
    filterGames();
  });

  localize(document);
  freshen();
  setInterval(freshen, 10000);

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
  window.addEventListener('scroll', () => showTip(document.activeElement), {
    passive: true,
  });

  if (!eventsUrl || !window.EventSource) return;

  const setConn = (state) => {
    const el = document.getElementById('conn');
    if (el) {
      el.className = `conn ${state}`;
      el.textContent = state === 'live' ? 'Connected' : 'Reconnecting…';
    }
  };

  let failures = 0;
  const es = new EventSource(eventsUrl);
  es.addEventListener('update', (e) => {
    failures = 0;
    for (const el of document.querySelectorAll('details[id]'))
      detailsState.set(el.id, el.open);
    const focusedId = document.activeElement && document.activeElement.id;
    const { summary, content } = JSON.parse(e.data);
    document.getElementById('summary').innerHTML = summary;
    document.getElementById('content').innerHTML = content;
    for (const el of document.querySelectorAll('details[id]')) {
      if (detailsState.has(el.id)) el.open = detailsState.get(el.id);
    }
    filterGames();
    localize(document);
    freshen();
    setConn('live');
    if (focusedId)
      document.getElementById(focusedId)?.focus({ preventScroll: true });
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
