'use strict';

// Ergänzung der Host-Anbindung für SONOFF ZBMINIR2 / MINI-ZBD. Cluster,
// Attributtypen und Herstelleroptionen stammen weiterhin aus der installierten
// Converter-Bibliothek; insbesondere 0xFC11 / 0x0016 wird nicht umdefiniert.
const { Zcl } = require('zigbee-herdsman');

function matches(device, definition) {
  return definition && definition.vendor === 'SONOFF'
    && ['ZBMINIR2', 'MINI-ZBD'].includes(device.modelID);
}

async function prepareDefinition(device, definition) {
  if (!matches(device, definition)) return definition;
  // modernExtend.deviceAddCustomCluster registriert den Cluster beim Start.
  // Das muss vor configure(), read(), write() und der ZCL-Dekodierung passieren.
  await definition.onEvent({ type: 'start', data: { device, options: {}, state: {} } });
  // commandsOnOff verarbeitet auch on/off, deklariert hier aber nur toggle.
  // Die Bibliotheksdefinition bleibt unverändert (weitere Geräte/Instanzen).
  const exposes = definition.exposes.map((feature) => feature.property === 'action'
    ? { ...feature, values: [...new Set([...feature.values, 'on', 'off'])] }
    : feature);
  return { ...definition, exposes };
}

function clusterFor(message) {
  try {
    return Zcl.Utils.getCluster(message.cluster, message.meta && message.meta.manufacturerCode,
      message.device && message.device.customClusters);
  } catch (_) {
    return null;
  }
}

function normalizeMessage(message) {
  const cluster = clusterFor(message);
  if (!cluster) return message;
  const data = { ...message.data };
  // Herdsman liefert normalerweise Namen. Numerische Attributmeldungen werden
  // ebenfalls auf die registrierte Definition abgebildet, ohne Werte zu raten.
  for (const [key, value] of Object.entries(data)) {
    if (!/^(?:\d+|0x[0-9a-f]+)$/i.test(key)) continue;
    try { data[Zcl.Utils.getClusterAttribute(cluster, Number(key), message.meta && message.meta.manufacturerCode).name] = value; } catch (_) { /* unbekanntes Attribut */ }
  }
  return { ...message, cluster: cluster.name, data };
}

function isSwitchCommand(message) {
  return message.cluster === 'genOnOff'
    && ['commandToggle', 'commandOn', 'commandOff', 'commandOffWithEffect'].includes(message.type);
}

function stateFromRead(data) {
  const value = data && (data.onOff ?? data[0]);
  if (value === 1 || value === true) return { state: 'ON' };
  if (value === 0 || value === false) return { state: 'OFF' };
  throw new Error('genOnOff-Abfrage enthält keinen gültigen Relaiszustand.');
}

function describeMessage(message) {
  const cluster = clusterFor(message);
  return JSON.stringify({
    device: message.device && message.device.ieeeAddr,
    endpoint: message.endpoint && message.endpoint.ID,
    cluster: message.cluster,
    clusterId: cluster ? `0x${cluster.ID.toString(16).padStart(4, '0')}` : null,
    command: message.type,
    attributes: message.data,
    manufacturerCode: message.meta && message.meta.manufacturerCode != null
      ? message.meta.manufacturerCode : null,
    transaction: message.meta && message.meta.zclTransactionSequenceNumber,
  });
}

module.exports = { matches, prepareDefinition, normalizeMessage, isSwitchCommand, stateFromRead, describeMessage };
