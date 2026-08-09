'use strict';

const { strictFinite, strictInteger } = require('./validation');

function runtimePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Laufzeitzustand fehlt.');
  const sourceColor = input.display_color;
  if (!sourceColor || typeof sourceColor !== 'object' || Array.isArray(sourceColor)) {
    throw new Error('Anzeigefarbe fehlt.');
  }
  const payload = {
    percentage_value: (() => {
      const value = strictFinite(input.percentage_value, 'Prozentwert');
      if (value < 0 || value > 100) throw new Error('Prozentwert muss zwischen 0 und 100 liegen.');
      return value;
    })(),
    display_color: {
      r: strictInteger(sourceColor.r, 0, 255, 'Anzeigefarbe Rot'),
      g: strictInteger(sourceColor.g, 0, 255, 'Anzeigefarbe Grün'),
      b: strictInteger(sourceColor.b, 0, 255, 'Anzeigefarbe Blau'),
    },
    dynamic_brightness: strictInteger(input.dynamic_brightness, 0, 100, 'Dynamische Helligkeit'),
    transition_milliseconds: strictInteger(input.transition_milliseconds, 0, 60000, 'Übergangszeit'),
  };
  if (input.direction_indicator != null) {
    const indicator = input.direction_indicator;
    if (!indicator || typeof indicator !== 'object' || Array.isArray(indicator)
        || ![null, 'rising', 'falling'].includes(indicator.direction)) {
      throw new Error('Richtungsindikator ist ungültig.');
    }
    const sweep = strictInteger(indicator.sweep_milliseconds, 100, 10000, 'Indikatorgeschwindigkeit');
    const interval = strictInteger(indicator.pulse_interval_milliseconds, 500, 60000, 'Indikatorimpulsabstand');
    if (interval < sweep) throw new Error('Indikatorimpulsabstand darf nicht kürzer als die Indikatorgeschwindigkeit sein.');
    payload.direction_indicator = {
      direction: indicator.direction,
      sweep_milliseconds: sweep,
      pulse_interval_milliseconds: interval,
      dimming_percent: strictInteger(indicator.dimming_percent, 1, 100, 'Indikatordimmung'),
    };
  }
  return payload;
}

class LegacyRuntimeAdapter {
  constructor(transport) {
    this.transport = transport;
    this.lastSent = null;
    this.pendingState = null;
    this.transport.on('online', () => {
      this.sessionStarted();
      if (this.pendingState) this.sendState(this.pendingState, true);
    });
  }

  sessionStarted() {
    this.lastSent = null;
  }

  sendState(input, force = false) {
    const payload = runtimePayload({
      percentage_value: input.percentage,
      display_color: input.color,
      dynamic_brightness: input.brightness,
      transition_milliseconds: input.transitionMilliseconds,
      ...(input.directionIndicator == null
        ? {} : { direction_indicator: input.directionIndicator }),
    });
    const encoded = JSON.stringify(payload);
    this.pendingState = input;
    if (!this.transport.ready) return false;
    if (!force && encoded === this.lastSent) return false;
    const sent = this.transport.send('state.set', payload);
    if (!sent) return false;
    this.lastSent = encoded;
    return true;
  }
}

module.exports = { runtimePayload, LegacyRuntimeAdapter };
