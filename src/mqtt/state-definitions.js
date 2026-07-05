'use strict';

const { loadMqttConfig, buildMqttStateDefinitions } = require('./config');
const {
  loadStromverbrauchConfig,
  buildStromverbrauchStateDefinitions,
} = require('../stromverbrauch/config');
const {
  listPvPlants,
  buildPhotovoltaikStateDefinitions,
} = require('../photovoltaik/plants');
const {
  loadBatterieConfig,
  buildBatterieStateDefinitions,
} = require('../batterie/config');
const { loadGridControlConfig, buildGridControlStateDefinitions } = require('../grid-control/config');
const { listWallboxes, buildWallboxStateDefinitions } = require('../wallbox/boxes');
const { listActors, buildMessSchaltStateDefinitions } = require('../messen-schalten/actors');
const { listSwitchGroups, buildSchaltgruppenStateDefinitions } = require('../messen-schalten/schaltgruppen');
const { isEnabled } = require('../modules');
const { AUTARK_DAYS_STATE_ID, AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID } = require('../operating-state');

async function loadAllStateDefinitions(db) {
  const mqttConfig = await new Promise((resolve) => loadMqttConfig(db, resolve));
  const stromverbrauchConfig = await new Promise((resolve) => loadStromverbrauchConfig(db, resolve));
  const batterieConfig = await new Promise((resolve) => loadBatterieConfig(db, resolve));
  const pvPlants = await listPvPlants(db);
  const operatingRow = await new Promise((resolve) => {
    db.get(
      'SELECT autark_days_topic, autark_days_previous_year_topic FROM operating_state WHERE id = 1',
      (err, row) => resolve(err ? null : row)
    );
  });
  const definitions = [
    ...buildMqttStateDefinitions(mqttConfig),
    ...buildStromverbrauchStateDefinitions(stromverbrauchConfig),
    ...buildBatterieStateDefinitions(batterieConfig),
    ...buildPhotovoltaikStateDefinitions(pvPlants),
    ...buildMessSchaltStateDefinitions(await listActors(db)),
    ...buildSchaltgruppenStateDefinitions(await listSwitchGroups(db)),
  ];
  if (operatingRow && operatingRow.autark_days_topic) {
    definitions.push({ id: AUTARK_DAYS_STATE_ID, topic: operatingRow.autark_days_topic });
  }
  if (operatingRow && operatingRow.autark_days_previous_year_topic) {
    definitions.push({
      id: AUTARK_DAYS_PREVIOUS_YEAR_STATE_ID,
      topic: operatingRow.autark_days_previous_year_topic,
    });
  }
  if (isEnabled('grid-control')) {
    const gridControlConfig = await new Promise((resolve) => loadGridControlConfig(db, resolve));
    definitions.push(...buildGridControlStateDefinitions(gridControlConfig));
  }
  if (isEnabled('wallbox')) {
    definitions.push(...buildWallboxStateDefinitions(await listWallboxes(db)));
  }
  return definitions;
}

module.exports = { loadAllStateDefinitions };
