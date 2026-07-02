'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decode, encode, registerCount, regsToBuffer } = require('../adapter/modbus/decode');
const { buildPollGroups } = require('../adapter/modbus/index');

test('registerCount je Datentyp', () => {
  assert.equal(registerCount({ dataType: 'uint16' }), 1);
  assert.equal(registerCount({ dataType: 'int32' }), 2);
  assert.equal(registerCount({ dataType: 'float64' }), 4);
  assert.equal(registerCount({ dataType: 'string', length: 8 }), 8);
});

test('uint16 mit Skalierung/Offset', () => {
  assert.equal(decode([2353], { dataType: 'uint16', scale: 0.01 }), 23.53);
  assert.equal(decode([100], { dataType: 'int16', scale: 1, offset: -50 }), 50);
});

test('int16 negativ', () => {
  assert.equal(decode([0xffff], { dataType: 'int16' }), -1);
});

test('int32 Big-Endian vs Word-Swap', () => {
  // 70000 = 0x00011170 -> Register [0x0001, 0x1170]
  assert.equal(decode([0x0001, 0x1170], { dataType: 'int32', byteOrder: 'big', wordOrder: 'big' }), 70000);
  // Word-Swap: dieselben Register, niederwertiges Wort zuerst
  assert.equal(decode([0x1170, 0x0001], { dataType: 'int32', wordOrder: 'little' }), 70000);
});

test('float32 Big-Endian', () => {
  // 1.5f = 0x3FC00000 -> [0x3FC0, 0x0000]
  assert.equal(decode([0x3fc0, 0x0000], { dataType: 'float32' }), 1.5);
});

test('bit-Extraktion', () => {
  assert.equal(decode([0b0000000000000100], { dataType: 'bit', bit: 2 }), true);
  assert.equal(decode([0b0000000000000100], { dataType: 'bit', bit: 1 }), false);
});

test('Byte-Swap innerhalb des Registers', () => {
  // regsToBuffer mit byteOrder little vertauscht die Bytes je Register
  assert.deepEqual([...regsToBuffer([0x1234], 'little', 'big')], [0x34, 0x12]);
  assert.deepEqual([...regsToBuffer([0x1234], 'big', 'big')], [0x12, 0x34]);
});

test('encode/decode Roundtrip', () => {
  for (const dt of ['int16', 'uint16', 'int32', 'uint32', 'float32']) {
    const reg = { dataType: dt, byteOrder: 'big', wordOrder: 'big', scale: 1, offset: 0 };
    const value = dt === 'float32' ? 12.5 : 1234;
    assert.equal(decode(encode(value, reg), reg), value, `Roundtrip ${dt}`);
  }
  // mit Skalierung
  const reg = { dataType: 'uint16', scale: 0.1, offset: 0 };
  assert.equal(decode(encode(23.5, reg), reg), 23.5);
});

test('Modbus-Polling gruppiert nur zusammenhängende Register gleicher Klasse', () => {
  const regs = [
    { unitId: 1, register: 10, registerType: 'holding', dataType: 'uint16', pollIntervalMs: 1000 },
    { unitId: 1, register: 11, registerType: 'holding', dataType: 'float32', pollIntervalMs: 1000 },
    { unitId: 1, register: 13, registerType: 'holding', dataType: 'uint16', pollIntervalMs: 5000 },
    { unitId: 2, register: 20, registerType: 'input', dataType: 'uint16', pollIntervalMs: 1000 },
  ];
  const groups = buildPollGroups(regs);
  assert.equal(groups.length, 3);
  const combined = groups.find((group) => group.start === 10);
  assert.equal(combined.count, 3);
  assert.equal(combined.items.length, 2);
  assert.deepEqual(combined.items.map((item) => item.offset), [0, 1]);
});
