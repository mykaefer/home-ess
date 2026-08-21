'use strict';

// Systemweite Warnfunktion.
//
// Jede Automatik, die einen Warntext an ihr MQTT-Warntopic schreibt, meldet
// denselben Text zusätzlich hier an. Der Text landet im System-State
// `operating.warnungText`, das Flag `operating.warnungAktiv` wird dabei
// automatisch auf true gesetzt. Solange das Flag steht, zeigt die Oberfläche
// auf jeder Seite ein Warnband. Erst das Quittieren durch den Nutzer setzt das
// Flag zurück und leert dabei auch den Warntext.
//
// Grundsatz: Hier landen ausschließlich Zustände, die ein Eingreifen des
// Nutzers erfordern — keine sporadischen Aussetzer, die sich von selbst
// erledigen.

const state = { active: false, text: '', raisedAt: 0, source: '' };
const acknowledgedListeners = new Set();

let database = null;

function run(db, sql, params = []) {
  // Fehler (z. B. fehlende Tabelle in minimalen Test-Schemata) werden
  // geschluckt; die Warnung bleibt dann rein im Speicher bestehen.
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    db.run(sql, params, (err) => resolve(!err));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve) => {
    if (!db) return resolve(null);
    db.get(sql, params, (err, row) => resolve(err ? null : row || null));
  });
}

// Systemwerte sofort neu berechnen, damit Warntext und Flag ohne Wartezeit auf
// den nächsten Intervalllauf in den States stehen. Später (nicht oben) geladen,
// weil die Systemwerte ihrerseits dieses Modul lesen.
function refreshSystemStates() {
  try {
    require('./states/system-runtime').schedule();
  } catch (_) {
    /* Ohne laufende Systemwert-Runtime (Tests) bleibt es beim Speicherstand. */
  }
}

async function init(db) {
  database = db;
  const row = await get(db, 'SELECT active, text, raised_at, source FROM system_warning WHERE id = 1');
  if (row) {
    state.active = !!row.active;
    state.text = row.text || '';
    state.raisedAt = Number(row.raised_at) || 0;
    state.source = row.source || '';
  }
  refreshSystemStates();
  return getState();
}

function getState() {
  return { ...state };
}

// Warnung melden. Ein identischer, bereits aktiver Text wird nicht erneut
// gesetzt — der Zeitstempel der ersten Meldung bleibt damit erhalten.
async function raise(db, text, options = {}) {
  const message = String(text == null ? '' : text).trim();
  if (!message) return getState();
  const source = String(options.source || '').trim();
  if (state.active && state.text === message) return getState();

  state.active = true;
  state.text = message;
  state.raisedAt = Number(options.now) || Date.now();
  state.source = source;
  await run(
    db || database,
    `INSERT INTO system_warning (id, active, text, raised_at, source) VALUES (1, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET active=1, text=excluded.text, raised_at=excluded.raised_at, source=excluded.source`,
    [state.text, state.raisedAt, state.source]
  );
  refreshSystemStates();
  return getState();
}

// Quittierung durch den Nutzer: Flag auf false und Warntext leeren. Die
// angemeldeten Zuhörer (z. B. die Netzsteuerung) räumen daraufhin ihre eigenen
// MQTT-Warntopics auf.
async function acknowledge(db) {
  const previous = getState();
  state.active = false;
  state.text = '';
  state.raisedAt = 0;
  state.source = '';
  await run(
    db || database,
    `INSERT INTO system_warning (id, active, text, raised_at, source) VALUES (1, 0, '', 0, '')
     ON CONFLICT(id) DO UPDATE SET active=0, text='', raised_at=0, source=''`
  );
  refreshSystemStates();
  for (const listener of acknowledgedListeners) {
    try {
      listener(previous);
    } catch (_) {
      /* Ein fehlerhafter Zuhörer darf die Quittierung nicht verhindern. */
    }
  }
  return getState();
}

function onAcknowledged(listener) {
  if (typeof listener !== 'function') return () => {};
  acknowledgedListeners.add(listener);
  return () => acknowledgedListeners.delete(listener);
}

function resetForTests() {
  state.active = false;
  state.text = '';
  state.raisedAt = 0;
  state.source = '';
  acknowledgedListeners.clear();
  database = null;
}

module.exports = { init, getState, raise, acknowledge, onAcknowledged, resetForTests };
