/*
 * Makes the whole date field open the browser's own calendar, not just the
 * little icon at its right edge.
 *
 * `<input type="date">` already shows a calendar when you hit the icon; this
 * only widens the target so tapping anywhere in the field does it too, which
 * matters a lot more on a phone than on a desktop.
 *
 * showPicker() requires a user gesture and throws in a few situations (an
 * unsupported browser, a cross-origin frame, a second call while the picker is
 * already up). All of those are fine to ignore — the native icon still works.
 */
(function () {
  'use strict';

  var fields = document.querySelectorAll('input.datefield[type="date"]');
  if (!fields.length) return;

  Array.prototype.forEach.call(fields, function (field) {
    if (typeof field.showPicker !== 'function') return;
    field.addEventListener('click', function () {
      try {
        field.showPicker();
      } catch (_) {
        /* the icon still opens it */
      }
    });
  });
})();
