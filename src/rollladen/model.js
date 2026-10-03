'use strict';

const HOUR = 3600000;
const closeEnough = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2;

// Reines Entscheidungsmodell. Positionen intern: 0 offen, 100 geschlossen.
// Manuelle Raumziele bleiben unabhängig von temporären Übersteuerungen erhalten.
function planRoom(previous = {}, input) {
  const state = structuredClone(previous);
  state.shutters ||= {};
  const { now, elevation, brightness, shutters } = input;
  // 0 %: vollständige Nacht (-18°), 100 %: Horizont (0°).
  // Derselbe Beginn der Dämmerung gilt für „Helligkeit aktuell“.
  const threshold = -18 + 18 * brightness / 100;
  const night = Number.isFinite(elevation) ? elevation <= threshold : state.night;
  const boundary = state.night != null && night != null && state.night !== night;
  if (boundary) { state.manual = false; state.manualTargets = {}; }
  state.night = night;
  const decisions = [];
  for (const shutter of shutters) {
    const s = state.shutters[shutter.id] ||= {};
    const sunRisk = (shutter.shadePercent ?? 100) > 0 && shutter.sunReliable && Number.isFinite(shutter.temperature) && Number.isFinite(shutter.limit)
      && shutter.predictedTemperature >= shutter.limit - 0.5;
    if (sunRisk) s.clearSince = null;
    else s.clearSince ??= now;
    if (!s.shaded && sunRisk && (!s.lastSunMove || now - s.lastSunMove >= HOUR)) {
      s.shaded = true; s.shadeSince = now; s.lastSunMove = now;
    }
    if (s.shaded && now - s.shadeSince >= HOUR && s.clearSince != null && now - s.clearSince >= 20 * 60000) {
      s.shaded = false; s.lastSunMove = now;
    }
    s.planned = night ? 100 : s.shaded ? (shutter.shadePercent ?? 100) : 0;
    // Ohne Sonnenstand keine neue astronomische Fahrt, vorhandene Ziele bleiben.
    if (night == null) s.planned = s.previousPlanned ?? null;
    s.previousPlanned = s.planned;
  }
  const manualChanges = shutters.filter(s => s.manualChange && Number.isFinite(s.position));
  if (manualChanges.length) {
    state.manual = true;
    state.manualTargets ||= {};
    for (const shutter of shutters) {
      if (state.manualTargets[shutter.id] == null) state.manualTargets[shutter.id] = shutter.position;
    }
    for (const shutter of manualChanges) state.manualTargets[shutter.id] = shutter.position;
    // Nur ein Benutzereingriff darf die Automatik vor der nächsten Dämmerung
    // reaktivieren. Kino-/Fensterfahrten gelten ausdrücklich nicht als Rückkehr.
    if (shutters.every(s => closeEnough(state.manualTargets[s.id], state.shutters[s.id].planned))) {
      state.manual = false; state.manualTargets = {};
    }
  }
  for (const shutter of shutters) {
    const s = state.shutters[shutter.id];
    let target = state.manual ? state.manualTargets?.[shutter.id] : s.planned;
    let reason = state.manual ? 'Manuell bis zum nächsten Tag-/Nachtwechsel' : night ? 'Nachtschluss' : s.shaded ? 'Vorausschauender Sonnenschutz' : 'Tagesposition';
    if (shutter.contactOpen) { target = 0; reason = 'Fenster/Tür geöffnet'; }
    if (shutter.cinema) { target = 100; reason = 'Heimkino'; }
    // Außerhalb des ausdrücklich aktivierten Kinos sperren unbekannte Kontakte.
    if (!shutter.cinema && shutter.contactUnknown && target > shutter.position) { target = null; reason = 'Fensterkontakt unbekannt – Schließen gesperrt'; }
    // Die Stunde betrifft Sonnenschutz. Sicherheitsöffnung, explizites Kino und
    // Benutzerbefehle haben Vorrang. Morgens wird eine junge Beschattung gehalten.
    if (!state.manual && !shutter.cinema && !shutter.contactOpen && target === 0 && s.shaded && now - s.shadeSince < HOUR) target = shutter.shadePercent ?? 100;
    decisions.push({ id: shutter.id, target, planned: s.planned, reason });
  }
  return { state, decisions };
}
module.exports = { planRoom, closeEnough, HOUR };
