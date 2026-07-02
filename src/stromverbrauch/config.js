'use strict';

const { normalizeMqttTopic } = require('../mqtt/topics');

const DEFAULTS = {
  eigenverbrauchL1Topic: '',
  eigenverbrauchL2Topic: '',
  eigenverbrauchL3Topic: '',
  netzbezugL1Topic: '',
  netzbezugL2Topic: '',
  netzbezugL3Topic: '',
  netzbezugZaehlerL1Topic: '',
  netzbezugZaehlerL2Topic: '',
  netzbezugZaehlerL3Topic: '',
  einspeisungZaehlerL1Topic: '',
  einspeisungZaehlerL2Topic: '',
  einspeisungZaehlerL3Topic: '',
};

const EIGENVERBRAUCH_L1_STATE_ID = 'stromverbrauch_eigenverbrauch_l1';
const EIGENVERBRAUCH_L2_STATE_ID = 'stromverbrauch_eigenverbrauch_l2';
const EIGENVERBRAUCH_L3_STATE_ID = 'stromverbrauch_eigenverbrauch_l3';
const NETZBEZUG_L1_STATE_ID = 'stromverbrauch_netzbezug_l1';
const NETZBEZUG_L2_STATE_ID = 'stromverbrauch_netzbezug_l2';
const NETZBEZUG_L3_STATE_ID = 'stromverbrauch_netzbezug_l3';
const NETZBEZUG_ZAEHLER_L1_STATE_ID = 'stromverbrauch_netzbezug_zaehler_l1';
const NETZBEZUG_ZAEHLER_L2_STATE_ID = 'stromverbrauch_netzbezug_zaehler_l2';
const NETZBEZUG_ZAEHLER_L3_STATE_ID = 'stromverbrauch_netzbezug_zaehler_l3';
const EINSPEISUNG_ZAEHLER_L1_STATE_ID = 'stromverbrauch_einspeisung_zaehler_l1';
const EINSPEISUNG_ZAEHLER_L2_STATE_ID = 'stromverbrauch_einspeisung_zaehler_l2';
const EINSPEISUNG_ZAEHLER_L3_STATE_ID = 'stromverbrauch_einspeisung_zaehler_l3';
let configCacheDb = null;
let configCache = null;

function loadStromverbrauchConfig(db, callback) {
  if (configCacheDb === db && configCache) {
    queueMicrotask(() => callback({ ...configCache }));
    return;
  }
  db.get(
    `SELECT
      eigenverbrauch_l1_topic AS eigenverbrauchL1Topic,
      eigenverbrauch_l2_topic AS eigenverbrauchL2Topic,
      eigenverbrauch_l3_topic AS eigenverbrauchL3Topic,
      netzbezug_l1_topic AS netzbezugL1Topic,
      netzbezug_l2_topic AS netzbezugL2Topic,
      netzbezug_l3_topic AS netzbezugL3Topic,
      netzbezug_zaehler_l1_topic AS netzbezugZaehlerL1Topic,
      netzbezug_zaehler_l2_topic AS netzbezugZaehlerL2Topic,
      netzbezug_zaehler_l3_topic AS netzbezugZaehlerL3Topic,
      einspeisung_zaehler_l1_topic AS einspeisungZaehlerL1Topic,
      einspeisung_zaehler_l2_topic AS einspeisungZaehlerL2Topic,
      einspeisung_zaehler_l3_topic AS einspeisungZaehlerL3Topic
     FROM stromverbrauch_config
     WHERE id = 1`,
    (err, row) => {
      const config = err || !row ? { ...DEFAULTS } : {
        eigenverbrauchL1Topic: row.eigenverbrauchL1Topic || '',
        eigenverbrauchL2Topic: row.eigenverbrauchL2Topic || '',
        eigenverbrauchL3Topic: row.eigenverbrauchL3Topic || '',
        netzbezugL1Topic: row.netzbezugL1Topic || '',
        netzbezugL2Topic: row.netzbezugL2Topic || '',
        netzbezugL3Topic: row.netzbezugL3Topic || '',
        netzbezugZaehlerL1Topic: row.netzbezugZaehlerL1Topic || '',
        netzbezugZaehlerL2Topic: row.netzbezugZaehlerL2Topic || '',
        netzbezugZaehlerL3Topic: row.netzbezugZaehlerL3Topic || '',
        einspeisungZaehlerL1Topic: row.einspeisungZaehlerL1Topic || '',
        einspeisungZaehlerL2Topic: row.einspeisungZaehlerL2Topic || '',
        einspeisungZaehlerL3Topic: row.einspeisungZaehlerL3Topic || '',
      };
      configCacheDb = db;
      configCache = config;
      callback({ ...config });
    }
  );
}

function saveStromverbrauchConfig(db, input, callback) {
  const config = {
    eigenverbrauchL1Topic: normalizeMqttTopic(input.eigenverbrauchL1Topic || ''),
    eigenverbrauchL2Topic: normalizeMqttTopic(input.eigenverbrauchL2Topic || ''),
    eigenverbrauchL3Topic: normalizeMqttTopic(input.eigenverbrauchL3Topic || ''),
    netzbezugL1Topic: normalizeMqttTopic(input.netzbezugL1Topic || ''),
    netzbezugL2Topic: normalizeMqttTopic(input.netzbezugL2Topic || ''),
    netzbezugL3Topic: normalizeMqttTopic(input.netzbezugL3Topic || ''),
    netzbezugZaehlerL1Topic: normalizeMqttTopic(input.netzbezugZaehlerL1Topic || ''),
    netzbezugZaehlerL2Topic: normalizeMqttTopic(input.netzbezugZaehlerL2Topic || ''),
    netzbezugZaehlerL3Topic: normalizeMqttTopic(input.netzbezugZaehlerL3Topic || ''),
    einspeisungZaehlerL1Topic: normalizeMqttTopic(input.einspeisungZaehlerL1Topic || ''),
    einspeisungZaehlerL2Topic: normalizeMqttTopic(input.einspeisungZaehlerL2Topic || ''),
    einspeisungZaehlerL3Topic: normalizeMqttTopic(input.einspeisungZaehlerL3Topic || ''),
  };

  db.run(
    `UPDATE stromverbrauch_config
     SET eigenverbrauch_l1_topic = ?, eigenverbrauch_l2_topic = ?, eigenverbrauch_l3_topic = ?,
         netzbezug_l1_topic = ?, netzbezug_l2_topic = ?, netzbezug_l3_topic = ?,
         netzbezug_zaehler_l1_topic = ?, netzbezug_zaehler_l2_topic = ?, netzbezug_zaehler_l3_topic = ?,
         einspeisung_zaehler_l1_topic = ?, einspeisung_zaehler_l2_topic = ?, einspeisung_zaehler_l3_topic = ?
     WHERE id = 1`,
    [
      config.eigenverbrauchL1Topic,
      config.eigenverbrauchL2Topic,
      config.eigenverbrauchL3Topic,
      config.netzbezugL1Topic,
      config.netzbezugL2Topic,
      config.netzbezugL3Topic,
      config.netzbezugZaehlerL1Topic,
      config.netzbezugZaehlerL2Topic,
      config.netzbezugZaehlerL3Topic,
      config.einspeisungZaehlerL1Topic,
      config.einspeisungZaehlerL2Topic,
      config.einspeisungZaehlerL3Topic,
    ],
    (err) => {
      if (!err) { configCacheDb = db; configCache = config; }
      callback(err, config);
    }
  );
}

function buildStromverbrauchStateDefinitions(cfg = DEFAULTS) {
  const defs = [];
  pushTopic(defs, EIGENVERBRAUCH_L1_STATE_ID, cfg.eigenverbrauchL1Topic);
  pushTopic(defs, EIGENVERBRAUCH_L2_STATE_ID, cfg.eigenverbrauchL2Topic);
  pushTopic(defs, EIGENVERBRAUCH_L3_STATE_ID, cfg.eigenverbrauchL3Topic);
  pushTopic(defs, NETZBEZUG_L1_STATE_ID, cfg.netzbezugL1Topic);
  pushTopic(defs, NETZBEZUG_L2_STATE_ID, cfg.netzbezugL2Topic);
  pushTopic(defs, NETZBEZUG_L3_STATE_ID, cfg.netzbezugL3Topic);
  pushTopic(defs, NETZBEZUG_ZAEHLER_L1_STATE_ID, cfg.netzbezugZaehlerL1Topic);
  pushTopic(defs, NETZBEZUG_ZAEHLER_L2_STATE_ID, cfg.netzbezugZaehlerL2Topic);
  pushTopic(defs, NETZBEZUG_ZAEHLER_L3_STATE_ID, cfg.netzbezugZaehlerL3Topic);
  pushTopic(defs, EINSPEISUNG_ZAEHLER_L1_STATE_ID, cfg.einspeisungZaehlerL1Topic);
  pushTopic(defs, EINSPEISUNG_ZAEHLER_L2_STATE_ID, cfg.einspeisungZaehlerL2Topic);
  pushTopic(defs, EINSPEISUNG_ZAEHLER_L3_STATE_ID, cfg.einspeisungZaehlerL3Topic);
  return defs;
}

function pushTopic(defs, id, topic) {
  if (topic) defs.push({ id, topic });
}

module.exports = {
  loadStromverbrauchConfig,
  saveStromverbrauchConfig,
  buildStromverbrauchStateDefinitions,
  EIGENVERBRAUCH_L1_STATE_ID,
  EIGENVERBRAUCH_L2_STATE_ID,
  EIGENVERBRAUCH_L3_STATE_ID,
  NETZBEZUG_L1_STATE_ID,
  NETZBEZUG_L2_STATE_ID,
  NETZBEZUG_L3_STATE_ID,
  NETZBEZUG_ZAEHLER_L1_STATE_ID,
  NETZBEZUG_ZAEHLER_L2_STATE_ID,
  NETZBEZUG_ZAEHLER_L3_STATE_ID,
  EINSPEISUNG_ZAEHLER_L1_STATE_ID,
  EINSPEISUNG_ZAEHLER_L2_STATE_ID,
  EINSPEISUNG_ZAEHLER_L3_STATE_ID,
  DEFAULTS,
};
