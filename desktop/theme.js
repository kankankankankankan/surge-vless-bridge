/**
 * [INPUT]: Uses system color preference, localStorage and appearance controls.
 * [OUTPUT]: Sets the resolved theme before paint and persists appearance choices.
 * [POS]: Renderer-only preferences; independent of bridge configuration and IPC.
 * [PROTOCOL]: Update this header on change, then check AGENTS.md
 */
(() => {
  const key = 'surge-vless-bridge.appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const choices = ['system', 'light', 'dark'];
  let preference = 'system';
  let persisted = true;
  let themeFrame;
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) preference = saved;
  } catch {
    persisted = false;
  }

  const apply = () => {
    const resolved = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    if (document.documentElement.dataset.theme !== resolved) {
      // Hover transitions must not interpolate a new text color against an old surface.
      document.documentElement.classList.add('theme-changing');
      cancelAnimationFrame(themeFrame);
      themeFrame = requestAnimationFrame(() => {
        themeFrame = requestAnimationFrame(() => document.documentElement.classList.remove('theme-changing'));
      });
    }
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.querySelectorAll('[data-appearance]').forEach(button => {
      const selected = button.dataset.appearance === preference;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    const status = document.querySelector('#appearance-status');
    if (status) status.textContent = persisted
      ? preference === 'system' ? `随 macOS 自动切换，当前为${resolved === 'dark' ? '深色' : '浅色'}。` : '已记住选择，下次打开时继续使用。'
      : '当前窗口已应用；外观偏好无法保存。';
  };

  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  document.addEventListener('DOMContentLoaded', () => {
    const buttons = [...document.querySelectorAll('[data-appearance]')];
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        preference = button.dataset.appearance;
        try { localStorage.setItem(key, preference); persisted = true; } catch { persisted = false; }
        apply();
      });
      button.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % buttons.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        buttons[next].click();
        buttons[next].focus();
      });
    });
    apply();
  });
})();
