'use strict';

// Laden/Speichern der MQTT-Broker-Konfiguration (Tabelle mqtt_config, id=1).
const DEFAULTS = {
  host: 'localhost',
  port: 1883,
  username: '',
  password: '',
  latitude: '',
  longitude: '',
  timezone: 'Europe/Berlin',
  dstEnabled: 1,
  outdoorTemperatureTopic: '',
  clockTimeTopic: '',
  clockDateTopic: '',
};

const ENVIRONMENT_STATE_IDS = {
  outdoorTemperature: 'mqtt.outdoorTemperature',
  clockTime: 'mqtt.clockTime',
  clockDate: 'mqtt.clockDate',
};

function loadMqttConfig(db, callback) {
  db.get(
    `SELECT host, port, username, password,
            latitude, longitude, timezone, dst_enabled AS dstEnabled,
            outdoor_temperature_topic AS outdoorTemperatureTopic,
            clock_time_topic AS clockTimeTopic,
            clock_date_topic AS clockDateTopic
       FROM mqtt_config
      WHERE id = 1`,
    (err, row) => {
    if (err || !row) return callback({ ...DEFAULTS });
    callback({
      ...row,
      timezone: row.timezone || DEFAULTS.timezone,
      dstEnabled: row.dstEnabled == null ? 1 : row.dstEnabled,
    });
    }
  );
}

function saveMqttConfig(db, input, callback) {
  const host = input.host || '';
  const port = Number(input.port) || 1883;
  const username = input.username || '';
  const password = input.password || '';
  const latitude = parseDecimal(input.latitude);
  const longitude = parseDecimal(input.longitude);
  const timezone = (input.timezone || DEFAULTS.timezone).trim();
  const dstEnabled = isChecked(input.dstEnabled) ? 1 : 0;
  const outdoorTemperatureTopic = input.outdoorTemperatureTopic || '';
  const clockTimeTopic = input.clockTimeTopic || '';
  const clockDateTopic = input.clockDateTopic || '';
  db.run(
    `UPDATE mqtt_config
        SET host = ?, port = ?, username = ?, password = ?,
            latitude = ?, longitude = ?, timezone = ?, dst_enabled = ?,
            outdoor_temperature_topic = ?, clock_time_topic = ?, clock_date_topic = ?
      WHERE id = 1`,
    [host, port, username, password, latitude, longitude, timezone, dstEnabled,
      outdoorTemperatureTopic, clockTimeTopic, clockDateTopic],
    (err) =>
      callback(err, {
        host,
        port,
        username,
        password,
        latitude: latitude == null ? '' : latitude,
        longitude: longitude == null ? '' : longitude,
        timezone,
        dstEnabled,
        outdoorTemperatureTopic,
        clockTimeTopic,
        clockDateTopic,
      })
  );
}

function buildMqttStateDefinitions(config) {
  return [
    { id: ENVIRONMENT_STATE_IDS.outdoorTemperature, topic: config.outdoorTemperatureTopic || '' },
    { id: ENVIRONMENT_STATE_IDS.clockTime, topic: config.clockTimeTopic || '' },
    { id: ENVIRONMENT_STATE_IDS.clockDate, topic: config.clockDateTopic || '' },
  ].filter((entry) => entry.topic);
}

// Checkbox-Werte kommen je nach Quelle als 'on', '1', true … oder fehlen ganz.
function isChecked(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

function parseDecimal(value) {
  if (value == null) return null;
  const normalized = String(value).trim().replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeTemperature(value) {
  const numeric = parseDecimal(value);
  if (numeric == null) {
    return { raw: value == null ? '' : String(value), value: null, display: '-- °C' };
  }
  return {
    raw: String(value),
    value: numeric,
    display: `${numeric.toFixed(1)} °C`,
  };
}

function normalizeTime(value) {
  const raw = value == null ? '' : String(value).trim();
  const match = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    return { raw, hours: null, minutes: null, seconds: null, iso: '', display: '--:--' };
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] == null ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return { raw, hours: null, minutes: null, seconds: null, iso: '', display: '--:--' };
  }

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return {
    raw,
    hours,
    minutes,
    seconds,
    iso: `${hh}:${mm}:${ss}`,
    display: `${hh}:${mm}`,
  };
}

function normalizeDate(value) {
  const raw = value == null ? '' : String(value).trim();
  let year = null;
  let month = null;
  let day = null;

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    }
  }

  const calendarDate = new Date(Date.UTC(year || 0, (month || 1) - 1, day || 1));
  if (!year || !month || !day || month > 12 || day > 31 ||
      calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) {
    return { raw, year: null, month: null, day: null, iso: '', display: '--.--.----' };
  }

  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    raw,
    year,
    month,
    day,
    iso: `${yyyy}-${mm}-${dd}`,
    display: `${dd}.${mm}.${yyyy}`,
  };
}

function buildEnvironmentSnapshot(cache) {
  const temperatureValue = cache.get(ENVIRONMENT_STATE_IDS.outdoorTemperature)?.value;
  const timeValue = cache.get(ENVIRONMENT_STATE_IDS.clockTime)?.value;
  const dateValue = cache.get(ENVIRONMENT_STATE_IDS.clockDate)?.value;

  return {
    temperature: normalizeTemperature(temperatureValue),
    time: normalizeTime(timeValue),
    date: normalizeDate(dateValue),
  };
}

module.exports = {
  loadMqttConfig,
  saveMqttConfig,
  DEFAULTS,
  ENVIRONMENT_STATE_IDS,
  buildMqttStateDefinitions,
  buildEnvironmentSnapshot,
  normalizeTime,
  normalizeDate,
};
