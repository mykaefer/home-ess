'use strict';

const { strictFinite, strictInteger } = require('./validation');
const { encodeTimeline } = require('./timeline');

function scaleColor(color, factor) {
  return {
    r: Math.max(0, Math.min(255, Math.round(color.r * factor))),
    g: Math.max(0, Math.min(255, Math.round(color.g * factor))),
    b: Math.max(0, Math.min(255, Math.round(color.b * factor))),
  };
}

function renderPercentageFrame(input) {
  const pixelCount = strictInteger(input.pixelCount, 1, 0xffff, 'Pixelanzahl');
  const percentage = strictFinite(input.percentage, 'Prozentwert');
  const brightness = strictInteger(input.brightness, 0, 100, 'Plugin-Helligkeit');
  if (percentage < 0 || percentage > 100) throw new Error('Prozentwert muss zwischen 0 und 100 liegen.');
  const sourceColor = input.color || {};
  const base = scaleColor({
    r: strictInteger(sourceColor.r, 0, 255, 'Farbe Rot'),
    g: strictInteger(sourceColor.g, 0, 255, 'Farbe Grün'),
    b: strictInteger(sourceColor.b, 0, 255, 'Farbe Blau'),
  }, brightness / 100);
  const active = percentage * pixelCount / 100;
  const full = Math.floor(active);
  const fraction = input.fractional === false ? 0 : active - full;
  const pixels = [];
  for (let index = 0; index < pixelCount; index += 1) {
    if (index < full) pixels.push({ ...base });
    else if (index === full && fraction > 0) pixels.push(scaleColor(base, fraction));
    else pixels.push({ r: 0, g: 0, b: 0 });
  }
  return pixels;
}

function frameBuffer(pixels) {
  return Buffer.from(pixels.flatMap((pixel) => [pixel.r, pixel.g, pixel.b]));
}

function compileIndicatorTimeline(frame, indicator, limits) {
  const direction = indicator.direction;
  if (!['rising', 'falling'].includes(direction)) return null;
  const pixelCount = frame.length;
  const sweep = strictInteger(indicator.sweep_milliseconds, 100, 10000, 'Indikatorgeschwindigkeit');
  const duration = strictInteger(indicator.pulse_interval_milliseconds, 500, 60000, 'Impulsabstand');
  const dimming = strictInteger(indicator.dimming_percent, 1, 100, 'Indikatordimmung');
  const minimum = limits.minimum_frame_interval_milliseconds;
  if (limits.maximum_timeline_events < 2) {
    throw new Error('Manifest erlaubt nicht genügend Timelineereignisse für den Richtungsindikator.');
  }
  const steps = Math.max(1, Math.min(
    pixelCount,
    Math.floor(sweep / minimum),
    limits.maximum_timeline_events - 1,
  ));
  const delta = Math.max(minimum, Math.floor(sweep / steps));
  if (delta * steps >= duration) throw new Error('Impulsabstand ist für Geschwindigkeit und Manifest-Frameintervall zu kurz.');
  const indices = Array.from({ length: steps }, (_, step) => {
    const ratio = steps === 1 ? 0 : step / (steps - 1);
    const logical = Math.round(ratio * (pixelCount - 1));
    return direction === 'rising' ? logical : pixelCount - 1 - logical;
  });
  const events = [{
    delta_milliseconds: 0,
    operations: [
      { op: 'SET_RANGE_RGB', start: 0, pixels: frame },
      { op: 'SET_PIXEL', index: indices[0], ...scaleColor(frame[indices[0]], 1 - dimming / 100) },
    ],
  }];
  for (let step = 1; step < indices.length; step += 1) {
    const previous = indices[step - 1];
    const current = indices[step];
    events.push({
      delta_milliseconds: delta,
      operations: [
        { op: 'SET_PIXEL', index: previous, ...frame[previous] },
        { op: 'SET_PIXEL', index: current, ...scaleColor(frame[current], 1 - dimming / 100) },
      ],
    });
  }
  events.push({
    delta_milliseconds: delta,
    operations: [{ op: 'SET_PIXEL', index: indices.at(-1), ...frame[indices.at(-1)] }],
  });
  return encodeTimeline(events, {
    pixelCount,
    durationMilliseconds: duration,
    minimumFrameIntervalMilliseconds: minimum,
    maximumEvents: limits.maximum_timeline_events,
    maximumBytes: limits.maximum_timeline_bytes,
  });
}

module.exports = { scaleColor, renderPercentageFrame, frameBuffer, compileIndicatorTimeline };
