'use strict';

const { renderLayout } = require('./layout');

// Seite „Fernzugriff“ (/remote-access). Deckt die Pairing-Stufe mit dauerhafter
// Identität ab: Pairing-Session anfordern, QR-Code anzeigen, Kopplungsanfrage
// mit Gerätefingerprint bestätigen/ablehnen, dauerhaftes Provisioning und den
// Status der authentifizierten Origin-WebSocket-/Tunnel-Verbindung.

function renderRemoteAccess() {
  const body = `        <h1>Fernzugriff</h1>

        <section class="settings-card remote-access-intro">
          <div class="settings-card-head">
            <h2>Smartphone koppeln</h2>
            <p class="settings-card-hint">
              Kopple die homeESS-App dauerhaft mit dieser homeESS-Instanz. Der
              erzeugte QR-Code ist nur wenige Minuten gültig; er
              gewährt allein noch keinen Zugriff. Nachdem die App den Code
              gescannt hat, prüfst du hier den Gerätefingerprint und bestätigst
              die Anfrage. homeESS richtet daraufhin eine dauerhafte Identität
              ein und verbindet sich über den Relay-Tunnel mit der App.
            </p>
          </div>

          <div id="ra-panel" class="remote-access-panel" aria-busy="true">
            <p class="remote-access-loading">Status wird geladen&nbsp;…</p>
          </div>

          <p id="ra-status" class="remote-access-live" role="status" aria-live="polite"></p>
        </section>

        <section class="settings-card remote-access-devices">
          <div class="settings-card-head">
            <h2>Gekoppelte Geräte</h2>
            <p class="settings-card-hint">
              Übersicht der dauerhaft gekoppelten Geräte und ihres aktuellen
              Verbindungsstatus über den Relay-Tunnel. Die Internet-Nutzung
              erfordert die homeESS Remote Lizenz in der App.
            </p>
          </div>

          <dl class="remote-access-devices-summary" id="ra-devices-summary">
            <div><dt>Relay-Verbindung</dt><dd id="ra-devices-relay">wird geladen&nbsp;…</dd></div>
            <div><dt>Gekoppelte Geräte</dt><dd id="ra-devices-count">–</dd></div>
            <div><dt>Aktive Geräte</dt><dd id="ra-devices-active">–</dd></div>
          </dl>

          <div id="ra-devices-list" class="remote-access-devices-list" role="list" aria-live="polite">
            <p class="remote-access-loading">Geräte werden geladen&nbsp;…</p>
          </div>
        </section>`;

  const script = `${clientScript()}\n${devicesScript()}`;
  return renderLayout({ title: 'Fernzugriff', activePath: '/remote-access', body, script });
}

// Der clientseitige Controller. Läuft vollständig gegen die lokalen
// /api/remote-access-Endpunkte — niemals direkt gegen den Relay. Alle
// dynamischen Texte werden über textContent gesetzt (kein innerHTML → kein XSS).
function clientScript() {
  return `    (function () {
      var panel = document.getElementById('ra-panel');
      var live = document.getElementById('ra-status');
      if (!panel) return;

      var POLL_MIN = 2, POLL_MAX = 30;
      var CONN_POLL_MS = 4000;
      var state = {
        status: 'unknown', expiresAt: null, pollIntervalSeconds: 3, qr: null,
        claim: null, provisioningError: null, device: null, instance: null,
        pairedAt: null, connection: null, errorTitle: null, errorMessage: null
      };
      var pollTimer = null, countdownTimer = null, connTimer = null;
      var inFlightPoll = false, busy = false, unmounted = false;

      function csrfHeaders(extra) {
        var h = { 'X-HomeESS-Request': '1' };
        if (extra) for (var k in extra) h[k] = extra[k];
        return h;
      }
      function announce(msg) { if (live) live.textContent = msg; }
      function clearTimers() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      }
      function fmtDuration(totalSeconds) {
        var s = Math.max(0, Math.floor(totalSeconds));
        var m = Math.floor(s / 60), r = s % 60;
        return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
      }
      function remainingSeconds() {
        if (!state.expiresAt) return 0;
        var ms = Date.parse(state.expiresAt) - Date.now();
        return ms > 0 ? ms / 1000 : 0;
      }

      // ---- Rendering ------------------------------------------------------
      function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      }
      function button(label, cls, onClick, disabled) {
        var b = el('button', cls, label);
        b.type = 'button';
        if (disabled) b.disabled = true;
        b.addEventListener('click', onClick);
        return b;
      }
      function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

      function render() {
        clearNode(panel);
        panel.setAttribute('aria-busy', busy ? 'true' : 'false');
        switch (state.status) {
          case 'pending': return renderPending();
          case 'awaiting_confirmation': return renderAwaitingConfirmation();
          case 'creating': return renderCreating();
          case 'confirming': return renderSettingUp('Bestätigung wird gesendet …');
          case 'confirmed':
          case 'provisioning': return renderSettingUp('Kopplung wird dauerhaft eingerichtet …');
          case 'paired': return renderPaired();
          case 'rejected': return renderTerminal('Kopplungsanfrage abgelehnt', 'Die Kopplungsanfrage wurde abgelehnt.', 'Neuen Code erzeugen');
          case 'expired': return renderTerminal('Code abgelaufen', 'Der Pairing-Code ist abgelaufen.');
          case 'cancelled': return renderTerminal('Kopplung abgebrochen', 'Die Kopplung wurde abgebrochen.');
          case 'error': return renderError();
          default: return renderNone();
        }
      }

      function renderNone() {
        panel.appendChild(el('p', 'remote-access-text',
          'Es ist keine Kopplung vorbereitet. Erzeuge einen QR-Code, um die homeESS-App dauerhaft zu koppeln. Der Code ist nur kurz gültig.'));
        var row = el('div', 'button-row');
        row.appendChild(button('Smartphone koppeln', '', startPairing));
        panel.appendChild(row);
      }
      function renderCreating() {
        panel.appendChild(el('p', 'remote-access-text', 'Pairing-Code wird erstellt …'));
        var row = el('div', 'button-row');
        row.appendChild(button('Smartphone koppeln', '', function () {}, true));
        panel.appendChild(row);
      }
      function renderPending() {
        var status = el('p', 'remote-access-state remote-access-state--pending');
        status.appendChild(el('span', 'remote-access-dot', ''));
        status.appendChild(el('span', null, 'Warte auf Smartphone'));
        panel.appendChild(status);
        if (state.qr) {
          var figure = el('figure', 'remote-access-qr');
          var img = document.createElement('img');
          img.src = 'data:image/png;base64,' + state.qr;
          img.alt = 'QR-Code zum Koppeln der homeESS-App';
          img.className = 'remote-access-qr-img';
          figure.appendChild(img);
          panel.appendChild(figure);
        }
        var cd = el('p', 'remote-access-countdown'); cd.id = 'ra-countdown';
        panel.appendChild(cd);
        panel.appendChild(el('p', 'remote-access-hint',
          'Teile diesen QR-Code mit niemandem. Er enthält ein kurzlebiges Geheimnis und ist nur wenige Minuten gültig.'));
        var row = el('div', 'button-row');
        row.appendChild(button('Abbrechen', 'button-secondary', cancelPairing, busy));
        panel.appendChild(row);
        updateCountdown();
      }
      function renderAwaitingConfirmation() {
        panel.appendChild(el('h2', 'remote-access-subtitle', 'Kopplungsanfrage'));
        var status = el('p', 'remote-access-state remote-access-state--pending');
        status.appendChild(el('span', 'remote-access-dot', ''));
        status.appendChild(el('span', null, 'Smartphone wartet auf Bestätigung'));
        panel.appendChild(status);
        var claim = state.claim || {};
        var list = el('dl', 'remote-access-claim');
        addRow(list, 'Gerät', claim.deviceName || 'Unbekanntes Smartphone');
        addRow(list, 'Plattform', formatPlatform(claim.platform));
        addRow(list, 'App-Version', claim.appVersion || 'Unbekannt');
        addRow(list, 'Angefragt', formatClaimTime(claim.claimedAt));
        addRow(list, 'Schlüsselfingerprint', claim.deviceFingerprint || 'Unbekannt');
        panel.appendChild(list);
        panel.appendChild(el('p', 'remote-access-hint',
          'Prüfe den Schlüsselfingerprint gegen die Anzeige in der App, bevor du bestätigst. Der Fingerprint ist kein Geheimnis.'));
        var cd = el('p', 'remote-access-countdown'); cd.id = 'ra-countdown';
        panel.appendChild(cd);
        var row = el('div', 'button-row');
        row.appendChild(button('Smartphone bestätigen', '', confirmPairing, busy));
        row.appendChild(button('Ablehnen', 'button-danger', rejectPairing, busy));
        row.appendChild(button('Abbrechen', 'button-secondary', cancelPairing, busy));
        panel.appendChild(row);
        updateCountdown();
      }
      function renderSettingUp(text) {
        var status = el('p', 'remote-access-state remote-access-state--pending');
        status.appendChild(el('span', 'remote-access-dot', ''));
        status.appendChild(el('span', null, text));
        panel.appendChild(status);
        panel.appendChild(el('p', 'remote-access-text',
          'Die dauerhafte Identität wird eingerichtet. Bitte einen Moment Geduld – dies geschieht automatisch.'));
        if (state.provisioningError) {
          panel.appendChild(el('p', 'error-text', provisioningErrorText(state.provisioningError)));
          var row = el('div', 'button-row');
          row.appendChild(button('Erneut einrichten', '', provisionRetry, busy));
          row.appendChild(button('Abbrechen', 'button-secondary', cancelPairing, busy));
          panel.appendChild(row);
        }
      }
      function renderPaired() {
        panel.appendChild(el('p', 'remote-access-state remote-access-state--done', 'Smartphone dauerhaft gekoppelt'));
        var d = state.device || {}, inst = state.instance || {};
        var list = el('dl', 'remote-access-claim');
        addRow(list, 'Gerät', d.name || 'Smartphone');
        addRow(list, 'Plattform', formatPlatform(d.platform));
        if (d.deviceIdShort) addRow(list, 'Geräte-ID', d.deviceIdShort);
        if (d.fingerprint) addRow(list, 'Geräte-Fingerprint', shortFp(d.fingerprint));
        if (inst.fingerprint) addRow(list, 'Instanz-Fingerprint', shortFp(inst.fingerprint));
        addRow(list, 'Gekoppelt am', formatDateTime(state.pairedAt));
        addRow(list, 'Verbindung', connectionLabel(state.connection));
        panel.appendChild(list);
        panel.appendChild(el('p', 'remote-access-hint',
          'Die Identität wurde eingerichtet. Der Fernzugriff läuft verschlüsselt über den Relay-Tunnel; VPN, Portfreigabe und DynDNS sind nicht erforderlich. Die gekoppelten Geräte findest du unten in der Übersicht.'));
        var row = el('div', 'button-row');
        // Weitere Kopplung ergänzt die Liste und ersetzt kein vorhandenes Gerät.
        row.appendChild(button('Weiteres Gerät koppeln', '', startPairing, busy));
        row.appendChild(button('Verbindung neu aufbauen', 'button-secondary', reconnectConnection, busy));
        panel.appendChild(row);
      }
      function renderTerminal(title, text, buttonText) {
        panel.appendChild(el('p', 'remote-access-state remote-access-state--done', title));
        panel.appendChild(el('p', 'remote-access-text', text));
        var row = el('div', 'button-row');
        row.appendChild(button(buttonText || 'Neuen Code erzeugen', '', startPairing, busy));
        panel.appendChild(row);
      }
      function renderError() {
        panel.appendChild(el('p', 'remote-access-state remote-access-state--error', state.errorTitle || 'Fehler'));
        panel.appendChild(el('p', 'error-text', state.errorMessage || 'Es ist ein Fehler aufgetreten.'));
        var row = el('div', 'button-row');
        row.appendChild(button('Erneut versuchen', '', startPairing, busy));
        panel.appendChild(row);
      }

      function addRow(list, label, value) {
        list.appendChild(el('dt', null, label));
        list.appendChild(el('dd', null, value));
      }
      function formatPlatform(p) { return p === 'android' ? 'Android' : (p || 'Unbekannt'); }
      function shortFp(fp) {
        if (!fp) return 'Unbekannt';
        var parts = String(fp).split('-');
        return parts.length > 4 ? parts.slice(0, 4).join('-') + '-…' : fp;
      }
      function formatClaimTime(v) {
        if (!v) return 'Unbekannt';
        var ms = Date.parse(v);
        if (!isFinite(ms)) return 'Unbekannt';
        return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
      }
      function formatDateTime(v) {
        if (!v) return 'Unbekannt';
        var ms = Date.parse(v);
        if (!isFinite(ms)) return 'Unbekannt';
        return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
      function connectionLabel(conn) {
        if (!conn) return 'Nicht verbunden';
        switch (conn.state) {
          case 'connecting':
          case 'reconnecting':
          case 'waiting_for_challenge':
          case 'authenticating': return 'Verbindung wird aufgebaut';
          case 'authenticated': return 'Am Relay authentifiziert';
          case 'disconnected': return 'Verbindung getrennt';
          case 'failed':
            return conn.lastError === 'remote_access_authentication_failed'
              ? 'Authentifizierung fehlgeschlagen' : 'Verbindung getrennt';
          case 'stopped':
          case 'disabled':
          case 'idle':
          default: return 'Nicht verbunden';
        }
      }

      function updateCountdown() {
        var node = document.getElementById('ra-countdown');
        if (!node) return;
        var secs = remainingSeconds();
        node.textContent = 'Gültig für ' + fmtDuration(secs);
        if (secs <= 0) { node.textContent = 'Gültig für 00:00'; if (!inFlightPoll) pollOnce(); }
      }

      // ---- Fehlerabbildung -----------------------------------------------
      var ERROR_TEXT = {
        remote_access_relay_unavailable: { title: 'Relay nicht erreichbar', msg: 'Der Relay-Server ist derzeit nicht erreichbar. Prüfe die Netzwerkverbindung und versuche es erneut.' },
        remote_access_rate_limited: { title: 'Zu viele Anfragen', msg: 'Es wurden zu viele Pairing-Codes angefordert. Bitte warte kurz und versuche es erneut.' },
        remote_access_capacity_reached: { title: 'Keine Kapazität', msg: 'Derzeit sind zu viele Kopplungen gleichzeitig aktiv. Bitte versuche es später erneut.' },
        remote_access_invalid_response: { title: 'Unerwartete Antwort', msg: 'Die Antwort des Relay-Servers war ungültig. Bitte versuche es erneut.' },
        remote_access_session_conflict: { title: 'Status geändert', msg: 'Der Kopplungsstatus hat sich zwischenzeitlich geändert.' },
        remote_access_session_expired: { title: 'Code abgelaufen', msg: 'Der Pairing-Code ist abgelaufen.' },
        remote_access_identity_proof_failed: { title: 'Identitätsnachweis fehlgeschlagen', msg: 'homeESS konnte seinen Instanz-Nachweis nicht erbringen. Bitte versuche es erneut.' },
        remote_access_provisioning_failed: { title: 'Einrichtung fehlgeschlagen', msg: 'Die dauerhafte Kopplung konnte nicht abgeschlossen werden. Bitte erneut versuchen.' },
        remote_access_provisioning_expired: { title: 'Code abgelaufen', msg: 'Der Pairing-Code ist vor Abschluss der Einrichtung abgelaufen.' },
        remote_access_identity_mismatch: { title: 'Identität passt nicht', msg: 'Die vom Relay gemeldete Identität passt nicht zum lokalen Schlüssel. Die Kopplung wurde aus Sicherheitsgründen nicht übernommen.' },
        remote_access_internal_error: { title: 'Unerwarteter Fehler', msg: 'Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es erneut.' }
      };
      function provisioningErrorText(code) {
        var e = ERROR_TEXT[code] || ERROR_TEXT.remote_access_provisioning_failed;
        return e.msg;
      }
      function toError(code) {
        var e = ERROR_TEXT[code] || ERROR_TEXT.remote_access_internal_error;
        state.status = 'error'; state.errorTitle = e.title; state.errorMessage = e.msg; state.qr = null;
        announce(e.title + ': ' + e.msg);
        clearTimers(); stopConnPolling(); render();
      }

      // ---- Zustandsübernahme ---------------------------------------------
      function applyView(view) {
        var prev = state.status;
        state.status = view.status;
        state.expiresAt = view.expiresAt || null;
        state.claim = view.claim || null;
        state.provisioningError = view.provisioningError || null;
        if (view.pollIntervalSeconds) state.pollIntervalSeconds = Math.min(POLL_MAX, Math.max(POLL_MIN, view.pollIntervalSeconds));
        if (view.qrCode && view.qrCode.base64) state.qr = view.qrCode.base64;
        if (view.status !== 'pending') state.qr = null;
        if (view.status === 'paired') {
          state.device = view.device || null;
          state.instance = view.instance || null;
          state.pairedAt = view.pairedAt || null;
        }
        render();

        if (isPollingStatus(view.status)) {
          startCountdown(); schedulePoll(); stopConnPolling();
          if (view.status === 'pending' && prev !== 'pending') announce('Warte auf Smartphone. QR-Code ist bereit.');
          if (view.status === 'awaiting_confirmation' && prev !== 'awaiting_confirmation') announce('Smartphone wartet auf Bestätigung.');
          if ((view.status === 'confirmed' || view.status === 'provisioning') && prev !== view.status) announce('Kopplung wird dauerhaft eingerichtet.');
        } else {
          clearTimers();
          if (view.status === 'paired') { announce('Smartphone dauerhaft gekoppelt.'); startConnPolling(); }
          else {
            stopConnPolling();
            if (view.status === 'expired') announce('Der Pairing-Code ist abgelaufen.');
            else if (view.status === 'cancelled') announce('Die Kopplung wurde abgebrochen.');
            else if (view.status === 'rejected') announce('Kopplungsanfrage abgelehnt.');
          }
        }
      }
      // pending/awaiting/confirmed/provisioning werden weiter gepollt, bis paired.
      function isPollingStatus(status) {
        return status === 'pending' || status === 'awaiting_confirmation'
          || status === 'confirmed' || status === 'provisioning';
      }
      function startCountdown() { if (!countdownTimer) countdownTimer = setInterval(updateCountdown, 1000); }

      // ---- Pairing-Polling ------------------------------------------------
      function schedulePoll() {
        if (pollTimer || unmounted) return;
        if (!isPollingStatus(state.status) || busy) return;
        pollTimer = setTimeout(function () { pollTimer = null; pollOnce(); }, state.pollIntervalSeconds * 1000);
      }
      function pollOnce() {
        if (inFlightPoll || unmounted) return;
        if (!isPollingStatus(state.status) || busy) return;
        inFlightPoll = true;
        fetch('/api/remote-access/pairing', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function (view) { inFlightPoll = false; if (!unmounted) applyView(view); })
          .catch(function (err) {
            inFlightPoll = false;
            if (unmounted) return;
            if (isPollingStatus(state.status)) { pollTimer = setTimeout(function () { pollTimer = null; pollOnce(); }, 5000); }
            else toError(err && err.error);
          });
      }

      // ---- Verbindungsstatus-Polling (nach paired) ------------------------
      function startConnPolling() { if (connTimer || unmounted) return; pollConnection(); connTimer = setInterval(pollConnection, CONN_POLL_MS); }
      function stopConnPolling() { if (connTimer) { clearInterval(connTimer); connTimer = null; } }
      function pollConnection() {
        if (unmounted) return;
        fetch('/api/remote-access/connection', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (conn) { if (conn && !unmounted && state.status === 'paired') { state.connection = conn; render(); } })
          .catch(function () {});
      }
      function reconnectConnection() {
        fetch('/api/remote-access/connection/connect', { method: 'POST', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (conn) { if (conn && !unmounted) { state.connection = conn; render(); } })
          .catch(function () {});
      }

      // ---- Aktionen -------------------------------------------------------
      function startPairing() {
        if (busy) return;
        busy = true; clearTimers(); stopConnPolling();
        state.status = 'creating'; state.qr = null; state.claim = null; state.provisioningError = null;
        announce('Pairing-Code wird erstellt.'); render();
        fetch('/api/remote-access/pairing', { method: 'POST', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function (view) { busy = false; applyView(view); })
          .catch(function (err) { busy = false; toError(err && err.error); });
      }
      function cancelPairing() {
        if (busy) return;
        busy = true; clearTimers(); stopConnPolling();
        announce('Kopplung wird abgebrochen.'); render();
        fetch('/api/remote-access/pairing', { method: 'DELETE', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function () { busy = false; applyView({ status: 'cancelled' }); })
          .catch(function () { busy = false; applyView({ status: 'cancelled' }); });
      }
      // Bestätigen: liefert eine View (confirmed/provisioning/paired) zurück.
      function confirmPairing() {
        if (busy) return;
        busy = true; clearTimers();
        state.status = 'confirming'; announce('Bestätigung wird gesendet …'); render();
        fetch('/api/remote-access/pairing/confirm', { method: 'POST', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function (view) { busy = false; applyView(view); })
          .catch(function (err) {
            busy = false;
            if (err && (err.error === 'remote_access_session_conflict' || err.error === 'remote_access_session_expired')) {
              announce('Der Kopplungsstatus hat sich zwischenzeitlich geändert.'); pollStatusNow(err.error);
            } else { toError(err && err.error); }
          });
      }
      function provisionRetry() {
        if (busy) return;
        busy = true; announce('Einrichtung wird erneut versucht …'); render();
        fetch('/api/remote-access/pairing/provision', { method: 'POST', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function (view) { busy = false; applyView(view); })
          .catch(function (err) {
            busy = false;
            if (err && err.error === 'remote_access_identity_mismatch') { toError(err.error); }
            else { state.provisioningError = (err && err.error) || 'remote_access_provisioning_failed'; render(); schedulePoll(); }
          });
      }
      function rejectPairing() {
        if (busy) return;
        busy = true; clearTimers();
        state.status = 'confirming'; announce('Ablehnung wird gesendet …'); render();
        fetch('/api/remote-access/pairing/reject', { method: 'POST', headers: csrfHeaders({ Accept: 'application/json' }), credentials: 'same-origin' })
          .then(function (r) { if (r.ok) return null; return r.json().then(function (b) { throw b; }); })
          .then(function () { busy = false; pollStatusNow(); })
          .catch(function (err) {
            busy = false;
            if (err && (err.error === 'remote_access_session_conflict' || err.error === 'remote_access_session_expired')) {
              announce('Der Kopplungsstatus hat sich zwischenzeitlich geändert.'); pollStatusNow(err.error);
            } else { toError(err && err.error); }
          });
      }
      function pollStatusNow(fallbackError) {
        fetch('/api/remote-access/pairing', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function (view) { applyView(view); })
          .catch(function () { if (fallbackError) toError(fallbackError); else toError('remote_access_internal_error'); });
      }

      // ---- Lifecycle ------------------------------------------------------
      function stopEverything() { unmounted = true; clearTimers(); stopConnPolling(); }
      window.addEventListener('beforeunload', stopEverything);
      window.addEventListener('pagehide', stopEverything);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { clearTimers(); stopConnPolling(); }
        else if (!unmounted) {
          if (isPollingStatus(state.status)) { startCountdown(); schedulePoll(); }
          else if (state.status === 'paired') { startConnPolling(); }
        }
      });

      // Initialzustand laden.
      fetch('/api/remote-access/pairing', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { status: 'none' }; })
        .then(function (view) { applyView(view); })
        .catch(function () { state.status = 'none'; render(); });
    })();`;
}

// Eigenständiger Controller für die Sektion „Gekoppelte Geräte". Fragt die lokale
// Geräteübersicht ab (nie direkt gegen den Relay) und rendert ausschließlich über
// textContent — Gerätenamen und alle dynamischen Werte werden dadurch escaped
// (kein innerHTML → kein XSS). Es werden keine Tokens/Secrets erwartet oder
// angezeigt; der Server liefert bereits gekürzte IDs/Fingerprints.
function devicesScript() {
  return `    (function () {
      var summaryRelay = document.getElementById('ra-devices-relay');
      var summaryCount = document.getElementById('ra-devices-count');
      var summaryActive = document.getElementById('ra-devices-active');
      var listNode = document.getElementById('ra-devices-list');
      if (!listNode) return;

      var POLL_MS = 5000;
      var timer = null, inFlight = false, unmounted = false;
      // Laufende Entfernungen und Fehlermeldungen je deviceId (nur clientseitig).
      var removing = {}, removeErrors = {};
      var lastView = { relay: { connected: false }, counts: { paired: 0, active: 0 }, devices: [] };

      function csrfHeaders(extra) {
        var h = { 'X-HomeESS-Request': '1' };
        if (extra) for (var k in extra) h[k] = extra[k];
        return h;
      }
      var REMOVE_ERROR_TEXT = {
        remote_access_not_connected: 'Keine Relay-Verbindung. Das Gerät wurde nicht entfernt – bitte bei bestehender Verbindung erneut versuchen.',
        remote_access_link_removal_timeout: 'Zeitüberschreitung. Das Gerät wurde nicht sicher entfernt – bitte erneut versuchen.',
        remote_access_link_removal_failed: 'Die Entfernung ist fehlgeschlagen. Das Gerät bleibt vorerst erhalten.',
        remote_access_invalid_device_id: 'Ungültiges Gerät.',
        remote_access_relay_unavailable: 'Der Relay-Server ist nicht erreichbar. Bitte später erneut versuchen.'
      };
      function removeErrorText(code) { return REMOVE_ERROR_TEXT[code] || 'Die Entfernung ist fehlgeschlagen. Bitte erneut versuchen.'; }

      function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      }
      function button(label, cls, onClick, disabled) {
        var b = el('button', cls, label);
        b.type = 'button';
        if (disabled) b.disabled = true;
        b.addEventListener('click', onClick);
        return b;
      }
      function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

      var CONNECTION_LABEL = {
        active: 'Aktiv verbunden',
        offline: 'Gekoppelt, derzeit offline',
        unknown: 'Status unbekannt'
      };
      function formatPlatform(p) { return p === 'android' ? 'Android' : (p || 'Unbekannt'); }
      function formatDateTime(v) {
        if (!v) return 'Unbekannt';
        var ms = Date.parse(v);
        if (!isFinite(ms)) return 'Unbekannt';
        return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      }

      function renderSummary(view) {
        if (summaryRelay) summaryRelay.textContent = view.relay && view.relay.connected ? 'verbunden' : 'getrennt';
        if (summaryCount) summaryCount.textContent = String(view.counts ? view.counts.paired : 0);
        if (summaryActive) summaryActive.textContent = String(view.counts ? view.counts.active : 0);
      }

      function deviceCard(d) {
        var card = el('div', 'remote-access-device');
        card.setAttribute('role', 'listitem');
        var conn = CONNECTION_LABEL[d.connection] || CONNECTION_LABEL.unknown;
        var head = el('div', 'remote-access-device-head');
        head.appendChild(el('span', 'remote-access-device-name', d.deviceName || 'Gerät'));
        head.appendChild(el('span', 'remote-access-device-badge remote-access-device-badge--' + (d.connection || 'unknown'), conn));
        card.appendChild(head);

        var list = el('dl', 'remote-access-claim');
        addRow(list, 'Plattform', formatPlatform(d.platform));
        if (d.deviceIdShort) addRow(list, 'Geräte-ID', d.deviceIdShort);
        if (d.fingerprintShort) addRow(list, 'Fingerprint', d.fingerprintShort);
        addRow(list, 'Gekoppelt seit', formatDateTime(d.pairedAt));
        addRow(list, 'Zuletzt verbunden', d.lastKnownConnectedAt ? formatDateTime(d.lastKnownConnectedAt) : 'Noch nie');
        addRow(list, 'Verbindungsstatus', conn);
        card.appendChild(list);

        var isRemoving = !!removing[d.deviceId];
        if (isRemoving) {
          var pending = el('p', 'remote-access-state remote-access-state--pending');
          pending.appendChild(el('span', 'remote-access-dot', ''));
          pending.appendChild(el('span', null, 'Wird entfernt …'));
          card.appendChild(pending);
        }
        if (removeErrors[d.deviceId]) {
          card.appendChild(el('p', 'error-text', removeErrors[d.deviceId]));
        }

        var actions = el('div', 'button-row');
        // Entfernung ist nur über die authentifizierte Relay-Verbindung möglich.
        var canRemove = lastView.relay && lastView.relay.connected;
        actions.appendChild(button('Gerät entfernen', 'button-danger', function () { removeDevice(d); }, isRemoving || !canRemove));
        card.appendChild(actions);
        if (!canRemove && !isRemoving) {
          card.appendChild(el('p', 'remote-access-hint', 'Entfernen ist nur bei bestehender Relay-Verbindung möglich.'));
        }
        return card;
      }
      function addRow(list, label, value) {
        list.appendChild(el('dt', null, label));
        list.appendChild(el('dd', null, value));
      }

      // Entfernung anstoßen: NICHT sofort lokal löschen. Erst nach bestätigtem
      // Relay-Zustand (link_removed) bzw. dem darauf folgenden linked_devices-
      // Snapshot verschwindet das Gerät aus der Liste. Bei Fehler/Timeout bleibt es
      // erhalten und es wird ein Fehler angezeigt.
      function removeDevice(d) {
        if (!d || !d.deviceId || removing[d.deviceId]) return;
        var name = d.deviceName || 'dieses Gerät';
        if (!window.confirm('Gerät „' + name + '" wirklich entfernen? Die Kopplung wird über den Relay dauerhaft aufgehoben.')) return;
        removing[d.deviceId] = true;
        delete removeErrors[d.deviceId];
        render(lastView);
        fetch('/api/remote-access/devices/remove', {
          method: 'POST',
          headers: csrfHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
          credentials: 'same-origin',
          body: JSON.stringify({ deviceId: d.deviceId })
        })
          .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw b; }); })
          .then(function () {
            // Erfolg (link_removed bestätigt). Gerät bleibt „Wird entfernt …", bis
            // der autoritative linked_devices-Snapshot es aus der Liste nimmt.
            if (!unmounted) load();
          })
          .catch(function (err) {
            if (unmounted) return;
            delete removing[d.deviceId];
            removeErrors[d.deviceId] = removeErrorText(err && err.error);
            render(lastView);
          });
      }

      function render(view) {
        lastView = view || lastView;
        var devices = (view && view.devices) || [];
        // Zustand für nicht mehr vorhandene Geräte aufräumen (erfolgreich entfernt).
        var present = {};
        for (var k = 0; k < devices.length; k++) present[devices[k].deviceId] = true;
        for (var id in removing) { if (!present[id]) delete removing[id]; }
        for (var id2 in removeErrors) { if (!present[id2]) delete removeErrors[id2]; }

        renderSummary(view || lastView);
        clearNode(listNode);
        if (!devices.length) {
          listNode.appendChild(el('p', 'remote-access-text', 'Es ist noch kein Gerät gekoppelt. Kopple oben ein Smartphone, um es hier zu sehen.'));
          return;
        }
        for (var i = 0; i < devices.length; i++) listNode.appendChild(deviceCard(devices[i]));
      }
      function renderError() {
        clearNode(listNode);
        if (summaryRelay) summaryRelay.textContent = 'unbekannt';
        listNode.appendChild(el('p', 'error-text', 'Die Geräteübersicht konnte nicht geladen werden.'));
      }

      function schedule() {
        if (timer || unmounted) return;
        timer = setTimeout(function () { timer = null; load(); }, POLL_MS);
      }
      function load() {
        if (inFlight || unmounted) return;
        inFlight = true;
        fetch('/api/remote-access/devices', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (view) { inFlight = false; if (!unmounted) { if (view) render(view); else renderError(); schedule(); } })
          .catch(function () { inFlight = false; if (!unmounted) { renderError(); schedule(); } });
      }

      window.addEventListener('beforeunload', function () { unmounted = true; if (timer) clearTimeout(timer); });
      window.addEventListener('pagehide', function () { unmounted = true; if (timer) clearTimeout(timer); });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { if (timer) { clearTimeout(timer); timer = null; } }
        else if (!unmounted) { load(); }
      });

      load();
    })();`;
}

module.exports = renderRemoteAccess;
