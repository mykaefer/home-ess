'use strict';

(function () {
  const config = document.currentScript.dataset;
  const base = config.shareBase;
  const isRead = config.shareMode === 'read';
  const theme = config.shareTheme === 'dunkel' ? 'dunkel' : 'hell';
  function map(value) {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return url.href;
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) url.pathname = base + url.pathname;
    url.searchParams.set('theme', theme);
    return url.href;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (input instanceof Request) return originalFetch(new Request(map(input.url), input), init);
    return originalFetch(map(String(input)), init);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return originalOpen.call(this, method, map(url), ...rest); };
  function prepare() {
    document.querySelectorAll('form').forEach(form => {
      const action = map(form.action);
      if (form.action !== action) form.action = action;
      if (form.method.toLowerCase() === 'get' && !form.querySelector('input[name="theme"]')) {
        const field = document.createElement('input');
        field.type = 'hidden'; field.name = 'theme'; field.value = theme;
        form.appendChild(field);
      }
      if (isRead && form.method.toLowerCase() !== 'get') {
        form.querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = true; });
      }
    });
    document.querySelectorAll('a[href]').forEach(link => {
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin) {
        const href = map(link.href);
        if (link.href !== href) link.href = href;
      }
    });
    if (isRead) document.querySelectorAll('[draggable="true"]').forEach(node => { node.draggable = false; });
  }
  document.addEventListener('submit', event => {
    if (isRead && event.target.method.toLowerCase() !== 'get') { event.preventDefault(); event.stopImmediatePropagation(); }
    else event.target.action = map(event.target.action);
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    prepare();
    new MutationObserver(prepare).observe(document.querySelector('.main-content'), { childList: true, subtree: true });
  });
  // Ohne Titelleiste genügt ein leeres Aktualisierungssignal. Systemweite
  // MQTT-Namen/-Werte werden keinem Freigabelink zugänglich gemacht.
  const timer = window.setInterval(() => {
    window.dispatchEvent(new CustomEvent('homeess:mqtt', { detail: {} }));
  }, 5000);
  window.addEventListener('beforeunload', () => window.clearInterval(timer));
})();
