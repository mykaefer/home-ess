'use strict';

// Zentrale Leseschicht für alle homeESS-States. Systemwerte werden dynamisch
// berechnet, Adapter-Metadaten bleiben in adapter_states persistiert und ihre
// Livewerte kommen aus dem gemeinsamen State-Bus. Verbraucher müssen dadurch
// nicht mehr wissen, aus welcher Quelle ein State stammt.

const bus = require('../state-bus');
const { compareNodes, compareCatalogItems, compareText, sortStates } = require('./sort');
const stateProperties = require('./properties');
const {
  buildStatesTree: buildAdapterStatesTree,
  categoryParts,
} = require('../adapters/states');
const { listCalculatedInternalValues, VALUE_CATEGORIES } = require('./system-values');
const { topicForId } = require('./system-topics');
const customStates = require('./custom');

const SNAPSHOT_CACHE_MS = 900;
let snapshotCache = null;
let snapshotInFlight = null;

function categoryList(root, isRoot = false) {
  const order = new Map(VALUE_CATEGORIES.map((name, index) => [name, index]));
  return Array.from(root.values())
    .sort((a, b) => {
      if (!isRoot) return compareNodes(a, b);
      const left = order.has(a.name) ? order.get(a.name) : VALUE_CATEGORIES.length;
      const right = order.has(b.name) ? order.get(b.name) : VALUE_CATEGORIES.length;
      return left - right || compareNodes(a, b);
    })
    .map((node) => {
      const children = categoryList(node._children);
      const stateCount = node.states.length + children.reduce((sum, child) => sum + child.stateCount, 0);
      return { name: node.name, states: sortStates(node.states), children, stateCount };
    });
}

function systemCategories(values) {
  const root = new Map();
  for (const entry of values || []) {
    let level = root;
    let category = null;
    for (const name of categoryParts(entry.category)) {
      if (!level.has(name)) level.set(name, { name, states: [], _children: new Map() });
      category = level.get(name);
      level = category._children;
    }
    category.states.push({
      address: entry.id,
      name: entry.label,
      topic: topicForId(entry.id),
      unit: entry.unit || '',
      writable: false,
      topicSelectable: false,
      sourceType: 'system',
      value: entry.value,
      display: entry.display,
    });
  }
  return categoryList(root, true);
}

function mergeCategories(categories) {
  const byName = new Map();
  for (const category of categories || []) {
    if (!byName.has(category.name)) {
      byName.set(category.name, {
        name: category.name,
        states: [],
        children: [],
        stateCount: 0,
      });
    }
    const target = byName.get(category.name);
    target.states.push(...(category.states || []));
    target.children.push(...(category.children || []));
  }
  return Array.from(byName.values()).map((category) => {
    category.children = mergeCategories(category.children);
    category.stateCount = category.states.length
      + category.children.reduce((sum, child) => sum + child.stateCount, 0);
    return category;
  });
}

function decorateAdapterBlocks(blocks) {
  const decorateCategories = (categories) => (categories || []).map((category) => ({
    ...category,
    states: (category.states || []).map((state) => ({
      ...state,
      sourceType: state.sourceType || (state.topic && state.topic.startsWith('schaltgruppe://') ? 'system' : 'adapter'),
      topicSelectable: state.topicSelectable !== false,
    })),
    children: decorateCategories(category.children),
  }));
  return (blocks || []).map((block) => ({
    ...block,
    sourceType: block.virtual ? 'system' : 'adapter',
    categories: decorateCategories(block.categories),
  }));
}

async function buildStatesTree(db, cache = bus.getCache()) {
  const [system, adapters, custom] = await Promise.all([
    listCalculatedInternalValues(db, cache),
    buildAdapterStatesTree(db),
    customStates.buildStatesBlock(db),
  ]);
  const decorated = decorateAdapterBlocks(adapters);
  const virtual = decorated.filter((block) => block.virtual);
  const physical = decorated.filter((block) => !block.virtual);
  const blocks = [{
    instanceId: 'system',
    instanceName: 'system',
    adapterId: null,
    adapterName: 'System',
    prefix: 'system',
    enabled: true,
    running: true,
    virtual: true,
    system: true,
    sourceType: 'system',
    categories: mergeCategories([
      ...systemCategories(system),
      ...virtual.flatMap((block) => block.categories || []),
    ]),
  }, ...sortBlocks([custom, ...physical])];
  return stateProperties.applyToBlocks(blocks);
}

// Anzeigetitel eines Blocks – zugleich sein Sortierschlüssel. Der System-Block
// behält seinen festen Platz an der Spitze (wie im Wertekatalog), alle übrigen
// Prefix-Gruppen stehen alphanumerisch aufsteigend darunter.
function blockSortKey(block) {
  if (!block) return '';
  if (block.custom) return 'custom://';
  if (block.virtual) return String(block.adapterName || block.instanceName || '');
  return `${block.prefix}://${block.instanceName}`;
}

function sortBlocks(blocks) {
  return (blocks || []).filter(Boolean)
    .sort((left, right) => compareText(blockSortKey(left), blockSortKey(right)));
}

function entriesFromBlocks(blocks) {
  const entries = [];
  const walk = (categories, currentPath, block) => {
    const root = block.virtual ? (block.adapterName || block.instanceName || 'Sonstiges') : `Adapter: ${block.instanceName}`;
    for (const category of categories || []) {
      const nextPath = block.virtual && category.name === root && currentPath.length === 0
        ? currentPath
        : [...currentPath, category.name];
      for (const state of category.states || []) {
        entries.push({
          id: state.topic,
          label: state.catalogLabel || `${block.instanceName} – ${state.name}`,
          value: state.value,
          display: state.display,
          category: [root, ...nextPath].join(' / '),
          sourceType: state.sourceType || (block.virtual ? 'system' : 'adapter'),
          writable: !!state.writable,
          topicSelectable: state.topicSelectable !== false,
        });
      }
      walk(category.children, nextPath, block);
    }
  };
  for (const block of blocks || []) walk(block.categories, [], block);
  return entries;
}

async function listAllStates(db, cache = bus.getCache()) {
  if (snapshotCache && snapshotCache.db === db && snapshotCache.cache === cache &&
      Date.now() - snapshotCache.at < SNAPSHOT_CACHE_MS) {
    return snapshotCache.values;
  }
  if (snapshotInFlight && snapshotInFlight.db === db && snapshotInFlight.cache === cache) {
    return snapshotInFlight.promise;
  }
  const promise = Promise.all([
    listCalculatedInternalValues(db, cache),
    buildAdapterStatesTree(db),
    customStates.listCatalogEntries(db),
  ]).then(([system, adapters, custom]) => [
    ...system.map((entry) => ({
      ...entry,
      sourceType: 'system',
      writable: false,
      topicSelectable: false,
    })),
    ...entriesFromBlocks(decorateAdapterBlocks(adapters)),
    ...custom,
  ]).then((values) => stateProperties.applyToEntries(values).sort(compareCatalogItems));
  snapshotInFlight = { db, cache, promise };
  try {
    const values = await promise;
    snapshotCache = { db, cache, at: Date.now(), values };
    return values;
  } finally {
    if (snapshotInFlight && snapshotInFlight.promise === promise) snapshotInFlight = null;
  }
}

function invalidateStates() {
  snapshotCache = null;
}

module.exports = {
  buildStatesTree,
  listAllStates,
  invalidateStates,
  entriesFromBlocks,
};
