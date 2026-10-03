'use strict';

// Endpositionen bevorzugen die Richtungsbefehle, Zwischenpositionen benötigen
// einen Prozent-State. Ohne Richtungs-State übernimmt Prozent auch die Endlage.
function command(shutter, target) {
  if (target === 0 && shutter.upTopic) return { topic: shutter.upTopic, value: shutter.upValue, kind: 'up' };
  if (target === 100 && shutter.downTopic) return { topic: shutter.downTopic, value: shutter.downValue, kind: 'down' };
  if (!shutter.positionTopic || !Number.isFinite(target) || target < 0 || target > 100) return null;
  return { topic: shutter.positionTopic, value: shutter.openValue + target / 100 * (shutter.closedValue - shutter.openValue), kind: 'position' };
}

// Ohne Prozent-Rückmeldung sind nur angenommene Endlagen verfügbar. Bekannte
// Richtungsflanken erkennen Handbedienung; retained Anfangswerte sind keine Fahrt.
function directionFeedback(shutter, memory, entries, now) {
  memory.directionValues ||= {};
  let manualTarget = null;
  for (const kind of ['up', 'down'].sort((a, b) => (entries[a]?.receivedAt || 0) - (entries[b]?.receivedAt || 0))) {
    const entry = entries[kind];
    if (!entry) continue;
    const value = String(entry.value).trim().toLowerCase();
    const previous = memory.directionValues[kind];
    memory.directionValues[kind] = value;
    if (previous == null || previous === value || value !== String(shutter[`${kind}Value`]).trim().toLowerCase()) continue;
    if (memory.commandEcho?.kind === kind && now <= memory.commandEcho.until) continue;
    manualTarget = kind === 'up' ? 0 : 100;
  }
  if (manualTarget != null) {
    memory.estimated = manualTarget;
    memory.pending = { target: manualTarget, until: now + shutter.travelSeconds * 1000 };
    memory.fault = null;
  } else if (memory.pending && now >= memory.pending.until) {
    memory.estimated = memory.pending.target;
    memory.pending = null;
  }
  return { position: memory.estimated ?? null, manualChange: manualTarget != null };
}
module.exports = { command, directionFeedback };
