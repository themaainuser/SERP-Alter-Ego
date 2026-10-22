// Resolve the stored theme (system/light/dark) before first paint — no flash.
// Loaded as a blocking classic script from <head>; it must stay a separate file because the
// page's Content-Security-Policy does not allow inline scripts. client/app.ts owns the switch.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('serp-alter-ego-theme'); } catch (e) {}
  var dark = mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
