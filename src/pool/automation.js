'use strict';

const mqttClient = require('../mqtt/client');
const { buildEnvironmentSnapshot } = require('../mqtt/config');
const { loadPoolConfig, readPoolValue } = require('./config');
const { assessHeaderSkyState } = require('../photovoltaik/aggregation');
const { listPvPlants } = require('../photovoltaik/plants');
const { isEnabled } = require('../modules');
const levelHandler = require('../operating-level/handler');

const HOLD_MS = 2 * 60 * 1000; // 2 Minuten Mindesthaltedauer nach Schaltung

// Verbraucher-IDs beim zentralen Betriebslevel-Handler.
const POOL_CONSUMER = { solar: 'pool.solar', filter: 'pool.filter' };

// In-Memory-Zustand (nach Neustart zurückgesetzt – für Poolpumpe akzeptabel)
const solar = {
  output: null,   // 'on' | 'off' | null
  changedAt: 0,
  tempMode: false,
  tempSampling: false,
  tempSamplingStart: 0,
  tempCycleStart: 0,
};

const filter = {
  output: null,
};

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseOn(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
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

// Einschalten im Automatikpfad nur nach Freigabe durch das Betriebslevel.
// priority = effektive Priorität der zugrunde liegenden Aufgabe (Solar-/Filterdienst).
// Liefert den tatsächlich geschalteten Zustand (false, wenn das Level das Einschalten sperrt).
function gatedSend(topic, on, priority) {
  const effective = !!on && levelHandler.isAllowed(priority);
  send(topic, effective);
  return effective;
}

// Sofort-Abschaltung auf Anforderung des Betriebslevel-Handlers (Level gesunken).
function forceOff(which, cfg) {
  const topic = commandTopic(which, cfg);
  if (!topic) return;
  send(topic, false);
  if (which === 'filter') {
    filter.output = 'off';
  } else {
    solar.output = 'off';
    solar.changedAt = Date.now();
  }
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
    return;
  }

  const cfg = await new Promise((resolve) => loadPoolConfig(db, resolve));
  const cache = mqttClient.getCache();
  const now = Date.now();
  const localMinutes = currentMinutes(cache);

  // ── Solarpumpe ──────────────────────────────────────────────────────────────
  if (cfg.solarPumpCommandTopic && pumpModes.solar !== 'auto') {
    const desired = pumpModes.solar;
    if (solar.output !== desired) {
      send(cfg.solarPumpCommandTopic, desired === 'on');
      solar.output = desired;
      solar.changedAt = now;
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
      if (solar.output !== desired) {
        const holdOk = solar.changedAt === 0 || now - solar.changedAt >= HOLD_MS;
        if (holdOk) {
          const on = gatedSend(cfg.solarPumpCommandTopic, desired === 'on', cfg.solarPumpPriority);
          solar.output = on ? 'on' : 'off';
          solar.changedAt = now;
        }
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
    const desired = pumpModes.filter;
    if (filter.output !== desired) {
      send(cfg.filterPumpCommandTopic, desired === 'on');
      filter.output = desired;
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

    if (filter.output !== desired) {
      const on = gatedSend(cfg.filterPumpCommandTopic, desired === 'on', cfg.filterPumpPriority);
      filter.output = on ? 'on' : 'off';
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

function runNow(db) {
  const run = _tickChain.then(() => tick(db));
  _tickChain = run.catch(() => {});
  return run;
}

function init(db) {
  if (_timer) return;
  _timer = setInterval(() => runNow(db).catch(() => {}), 30000);
  runNow(db).catch(() => {});
}

module.exports = { init, runNow, getSolarOutput, getFilterOutput, getPumpMode, setPumpMode, getEffectivePriority };
