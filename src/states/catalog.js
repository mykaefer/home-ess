'use strict';

const { compareNodes, compareCatalogItems, compareStates } = require('./sort');
const registry = require('../adapters/registry');
const instancesRepo = require('../adapters/instances');
const {
  buildProvidedStatesBlocks,
  categoryParts,
  displayValue,
} = require('../adapters/states');
const { buildSchemeTopic, parseSchemeTopic } = require('../mqtt/topics');
const { parseSystemTopic } = require('./system-topics');
const {
  listCalculatedInternalValues,
} = require('./system-values');
const customStates = require('./custom');
const stateProperties = require('./properties');

const PAGE_SIZE = 100;
const MAX_PATH_LENGTH = 1000;
const MAX_SEARCH_LENGTH = 120;

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function normalizePath(path) {
  return String(path || '')
    .slice(0, MAX_PATH_LENGTH)
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' / ');
}

function pathParts(path) {
  const normalized = normalizePath(path);
  return normalized ? normalized.split(' / ') : [];
}

function adapterRoot(instance) {
  return `Adapter: ${instance.name}`;
}

function adapterPrefix(instance) {
  const manifest = registry.getManifest(instance.adapterId);
  return manifest ? manifest.prefix : instance.adapterId;
}

function catalogEntryFromState(state, instance, categoryPath) {
  const id = state.topic || buildSchemeTopic(adapterPrefix(instance), instance.name, state.address);
  const cachedValue = state.value;
  return {
    id,
    label: state.catalogLabel || `${instance.name} – ${state.name || state.address}`,
    value: cachedValue == null ? null : cachedValue,
    display: state.display == null ? displayValue(cachedValue, state.unit || '', id) : state.display,
    category: [adapterRoot(instance), ...categoryPath].join(' / '),
  };
}

function entriesFromProvidedBlocks(blocks) {
  const entries = [];
  const walk = (categories, currentPath, instance) => {
    const root = instance.adapterName || instance.instanceName || 'Sonstiges';
    for (const category of categories || []) {
      const nextPath = category.name === root && currentPath.length === 0
        ? currentPath
        : [...currentPath, category.name];
      for (const state of category.states || []) {
        entries.push({
          id: state.topic,
          label: state.catalogLabel || `${instance.instanceName} – ${state.name}`,
          value: state.value,
          display: state.display,
          category: [root, ...nextPath].join(' / '),
        });
      }
      walk(category.children, nextPath, instance);
    }
  };
  for (const block of blocks || []) walk(block.categories, [], block);
  return entries;
}

async function listLocalValues(db, cache) {
  const [calculated, provided, custom] = await Promise.all([
    listCalculatedInternalValues(db, cache),
    buildProvidedStatesBlocks(db, cache),
    customStates.listCatalogEntries(db),
  ]);
  return stateProperties.applyToEntries([
    ...calculated.map((entry) => ({
      ...entry,
      category: `System / ${entry.category || 'Sonstiges'}`,
      sourceType: 'system',
      topicSelectable: false,
    })),
    ...entriesFromProvidedBlocks(provided).map((entry) => ({
      ...entry,
      category: `System / ${entry.category || 'Sonstiges'}`,
      sourceType: 'system',
      topicSelectable: true,
    })),
    ...custom,
  ]);
}

function orderRootNodes(nodes) {
  const order = new Map([['System', 0]]);
  return nodes.sort((a, b) => {
    const left = order.has(a.name) ? order.get(a.name) : 1;
    const right = order.has(b.name) ? order.get(b.name) : 1;
    return left - right || compareNodes(a, b);
  });
}

function buildTree(values) {
  const root = new Map();
  for (const value of values || []) {
    let level = root;
    for (const name of categoryParts(value.category)) {
      if (!level.has(name)) {
        level.set(name, { name, count: 0, items: [], children: new Map() });
      }
      const node = level.get(name);
      node.count += 1;
      level = node.children;
    }
    const parts = categoryParts(value.category);
    let targetLevel = root;
    let target = null;
    for (const name of parts) {
      target = targetLevel.get(name);
      targetLevel = target.children;
    }
    if (target) target.items.push(value);
  }
  return root;
}

function findTreeNode(root, parts) {
  let level = root;
  let node = null;
  for (const part of parts) {
    node = level.get(part);
    if (!node) return null;
    level = node.children;
  }
  return node;
}

function nodeViews(nodes, parentPath, isRoot = false) {
  const result = Array.from(nodes.values()).map((node) => ({
    name: node.name,
    path: parentPath ? `${parentPath} / ${node.name}` : node.name,
    count: node.count,
  }));
  return isRoot ? orderRootNodes(result) : result.sort(compareNodes);
}

function pageItems(items, offset) {
  const sorted = [...items].sort(compareCatalogItems);
  const page = sorted.slice(offset, offset + PAGE_SIZE);
  return {
    items: page.map(({ id, label, display, category }) => ({ id, label, display, category })),
    nextOffset: offset + PAGE_SIZE < sorted.length ? offset + PAGE_SIZE : null,
  };
}

function localLevel(values, path, offset) {
  const parts = pathParts(path);
  const tree = buildTree(values);
  if (!parts.length) {
    return { path: '', nodes: nodeViews(tree, '', true), items: [], nextOffset: null };
  }
  const node = findTreeNode(tree, parts);
  if (!node) return { path, nodes: [], items: [], nextOffset: null };
  const page = pageItems(node.items, offset);
  return {
    path,
    nodes: nodeViews(node.children, path),
    items: page.items,
    nextOffset: page.nextOffset,
  };
}

async function adapterCounts(db) {
  return dbAll(
    db,
    `SELECT i.id, i.adapter_id, i.name, i.enabled, COUNT(s.address) AS state_count
       FROM adapter_instances i
       LEFT JOIN adapter_states s ON s.instance_id = i.id
      GROUP BY i.id, i.adapter_id, i.name, i.enabled
      HAVING COUNT(s.address) > 0
      ORDER BY i.name COLLATE NOCASE`
  );
}

async function findAdapterByRoot(db, root) {
  const instances = await instancesRepo.listInstances(db);
  return instances.find((instance) => adapterRoot(instance) === root) || null;
}

function startsWithParts(parts, prefix) {
  return prefix.every((part, index) => parts[index] === part);
}

async function adapterLevel(db, cache, instance, path, offset) {
  const root = adapterRoot(instance);
  const relative = pathParts(path).slice(1);
  const summaries = await dbAll(
    db,
    `SELECT category, COUNT(*) AS state_count
       FROM adapter_states
      WHERE instance_id = ?
      GROUP BY category`,
    [instance.id]
  );
  const children = new Map();
  const directCategories = [];
  for (const row of summaries) {
    const parts = categoryParts(row.category);
    if (!startsWithParts(parts, relative)) continue;
    if (parts.length === relative.length) {
      directCategories.push(row.category || '');
      continue;
    }
    const name = parts[relative.length];
    children.set(name, (children.get(name) || 0) + Number(row.state_count || 0));
  }
  const nodes = Array.from(children, ([name, count]) => ({
    name,
    path: `${path} / ${name}`,
    count,
  })).sort(compareNodes);

  let rows = [];
  let nextOffset = null;
  if (directCategories.length) {
    const placeholders = directCategories.map(() => '?').join(', ');
    // Sortiert wird in JavaScript: SQLite kennt keine alphanumerische
    // Kollation, sonst stünde „Kanal10" vor „Kanal2" und die Reihenfolge
    // spränge zwischen den Seiten.
    const all = await dbAll(
      db,
      `SELECT address, name, category, unit, last_value
         FROM adapter_states
        WHERE instance_id = ? AND category IN (${placeholders})`,
      [instance.id, ...directCategories]
    );
    all.sort(compareStates);
    rows = all.slice(offset, offset + PAGE_SIZE);
    if (all.length > offset + PAGE_SIZE) nextOffset = offset + PAGE_SIZE;
  }
  const items = rows.map((row) => {
    const id = buildSchemeTopic(adapterPrefix(instance), instance.name, row.address);
    const cached = cache.get(id);
    const value = cached ? cached.value : row.last_value;
    return catalogEntryFromState({
      ...row,
      topic: id,
      value,
      display: displayValue(value, row.unit, id),
    }, instance, categoryParts(row.category));
  }).map(({ id, label, display, category }) => ({ id, label, display, category }));

  return { path: normalizePath(path), nodes, items, nextOffset };
}

async function listCatalogLevel(db, cache, rawPath = '', rawOffset = 0) {
  const path = normalizePath(rawPath);
  const offset = Math.max(0, Number.parseInt(rawOffset, 10) || 0);
  const parts = pathParts(path);

  if (!parts.length) {
    // Die Wurzel besteht nur aus Metadaten. Berechnete Werte werden erst beim
    // Öffnen ihrer Kategorie erzeugt; Adapterwerte bleiben bis zum jeweiligen
    // Blatt vollständig unangetastet.
    const adapters = await adapterCounts(db);
    const customCount = (await dbGet(db, 'SELECT COUNT(*) AS count FROM custom_states')).count || 0;
    const localNodes = [
      { name: 'System', path: 'System', count: null },
      ...(customCount ? [{ name: 'Custom', path: 'Custom', count: Number(customCount) }] : []),
    ];
    const adapterNodes = adapters.map((instance) => ({
      name: adapterRoot(instance),
      path: adapterRoot(instance),
      count: Number(instance.state_count || 0),
    }));
    return {
      path: '',
      nodes: orderRootNodes([...localNodes, ...adapterNodes]),
      items: [],
      nextOffset: null,
    };
  }

  const instance = parts[0].startsWith('Adapter: ')
    ? await findAdapterByRoot(db, parts[0])
    : null;
  if (instance) return adapterLevel(db, cache, instance, path, offset);
  return localLevel(await listLocalValues(db, cache), path, offset);
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function searchAdapterValues(db, cache, query) {
  const like = `%${escapeLike(query.toLowerCase())}%`;
  const rows = await dbAll(
    db,
    `SELECT s.address, s.name, s.category, s.unit, s.last_value,
            i.id AS instance_id, i.adapter_id, i.name AS instance_name, i.enabled
       FROM adapter_states s
       JOIN adapter_instances i ON i.id = s.instance_id
      WHERE lower(s.name) LIKE ? ESCAPE '\\'
         OR lower(s.address) LIKE ? ESCAPE '\\'
         OR lower(s.category) LIKE ? ESCAPE '\\'
         OR lower(i.name) LIKE ? ESCAPE '\\'
      ORDER BY i.name COLLATE NOCASE, s.name COLLATE NOCASE, s.address
      LIMIT ?`,
    [like, like, like, like, PAGE_SIZE + 1]
  );
  const truncated = rows.length > PAGE_SIZE;
  const items = rows.slice(0, PAGE_SIZE).map((row) => {
    const instance = {
      id: row.instance_id,
      adapterId: row.adapter_id,
      name: row.instance_name,
      enabled: !!row.enabled,
    };
    const id = buildSchemeTopic(adapterPrefix(instance), instance.name, row.address);
    const cached = cache.get(id);
    const value = cached ? cached.value : row.last_value;
    return catalogEntryFromState({
      ...row,
      topic: id,
      value,
      display: displayValue(value, row.unit, id),
    }, instance, categoryParts(row.category));
  });
  return { items, truncated };
}

async function searchCatalog(db, cache, rawQuery = '') {
  const query = String(rawQuery || '').trim().slice(0, MAX_SEARCH_LENGTH);
  if (query.length < 2) return { query, items: [], truncated: false };
  const normalized = query.toLocaleLowerCase('de');
  const [localValues, adapterResult] = await Promise.all([
    listLocalValues(db, cache),
    searchAdapterValues(db, cache, query),
  ]);
  const localMatches = localValues.filter((entry) =>
    `${entry.category} ${entry.label} ${entry.id}`.toLocaleLowerCase('de').includes(normalized)
  );
  const combined = [...localMatches, ...adapterResult.items]
    .sort(compareCatalogItems);
  const truncated = adapterResult.truncated || combined.length > PAGE_SIZE;
  return {
    query,
    items: combined.slice(0, PAGE_SIZE)
      .map(({ id, label, display, category }) => ({ id, label, display, category })),
    truncated,
  };
}

async function resolveInternalValues(db, cache, sourceIds) {
  const wanted = new Set((sourceIds || []).map(String).filter(Boolean));
  if (!wanted.size) return [];
  const calculated = await listCalculatedInternalValues(db, cache);
  const found = calculated
    .filter((entry) => wanted.has(entry.id))
    .map((entry) => ({
      ...entry,
      category: `System / ${entry.category || 'Sonstiges'}`,
      sourceType: 'system',
      topicSelectable: false,
    }));
  const foundIds = new Set(found.map((entry) => entry.id));
  const missing = [...wanted].filter((id) => !foundIds.has(id));
  if (!missing.length) return found;

  const custom = await customStates.listCatalogEntries(db);
  found.push(...custom.filter((entry) => wanted.has(entry.id)));
  const customIds = new Set(found.map((entry) => entry.id));
  const missingAfterCustom = missing.filter((id) => !customIds.has(id));
  if (!missingAfterCustom.length) return found;

  const instances = await instancesRepo.listInstances(db);
  const instanceByKey = new Map();
  for (const instance of instances) {
    instanceByKey.set(`${adapterPrefix(instance)}\u0000${instance.name}`, instance);
  }
  const unresolved = [];
  for (const id of missingAfterCustom) {
    const parsed = parseSchemeTopic(id);
    const instance = parsed && instanceByKey.get(`${parsed.scheme}\u0000${parsed.instance}`);
    if (!parsed || !instance) {
      unresolved.push(id);
      continue;
    }
    const row = await dbGet(
      db,
      `SELECT address, name, category, unit, last_value
         FROM adapter_states
        WHERE instance_id = ? AND address = ?`,
      [instance.id, parsed.address]
    );
    if (!row) {
      unresolved.push(id);
      continue;
    }
    const cached = cache.get(id);
    const value = cached ? cached.value : row.last_value;
    found.push(catalogEntryFromState({
      ...row,
      topic: id,
      value,
      display: displayValue(value, row.unit, id),
    }, instance, categoryParts(row.category)));
  }

  if (unresolved.length) {
    const blocks = await buildProvidedStatesBlocks(db, cache);
    const wantedVirtual = new Set(unresolved);
    found.push(...entriesFromProvidedBlocks(blocks)
      .filter((entry) => wantedVirtual.has(entry.id))
      .map((entry) => ({
        ...entry,
        category: `System / ${entry.category || 'Sonstiges'}`,
        sourceType: 'system',
        topicSelectable: true,
      })));
  }
  return found;
}

// State-Verbraucher adressieren auch berechnete homeESS-Werte über ihr
// kanonisches system://-Topic. Der alte Wertekatalog verwendete dafür die
// fachliche Kurz-ID; diese Funktion hält beide Welten an der gemeinsamen
// Auflösungsgrenze auseinander, ohne Adapter-Topics umzuschreiben.
async function resolveStates(db, cache, stateTopics) {
  const requested = (stateTopics || []).map((topic) => String(topic || '').trim()).filter(Boolean);
  const lookupIds = requested.map((topic) => {
    const parsed = parseSystemTopic(topic);
    return parsed ? parsed.id : topic;
  });
  const values = await resolveInternalValues(db, cache, lookupIds);
  const byId = new Map(values.map((entry) => [entry.id, entry]));
  return requested.flatMap((topic) => {
    const parsed = parseSystemTopic(topic);
    const entry = byId.get(parsed ? parsed.id : topic);
    return entry ? [{ ...entry, id: topic, topic }] : [];
  });
}

module.exports = {
  PAGE_SIZE,
  listStatesLevel: listCatalogLevel,
  searchStates: searchCatalog,
  resolveStates,
  // Alte Namen bleiben als öffentliche Kompatibilitätsschicht erhalten.
  listCatalogLevel,
  searchCatalog,
  resolveInternalValues,
  normalizePath,
};
