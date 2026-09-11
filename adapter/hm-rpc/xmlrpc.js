'use strict';

const http = require('http');

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function encodeValue(value) {
  if (value == null) return '<value><nil/></value>';
  if (Array.isArray(value)) return `<value><array><data>${value.map(encodeValue).join('')}</data></array></value>`;
  if (typeof value === 'object') {
    const members = Object.entries(value).map(([key, entry]) =>
      `<member><name>${escapeXml(key)}</name>${encodeValue(entry)}</member>`).join('');
    return `<value><struct>${members}</struct></value>`;
  }
  if (typeof value === 'boolean') return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  if (Number.isInteger(value)) return `<value><i4>${value}</i4></value>`;
  if (typeof value === 'number') return `<value><double>${value}</double></value>`;
  return `<value><string>${escapeXml(value)}</string></value>`;
}

function decodeText(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function inner(xml, tag) {
  const block = blocks(xml, tag)[0];
  if (!block) return null;
  const start = block.indexOf('>');
  const end = block.toLowerCase().lastIndexOf(`</${tag.toLowerCase()}>`);
  return start >= 0 && end >= start ? block.slice(start + 1, end) : '';
}

function blocks(xml, tag) {
  const result = [];
  const regex = new RegExp(`<\\/?${tag}(?:\\s[^>]*)?\\s*\\/?>`, 'gi');
  let match;
  let depth = 0;
  let start = -1;
  while ((match = regex.exec(xml))) {
    const closing = match[0].startsWith('</');
    const selfClosing = /\/>$/.test(match[0]);
    if (!closing) {
      if (depth === 0) start = match.index;
      if (!selfClosing) depth += 1;
      else if (depth === 0) result.push(match[0]);
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) result.push(xml.slice(start, regex.lastIndex));
    }
  }
  return result;
}

function decodeValue(xml) {
  const body = inner(xml, 'value');
  if (body == null) return '';
  const typed = /^\s*<([\w.]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>\s*$/i.exec(body);
  if (!typed) return decodeText(body.trim());
  const type = typed[1].toLowerCase();
  const content = typed[2];
  if (type === 'string' || type === 'datetime.iso8601' || type === 'base64') return decodeText(content);
  if (type === 'boolean') return content.trim() === '1' || content.trim().toLowerCase() === 'true';
  if (type === 'int' || type === 'i4' || type === 'i8') return Number.parseInt(content, 10);
  if (type === 'double') return Number(content);
  if (type === 'nil') return null;
  if (type === 'array') return blocks(inner(content, 'data') || '', 'value').map(decodeValue);
  if (type === 'struct') {
    const object = {};
    for (const member of blocks(content, 'member')) {
      const name = decodeText(inner(member, 'name') || '');
      const valueXml = blocks(member, 'value')[0];
      object[name] = valueXml ? decodeValue(valueXml) : null;
    }
    return object;
  }
  return decodeText(content);
}

function methodCall(method, params = []) {
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${params.map((p) => `<param>${encodeValue(p)}</param>`).join('')}</params></methodCall>`;
}

function methodResponse(value) {
  return `<?xml version="1.0"?><methodResponse><params><param>${encodeValue(value)}</param></params></methodResponse>`;
}

function parseCall(xml) {
  return {
    method: decodeText(inner(xml, 'methodName') || ''),
    params: blocks(inner(xml, 'params') || '', 'param').map((param) => decodeValue(blocks(param, 'value')[0] || '<value/>')),
  };
}

function parseResponse(xml) {
  const fault = inner(xml, 'fault');
  if (fault != null) {
    const detail = decodeValue(blocks(fault, 'value')[0] || '<value/>');
    const error = new Error(detail.faultString || 'XML-RPC-Fehler');
    error.code = detail.faultCode;
    throw error;
  }
  const value = blocks(inner(xml, 'params') || '', 'value')[0];
  return value ? decodeValue(value) : null;
}

function call(options, method, params = [], timeout = 10000) {
  const body = methodCall(method, params);
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err); else resolve(value);
    };
    // Kein implizites Keep-Alive des Node-Global-Agent: CCU-RPC-Dienste können
    // eine offene HTTP-Verbindung nach der ersten Antwort unbrauchbar lassen.
    const headers = { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body), Connection: 'close' };
    if (options.username) headers.Authorization = `Basic ${Buffer.from(`${options.username}:${options.password || ''}`).toString('base64')}`;
    const req = http.request({ host: options.host, port: options.port, path: '/', method: 'POST', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => finish(new Error('XML-RPC Antwort abgebrochen')));
      res.on('error', finish);
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
          const xml = Buffer.concat(chunks).toString('utf8');
          if (!/<methodResponse[\s>]/.test(xml) || !xml.includes('</methodResponse>')) throw new Error('Ungültige XML-RPC-Antwort');
          finish(null, { value: parseResponse(xml), localAddress: req.socket.localAddress });
        } catch (err) { finish(err); }
      });
    });
    // Absolutes Zeitlimit umfasst auch DNS, Verbindungsaufbau und Teilantworten.
    deadline = setTimeout(() => {
      const err = new Error('XML-RPC Zeitüberschreitung');
      finish(err);
      req.destroy(err);
    }, timeout);
    req.on('error', finish);
    req.end(body);
  });
}

module.exports = { call, encodeValue, methodResponse, parseCall, parseResponse };
