'use strict';

const crypto = require('crypto');

const HEX_32_RE = /^[0-9a-f]{32}$/;
const BINDING_KEY_RE = /^[0-9a-f]{64}$/;
const BINDING_ID_RE = /^[0-9a-f]{64}$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function createAdapterNonce() {
  return randomHex(16);
}

function createBindingKey() {
  return randomHex(32);
}

function validateNonce(value, label = 'Nonce') {
  const text = String(value || '');
  if (!HEX_32_RE.test(text)) throw new Error(`${label} muss aus exakt 32 lowercase Hexzeichen bestehen.`);
  return text;
}

function validateBindingKey(value) {
  const text = String(value || '');
  if (!BINDING_KEY_RE.test(text)) {
    const error = new Error('Binding-Key muss aus exakt 64 lowercase Hexzeichen bestehen.');
    error.code = 'INVALID_BINDING_KEY';
    error.status = 422;
    throw error;
  }
  return text;
}

function validateBindingId(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const text = String(value || '');
  if (!BINDING_ID_RE.test(text)) throw new Error('Binding-ID muss aus exakt 64 lowercase Hexzeichen bestehen.');
  return text;
}

function validateInstanceId(value) {
  const text = String(value || '');
  if (!INSTANCE_ID_RE.test(text)) throw new Error('Ungültige HDP-Instanz-ID.');
  return text;
}

function bindingId(bindingKey) {
  return crypto.createHash('sha256').update(Buffer.from(validateBindingKey(bindingKey), 'hex')).digest('hex');
}

function bindingHeaders(credentials) {
  if (!credentials || !credentials.instanceId || !credentials.bindingKey) {
    throw new Error('HDP-Binding-Credentials fehlen.');
  }
  return {
    'X-HDP-Instance': validateInstanceId(credentials.instanceId),
    'X-HDP-Binding-Key': validateBindingKey(credentials.bindingKey),
  };
}

function basicAuthorization(credentials) {
  if (!credentials || !credentials.instanceId || !credentials.bindingKey) {
    throw new Error('HDP-Binding-Credentials fehlen.');
  }
  const value = `${validateInstanceId(credentials.instanceId)}:${validateBindingKey(credentials.bindingKey)}`;
  return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data || Buffer.alloc(0)).digest('hex');
}

module.exports = {
  HEX_32_RE,
  BINDING_KEY_RE,
  BINDING_ID_RE,
  randomHex,
  createAdapterNonce,
  createBindingKey,
  validateNonce,
  validateBindingKey,
  validateBindingId,
  validateInstanceId,
  bindingId,
  bindingHeaders,
  basicAuthorization,
  sha256,
};
