// Apply the saved preference before first paint; keep this external for the site CSP.
(() => {
  let theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  try {
    const saved = JSON.parse(localStorage.getItem('opc-theme') || 'null');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {
    /* System preference remains available when storage is blocked. */
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = theme === 'dark' ? '#0f1726' : '#f5f7fb';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0f1726' : '#245bdb');
})();
