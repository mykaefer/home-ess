'use strict';

// Ergänzung für Seiten ohne eigenen Live-Daten-Abruf. Wie im Dashboard werden
// Ereignis-Bursts in einem Ein-Sekunden-Fenster zusammengefasst. Vollständige
// servergerenderte Seiten prüfen wir höchstens einmal pro Minute.
(function () {
  const versionNode = document.querySelector('meta[name="homeess-page-version"]');
  const main = document.querySelector('.main-content');
  if (!versionNode || !main) return;
  const version = versionNode.content;
  const intervalMs = 60000;
  const delayMs = 1000;
  const forms = new WeakMap();
  let lastStarted = Date.now();
  let queued = null;
  let controller = null;
  let busy = false;
  let stopped = false;

  function formValues(form) {
    return JSON.stringify(Array.from(form.querySelectorAll('input, select, textarea'))
      .filter(field => field.type !== 'hidden')
      .map(field => [field.name, field.type, field.value,
        field.type === 'checkbox' || field.type === 'radio' ? field.checked : null,
        field.multiple && field.selectedOptions ? Array.from(field.selectedOptions).map(option => option.value) : null,
        field.files ? Array.from(field.files).map(file => [file.name, file.size, file.lastModified]) : null]));
  }
  main.querySelectorAll('form').forEach(form => forms.set(form, formValues(form)));

  function editing() {
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return true;
    try { if (document.querySelector(':popover-open')) return true; } catch (_) { /* Ältere Browser ohne Popover-API. */ }
    const active = document.activeElement;
    if (active && main.contains(active) && active.matches('input, select, textarea, [contenteditable="true"]')) return true;
    if (document.querySelector('[aria-grabbed="true"], .is-dragging, .group-dragging, .dragging')) return true;
    return Array.from(main.querySelectorAll('form')).some(form => {
      if (form.closest('dialog:not([open])')) return false;
      // Nachträglich geöffnete/aufgebaute Formulare werden konservativ bewahrt.
      return !forms.has(form) || forms.get(form) !== formValues(form);
    });
  }

  async function refresh() {
    queued = null;
    if (stopped || busy || document.hidden || editing()) return;
    busy = true;
    lastStarted = Date.now();
    controller = new AbortController();
    const requestController = controller;
    const timeout = window.setTimeout(() => requestController.abort(), 8000);
    try {
      // Dieselbe URL erhält Seitenumfang und Theme eines Freigabelinks. Der
      // Abruf verwendet die bestehende GET-Route, ohne eine Schreibaktion.
      const response = await window.fetch(window.location.href, {
        headers: { Accept: 'text/html' }, cache: 'no-store', signal: requestController.signal,
      });
      if ([401, 403, 404].includes(response.status)) { stop(); return; }
      if (!response.ok || response.redirected) return;
      const html = await response.text();
      const page = new DOMParser().parseFromString(html, 'text/html');
      const nextVersion = page.querySelector('meta[name="homeess-page-version"]');
      // Eingaben und Dialoge können auch während des Abrufs begonnen werden.
      if (!stopped && !requestController.signal.aborted && !document.hidden && !editing() && nextVersion && nextVersion.content !== version) {
        window.location.reload();
      }
    } catch (_) {
      // Bei einer Unterbrechung bleibt die Seite auf dem letzten Stand.
    } finally {
      window.clearTimeout(timeout);
      controller = null;
      busy = false;
    }
  }

  function queueRefresh() {
    if (stopped || busy || queued !== null || document.hidden) return;
    const wait = Math.max(delayMs, intervalMs - (Date.now() - lastStarted));
    queued = window.setTimeout(refresh, wait);
  }
  function visible() { if (!document.hidden) queueRefresh(); }
  let timer = window.setInterval(queueRefresh, intervalMs);
  window.addEventListener('homeess:mqtt', queueRefresh);
  document.addEventListener('visibilitychange', visible);
  function stop() {
    stopped = true;
    window.clearInterval(timer);
    if (queued !== null) window.clearTimeout(queued);
    queued = null;
    if (controller) controller.abort();
    window.removeEventListener('homeess:mqtt', queueRefresh);
    document.removeEventListener('visibilitychange', visible);
  }
  window.addEventListener('pagehide', stop);
  // Rückkehr aus dem Browser-Cache: Prüfung wieder starten, ohne Eingaben
  // oder Dialoge durch ein unbedingtes Neuladen zu verlieren.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    stopped = false;
    timer = window.setInterval(queueRefresh, intervalMs);
    window.addEventListener('homeess:mqtt', queueRefresh);
    document.addEventListener('visibilitychange', visible);
    queueRefresh();
  });
})();
