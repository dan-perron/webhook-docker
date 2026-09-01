/*
 * Availability grid: drag out a block, then drag its edges to adjust — the way
 * you would in a calendar app.
 *
 * Everything here is an enhancement. The grid is a form of submit buttons that
 * already works with JS off; this file preventDefaults those submits and
 * replaces them with batched saves.
 *
 * The interaction, in full:
 *   - A visible brush (Free / If needed) says WHAT you are painting.
 *   - Press and drag on empty squares to sweep out a block. Moving back up
 *     shrinks it again — the range is recomputed from the anchor every time
 *     rather than accumulated, so a drag can always be taken back.
 *   - Press the grab strip at the top or bottom edge of an existing block and
 *     drag to move just that end. The other end stays put.
 *   - Tap without moving to toggle a single square.
 * A drag stays in the column it started in, like dragging in a calendar.
 */
(function () {
  'use strict';

  var root = document.getElementById('mygrid');
  var wrap = document.getElementById('gridwrap');
  var dataEl = document.getElementById('grid-data');
  if (!root || !wrap || !dataEl) return;

  var cfg = JSON.parse(dataEl.textContent);
  var NONE = 'none';
  var WORD = { yes: 'free', ifNeeded: 'if needed', none: 'not available' };
  var MOVE_THRESHOLD = 4; // px before a press counts as a drag rather than a tap
  var EDGE_SCROLL = 36; // px from the scroll box edge that starts auto-scrolling

  var cells = new Map(); // slotKey -> element
  var server = new Map(); // slotKey -> last value the server confirmed
  root.querySelectorAll('[data-slot]').forEach(function (el) {
    cells.set(el.dataset.slot, el);
    server.set(el.dataset.slot, el.dataset.state || NONE);
  });

  // Column model. cfg.fills already lists each date's slot keys in row order,
  // so the geometry normally never has to be re-derived from the DOM.
  var cols = {};
  var rowOf = {};
  var dateOf = {};
  var dates = [];

  if (cfg.dates && cfg.fills) {
    dates = cfg.dates;
    dates.forEach(function (date) {
      cols[date] = cfg.fills['date:' + date] || [];
    });
  } else {
    // A tab opened before `dates` landed in grid-data would otherwise find no
    // columns at all, bail out of every pointerdown, and look completely dead.
    // The DOM already holds the same information, so rebuild from it: the table
    // is row-major, which means grouping by date preserves each column's order.
    root.querySelectorAll('[data-slot]').forEach(function (el) {
      var key = el.dataset.slot;
      var date = key.slice(0, key.indexOf('_'));
      if (!cols[date]) {
        cols[date] = [];
        dates.push(date);
      }
      cols[date].push(key);
    });
    dates.sort();
  }

  dates.forEach(function (date) {
    cols[date].forEach(function (key, i) {
      rowOf[key] = i;
      dateOf[key] = date;
    });
  });

  /** Weekday of a column, as the viewer sees it. */
  function weekdayOf(date) {
    if (cfg.dow && cfg.dow[date] !== undefined) return cfg.dow[date];
    // Stale-page fallback. Ignores the viewer's timezone shift, which the
    // server-rendered cfg.dow accounts for — good enough to keep quick fill
    // usable until the page is reloaded.
    return new Date(date + 'T00:00:00').getDay();
  }

  var brush = 'yes';
  var touched = new Set();
  var drag = null;

  document.querySelectorAll('input[name="brush"]').forEach(function (radio) {
    if (radio.checked) brush = radio.value;
    radio.addEventListener('change', function () {
      if (radio.checked) brush = radio.value;
    });
  });

  function get(key) {
    var el = cells.get(key);
    return el ? el.dataset.state || NONE : NONE;
  }

  function set(key, value) {
    var el = cells.get(key);
    if (!el) return;
    el.dataset.state = value;
    el.setAttribute('aria-label', el.dataset.label + ', ' + WORD[value]);
  }

  /**
   * Mark the first and last square of every block so CSS can draw grab strips.
   * Recomputed after any change rather than tracked incrementally — there are
   * only a few hundred squares, and correctness beats cleverness here.
   */
  function refreshGrips() {
    dates.forEach(function (date) {
      var keys = cols[date];
      keys.forEach(function (key, i) {
        var el = cells.get(key);
        if (!el) return;
        var state = get(key);
        if (state === NONE) {
          el.removeAttribute('data-grip');
          return;
        }
        var grip = [];
        if (i === 0 || get(keys[i - 1]) !== state) grip.push('top');
        if (i === keys.length - 1 || get(keys[i + 1]) !== state)
          grip.push('bottom');
        if (grip.length) el.setAttribute('data-grip', grip.join(' '));
        else el.removeAttribute('data-grip');
      });
    });
  }

  /** Row under a Y coordinate, clamped — dragging past either end pins to it. */
  function rowAtY(y, date) {
    var keys = cols[date];
    for (var i = 0; i < keys.length; i++) {
      var el = cells.get(keys[i]);
      if (!el) continue;
      if (y < el.getBoundingClientRect().bottom) return i;
    }
    return keys.length - 1;
  }

  // The grid scrolls in its own box, so a long drag has to drive that box.
  var scroller = root.closest('.grid-scroll');
  function autoScroll(y) {
    if (!scroller) return;
    var box = scroller.getBoundingClientRect();
    if (y < box.top + EDGE_SCROLL) scroller.scrollTop -= 12;
    else if (y > box.bottom - EDGE_SCROLL) scroller.scrollTop += 12;
  }

  /**
   * Rebuild the column from its pre-drag snapshot, then lay the range on top.
   * Recomputing from the snapshot each time is what lets a drag shrink; a
   * paint-as-you-touch model can only ever grow.
   */
  function applyRange(lo, hi) {
    var d = drag;
    d.keys.forEach(function (key, i) {
      set(key, d.snapshot[i]);
    });
    // Resizing clears the block being resized first, so pulling an edge inward
    // actually gives ground back instead of leaving the old squares filled.
    if (d.resize) {
      for (var i = d.blockLo; i <= d.blockHi; i++) set(d.keys[i], NONE);
    }
    for (var j = lo; j <= hi; j++) set(d.keys[j], d.value);
  }

  root.addEventListener('pointerdown', function (e) {
    var cell = e.target.closest('[data-slot]');
    if (!cell) return;
    e.preventDefault(); // no text selection, no compatibility mouse events
    try {
      // Capture on the mouse too, so both input types take the same code path.
      root.setPointerCapture(e.pointerId);
    } catch (_) {
      /* capture is best-effort */
    }

    var key = cell.dataset.slot;
    var date = dateOf[key];
    var row = rowOf[key];
    if (date === undefined || row === undefined) return;

    var keys = cols[date];
    var snapshot = keys.map(get);
    var state = snapshot[row];

    // Which block, if any, this square belongs to.
    var lo = row;
    var hi = row;
    if (state !== NONE) {
      while (lo > 0 && snapshot[lo - 1] === state) lo--;
      while (hi < keys.length - 1 && snapshot[hi + 1] === state) hi++;
    }

    // Grab strips live at the outer edges of a block. Sized off the cell so it
    // stays proportional when touch bumps cells from 34px to 42px.
    var rect = cell.getBoundingClientRect();
    var zone = Math.min(14, rect.height * 0.34);
    var grip = cell.getAttribute('data-grip') || '';
    var resize = null;
    if (state !== NONE) {
      if (grip.indexOf('top') >= 0 && e.clientY - rect.top <= zone) {
        resize = 'start';
      } else if (
        grip.indexOf('bottom') >= 0 &&
        rect.bottom - e.clientY <= zone
      ) {
        resize = 'end';
      }
    }

    drag = {
      date: date,
      keys: keys,
      snapshot: snapshot,
      resize: resize,
      blockLo: lo,
      blockHi: hi,
      // Resizing pivots on the far end of the block; a new block pivots on the
      // square you pressed.
      anchor: resize === 'start' ? hi : resize === 'end' ? lo : row,
      value: resize ? state : state === brush ? NONE : brush,
      row: row,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    window.__painting = true; // pauses the #everyone poll
  });

  root.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.moved) {
      // Below the threshold this is still a tap, and taps must not resize.
      if (
        Math.abs(e.clientX - drag.x) < MOVE_THRESHOLD &&
        Math.abs(e.clientY - drag.y) < MOVE_THRESHOLD
      ) {
        return;
      }
      drag.moved = true;
    }
    autoScroll(e.clientY);
    var row = rowAtY(e.clientY, drag.date);
    applyRange(Math.min(drag.anchor, row), Math.max(drag.anchor, row));
  });

  function finish(e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    window.__painting = false;
    try {
      root.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* already released */
    }
    if (!d.moved) {
      // Never moved, so it was a tap: toggle the one square.
      var key = d.keys[d.row];
      set(key, get(key) === brush ? NONE : brush);
    }
    refreshGrips();
    d.keys.forEach(function (key) {
      touched.add(key);
    });
    flush();
  }

  root.addEventListener('pointerup', finish);
  // iOS fires pointercancel when it decides the gesture was a system gesture.
  // Commit what was painted — never revert, that throws away real work.
  root.addEventListener('pointercancel', finish);

  // Keyboard and assistive-tech activation only. Enter/Space on a <button>
  // produces a click with detail === 0; pointer-driven clicks are always >= 1.
  root.addEventListener('click', function (e) {
    e.preventDefault(); // keep the no-JS form submit inert
    var cell = e.target.closest('[data-slot]');
    if (!cell || e.detail !== 0) return;
    var key = cell.dataset.slot;
    touched.clear();
    touched.add(key);
    set(key, get(key) === brush ? NONE : brush);
    refreshGrips();
    flush();
  });

  function paintAll(pairs) {
    touched.clear();
    pairs.forEach(function (pair) {
      touched.add(pair[0]);
      set(pair[0], pair[1]);
    });
    refreshGrips();
    flush();
  }

  // Row / column bulk fill. cfg.fills is precomputed server-side so this file
  // never has to do date math.
  wrap.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-fill]');
    if (!btn) return;
    e.preventDefault();
    var keys = cfg.fills[btn.dataset.fill];
    if (!keys || !keys.length) return;
    var allBrush = keys.every(function (k) {
      return get(k) === brush;
    });
    paintAll(
      keys.map(function (k) {
        return [k, allBrush ? NONE : brush];
      })
    );
  });

  // ---- Quick fill ----
  // Both forms already work as plain POSTs; intercepting only saves a reload.
  function slotsIn(dates, fromMinute, toMinute) {
    var keys = [];
    dates.forEach(function (date) {
      (cols[date] || []).forEach(function (key) {
        var hhmm = key.slice(key.indexOf('_') + 1);
        var minute =
          parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
        if (minute >= fromMinute && minute < toMinute) keys.push(key);
      });
    });
    return keys;
  }

  var quick = document.getElementById('quickfill');
  if (quick) {
    quick.addEventListener('submit', function (e) {
      var action = e.submitter && e.submitter.value;
      if (!action) return; // let the plain POST happen
      e.preventDefault();
      var from = Number(quick.elements.fromMinute.value);
      var to = Number(quick.elements.toMinute.value);
      var days = dates.filter(function (date) {
        var box = quick.querySelector(
          'input[name="dow"][value="' + weekdayOf(date) + '"]'
        );
        return box && box.checked;
      });
      var value = action === 'clear' ? NONE : action;
      paintAll(
        slotsIn(days, from, to).map(function (key) {
          return [key, value];
        })
      );
    });
  }

  var copy = document.getElementById('copyday');
  if (copy) {
    copy.addEventListener('submit', function (e) {
      e.preventDefault();
      var source = copy.elements.from.value;
      var targets = Array.prototype.slice
        .call(copy.querySelectorAll('input[name="to"]:checked'))
        .map(function (box) {
          return box.value;
        })
        .filter(function (date) {
          return date !== source;
        });
      if (!targets.length) {
        status('Tick the days to copy onto first.', true);
        return;
      }
      // Copy row by row, so this stays right whatever the slot size is.
      var pairs = [];
      (cols[source] || []).forEach(function (srcKey, i) {
        var value = get(srcKey);
        targets.forEach(function (date) {
          var key = (cols[date] || [])[i];
          if (key) pairs.push([key, value]);
        });
      });
      paintAll(pairs);
    });
  }

  var statusEl = document.getElementById('savestatus');
  function status(msg, bad) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('savestatus--err', !!bad);
  }

  // Serialize saves so two quick drags can't swap #everyone out of order.
  var chain = Promise.resolve();

  function flush() {
    var changes = [];
    touched.forEach(function (key) {
      if (get(key) !== server.get(key))
        changes.push({ key: key, value: get(key) });
    });
    touched.clear();
    if (changes.length) {
      chain = chain.then(function () {
        return save(changes);
      });
    }
  }

  function save(changes) {
    status('Saving…');
    return fetch(cfg.saveUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: changes }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        changes.forEach(function (ch) {
          server.set(ch.key, ch.value);
        });
        // htmx.swap (not innerHTML) because the fragment carries hx-* attributes
        // — the poll trigger and the duration select — that need processing.
        if (window.htmx) {
          htmx.swap('#everyone', html, { swapStyle: 'outerHTML' });
        }
        status('Saved');
      })
      .catch(function () {
        changes.forEach(function (ch) {
          set(ch.key, server.get(ch.key));
        });
        refreshGrips();
        status('Could not save — that change was undone.', true);
      });
  }

  // The browser is the only thing that knows the URL the user actually typed,
  // so let it have the last word over whatever the server guessed.
  try {
    var share = document.getElementById('sharelink');
    if (share) share.value = window.location.origin + window.location.pathname;
  } catch (_) {
    /* leave the server-rendered value */
  }

  // Heatmap detail. The id -> name map is inlined, so no round-trip. Both
  // lookups happen inside the handler because #everyone (and the map with it)
  // is replaced on every save.
  document.addEventListener('click', function (e) {
    var cell = e.target.closest('[data-heat]');
    if (!cell) return;
    var detail = document.getElementById('heatdetail');
    var data = document.getElementById('names-data');
    if (!detail || !data) return;
    var names = JSON.parse(data.textContent);
    var lookup = function (csv) {
      return csv
        ? csv.split(',').map(function (id) {
            return names[id] || '?';
          })
        : [];
    };
    var yes = lookup(cell.dataset.yes);
    var iff = lookup(cell.dataset.if);
    var parts = [cell.dataset.label + ' — '];
    parts.push(yes.length ? 'Free: ' + yes.join(', ') : 'Nobody is free');
    if (iff.length) parts.push(' · If needed: ' + iff.join(', '));
    detail.textContent = parts.join('');
  });

  refreshGrips();
})();
