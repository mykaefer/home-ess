'use strict';

// homeESS-Zigbee-Adapter.
//
// Macht homeESS zur eigenständigen Zigbee-Zentrale: Netzwerkverwaltung,
// Pairing, Geräte-Interviews und Gerätebefehle laufen vollständig in diesem
// Adapterprozess. Es wird kein Zigbee2MQTT, kein ioBroker, kein deCONZ-Server,
// kein MQTT-Gateway und kein Cloud-Dienst benötigt; der Coordinator ist reine
// Funkhardware.
//
// Aufbau (bewusst getrennt, damit weitere Coordinator-Typen ohne Umbau folgen
// können):
//
//   lib/transport.js     – Serial oder TCP, sonst nichts
//   lib/coordinator.js   – Hardwaretreiber, rein lesende Bestandsaufnahme
//   lib/network.js       – bestehendes Netz übernehmen vs. neues erstellen
//   lib/backup.js        – Coordinator-Backup, Zigbee2MQTT-Import, Persistenz
//   lib/converters.js    – zigbee-herdsman-converters (Empfang und Befehle)
//   lib/exposes.js       – Exposes → homeESS-States
//   lib/devices.js       – Geräteverzeichnis
//   lib/availability.js  – Verfügbarkeit inkl. schlafender Batteriegeräte
//   lib/runtime.js       – Lebenszyklus, Ereignisse, Reconnect
//   lib/management.js    – Verwaltungsseite
//
// Die Abhängigkeiten zigbee-herdsman und zigbee-herdsman-converters liegen im
// Adapterverzeichnis unter node_modules/ und werden nicht global in homeESS
// installiert.

const runtimeLib = require('./lib/runtime');
const managementLib = require('./lib/management');

function createAdapter(host, dependencies = {}) {
  let runtime = null;
  let config = {};

  function loadModules() {
    // Erst hier laden: Ein Konfigurationsfehler soll mit einer klaren Meldung
    // scheitern und nicht schon beim Einlesen der Datei.
    /* eslint-disable global-require */
    const herdsman = dependencies.herdsman || require('zigbee-herdsman');
    const converters = dependencies.converters || require('zigbee-herdsman-converters');
    /* eslint-enable global-require */
    return {
      Controller: herdsman.Controller,
      setLogger: herdsman.setLogger,
      setConverterLogger: converters.setLogger,
      // Nur für Tests austauschbar; im Betrieb gilt das Treiberverzeichnis.
      getDriver: dependencies.getDriver,
      // Ebenfalls nur für Tests: die Zeitwerte der Kartenautomatik und der
      // Zuständigkeitsprüfung.
      topologyTimings: dependencies.topologyTimings,
      lockCheckMs: dependencies.lockCheckMs,
    };
  }

  return {
    async start(instanceConfig) {
      config = instanceConfig || {};
      runtime = dependencies.createRuntime
        ? dependencies.createRuntime(host, config)
        : runtimeLib.createRuntime(host, loadModules());
      await runtime.start(config);
    },

    async stop() {
      if (!runtime) return;
      try {
        await runtime.stop();
      } finally {
        runtime = null;
      }
    },

    // Schreibwunsch aus homeESS. Fehler werden protokolliert statt geworfen:
    // Ein abgelehnter Schaltbefehl darf den Adapterprozess nicht beenden.
    write(address, value) {
      if (!runtime) return;
      Promise.resolve()
        .then(() => runtime.write(address, value))
        .catch((error) => host.error(`Zigbee-Schreibzugriff auf ${address} fehlgeschlagen: `
          + `${error && error.message ? error.message : error}`));
    },

    read(address) {
      if (!runtime) return;
      Promise.resolve()
        .then(() => runtime.read(address))
        .catch((error) => host.debug(`Zigbee-Abfrage von ${address} fehlgeschlagen: `
          + `${error && error.message ? error.message : error}`));
    },

    async handleManagementRequest(request) {
      if (!runtime) {
        return { status: 503, json: { error: 'Der Zigbee-Adapter startet gerade. Bitte kurz warten.' } };
      }
      try {
        return await managementLib.handleRequest(request, {
          runtime,
          config,
          instanceName: host.name,
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        host.warn(`Zigbee-Verwaltung: ${message}`);
        return { status: Number(error && error.status) || 500, json: { error: message } };
      }
    },

    // Für Tests: Zugriff auf die innere Laufzeit.
    _internals: () => ({ runtime: () => runtime, config: () => config }),
  };
}

module.exports = createAdapter;
module.exports.createAdapter = createAdapter;
module.exports._lib = {
  runtime: runtimeLib,
  management: managementLib,
  transport: require('./lib/transport'),
  coordinator: require('./lib/coordinator'),
  network: require('./lib/network'),
  backup: require('./lib/backup'),
  exposes: require('./lib/exposes'),
  devices: require('./lib/devices'),
  availability: require('./lib/availability'),
  converters: require('./lib/converters'),
  logging: require('./lib/logging'),
};
