'use strict';

(function () {
  const button = document.getElementById('page-share-button');
  if (!button) return;
  const dialog = document.getElementById('page-share-dialog');
  const mode = document.getElementById('page-share-mode');
  const url = document.getElementById('page-share-url');
  const darkUrl = document.getElementById('page-share-url-dark');
  const link = document.getElementById('page-share-link');
  const message = document.getElementById('page-share-message');
  const save = document.getElementById('page-share-save');
  const labels = Array.from(mode.options).reduce((all, option) => ({ ...all, [option.value]: option.textContent }), {});
  const path = button.dataset.sharePath;
  let current = null;
  function apply(data) {
    current = data;
    mode.value = data.mode;
    button.dataset.shareMode = data.mode;
    button.title = labels[data.mode];
    button.setAttribute('aria-label', dialog.querySelector('h2').textContent + ': ' + labels[data.mode]);
    link.hidden = !data.url;
    url.value = data.urls ? new URL(data.urls.hell, window.location.origin).href : '';
    darkUrl.value = data.urls ? new URL(data.urls.dunkel, window.location.origin).href : '';
  }
  async function load() {
    const response = await fetch('/page-sharing?path=' + encodeURIComponent(path), { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    apply(data);
  }
  button.addEventListener('click', async () => {
    message.textContent = '';
    save.disabled = true;
    dialog.showModal();
    try { await load(); save.disabled = false; } catch (error) { message.textContent = error.message; }
  });
  document.getElementById('page-share-close').addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    mode.disabled = true;
    message.textContent = '';
    try {
      const response = await fetch('/page-sharing', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-HomeESS-Request': 'page-sharing' },
        body: JSON.stringify({ path, mode: mode.value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      apply(data);
      dialog.close();
    } catch (error) {
      message.textContent = error.message;
      if (current) mode.value = current.mode;
    } finally { save.disabled = false; mode.disabled = false; }
  });
  function attachCopy(buttonId, field) {
    document.getElementById(buttonId).addEventListener('click', async () => {
      field.focus();
      field.select();
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(field.value);
        else if (!document.execCommand('copy')) throw new Error();
      } catch (_) {
        // Die URL bleibt für manuelles Kopieren ausgewählt (auch ohne HTTPS).
        field.focus(); field.select();
      }
    });
  }
  attachCopy('page-share-copy', url);
  attachCopy('page-share-copy-dark', darkUrl);
  load().catch(() => {});
})();
