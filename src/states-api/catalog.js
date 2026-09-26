'use strict';

// Sicht der States API auf den zentralen homeESS-State-Baum.
//
// Grundlage ist ausschließlich states/repository.buildStatesTree() — derselbe
// Baum, den die States-Seite zeigt und über den /states/value schreibt. Hier
// entsteht keine eigene State-Struktur und keine Wertehaltung, nur ein
// kurzlebiger Index zum Nachschlagen:
//
//   Verzeichnis  – Wurzel („System“, „Custom“, „Adapter: <Instanz>“) plus die
//                  Kategorienamen, verbunden mit „ / “ (dieselbe Pfadform wie
//                  der States-Katalog unter /states/catalog)
//   State        – sein kanonisches Topic (system://…, custom://…, prefix://…)
//
// Ausschlüsse werden bei jeder Abfrage auf den fertigen Index angewendet.
// Ein State gilt als ausgeschlossen, wenn sein Topic ausgeschlossen ist oder
// irgendeines seiner Vorkommen in einem ausgeschlossenen Verzeichnis liegt;
// ein Verzeichnis, wenn es selbst oder ein übergeordnetes ausgeschlossen ist.
// Abgefragte Pfade werden immer erst auf einen Knoten des Index aufgelöst und
// dann geprüft — eine andere Schreibweise führt entweder zum selben Knoten
// (und damit zum selben Ergebnis) oder zu keinem.

const bus = require('../state-bus');
const { buildStatesTree } = require('../states/repository');
const { normalizePath } = require('../states/catalog');
const { isOn } = require('../states/controls');
const stateProperties = require('../states/properties');
const { parseSchemeTopic, buildSchemeTopic } = require('../mqtt/topics');

const INDEX_CACHE_MS = 1000;
const MAX_TEXT_LENGTH = 500;
const SEPARATOR = ' / ';

let indexCache = null;
let indexInFlight = null;

function canonicalTopic(topic) {
  const text = String(topic == null ? '' : topic).trim();
  const parsed = parseSchemeTopic(text);
  return parsed ? buildSchemeTopic(parsed.scheme, parsed.instance, parsed.address) : text;
}

function rootName(block) {
  if (block.system) return 'System';
  if (block.custom) return 'Custom';
  if (block.virtual) return String(block.adapterName || block.instanceName || 'System');
  return `Adapter: ${block.instanceName}`;
}

function folderNode(name, parent) {
  const path = parent && parent.path ? `${parent.path}${SEPARATOR}${name}` : name;
  return { name, path, parent: parent || null, children: new Map(), states: [], depth: parent ? parent.depth + 1 : 0 };
}

// Kategorienamen dürfen die Pfadtrennung nicht enthalten, sonst wäre ein Pfad
// mehrdeutig. Die Quellen zerlegen Kategorien bereits an „/“; hier wird der
// Rest abgesichert.
function segmentName(value) {
  return String(value == null ? '' : value).replace(/\s*\/\s*/g, ' - ').trim() || 'Allgemein';
}

function buildIndex(tree, cache) {
  const root = folderNode('', null);
  root.path = '';
  root.depth = -1;
  const folders = new Map([['', root]]);
  const byTopic = new Map();

  const ensureChild = (parent, name) => {
    const key = segmentName(name);
    if (!parent.children.has(key)) {
      const node = folderNode(key, parent.path === '' ? null : parent);
      node.parent = parent;
      node.depth = parent.depth + 1;
      parent.children.set(key, node);
      folders.set(node.path, node);
    }
    return parent.children.get(key);
  };

  const walk = (categories, parent, block) => {
    for (const category of categories || []) {
      const node = ensureChild(parent, category.name);
      for (const state of category.states || []) {
        const topic = canonicalTopic(state.topic);
        if (!topic) continue;
        const cached = cache && typeof cache.get === 'function' ? cache.get(topic) : null;
        const entry = {
          topic,
          state,
          folder: node,
          sourceType: state.sourceType || block.sourceType || (block.virtual ? 'system' : 'adapter'),
          receivedAt: cached && Number.isFinite(cached.receivedAt) ? cached.receivedAt : null,
        };
        node.states.push(entry);
        if (!byTopic.has(topic)) byTopic.set(topic, []);
        byTopic.get(topic).push(entry);
      }
      walk(category.children, node, block);
    }
  };

  for (const block of tree || []) {
    if (!block) continue;
    const blockRoot = ensureChild(root, rootName(block));
    walk(block.categories, blockRoot, block);
  }
  return { root, folders, byTopic };
}

async function loadIndex(db, cache = bus.getCache()) {
  const now = Date.now();
  if (indexCache && indexCache.db === db && indexCache.cache === cache && now - indexCache.at < INDEX_CACHE_MS) {
    return indexCache.index;
  }
  if (indexInFlight && indexInFlight.db === db && indexInFlight.cache === cache) return indexInFlight.promise;
  const promise = buildStatesTree(db, cache).then((tree) => buildIndex(tree, cache));
  indexInFlight = { db, cache, promise };
  try {
    const index = await promise;
    indexCache = { db, cache, at: Date.now(), index };
    return index;
  } finally {
    if (indexInFlight && indexInFlight.promise === promise) indexInFlight = null;
  }
}

function invalidate() {
  indexCache = null;
}

// ── Ausschlüsse ─────────────────────────────────────────────────────────────

function exclusionSets(exclusions = {}) {
  return {
    folders: new Set((exclusions.excludedFolders || []).map((path) => normalizePath(path)).filter(Boolean)),
    states: new Set((exclusions.excludedStates || []).map(canonicalTopic).filter(Boolean)),
  };
}

// Ausgeschlossen durch sich selbst oder einen Vorfahren?
function folderExcluded(node, sets) {
  for (let current = node; current && current.path; current = current.parent) {
    if (sets.folders.has(current.path)) return true;
  }
  return false;
}

// Liegt der Ausschluss direkt auf dem Verzeichnis oder erbt es ihn?
function folderExclusionSource(node, sets) {
  if (!node || !node.path) return null;
  if (sets.folders.has(node.path)) return 'self';
  for (let current = node.parent; current && current.path; current = current.parent) {
    if (sets.folders.has(current.path)) return 'parent';
  }
  return null;
}

function stateExcluded(index, topic, sets) {
  if (sets.states.has(topic)) return true;
  const occurrences = index.byTopic.get(topic) || [];
  return occurrences.some((entry) => folderExcluded(entry.folder, sets));
}

function isUnder(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

// ── Datenmodell eines States ────────────────────────────────────────────────

const NUMBER_RE = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/;

function isNumericText(value) {
  return typeof value === 'string' && NUMBER_RE.test(value.trim());
}

function numberFrom(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (isNumericText(value)) {
    const number = Number(value.trim().replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// Datentyp: Beschreibbare States bringen über ihr Bedienelement mit, wie sie
// gesetzt werden (Module und Custom States melden das selbst, sonst leitet
// states/controls.js es wie auf der States-Seite ab). Für reine Lesewerte zählt
// der aktuelle Wert. Ohne Wert bleibt der Typ unbekannt (null).
function dataType(state) {
  const control = state.writable ? state.control : null;
  if (control) {
    if (control.type === 'switch') return 'boolean';
    if (control.type === 'number') return 'number';
    if (control.type === 'select') {
      const options = control.options || [];
      return options.length && options.every((option) => isNumericText(String(option.value))) ? 'number' : 'string';
    }
    return 'string';
  }
  const value = state.value;
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null;
  if (typeof value === 'object') return 'json';
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'false') return 'boolean';
  if (isNumericText(text)) return 'number';
  return 'string';
}

function apiValue(value, type) {
  if (value == null) return null;
  if (type === 'boolean') return value === '' ? null : isOn(value);
  if (type === 'number') {
    const number = numberFrom(value);
    return number == null ? (value === '' ? null : value) : number;
  }
  if (type === 'string') return String(value);
  return value;
}

function controlView(control, type) {
  if (!control) return undefined;
  const view = { type: control.type };
  if (control.type === 'number') {
    if (Number.isFinite(control.min)) view.min = control.min;
    if (Number.isFinite(control.max)) view.max = control.max;
    const step = Number(control.step);
    if (control.step != null && control.step !== 'any' && Number.isFinite(step) && step > 0) view.step = step;
  } else if (control.type === 'select') {
    view.options = (control.options || []).map((option) => ({
      value: type === 'number' ? Number(option.value) : String(option.value),
      label: String(option.label),
    }));
  }
  return view;
}

function serializeState(entry) {
  const { state } = entry;
  const type = dataType(state);
  const result = {
    topic: entry.topic,
    name: String(state.name == null ? entry.topic : state.name),
    folder: entry.folder.path,
    value: apiValue(state.value, type),
    display: state.display == null ? null : String(state.display),
    type,
    readable: true,
    writable: state.writable === true,
    source: entry.sourceType,
  };
  if (state.unit) result.unit = String(state.unit);
  const properties = stateProperties.get(entry.topic);
  if (properties && Number.isInteger(properties.decimals)) result.decimals = properties.decimals;
  if (result.writable) {
    const control = controlView(state.control, type);
    if (control) result.control = control;
  }
  if (entry.receivedAt) result.updatedAt = new Date(entry.receivedAt).toISOString();
  return result;
}

// ── Gefilterte Sicht (API) ──────────────────────────────────────────────────

// Sicht mit angewendeten Ausschlüssen. Was hier nicht erscheint, existiert für
// API-Clients nicht — auch nicht in Zählern oder Verzeichnislisten.
function apiView(index, exclusions) {
  const sets = exclusionSets(exclusions);
  const visibleCount = new Map();

  const countFolder = (node) => {
    if (visibleCount.has(node)) return visibleCount.get(node);
    let count = 0;
    if (!node.path || !folderExcluded(node, sets)) {
      count = node.states.filter((entry) => !stateExcluded(index, entry.topic, sets)).length;
      for (const child of node.children.values()) count += countFolder(child);
    }
    visibleCount.set(node, count);
    return count;
  };

  const folderVisible = (node) => !!node && (!node.path || (!folderExcluded(node, sets) && countFolder(node) > 0));

  const visibleStates = (node) => node.states.filter((entry) => !stateExcluded(index, entry.topic, sets));

  function findFolder(path) {
    const normalized = normalizePath(path);
    const node = index.folders.get(normalized);
    return folderVisible(node) ? node : null;
  }

  function childFolders(node) {
    return [...node.children.values()]
      .filter(folderVisible)
      .map((child) => ({
        name: child.name,
        path: child.path,
        stateCount: countFolder(child),
        folderCount: [...child.children.values()].filter(folderVisible).length,
      }));
  }

  function listFolder(node) {
    return {
      path: node.path,
      name: node.name,
      parent: node.path ? (node.parent && node.parent.path) || '' : null,
      folders: childFolders(node),
      states: visibleStates(node).map(serializeState),
    };
  }

  // Alle sichtbaren States unterhalb eines Verzeichnisses in Baumreihenfolge,
  // jedes Topic genau einmal.
  function allStates(node = index.root) {
    const seen = new Set();
    const result = [];
    const walk = (current) => {
      if (!folderVisible(current)) return;
      for (const entry of visibleStates(current)) {
        if (seen.has(entry.topic)) continue;
        seen.add(entry.topic);
        result.push(entry);
      }
      for (const child of current.children.values()) walk(child);
    };
    walk(node);
    return result;
  }

  function findState(topic) {
    const canonical = canonicalTopic(topic);
    if (!canonical) return null;
    const occurrences = index.byTopic.get(canonical);
    if (!occurrences || !occurrences.length) return null;
    if (stateExcluded(index, canonical, sets)) return null;
    return occurrences[0];
  }

  return { findFolder, listFolder, allStates, findState, serializeState };
}

// ── Sicht für die Einstellungen (alle Einträge mit Freigabestatus) ──────────

function settingsLevel(index, exclusions, path, offset = 0, pageSize = 200) {
  const sets = exclusionSets(exclusions);
  const normalized = normalizePath(path);
  const node = index.folders.get(normalized);
  if (!node) return null;
  const source = folderExclusionSource(node, sets);
  if (source) {
    // Kinder eines ausgeschlossenen Verzeichnisses sind nicht separat
    // konfigurierbar und werden deshalb nicht geliefert.
    return { path: node.path, name: node.name, excluded: true, exclusion: source, folders: [], states: [], nextOffset: null };
  }
  const totalCount = (current) => current.states.length
    + [...current.children.values()].reduce((sum, child) => sum + totalCount(child), 0);
  const folders = [...node.children.values()].map((child) => ({
    name: child.name,
    path: child.path,
    stateCount: totalCount(child),
    excluded: sets.folders.has(child.path),
  }));
  const start = Math.max(0, Number.parseInt(offset, 10) || 0);
  const page = node.states.slice(start, start + pageSize);
  return {
    path: node.path,
    name: node.name,
    excluded: false,
    exclusion: null,
    folders,
    states: page.map((entry) => ({
      topic: entry.topic,
      name: String(entry.state.name == null ? entry.topic : entry.state.name),
      display: entry.state.display == null ? '' : String(entry.state.display),
      writable: entry.state.writable === true,
      excluded: sets.states.has(entry.topic),
    })),
    nextOffset: start + pageSize < node.states.length ? start + pageSize : null,
  };
}

// Neue Ausschlussliste nach einer Änderung aus den Einstellungen. Liefert
// { excludedFolders, excludedStates } oder wirft einen Fehler mit `status`.
// Hält das Regelwerk widerspruchsfrei: Unterhalb eines ausgeschlossenen
// Verzeichnisses gibt es keine eigenen Einträge.
function applyExclusionChange(index, exclusions, change) {
  const sets = exclusionSets(exclusions);
  const folders = [...sets.folders];
  let states = [...sets.states];
  const excluded = change.excluded === true;
  const fail = (status, message) => {
    const error = new Error(message);
    error.status = status;
    throw error;
  };

  if (change.kind === 'folder') {
    const node = index.folders.get(normalizePath(change.path));
    if (!node || !node.path) fail(404, 'Dieses Verzeichnis ist nicht bekannt.');
    const source = folderExclusionSource(node, sets);
    if (excluded) {
      if (source) return { excludedFolders: folders, excludedStates: states, changed: false, node };
      const remainingFolders = folders.filter((path) => {
        const other = index.folders.get(path);
        return !(other && isUnder(other, node));
      });
      // Einzelausschlüsse, deren Vorkommen alle im Verzeichnis liegen, sind
      // jetzt überflüssig; ein Vorkommen außerhalb hält den Eintrag.
      states = states.filter((topic) => {
        const occurrences = index.byTopic.get(topic) || [];
        return !(occurrences.length && occurrences.every((entry) => isUnder(entry.folder, node)));
      });
      return { excludedFolders: [...remainingFolders, node.path], excludedStates: states, changed: true, node };
    }
    if (source === 'parent') fail(409, 'Ein übergeordnetes Verzeichnis ist ausgeschlossen.');
    if (!source) return { excludedFolders: folders, excludedStates: states, changed: false, node };
    return { excludedFolders: folders.filter((path) => path !== node.path), excludedStates: states, changed: true, node };
  }

  if (change.kind === 'state') {
    const topic = canonicalTopic(change.topic);
    const occurrences = index.byTopic.get(topic);
    if (excluded) {
      if (!occurrences || !occurrences.length) fail(404, 'Dieser State ist nicht bekannt.');
      if (sets.states.has(topic)) return { excludedFolders: folders, excludedStates: states, changed: false, topic };
      if (occurrences.every((entry) => folderExcluded(entry.folder, sets))) {
        fail(409, 'Ein übergeordnetes Verzeichnis ist ausgeschlossen.');
      }
      return { excludedFolders: folders, excludedStates: [...states, topic], changed: true, topic };
    }
    if (occurrences && occurrences.some((entry) => folderExcluded(entry.folder, sets))) {
      fail(409, 'Ein übergeordnetes Verzeichnis ist ausgeschlossen.');
    }
    return {
      excludedFolders: folders,
      excludedStates: states.filter((entry) => entry !== topic),
      changed: sets.states.has(topic),
      topic,
    };
  }
  return fail(400, 'Unbekannte Änderung.');
}

// ── Schreibprüfung ──────────────────────────────────────────────────────────

function writeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Prüft einen Schreibwert gegen das Bedienelement des States und liefert die
// Zeichenkette, die über mqttClient.publish() geschrieben wird — dieselbe
// Darstellung, die auch die States-Seite sendet.
function payloadFor(state, value) {
  const control = state.control || { type: 'text' };
  if (value === null || typeof value === 'object') {
    throw writeError('invalid_value', 'Der Wert hat einen ungültigen Datentyp.');
  }
  if (control.type === 'switch') {
    if (value === true) return String(control.on);
    if (value === false) return String(control.off);
    if (typeof value === 'string' && (value === String(control.on) || value === String(control.off))) return value;
    throw writeError('invalid_value', 'Erwartet wird true oder false.');
  }
  if (control.type === 'number') {
    if (typeof value === 'boolean') throw writeError('invalid_value', 'Erwartet wird eine Zahl.');
    const number = numberFrom(value);
    if (number == null) throw writeError('invalid_value', 'Erwartet wird eine Zahl.');
    if (Number.isFinite(control.min) && number < control.min) {
      throw writeError('invalid_value', 'Der Wert liegt unter dem zulässigen Minimum.');
    }
    if (Number.isFinite(control.max) && number > control.max) {
      throw writeError('invalid_value', 'Der Wert liegt über dem zulässigen Maximum.');
    }
    const step = Number(control.step);
    if (control.step !== 'any' && Number.isFinite(step) && step > 0) {
      const base = Number.isFinite(control.min) ? control.min : 0;
      const ratio = (number - base) / step;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        throw writeError('invalid_value', 'Der Wert passt nicht zur zulässigen Schrittweite.');
      }
    }
    return String(number);
  }
  if (control.type === 'select') {
    const text = String(value);
    const option = (control.options || []).find((entry) => String(entry.value) === text);
    if (!option) throw writeError('invalid_value', 'Der Wert gehört nicht zu den zulässigen Optionen.');
    return String(option.value);
  }
  const text = String(value);
  if (text.length > MAX_TEXT_LENGTH) throw writeError('invalid_value', 'Der Text ist zu lang (höchstens 500 Zeichen).');
  return text;
}

module.exports = {
  loadIndex,
  invalidate,
  buildIndex,
  apiView,
  settingsLevel,
  applyExclusionChange,
  payloadFor,
  serializeState,
  canonicalTopic,
  dataType,
  apiValue,
};
