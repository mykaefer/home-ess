'use strict';

const crypto = require('crypto');
const { strictInteger } = require('./validation');

const OPCODES = Object.freeze({
  SET_PIXEL: 0x01,
  SET_RUN: 0x02,
  SET_RANGE_RGB: 0x03,
  FILL: 0x04,
});

function u16(value, label) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(strictInteger(value, 0, 0xffff, label));
  return buffer;
}

function u32(value, label) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(strictInteger(value, 0, 0xffffffff, label));
  return buffer;
}

function rgb(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} fehlt.`);
  return Buffer.from([
    strictInteger(value.r, 0, 255, `${label} Rot`),
    strictInteger(value.g, 0, 255, `${label} Grün`),
    strictInteger(value.b, 0, 255, `${label} Blau`),
  ]);
}

function encodeOperation(operation, pixelCount) {
  if (!operation || typeof operation !== 'object') throw new Error('Timelineoperation fehlt.');
  if (operation.op === 'FILL') return Buffer.concat([Buffer.from([OPCODES.FILL]), rgb(operation, 'FILL')]);
  if (operation.op === 'SET_PIXEL') {
    const index = strictInteger(operation.index, 0, pixelCount - 1, 'Pixelindex');
    return Buffer.concat([Buffer.from([OPCODES.SET_PIXEL]), u16(index, 'Pixelindex'), rgb(operation, 'SET_PIXEL')]);
  }
  if (operation.op === 'SET_RUN') {
    const start = strictInteger(operation.start, 0, pixelCount - 1, 'Run-Start');
    const count = strictInteger(operation.count, 1, pixelCount, 'Run-Länge');
    if (start + count > pixelCount) throw new Error('SET_RUN liegt außerhalb des Ausgangs.');
    return Buffer.concat([
      Buffer.from([OPCODES.SET_RUN]), u16(start, 'Run-Start'), u16(count, 'Run-Länge'),
      rgb(operation, 'SET_RUN'),
    ]);
  }
  if (operation.op === 'SET_RANGE_RGB') {
    const start = strictInteger(operation.start, 0, pixelCount - 1, 'Bereichsstart');
    if (!Array.isArray(operation.pixels) || operation.pixels.length < 1) throw new Error('SET_RANGE_RGB benötigt Pixel.');
    if (start + operation.pixels.length > pixelCount) throw new Error('SET_RANGE_RGB liegt außerhalb des Ausgangs.');
    return Buffer.concat([
      Buffer.from([OPCODES.SET_RANGE_RGB]), u16(start, 'Bereichsstart'),
      u16(operation.pixels.length, 'Bereichslänge'),
      ...operation.pixels.map((value) => rgb(value, 'Bereichspixel')),
    ]);
  }
  throw new Error(`Unbekannte Timelineoperation ${operation.op}.`);
}

function encodeTimeline(events, options) {
  if (!Array.isArray(events) || events.length < 1) throw new Error('Timeline benötigt mindestens ein Ereignis.');
  const pixelCount = strictInteger(options.pixelCount, 1, 0xffff, 'Pixelanzahl');
  const minimumInterval = strictInteger(options.minimumFrameIntervalMilliseconds, 1, 60000, 'Minimales Frameintervall');
  const duration = strictInteger(options.durationMilliseconds, 1, 86400000, 'Timelinedauer');
  const maximumEvents = strictInteger(options.maximumEvents, 1, 0xffff, 'Maximale Ereigniszahl');
  const maximumBytes = strictInteger(options.maximumBytes, 1, 0xffffffff, 'Maximale Timelinegröße');
  if (events.length > maximumEvents) throw new Error('Timeline überschreitet maximum_timeline_events.');
  let time = 0;
  const encoded = events.map((event, index) => {
    const delta = strictInteger(event.delta_milliseconds, 0, 0xffffffff, 'Timeline-Delta');
    if (index === 0 ? delta !== 0 : delta < minimumInterval) throw new Error('Timeline verletzt das minimale Frameintervall.');
    time += delta;
    if (time >= duration) throw new Error('Timelineereignis liegt außerhalb der Dauer.');
    if (!Array.isArray(event.operations) || event.operations.length < 1 || event.operations.length > 0xffff) {
      throw new Error('Timelineereignis benötigt Operationen.');
    }
    if (index === 0) {
      const first = event.operations[0];
      const absolute = first && (first.op === 'FILL'
        || (first.op === 'SET_RANGE_RGB' && first.start === 0
          && Array.isArray(first.pixels) && first.pixels.length === pixelCount));
      if (!absolute) throw new Error('Timeline muss mit einem absoluten Baselineframe beginnen.');
    }
    return Buffer.concat([
      u32(delta, 'Timeline-Delta'),
      u16(event.operations.length, 'Operationszahl'),
      ...event.operations.map((operation) => encodeOperation(operation, pixelCount)),
    ]);
  });
  const program = Buffer.concat(encoded);
  if (program.length > maximumBytes) throw new Error('Timeline überschreitet maximum_timeline_bytes.');
  return {
    program,
    eventCount: events.length,
    durationMilliseconds: duration,
    sha256: crypto.createHash('sha256').update(program).digest('hex'),
  };
}

module.exports = { OPCODES, encodeOperation, encodeTimeline };
