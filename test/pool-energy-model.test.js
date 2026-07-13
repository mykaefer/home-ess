'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { median, windowOverlapHours, poolLoadForHour } = require('../src/pool/energy-model');

test('Pumpenleistung wird robust über den Median gelernt', () => {
  assert.equal(median([500, 510, 490, 3000, 505]), 505);
});

test('Filter-Zeitfenster werden stundengenau geschnitten', () => {
  assert.equal(windowOverlapHours('08:30', '10:15', 8), 0.5);
  assert.equal(windowOverlapHours('08:30', '10:15', 9), 1);
  assert.equal(windowOverlapHours('08:30', '10:15', 10), 0.25);
});

test('Poolprognose kombiniert Solarprognose, Filterfenster und gelernte Leistung', () => {
  const model = {
    enabled: true, solarPowerW: 500, filterPowerW: 800,
    config: {
      filterPumpFollowSolar: false, filterBatteryEnabled: false,
      filterTime1Start: '10:30', filterTime1End: '11:30',
    },
  };
  const forecast = { hours: [{ dateKey: '2026-07-03', hour: 10, kwh: 2 }] };
  const load = poolLoadForHour(model, forecast, '2026-07-03', 10, 1, 50);
  assert.equal(load.solarKwh, 0.5);
  assert.equal(load.filterKwh, 0.4);
  assert.equal(load.totalKwh, 0.9);
});

test('Konfigurierte Nennleistung hat Vorrang vor der gelernten Leistung', () => {
  const model = {
    enabled: true, solarPowerW: 1342, filterPowerW: 635,
    config: {
      solarPumpRatedPowerW: 250, filterPumpRatedPowerW: 600,
      filterPumpFollowSolar: false, filterBatteryEnabled: false,
      filterTime1Start: '10:30', filterTime1End: '11:30',
    },
  };
  const forecast = { hours: [{ dateKey: '2026-07-03', hour: 10, kwh: 2 }] };
  const load = poolLoadForHour(model, forecast, '2026-07-03', 10, 1, 50);
  assert.equal(load.solarKwh, 0.25);
  assert.equal(load.filterKwh, 0.3);
});

test('Leere Nennleistung fällt auf die gelernte Leistung zurück', () => {
  const model = {
    enabled: true, solarPowerW: 500, filterPowerW: 800,
    config: {
      solarPumpRatedPowerW: '', filterPumpRatedPowerW: '',
      filterPumpFollowSolar: false, filterBatteryEnabled: false,
    },
  };
  const forecast = { hours: [{ dateKey: '2026-07-03', hour: 10, kwh: 2 }] };
  const load = poolLoadForHour(model, forecast, '2026-07-03', 10, 1, 50);
  assert.equal(load.solarKwh, 0.5);
});

test('Mit Standort steuert das Clear-Sky-Modell die Solarpumpen-Laufzeit', () => {
  const model = {
    enabled: true, solarPowerW: 250, filterPowerW: 600,
    config: { filterPumpFollowSolar: false, filterBatteryEnabled: false },
  };
  // Breitengrad gesetzt, aber Nachtstunde → Sonne unter dem Horizont → keine Solarlast,
  // obwohl (widersprüchlich) ein PV-Wert im Forecast stünde.
  const forecast = { latitude: 48.14, hours: [{ dateKey: '2026-07-14', hour: 2, kwh: 5 }] };
  const night = poolLoadForHour(model, forecast, '2026-07-14', 2, 1, 50);
  assert.equal(night.solarKwh, 0);
  // Mittagsstunde im Juli → Sonne hoch → volle Stunde Solarpumpe (0,25 kWh).
  const noon = poolLoadForHour(model, forecast, '2026-07-14', 12, 1, 50);
  assert.ok(Math.abs(noon.solarKwh - 0.25) < 1e-9, `erwartet 0,25, war ${noon.solarKwh}`);
});

test('Temperatur-Probeläufe sind kein Bestandteil des Prognosemodells', () => {
  const model = {
    enabled: true, solarPowerW: 500, filterPowerW: 800,
    config: {
      solarPumpMaxTemp: 20, solarPumpTempOnSeconds: 60, solarPumpTempPauseMinutes: 5,
      filterPumpFollowSolar: false, filterBatteryEnabled: false,
    },
  };
  const load = poolLoadForHour(model, { hours: [] }, '2026-07-03', 10, 1, 50);
  assert.equal(load.totalKwh, 0);
});
