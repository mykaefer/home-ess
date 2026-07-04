'use strict';

const DEFAULTS = {
  historyDays: 28,
  behaviorModel: 'grid_parallel',
  behaviorActive: false,
};

const BEHAVIOR_MODELS = {
  grid_parallel: 'Netzparallelbetrieb',
  off_grid: 'Autarkbetrieb',
};

function numberInRange(value, min, max, fallback) {
  const parsed = Number(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function loadPrognosisConfig(db) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM prognosis_config WHERE id = 1', (err, row) => {
      if (err || !row) return resolve({ ...DEFAULTS });
      resolve({
        historyDays: Math.round(numberInRange(row.history_days, 7, 90, DEFAULTS.historyDays)),
        behaviorModel: BEHAVIOR_MODELS[row.behavior_model] ? row.behavior_model : DEFAULTS.behaviorModel,
        behaviorActive: !!row.behavior_active,
      });
    });
  });
}

function savePrognosisConfig(db, input) {
  const config = {
    historyDays: Math.round(numberInRange(input.historyDays, 7, 90, DEFAULTS.historyDays)),
  };
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO prognosis_config (id, history_days)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET
        history_days=excluded.history_days`,
      [config.historyDays],
      (err) => (err ? reject(err) : resolve(config))
    );
  });
}

function activateBehaviorModel(db, model) {
  const behaviorModel = BEHAVIOR_MODELS[model] ? model : DEFAULTS.behaviorModel;
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE prognosis_config SET behavior_model = ?, behavior_active = 1 WHERE id = 1`,
      [behaviorModel],
      (err) => (err ? reject(err) : resolve({ behaviorModel, behaviorActive: true }))
    );
  });
}

module.exports = {
  loadPrognosisConfig, savePrognosisConfig, activateBehaviorModel,
  DEFAULTS, BEHAVIOR_MODELS,
};
