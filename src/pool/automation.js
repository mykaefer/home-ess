'use strict';

const mqttClient = require('../mqtt/client');
const { buildEnvironmentSnapshot } = require('../mqtt/config');
const { loadPoolConfig, readPoolValue } = require('./config');
const { assessHeaderSkyState } = require('../photovoltaik/aggregation');
const { listPvPlants } = require('../photovoltaik/plants');
const { isEnabled } = require('../modules');
const levelHandler = require('../operating-level/handler');
const { loadGridControlConfig } = require('../grid-control/config');
const gridControlAutomation = require('../grid-control/automation');
const loadShed = require('../grid-control/load-shed');
const {
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
} = require('../stromverbrauch/config');

const HOLD_MS = 2 * 60 * 1000; // 2 Minuten Mindesthaltedauer nach Schaltung

// Verbraucher-IDs beim zentralen Betriebslevel-Handler.
const POOL_CONSUMER = { solar: 'pool.solar', filter: 'pool.filter' };

// In-Memory-Zustand (nach Neustart zurückgesetzt – für Poolpumpe akzeptabel)
const solar = {
  output: null,   // 'on' | 'off' | null
  changedAt: 0,
  loadShedOff: false,
  tempMode: false,
  tempSampling: false,
  tempSamplingStart: 0,
  tempCycleStart: 0,
};

const filter = {
  output: null,
  changedAt: 0,
  loadShedOff: false,
};

function load(loader, db) {
  return new Promise((resolve) => loader(db, resolve));
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseOn(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// Tatsächlicher Ist-Zustand einer Pumpe aus ihrem Status-Topic: true/false, oder
// null, wenn kein Status vorliegt. Grundlage für den Abgleich „Ziel vs. Realität",
// damit eine verlorene/übersehene Schaltung nachgesendet wird (analog M+S).
function actualPumpOn(cache, statusTopic) {
  if (!statusTopic) return null;
  const raw = readPoolValue(cache, statusTopic);
  if (raw == null || raw === '') return null;
  return parseOn(raw);
}
// Gerät bereits im Zielzustand? Bevorzugt der echte Status; ohne Status der interne Glaube.
function pumpInTarget(actual, believedOutput, target) {
  return actual != null ? (actual === (target === 'on')) : (believedOutput === target);
}

function timeToMinutes(t) {
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Exakt dieselbe MQTT-Zeitquelle wie die Uhr in der Titelzeile verwenden.
function currentMinutes(cache) {
  const environment = buildEnvironmentSnapshot(cache);
  if (environment.time.hours != null && environment.time.minutes != null) {
    return environment.time.hours * 60 + environment.time.minutes;
  }
  return null;
}

function inWindow(start, end, now) {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s == null || e == null || now == null) return false;
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

function send(topic, on) {
  if (!topic) return;
  mqttClient.publish(topic, on ? '1' : '0');
}

function commandTopic(which, cfg) {
  return which === 'filter' ? cfg.filterPumpCommandTopic : cfg.solarPumpCommandTopic;
}

function phaseFor(which, cfg) {
  return which === 'filter' ? cfg.filterPumpPhase : cfg.solarPumpPhase;
}

// Einschalten im Automatikpfad nur nach Freigabe durch das Betriebslevel.
// priority = effektive Priorität der zugrunde liegenden Aufgabe (Solar-/Filterdienst).
// Liefert den tatsächlich geschalteten Zustand (false, wenn das Level das Einschalten sperrt).
function gatedSend(topic, on, priority) {
  if (on && !levelHandler.isAllowed(priority)) return false;
  send(topic, !!on);
  return !!on;
}

// Sofort-Abschaltung auf Anforderung des Betriebslevel-Handlers (Level gesunken).
function forceOff(which, cfg) {
  const topic = commandTopic(which, cfg);
  if (!topic) return;
  send(topic, false);
  if (which === 'filter') {
    filter.output = 'off';
    filter.loadShedOff = false;
  } else {
    solar.output = 'off';
    solar.changedAt = Date.now();
    solar.loadShedOff = false;
  }
}

function isShed(which, priority, cfg) {
  return loadShed.shouldShed(phaseFor(which, cfg), priority);
}

// Registrierung beim Betriebslevel-Handler pflegen: nur im Automatik-Modus mit gesetztem Topic.
// Hand-Modus übersteuert das Level bewusst und bleibt daher unregistriert.
function syncRegistration(which, cfg) {
  const id = POOL_CONSUMER[which];
  if (commandTopic(which, cfg) && getPumpMode(which) === 'auto') {
    levelHandler.register(id, getEffectivePriority(which, cfg), {
      onMustTurnOff: () => forceOff(which, cfg),
    });
  } else {
    levelHandler.unregister(id);
  }
}

async function tick(db) {
  if (!isEnabled('pool')) {
    levelHandler.unregister(POOL_CONSUMER.solar);
    levelHandler.unregister(POOL_CONSUMER.filter);
    loadShed.unregisterProvider('pool');
    return;
  }

  const cfg = await new Promise((resolve) => loadPoolConfig(db, resolve));
  const cache = mqttClient.getCache();
  const now = Date.now();
  const localMinutes = currentMinutes(cache);
  const gridControlEnabled = isEnabled('grid-control');
  const gridCfg = gridControlEnabled ? await load(loadGridControlConfig, db) : null;
  const gridState = gridControlEnabled ? gridControlAutomation.getState() : null;
  const loadShedActive = !!(gridControlEnabled && gridCfg && gridCfg.loadEnabled && gridState);
  if (!loadShedActive) {
    solar.loadShedOff = false;
    filter.loadShedOff = false;
  }
  // Lastabwurf zählt für Steuerentscheidungen nur, SOLANGE er aktiv ist. Sonst
  // würde ein veralteter Cutoff aus einer früheren Grid-Control-Phase die Pumpe
  // dauerhaft aussperren (loadShed.stages werden bei Inaktivität nicht geleert).
  // Konsistent zu messen-schalten/automation.js (dort: loadShedActive ? … : false).
  const shedNow = (which, priority) => loadShedActive && isShed(which, priority, cfg);

  loadShed.registerProvider('pool', [
    cfg.solarPumpCommandTopic && (solar.output === 'on' || solar.loadShedOff)
      ? { id: POOL_CONSUMER.solar, phase: cfg.solarPumpPhase, priority: cfg.solarPumpPriority } : null,
    cfg.filterPumpCommandTopic && (filter.output === 'on' || filter.loadShedOff)
      ? { id: POOL_CONSUMER.filter, phase: cfg.filterPumpPhase, priority: getEffectivePriority('filter', cfg) } : null,
  ].filter(Boolean));
  if (loadShedActive) loadShed.update(gridState.inverterLoads, gridCfg, now);

  // ── Solarpumpe ──────────────────────────────────────────────────────────────
  if (cfg.solarPumpCommandTopic && pumpModes.solar !== 'auto') {
    // Hand-Modus übersteuert das Betriebslevel bewusst (LEVEL_HANDLING.md Punkt 3):
    // „an"/„aus" schalten unabhängig vom Level – das Gate wird ignoriert (die Pumpe
    // ist im Hand-Modus ohnehin nicht beim Level-Handler registriert). Der Lastabwurf
    // (Netzschutz) bleibt als eigenständiger Schutz erhalten.
    const desired = pumpModes.solar;
    const shed = shedNow('solar', cfg.solarPumpPriority);
    const shouldOn = desired === 'on' && !shed;
    const target = shouldOn ? 'on' : 'off';
    const actual = actualPumpOn(cache, cfg.solarPumpStatusTopic);
    const inTarget = pumpInTarget(actual, solar.output, target);
    const holdOk = solar.changedAt === 0 || now - solar.changedAt >= HOLD_MS;
    if (!inTarget && holdOk) {
      solar.loadShedOff = desired === 'on' && shed;
      send(cfg.solarPumpCommandTopic, shouldOn);
      solar.output = target;
      solar.changedAt = now;
    } else if (inTarget) {
      solar.output = target; // internen Glauben mit der Realität synchronisieren
    }
  } else if (cfg.solarPumpCommandTopic) {
    const waterTemp = parseNum(readPoolValue(cache, cfg.temperatureTopic));
    const maxTemp = cfg.solarPumpMaxTemp !== '' ? parseNum(String(cfg.solarPumpMaxTemp)) : null;
    const overTemp = maxTemp != null && waterTemp != null && waterTemp >= maxTemp;
    const tempOnMs = (cfg.solarPumpTempOnSeconds || 30) * 1000;
    const tempPauseMs = (cfg.solarPumpTempPauseMinutes || 30) * 60 * 1000;
    const filterAvailable = !!(cfg.filterPumpStatusTopic && cfg.filterPumpCommandTopic);
    const useFilterForSampling = !!(cfg.solarPumpTempUseFilter && filterAvailable);
    const tempCommandTopic = useFilterForSampling
      ? cfg.filterPumpCommandTopic
      : cfg.solarPumpCommandTopic;

    let sky = 'moon';
    try {
      const plants = await listPvPlants(db);
      sky = await assessHeaderSkyState(db, cache, plants);
    } catch (_) {}
    const hasSun = sky === 'sun';

    if (overTemp) {
      if (!solar.tempMode) {
        solar.tempMode = true;
        solar.tempSampling = false;
        solar.tempCycleStart = 0;
        // Filterpumpe übernimmt Probeläufe → Solarpumpe sofort ausschalten
        if (useFilterForSampling && solar.output === 'on') {
          send(cfg.solarPumpCommandTopic, false);
          solar.output = 'off';
          solar.changedAt = now;
        }
      }

      if (solar.tempSampling) {
        // Laufende Probe immer zu Ende führen – auch bei Beschattung.
        if (now - solar.tempSamplingStart >= tempOnMs) {
          send(tempCommandTopic, false);
          if (useFilterForSampling) {
            filter.output = 'off';
          } else {
            solar.output = 'off';
            solar.changedAt = now;
          }
          solar.tempSampling = false;
          solar.tempCycleStart = now;
        }
      } else if (hasSun) {
        // Neue Probe nur bei Sonneneinstrahlung starten
        if (solar.tempCycleStart === 0 || now - solar.tempCycleStart >= tempPauseMs) {
          // Bei bereits laufender Filterpumpe wird das Wasser ohnehin umgewälzt;
          // ein zusätzlicher Probelauf ist dann nicht erforderlich.
          const filterAlreadyRunning = useFilterForSampling &&
            parseOn(readPoolValue(cache, cfg.filterPumpStatusTopic));
          if (filterAlreadyRunning) {
            solar.tempCycleStart = now;
          } else if (gatedSend(tempCommandTopic, true, cfg.solarPumpPriority)) {
            // Probelauf zählt als Solardienst und wird über die Solar-Priorität freigegeben.
            if (useFilterForSampling) {
              filter.output = 'on';
            } else {
              solar.output = 'on';
              solar.changedAt = now;
            }
            solar.tempSampling = true;
            solar.tempSamplingStart = now;
          }
        }
      }
      // Bei Beschattung und !tempSampling: nichts tun – Pausenzähler läuft weiter
    } else {
      if (solar.tempMode) {
        solar.tempMode = false;
        // War die Filterpumpe für Probeläufe zuständig und noch eingeschaltet → abschalten
        if (useFilterForSampling && solar.tempSampling) {
          send(cfg.filterPumpCommandTopic, false);
          filter.output = 'off';
        }
        solar.tempSampling = false;
      }

      // Sonnenbasierte Steuerung
      const desired = hasSun ? 'on' : 'off';
      let requestOn = desired === 'on';
      if (requestOn && (shedNow('solar', cfg.solarPumpPriority)
        || !levelHandler.isAllowed(cfg.solarPumpPriority))) requestOn = false;
      const target = requestOn ? 'on' : 'off';
      // Am echten Status ausrichten: nachsenden, wenn das Gerät nicht im Ziel ist
      // (nicht nur bei abweichendem internen Glauben) – so wird eine verlorene
      // Schaltung korrigiert, gedrosselt über HOLD_MS.
      const actual = actualPumpOn(cache, cfg.solarPumpStatusTopic);
      const inTarget = pumpInTarget(actual, solar.output, target);
      const holdOk = solar.changedAt === 0 || now - solar.changedAt >= HOLD_MS;
      if (!inTarget && holdOk) {
        solar.loadShedOff = desired === 'on' && shedNow('solar', cfg.solarPumpPriority);
        const on = gatedSend(cfg.solarPumpCommandTopic, requestOn, cfg.solarPumpPriority);
        solar.output = on ? 'on' : 'off';
        solar.changedAt = now;
      } else if (inTarget) {
        solar.output = target; // internen Glauben mit der Realität synchronisieren
      }
    }
  }

  // Prioritätsflag aktualisieren: true während Filterpumpe aktiven Solarprobelauf ausführt
  _filterActsAsSolar = !!(
    cfg.solarPumpTempUseFilter &&
    cfg.filterPumpStatusTopic && cfg.filterPumpCommandTopic &&
    solar.tempMode && solar.tempSampling
  );

  // ── Filterpumpe ─────────────────────────────────────────────────────────────
  if (cfg.filterPumpCommandTopic && pumpModes.filter !== 'auto') {
    // Hand-Modus übersteuert das Betriebslevel bewusst (wie bei der Solarpumpe oben);
    // nur der Lastabwurf (Netzschutz) bleibt wirksam.
    const desired = pumpModes.filter;
    const effectivePriority = getEffectivePriority('filter', cfg);
    const shed = shedNow('filter', effectivePriority);
    const shouldOn = desired === 'on' && !shed;
    const target = shouldOn ? 'on' : 'off';
    const actual = actualPumpOn(cache, cfg.filterPumpStatusTopic);
    const inTarget = pumpInTarget(actual, filter.output, target);
    const holdOk = filter.changedAt === 0 || now - filter.changedAt >= HOLD_MS;
    if (!inTarget && holdOk) {
      filter.loadShedOff = desired === 'on' && shed;
      send(cfg.filterPumpCommandTopic, shouldOn);
      filter.output = target;
      filter.changedAt = now;
    } else if (inTarget) {
      filter.output = target; // internen Glauben mit der Realität synchronisieren
    }
  } else if (cfg.filterPumpCommandTopic && !_filterActsAsSolar) {
    let desired = 'off';

    if (cfg.filterPumpFollowSolar) {
      desired = solar.output || 'off';
    } else {
      const windows = [
        [cfg.filterTime1Start, cfg.filterTime1End],
        [cfg.filterTime2Start, cfg.filterTime2End],
        [cfg.filterTime3Start, cfg.filterTime3End],
      ];
      for (const [s, e] of windows) {
        if (inWindow(s, e, localMinutes)) { desired = 'on'; break; }
      }
    }

    // Akku-Override: SoC aus zentralem Batterie-Cache (batterie.soc)
    if (cfg.filterBatteryEnabled) {
      const socEntry = cache.get('batterie.soc');
      const soc = parseNum(socEntry ? socEntry.value : null);
      if (soc != null && soc >= (cfg.filterBatterySoc || 80)) desired = 'on';
    }

    const effectivePriority = getEffectivePriority('filter', cfg);
    let requestOn = desired === 'on';
    if (requestOn && (shedNow('filter', effectivePriority)
      || !levelHandler.isAllowed(effectivePriority))) requestOn = false;
    const target = requestOn ? 'on' : 'off';
    const actual = actualPumpOn(cache, cfg.filterPumpStatusTopic);
    const inTarget = pumpInTarget(actual, filter.output, target);
    const holdOk = filter.changedAt === 0 || now - filter.changedAt >= HOLD_MS;
    if (!inTarget && holdOk) {
      filter.loadShedOff = desired === 'on' && shedNow('filter', effectivePriority);
      const on = gatedSend(cfg.filterPumpCommandTopic, requestOn, effectivePriority);
      filter.output = on ? 'on' : 'off';
      filter.changedAt = now;
    } else if (inTarget) {
      filter.output = target; // internen Glauben mit der Realität synchronisieren
    }
  }

  if (loadShedActive && cfg.solarPumpCommandTopic && solar.output === 'on' && isShed('solar', cfg.solarPumpPriority, cfg)) {
    send(cfg.solarPumpCommandTopic, false);
    solar.output = 'off';
    solar.loadShedOff = true;
    solar.changedAt = now;
  }
  if (loadShedActive && cfg.filterPumpCommandTopic) {
    const effectivePriority = getEffectivePriority('filter', cfg);
    if (filter.output === 'on' && isShed('filter', effectivePriority, cfg)) {
      send(cfg.filterPumpCommandTopic, false);
      filter.output = 'off';
      filter.loadShedOff = true;
    }
  }

  // Registrierung beim Betriebslevel-Handler auf den aktuellen Stand bringen
  // (Topics gesetzt, Modus, effektive Priorität inkl. Solarprobelauf der Filterpumpe).
  syncRegistration('solar', cfg);
  syncRegistration('filter', cfg);
}

// Manueller Modus pro Pumpe: 'auto' | 'on' | 'off'
const pumpModes = { solar: 'auto', filter: 'auto' };

// Wird true während die Filterpumpe einen Solarprobelauf übernimmt.
// Signalisiert dem Last-Management: Filterpumpe hat in diesem Moment Solarpumpen-Priorität.
let _filterActsAsSolar = false;

function setPumpMode(which, mode) {
  if (which !== 'solar' && which !== 'filter') return;
  const previous = pumpModes[which];
  pumpModes[which] = mode;

  // Nach einem manuellen Solarmodus muss die Temperaturautomatik ihren Zustand
  // neu bewerten. Sonst kann ein alter tempMode die Abschaltung beim Wechsel
  // zurück auf Automatik überspringen.
  if (which === 'solar' && previous !== mode) {
    solar.tempMode = false;
    solar.tempSampling = false;
    solar.tempSamplingStart = 0;
    solar.tempCycleStart = 0;
    _filterActsAsSolar = false;
    // Moduswechsel = ausdrückliche Bedienhandlung → Haltesperre aufheben, damit
    // der neue Zielzustand sofort (nicht erst nach HOLD_MS) gesendet wird.
    solar.changedAt = 0;
  }
  if (which === 'filter' && previous !== mode) {
    filter.changedAt = 0;
  }
}

function getPumpMode(which) {
  return pumpModes[which] || 'auto';
}

function getSolarOutput() { return solar.output; }
function getFilterOutput() { return filter.output; }

// Effektive Priorität einer Pumpe zum aktuellen Zeitpunkt.
// Übernimmt während eines Filterpumpen-Probelaufes die Solarpumpen-Priorität.
function getEffectivePriority(which, cfg) {
  if (which === 'filter' && _filterActsAsSolar) return cfg.solarPumpPriority;
  return which === 'filter' ? cfg.filterPumpPriority : cfg.solarPumpPriority;
}

let _timer = null;
let _tickChain = Promise.resolve();
let _unsubscribe = null;

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

function init(db) {
  if (_timer) return;
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  if (!_unsubscribe) {
    _unsubscribe = mqttClient.onValuesChanged((event) => {
      const keys = event && Array.isArray(event.changedKeys) ? event.changedKeys : [];
      if (keys.some((key) => [EIGENVERBRAUCH_L1_STATE_ID, EIGENVERBRAUCH_L2_STATE_ID, EIGENVERBRAUCH_L3_STATE_ID].includes(String(key)))) {
        runNow(db).catch(() => {});
      }
    });
  }
  runNow(db).catch(() => {});
}

// Setzt den In-Memory-Zustand (Modus + Ist-Glaube) zurück – nur für Tests, damit
// sich Zustände nicht über mehrere Testfälle im selben Prozess vererben.
function resetForTests() {
  solar.output = null;
  solar.changedAt = 0;
  solar.loadShedOff = false;
  solar.tempMode = false;
  solar.tempSampling = false;
  solar.tempSamplingStart = 0;
  solar.tempCycleStart = 0;
  filter.output = null;
  filter.changedAt = 0;
  filter.loadShedOff = false;
  pumpModes.solar = 'auto';
  pumpModes.filter = 'auto';
  _filterActsAsSolar = false;
}

module.exports = {
  init, runNow, getSolarOutput, getFilterOutput, getPumpMode, setPumpMode,
  getEffectivePriority, resetForTests,
};
