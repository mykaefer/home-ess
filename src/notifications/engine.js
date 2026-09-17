'use strict';

// NotificationRuleEngine — verbindet State-Änderungen mit dem Nachrichtendienst.
//
// Die Engine hängt sich an genau die bestehende zentrale State-Infrastruktur, aus
// der auch Output-Engine, Bedingungen und Dashboard lesen: sie abonniert die
// States ihrer Regeln über `mqttClient.subscribeAdHoc()` und reagiert auf das
// `values`-Ereignis des State-Bus. Es gibt keine Polling-Schleife.
//
// Ablauf je Wertänderung:
//   alter Wert + neuer Wert → passende aktive Regeln → Triggerbedingung →
//   Cooldown → NotificationService.push()
//
// Zwei Zusagen sind dabei bindend:
//   1. Die Engine blockiert den normalen State-Update-Pfad nicht. Die Auswertung
//      ist ein reiner Vergleich; der Versand läuft asynchron daneben.
//   2. Ein Push-Fehler bricht die State-Verarbeitung niemals ab. Jeder Schritt
//      ist gekapselt, der Nachrichtendienst wirft beim Versand ohnehin nicht.
//
// Den alten Wert führt die Engine selbst mit: der State-Bus überschreibt seinen
// Cache, bevor er das Ereignis auslöst, und kennt daher nur den neuen Wert. Genau
// dieser mitgeführte Vorwert ist die Grundlage der Flankenerkennung.

const bus = require('../state-bus');
const mqttClient = require('../mqtt/client');
const repository = require('./rules');
const service = require('./service');
const { matches } = require('./triggers');
const { log } = require('./log');

let database = null;
let rules = [];
let unsubscribeBus = null;
let reloading = false;
// cacheKey -> Regel (genau eine Regel je Schlüssel, damit mehrere Regeln auf
// demselben State völlig unabhängig voneinander arbeiten).
let ruleByCacheKey = new Map();
// Registrierte Abos: cacheKey -> State-Adresse.
let subscriptions = new Map();
// Mitgeführter Vorwert je Abo: cacheKey -> { stateId, known, value }.
const baselines = new Map();

// Eigener Namensraum im gemeinsamen Wert-Cache, je Regel getrennt.
function cacheKey(ruleId) {
  return `notification:${ruleId}`;
}

function currentValue(key) {
  const entry = bus.getCache().get(key);
  return entry ? { known: true, value: entry.value } : { known: false, value: null };
}

// Eine Regel hat ausgelöst: Cooldown prüfen, ggf. senden. Läuft bewusst
// synchron bis zum Absenden — `last_triggered_at` wird sofort gesetzt, damit ein
// flatternder Sensor auch dann entprellt bleibt, wenn die Relay-Antwort noch aussteht.
function fire(rule, now) {
  const cooldownMs = Math.max(0, Number(rule.cooldownSeconds) || 0) * 1000;
  if (cooldownMs > 0 && rule.lastTriggeredAt != null && now - rule.lastTriggeredAt < cooldownMs) {
    // Innerhalb des Cooldowns: kein Push, und `last_triggered_at` bleibt
    // unangetastet — der Cooldown verlängert sich dadurch nicht.
    log('notification_rule_suppressed', {
      ruleId: rule.id, eventType: rule.eventType, severity: rule.severity, reason: 'cooldown',
    });
    return;
  }

  rule.lastTriggeredAt = now;
  log('notification_rule_triggered', {
    ruleId: rule.id, eventType: rule.eventType, severity: rule.severity, triggerType: rule.triggerType,
  });
  if (database) repository.markTriggered(database, rule.id, now).catch(() => {});

  // Ab hier läuft alles neben der State-Verarbeitung: der Nachrichtendienst
  // liefert ein strukturiertes Ergebnis und wirft beim Versand nicht; das
  // .catch() sichert den Rest (etwa eine ungültig gewordene Regel) ab.
  service.push({ title: rule.title, body: rule.body, type: rule.eventType, severity: rule.severity })
    .then((result) => {
      if (result.accepted) return;
      log('notification_push_failed', {
        ruleId: rule.id, eventType: rule.eventType, severity: rule.severity, reason: result.reason,
      });
    })
    .catch((error) => {
      log('notification_push_failed', {
        ruleId: rule.id,
        eventType: rule.eventType,
        severity: rule.severity,
        reason: String((error && error.message) || 'send_failed').slice(0, 200),
      });
    });
}

// Eine einzelne geänderte Cache-Adresse bewerten. Gibt zurück, ob ausgelöst wurde
// (für Tests); Fehler werden hier gefangen, damit ein defekter Einzelfall nie den
// State-Update-Pfad des Bus abbricht.
function evaluateKey(key, now = Date.now()) {
  const rule = ruleByCacheKey.get(key);
  if (!rule) return false;
  const next = currentValue(key);
  if (!next.known) return false;
  const previous = baselines.get(key) || { stateId: rule.stateId, known: false, value: null };
  // Der neue Wert ist ab sofort der Vorwert — auch wenn der Trigger nicht
  // zutrifft oder der Cooldown den Push unterdrückt. Sonst würde die
  // Flankenerkennung nach einer Unterdrückung auf einem veralteten Wert stehen.
  baselines.set(key, { stateId: rule.stateId, known: true, value: next.value });
  try {
    if (!matches(rule.triggerType, rule.triggerValue, previous, next.value)) return false;
    fire(rule, now);
    return true;
  } catch (error) {
    log('notification_push_failed', {
      ruleId: rule.id,
      eventType: rule.eventType,
      reason: String((error && error.message) || 'rule_error').slice(0, 200),
    });
    return false;
  }
}

function onValues(event) {
  if (reloading || !event || !Array.isArray(event.changedKeys)) return;
  const now = Date.now();
  for (const key of event.changedKeys) {
    const text = String(key);
    if (!ruleByCacheKey.has(text)) continue;
    evaluateKey(text, now);
  }
}

// Abos und Regelindex neu aufbauen. Wird nach jeder Änderung an den Regeln
// aufgerufen. Bestehende Vorwerte bleiben erhalten, solange Regel und State
// dieselben sind — sonst würde jedes Speichern eine echte Flanke verschlucken.
async function reload() {
  if (!database) return [];
  reloading = true;
  try {
    const active = await repository.listActiveRules(database);
    const nextIndex = new Map();
    const nextSubscriptions = new Map();
    for (const rule of active) {
      if (!rule.stateId) continue;
      const key = cacheKey(rule.id);
      nextIndex.set(key, rule);
      nextSubscriptions.set(key, rule.stateId);
    }

    for (const [key, stateId] of subscriptions) {
      if (nextSubscriptions.get(key) === stateId) continue;
      mqttClient.unsubscribeAdHoc(key);
      baselines.delete(key);
    }
    for (const [key, stateId] of nextSubscriptions) {
      if (subscriptions.get(key) === stateId) continue;
      mqttClient.subscribeAdHoc(stateId, key);
      // Ein sofort bekannter Wert (Retained/System-Route) ist nur die
      // Ausgangsbasis und darf nicht als Flanke gelten.
      const known = currentValue(key);
      baselines.set(key, { stateId, known: known.known, value: known.value });
    }

    rules = active;
    ruleByCacheKey = nextIndex;
    subscriptions = nextSubscriptions;
    return rules;
  } finally {
    reloading = false;
  }
}

async function init(db) {
  database = db;
  if (!unsubscribeBus) unsubscribeBus = bus.onValuesChanged(onValues);
  await reload();
}

function stop() {
  if (unsubscribeBus) unsubscribeBus();
  unsubscribeBus = null;
  for (const key of subscriptions.keys()) mqttClient.unsubscribeAdHoc(key);
  subscriptions = new Map();
  ruleByCacheKey = new Map();
  baselines.clear();
  rules = [];
  database = null;
}

function getRuntime() {
  return rules;
}

module.exports = { init, reload, stop, onValues, evaluateKey, getRuntime, cacheKey };
