'use strict';

// Bidirektionale Synchronisierung des Mindest-Ladezustands (min_soc) über ein
// optionales, eigenes Remote-Topic — Vorbild: das Remote-Topic der
// Messen-+-Schalten-Geräte (dort neben dem Schalt-Topic). Analog gilt hier:
//   - min_soc_topic  = Ziel-/Steuer-Topic (wir schreiben den Wert dorthin, damit
//                      z. B. der Wechselrichter folgt; zusätzlich Live-Override
//                      für die abgeleiteten Batteriezustände).
//   - remote_topic   = zusätzliches, bidirektional synchronisiertes Topic für
//                      denselben Mindest-SoC-Wert.
//
// Verknüpft ist das Remote-Topic mit der **Mindest-SoC-Einstellung** (nicht mit
// dem Live-SoC): ändert sich die Einstellung, wird der Wert an das Remote-Topic
// gespiegelt (routes/batterie.js beim Speichern); ändert ein externes System den
// Wert auf dem Remote-Topic, wird er als neue Mindest-SoC-Einstellung übernommen
// ("mitgezogen"), persistiert und zusätzlich an das Steuer-Topic weitergegeben.
//
// Kein Echo-Aufschaukeln: eigene Publishes (mqttClient.publish) tragen `ack:false`
// und landen nie im Cache (mqtt/client.js, MQTT.md); nur echte externe Werte bzw.
// bestätigte Broker-Rückmeldungen füllen `batterie.minSocRemote`.

const mqttClient = require('../mqtt/client');
const { loadBatterieConfig, saveBatterieConfig, STATE_IDS } = require('./config');

function load(db) {
  return new Promise((resolve) => loadBatterieConfig(db, resolve));
}

function save(db, cfg) {
  return new Promise((resolve, reject) => {
    saveBatterieConfig(db, cfg, (err, saved) => (err ? reject(err) : resolve(saved)));
  });
}

// Jede Änderung der Mindest-SoC-Einstellung mit Quelle ins Journal, damit sich
// ein unerwartetes Zurückdrehen (z. B. durch einen externen Remote-Wert) belegen lässt.
function logMinSocChange(source, from, to, details = {}) {
  console.log('[batterie minSoc]', JSON.stringify({ ts: new Date().toISOString(), source, from, to, ...details }));
}

// Das 5-%-Raster gilt für die beiden Bedienwege: den Schieberegler und einen
// extern gesetzten Remote-Wert. Die dynamische Mindest-SoC-Automatik arbeitet
// dagegen in 1-%-Schritten und umgeht das Raster bewusst.
function roundToStep(value) {
  return Math.round(Math.min(100, Math.max(0, value)) / 5) * 5;
}

function roundToPercent(value) {
  return Math.round(Math.min(100, Math.max(0, value)));
}

// Zeitstempel der zuletzt verarbeiteten Remote-Nachricht. Verhindert, dass
// derselbe externe Wert mehrfach übernommen wird und – zusammen mit
// noteLocalChange – dass ein noch nicht durch einen frischen Broker-Wert
// abgelöster Cache-Eintrag eine gerade gespeicherte Einstellung überschreibt.
let lastAppliedReceivedAt = 0;

// Eine explizite lokale Änderung (Speichern der Einstellungen) hat Vorrang vor
// jedem bis dahin bekannten Remote-Wert. Ohne diese Markierung würde ein noch im
// Cache liegender älterer Remote-Wert beim direkt folgenden Sync-Lauf als
// „externe Änderung" gewertet und die gerade gespeicherte Einstellung wieder
// zurückdrehen. Erst ein danach eintreffender, echt neuerer Remote-Wert zählt.
let lastLocalChangeAt = 0;

function noteLocalChange() {
  lastAppliedReceivedAt = Date.now();
  lastLocalChangeAt = lastAppliedReceivedAt;
}

async function runSync(db) {
  const cfg = await load(db);
  if (!cfg.remoteTopic) return;
  const remote = mqttClient.getCache().get(STATE_IDS.minSocRemote);
  if (!remote || remote.value == null || remote.value === '') return;
  if (remote.receivedAt <= lastAppliedReceivedAt) return;
  lastAppliedReceivedAt = remote.receivedAt;
  const parsed = Number(String(remote.value).replace(',', '.'));
  if (!Number.isFinite(parsed)) return;
  // Spiegelt das Remote-Topic exakt die aktuelle Einstellung zurück, ist das
  // keine externe Änderung. Ohne diese Ausnahme würde ein von der Automatik
  // gesetzter 1-%-Wert (z. B. 43) beim Echo auf 45 gerastet.
  if (roundToPercent(parsed) === cfg.minSoc) return;
  const rounded = roundToStep(parsed);
  if (rounded !== cfg.minSoc) {
    logMinSocChange('remote-topic', cfg.minSoc, rounded, {
      topic: cfg.remoteTopic,
      remoteValue: remote.value,
      remoteReceivedAt: new Date(remote.receivedAt).toISOString(),
      localChangeAt: lastLocalChangeAt ? new Date(lastLocalChangeAt).toISOString() : null,
    });
    await save(db, { ...cfg, minSoc: rounded });
    // Das Steuer-Topic (und damit z. B. der Wechselrichter) folgt der Übernahme.
    if (cfg.minSocTopic) mqttClient.publish(cfg.minSocTopic, rounded);
  }
  // Externen Rohwert auf den 5-%-Raster-Wert korrigieren (z. B. 33 -> 35). Der
  // receivedAt-Schutz greift danach, ein eigenes Echo läuft als No-Op aus.
  if (String(remote.value) !== String(rounded)) {
    mqttClient.publish(cfg.remoteTopic, rounded);
  }
}

// Eine lokal gespeicherte Einstellung (Formular oder Regler) an Steuer- und
// Remote-Topic weitergeben. noteLocalChange sorgt dafür, dass ein noch im Cache
// liegender älterer Remote-Wert die gerade gespeicherte Einstellung nicht sofort
// wieder zurückdreht.
function publishLocalMinSoc(previous, config, source) {
  if (previous && previous.minSoc !== config.minSoc) {
    logMinSocChange(source, previous.minSoc, config.minSoc);
  }
  if (config.minSocTopic) mqttClient.publish(config.minSocTopic, config.minSoc);
  if (config.remoteTopic) {
    noteLocalChange();
    mqttClient.publish(config.remoteTopic, config.minSoc);
  }
}

// Nur den Mindest-SoC ändern (Schieberegler oder Automatik), alle übrigen
// Einstellungen bleiben. `source` landet im Journal, damit sich eine Änderung
// später der Bedienung bzw. der dynamischen Automatik zuordnen lässt.
// `snapToStep` rastet auf das 5-%-Raster des Schiebereglers; die dynamische
// Automatik schaltet es ab und setzt in 1-%-Schritten.
async function setLocalMinSoc(db, value, { source = 'oberflaeche', snapToStep = true } = {}) {
  const parsed = Number(String(value == null ? '' : value).replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    const error = new Error('Ungültiger Mindest-Ladezustand.');
    error.validation = true;
    throw error;
  }
  const previous = await load(db);
  const minSoc = snapToStep ? roundToStep(parsed) : roundToPercent(parsed);
  const saved = await save(db, { ...previous, minSoc });
  publishLocalMinSoc(previous, saved, source);
  return saved;
}

let _tickChain = Promise.resolve();
function runNow(db) {
  const run = _tickChain.then(() => runSync(db));
  _tickChain = run.catch(() => {});
  return run;
}

let _debounce = null;
function scheduleRun(db) {
  if (_debounce) return;
  _debounce = setTimeout(() => {
    _debounce = null;
    runNow(db).catch(() => {});
  }, 1000);
}

function isRelevantEvent(event) {
  const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
  return keys.includes(STATE_IDS.minSocRemote);
}

let _unsubscribe = null;
function init(db) {
  if (!_unsubscribe) {
    _unsubscribe = mqttClient.onValuesChanged((event) => {
      if (isRelevantEvent(event)) scheduleRun(db);
    });
  }
  runNow(db).catch(() => {});
}

function resetForTests() {
  lastAppliedReceivedAt = 0;
  lastLocalChangeAt = 0;
}

module.exports = {
  init, runNow, runSync, noteLocalChange, logMinSocChange, publishLocalMinSoc, setLocalMinSoc,
  isRelevantEvent, resetForTests,
};
