// Live updates: the server pushes re-rendered summary/content HTML over SSE
// whenever the tracker changes anything. EventSource reconnects by itself.
(() => {
  const script = document.currentScript;
  const eventsUrl = script && script.dataset.events;
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
