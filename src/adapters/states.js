'use strict';

// Aggregiert die von den Adapter-Instanzen gemeldeten States zu einem Baum
// (Instanz → Kategorie → beliebig viele Unterkategorien → State).
// Grundlage ist die persistierte Tabelle adapter_states (vom Host gepflegt), damit
// die States-Seite und der Picker auch bei gestopptem Adapter Namen anzeigen.

const bus = require('../state-bus');
const registry = require('./registry');
const instancesRepo = require('./instances');
const host = require('./host');
const { buildSchemeTopic } = require('../mqtt/topics');

// Zusätzliche States-Blöcke interner Module (z. B. Schaltgruppen): ein Provider
// liefert pro Aufruf 0..n Blöcke in derselben Form wie eine Adapter-Instanz
// (virtual: true). Sie erscheinen damit automatisch auf der States-Seite, im
// State-Picker und im Wertekatalog.
const statesProviders = [];
function registerStatesProvider(provider) {
  if (typeof provider === 'function' && !statesProviders.includes(provider)) {
    statesProviders.push(provider);
  }
}

function loadStateRows(db) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM adapter_states ORDER BY category, name, address', (err, rows) => {
      resolve(err ? [] : rows || []);
    });
  });
}

function displayValue(value, unit) {
  if (value == null || value === '') return '—';
  return unit ? `${value} ${unit}` : String(value);
}

function categoryParts(value) {
  const parts = String(value || 'Allgemein').split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : ['Allgemein'];
}

function categoryList(root) {
  return Array.from(root.values()).sort((a, b) => a.name.localeCompare(b.name, 'de')).map((node) => {
    const children = categoryList(node._children);
    const stateCount = node.states.length + children.reduce((sum, child) => sum + child.stateCount, 0);
    return { name: node.name, states: node.states, children, stateCount };
  });
}

function forEachState(categories, callback) {
  for (const category of categories || []) {
    for (const state of category.states || []) callback(state, category);
    forEachState(category.children, callback);
  }
}

async function buildStatesTree(db) {
  const instances = await instancesRepo.listInstances(db);
  const rows = await loadStateRows(db);
  const cache = bus.getCache();
  const rowsByInstance = new Map();
  for (const row of rows) {
    if (!rowsByInstance.has(row.instance_id)) rowsByInstance.set(row.instance_id, []);
    rowsByInstance.get(row.instance_id).push(row);
  }

  const blocks = instances.map((instance) => {
    const manifest = registry.getManifest(instance.adapterId);
    const prefix = manifest ? manifest.prefix : instance.adapterId;
    const categoryRoot = new Map();
    for (const row of rowsByInstance.get(instance.id) || []) {
      const topic = buildSchemeTopic(prefix, instance.name, row.address);
      const cached = cache.get(topic);
      const value = cached ? cached.value : row.last_value;
      let level = categoryRoot;
      let category;
      for (const name of categoryParts(row.category)) {
        if (!level.has(name)) level.set(name, { name, states: [], _children: new Map() });
        category = level.get(name);
        level = category._children;
      }
      category.states.push({
        address: row.address,
        name: row.name || row.address,
        topic,
        unit: row.unit || '',
        writable: !!row.writable,
        value: value == null ? null : value,
        display: displayValue(value, row.unit),
      });
    }
    const categories = categoryList(categoryRoot);
    return {
      instanceId: instance.id,
      instanceName: instance.name,
      adapterId: instance.adapterId,
      adapterName: manifest ? manifest.name : instance.adapterId,
      prefix,
      enabled: instance.enabled,
      running: host.isRunning(instance.id),
      categories,
    };
  });

  for (const provider of statesProviders) {
    const provided = await Promise.resolve().then(() => provider(db, cache)).catch(() => null);
    if (Array.isArray(provided)) blocks.push(...provided.filter(Boolean));
    else if (provided) blocks.push(provided);
  }
  return blocks;
}

module.exports = { buildStatesTree, registerStatesProvider, displayValue, forEachState, categoryParts };
