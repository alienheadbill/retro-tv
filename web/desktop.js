// Keyboard controls for the desktop-browser presentation.
// Reuse the published app's real remote, keeping all channel logic in the shared TV engine.
(() => {
  const keyMap = {
    ArrowUp: 'up', ArrowDown: 'down', PageUp: 'up', PageDown: 'down',
    g: 'guide', i: 'info', m: 'mute', k: 'profile', c: 'crt',
    o: 'order', l: 'menu', Backspace: 'last', Escape: 'menu',
  };
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    const digit = /^[0-9]$/.test(event.key) ? event.key : null;
    const name = keyMap[event.key] || keyMap[event.key.toLowerCase()];
    const button = digit != null
      ? document.querySelector('#remote [data-digit="' + digit + '"]')
      : name ? document.querySelector('#remote [data-act="' + name + '"]') : null;
    if (!button) return;
    event.preventDefault();
    button.click();
  });
  document.addEventListener('wheel', event => {
    if (event.target.closest('#manage, #remote, #guide')) return;
    const direction = event.deltaY > 0 ? 'down' : 'up';
    const button = document.querySelector('#remote [data-act="' + direction + '"]');
    if (button) { event.preventDefault(); button.click(); }
  }, { passive: false });
})();
