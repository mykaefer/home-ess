'use strict';

const DEFAULTS = {
  historyDays: 28,
  behaviorModel: 'grid_parallel',
  behaviorActive: false,
  // Maximale relative Abweichung der Bilanz von der Selbstzählung (in %),
  // bevor der Guard die abgeschlossene Stunde durch die Selbstzählung ersetzt.
  selfCountGuardPercent: 25,
  // Absolute Mindest-Abweichung (kWh): darunter greift der Guard nie, egal wie
  // groß die relative Abweichung ist (schützt kleine Stunden vor Rauschen).
  selfCountGuardMinKwh: 0.2,
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
        selfCountGuardPercent: numberInRange(
          row.self_count_guard_percent, 1, 100, DEFAULTS.selfCountGuardPercent
        ),
        selfCountGuardMinKwh: numberInRange(
          row.self_count_guard_min_kwh, 0, 5, DEFAULTS.selfCountGuardMinKwh
        ),
      });
    });
  });
}

function savePrognosisConfig(db, input) {
  const config = {
    historyDays: Math.round(numberInRange(input.historyDays, 7, 90, DEFAULTS.historyDays)),
    selfCountGuardPercent: numberInRange(
      input.selfCountGuardPercent, 1, 100, DEFAULTS.selfCountGuardPercent
    ),
    selfCountGuardMinKwh: numberInRange(
      input.selfCountGuardMinKwh, 0, 5, DEFAULTS.selfCountGuardMinKwh
    ),
  };
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO prognosis_config (id, history_days, self_count_guard_percent, self_count_guard_min_kwh)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        history_days=excluded.history_days,
        self_count_guard_percent=excluded.self_count_guard_percent,
        self_count_guard_min_kwh=excluded.self_count_guard_min_kwh`,
      [config.historyDays, config.selfCountGuardPercent, config.selfCountGuardMinKwh],
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
