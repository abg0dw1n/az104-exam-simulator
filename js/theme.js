// Light/dark theme. Loaded as a plain (blocking) script in <head> so the right theme
// is applied before the page paints. The choice is per device: 'system' (default,
// follows the device setting), 'light' or 'dark'. Stored under a key sign-out keeps.
(function () {
  var KEY = 'itsh:theme';
  var COLORS = { light: '#faf4f2', dark: '#2d2a2e' }; // browser UI (theme-color) per theme
  var media = window.matchMedia('(prefers-color-scheme: light)');

  function pref() {
    try { return localStorage.getItem(KEY) || 'system'; } catch (e) { return 'system'; }
  }
  function resolve(p) { return p === 'system' ? (media.matches ? 'light' : 'dark') : p; }

  function syncToggle() {
    var b = document.getElementById('theme-toggle');
    if (!b) return;
    var light = document.documentElement.dataset.theme === 'light';
    var label = light ? 'Switch to dark mode' : 'Switch to light mode';
    b.setAttribute('aria-label', label);
    b.title = label;
  }

  function apply() {
    var theme = resolve(pref());
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
    syncToggle();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme, pref: pref() } }));
  }

  window.Theme = {
    pref: pref,
    current: function () { return document.documentElement.dataset.theme; },
    set: function (p) {
      try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch (e) { /* ignore */ }
      apply();
    },
    toggle: function () { this.set(this.current() === 'light' ? 'dark' : 'light'); },
  };

  apply();
  media.addEventListener('change', function () { if (pref() === 'system') apply(); });
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('theme-toggle');
    if (b) b.addEventListener('click', function () { window.Theme.toggle(); });
    syncToggle();
  });
})();
