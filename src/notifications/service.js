'use strict';

// Zentraler Nachrichtendienst von homeESS.
//
// Jede homeESS-Funktion, die eine Push-Benachrichtigung auslösen will, ruft
// ausschließlich `push()` auf. Nur dieses Modul kennt den Weg zum Gerät; der
// Aufrufer sieht weder Relay, noch WebSocket, noch FCM oder Push-Token.
//
// Der Versand läuft über die EINE bestehende, Ed25519-authentifizierte
// homeESS→Relay-Verbindung (`remote-access/connection-service`). Die Instanz
// ergibt sich allein aus dieser Authentifizierung, die Empfänger bestimmt allein
// der Relay aus seinen aktiven Kopplungen: gesendet werden nur Titel, Text,
// Ereignistyp und Priorität — nie instanceId, deviceId, Empfängerlisten,
// Push-Token oder Firebase-Daten.
//
// Es gibt bewusst KEINE persistente Offline-Warteschlange: ist der Relay nicht
// verbunden, scheitert der Push strukturiert und die auslösende homeESS-Funktion
// läuft unverändert weiter.

const connectionService = require('../remote-access/connection-service');
const { log } = require('./log');

const SEVERITIES = new Set(['normal', 'critical']);
const EVENT_TYPE_PATTERN = /^[a-z0-9_-]+$/;
const MAX_TITLE = 120;
const MAX_BODY = 500;
const MAX_EVENT_TYPE = 64;

function validation(message) {
  const error = new Error(message);
  error.validation = true;
  return error;
}

function cleanText(value, label, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw validation(`${label} fehlt.`);
  if (text.length > max) throw validation(`${label} ist zu lang.`);
  return text;
}

// Normalisiert und prüft eine Nachricht. Titel, Text, Ereignistyp und Priorität
// werden IMMER serverseitig validiert — unabhängig davon, ob die Nachricht aus
// einer Regel, aus der Testfunktion oder aus einer anderen homeESS-Funktion
// stammt.
function normalize(input = {}) {
  const title = cleanText(input.title, 'Titel', MAX_TITLE);
  const body = cleanText(input.body, 'Nachricht', MAX_BODY);
  const type = cleanText(input.type != null ? input.type : input.eventType, 'Ereignistyp', MAX_EVENT_TYPE);
  if (!EVENT_TYPE_PATTERN.test(type)) {
    throw validation('Ereignistyp darf nur Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich enthalten.');
  }
  const severity = String(input.severity == null || input.severity === '' ? 'normal' : input.severity).trim();
  if (!SEVERITIES.has(severity)) throw validation('Priorität muss normal oder kritisch sein.');
  return { title, body, type, severity };
}

function failed(reason) {
  return { accepted: false, recipients: 0, reason };
}

// Grund für einen nicht möglichen Versand aus dem Verbindungszustand ableiten.
// `null` bedeutet: die Verbindung steht, es darf gesendet werden.
function unavailableReason(status) {
  const state = status && status.state;
  if (!state || state === 'idle' || state === 'disabled' || state === 'stopped' || state === 'failed') {
    return 'relay_unavailable';
  }
  return state === 'authenticated' ? null : 'not_authenticated';
}

function reasonForError(error) {
  const code = error && error.code;
  if (code === 'remote_access_push_timeout') return 'timeout';
  if (code === 'remote_access_not_connected') return 'not_authenticated';
  return 'send_failed';
}

// Eine Push-Benachrichtigung senden. Löst immer auf (nie ab), sofern die Eingabe
// gültig ist: der Rückgabewert sagt strukturiert, ob und an wie viele Geräte
// zugestellt wurde. Ungültige Eingaben werfen einen Validierungsfehler — sie
// sind ein Programmier- bzw. Konfigurationsfehler und kein Zustellproblem.
async function push(input, options = {}) {
  const message = normalize(input);
  const connection = options.connectionService || connectionService;

  const blocked = unavailableReason(connection.getStatus());
  if (blocked) {
    log('notification_push_failed', { eventType: message.type, severity: message.severity, reason: blocked });
    return failed(blocked);
  }

  try {
    const result = await connection.pushNotification({
      title: message.title,
      body: message.body,
      eventType: message.type,
      severity: message.severity,
    });
    const recipients = Number.isInteger(result && result.recipients) && result.recipients >= 0 ? result.recipients : 0;
    log('notification_push_accepted', { eventType: message.type, severity: message.severity, recipients });
    return { accepted: true, recipients };
  } catch (error) {
    const reason = reasonForError(error);
    log('notification_push_failed', { eventType: message.type, severity: message.severity, reason });
    return failed(reason);
  }
}

module.exports = {
  push,
  normalize,
  SEVERITIES,
  EVENT_TYPE_PATTERN,
  MAX_TITLE,
  MAX_BODY,
  MAX_EVENT_TYPE,
};
