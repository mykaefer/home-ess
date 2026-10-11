'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForecast } = require('../src/photovoltaik/forecast');
const { cloudBreakPotentialForHour } = require('../src/prognosis/forecast');

const config = { latitude: 48, longitude: 11, timezone: 'Europe/Berlin' };
const plant = { id: 1, orientation: 180, tilt: 30, kwPeak: 6, efficiency: 100, cellType: 'Monokristallin' };

function weatherHour(hour, overrides = {}) {
  return { year: 2026, month: 6, day: 21, hour, minute: 0, ghi: 40, dni: 0, dhi: 40, cloud: 100, temp: 20, ...overrides };
}

test('PV-Prognose ergänzt Klarhimmel-Referenz, ohne den erwarteten Ertrag anzuheben', () => {
  const forecast = buildForecast({ hours: [weatherHour(12), weatherHour(0)] }, [plant], config);
  const noon = forecast.hours.find(slot => slot.hour === 12);
  const night = forecast.hours.find(slot => slot.hour === 0);
  assert.equal(noon.cloudCover, 100);
  assert.ok(noon.clearSkyKwh > noon.kwh);
  assert.equal(night.clearSkyKwh, 0);
  assert.equal(forecast.days[0].totalKwh, forecast.hours.reduce((sum, slot) => sum + slot.kwh, 0));

  const clear = buildForecast({ hours: [weatherHour(12, { cloud: 0 }), weatherHour(0, { cloud: 0 })] }, [plant], config);
  assert.equal(clear.days[0].totalKwh, forecast.days[0].totalKwh, 'Bewölkung ergänzt nur Szenariodaten');
  assert.equal(clear.hours[0].clearSkyKwh, noon.clearSkyKwh);
  assert.deepEqual(cloudBreakPotentialForHour({
    forecast: clear, dayKeyValue: '2026-06-21', hour: 12,
    pvKwh: noon.kwh, loadKwh: 0.5,
  }), { extraPvKwh: 0, extraChargePotentialKwh: 0 });
});

test('Klarhimmel-Referenz folgt der Anlagengröße und bleibt auch bei Nullprognose verfügbar', () => {
  const weather = { hours: [weatherHour(12, { ghi: 0, dhi: 0 })] };
  const small = buildForecast(weather, [plant], config);
  const large = buildForecast(weather, [{ ...plant, kwPeak: 12 }], config);
  assert.equal(small.days[0].totalKwh, 0);
  assert.ok(small.hours[0].clearSkyKwh > 0);
  assert.equal(large.hours[0].clearSkyKwh, small.hours[0].clearSkyKwh * 2);
});

test('fehlende Strahlungsdaten werden nicht als Grundlage für Wolkenlücken verwendet', () => {
  const forecast = buildForecast({ hours: [weatherHour(12, { ghi: null, dhi: null, dni: null })] }, [plant], config);
  assert.equal(forecast.hours[0].cloudCover, null);
  assert.deepEqual(cloudBreakPotentialForHour({
    forecast, dayKeyValue: '2026-06-21', hour: 12,
    pvKwh: 0, loadKwh: 0.5,
  }), { extraPvKwh: 0, extraChargePotentialKwh: 0 });
});
