'use strict';

// Zentrale, wiederverwendbare Routine für den Wertekatalog. Statt eines langen
// Dropdowns wird eine kompakte Liste mit schmalen Zeilen und einklappbaren
// Kategorien (= Herkunft des Wertes) samt aktuellem Ist-Wert gerendert. Die
// Auswahl landet in einem versteckten Eingabefeld (`inputId`), sodass sich das
// Bauteil unverändert in bestehende Formulare einfügt.
//
// Kategorien können – wie beim Adapter-State-Picker – MEHRERE Verzeichnisebenen
// abbilden: ein `category` der Form „A / B / C" wird als eingerückter Baum
// dargestellt. Der Auf-/Zuklapp-Zustand jeder Ebene wird clientseitig in
// localStorage gemerkt (gleiche „Merken"-Logik wie der Topic-Picker); die Suche
// klappt Treffer auf und stellt beim Leeren den gemerkten Zustand wieder her.
//
// Eingebunden auf der Output-Seite (Dialog „Hinzufuegen") und im Dashboard
// (Dialog „Widget hinzufuegen").

const { escapeHtml } = require('./components');
const { VALUE_CATEGORIES } = require('../output/internal-values');

// Kategorie-Pfad („A / B / C") in seine Ebenen zerlegen (identisch zur Logik der
// Adapter-States, damit sich beide Bäume gleich verhalten).
function categoryParts(value) {
  const parts = String(value == null ? '' : value)
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : ['Sonstiges'];
}

// Werte anhand ihres (mehrstufigen) Kategorie-Pfades zu einem Baum gruppieren.
// Rückgabe: sortierte Knotenliste mit { name, key, depth, items, children, count }.
// key = vollständiger Pfad (Persistenz-Schlüssel), depth = Verschachtelungstiefe.
function buildValueCatalogTree(values) {
  const root = new Map();
  for (const value of values || []) {
    let level = root;
    let node = null;
    for (const name of categoryParts(value.category)) {
      if (!level.has(name)) level.set(name, { name, items: [], children: new Map() });
      node = level.get(name);
      level = node.children;
    }
    if (node) node.items.push(value);
  }
  return toNodeList(root, true, '', 0);
}

function orderNodes(level, isTop) {
  const nodes = Array.from(level.values());
  if (!isTop) return nodes.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  // Oberste Ebene: bekannte Kategorien in fester Reihenfolge, der Rest alphabetisch.
  const known = VALUE_CATEGORIES.filter((cat) => level.has(cat)).map((cat) => level.get(cat));
  const extra = nodes
    .filter((node) => !VALUE_CATEGORIES.includes(node.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return [...known, ...extra];
}

function toNodeList(level, isTop, parentKey, depth) {
  return orderNodes(level, isTop).map((node) => {
    const key = parentKey ? `${parentKey} / ${node.name}` : node.name;
    const children = toNodeList(node.children, false, key, depth + 1);
    const items = node.items.slice().sort((a, b) => String(a.label).localeCompare(String(b.label), 'de'));
    const count = items.length + children.reduce((sum, child) => sum + child.count, 0);
    return { name: node.name, key, depth, items, children, count };
  });
}

function subtreeContainsSelected(node, selectedId) {
  if (!selectedId) return false;
  if (node.items.some((item) => item.id === selectedId)) return true;
  return node.children.some((child) => subtreeContainsSelected(child, selectedId));
}

function renderRow(item, inputId, selectedId, catKey) {
  const isSel = item.id === selectedId;
  // data-search enthält Kategorie-Pfad + Label, damit die Suche auch Kategorien
  // (und damit ganze Zweige) findet – analog zum Adapter-State-Picker.
  const search = escapeHtml(`${catKey} ${item.label}`.toLowerCase());
  return `              <button type="button" class="value-row${isSel ? ' is-selected' : ''}" data-id="${escapeHtml(item.id)}" data-label="${escapeHtml(item.label)}" data-search="${search}" onclick="valueCatalogSelect('${escapeHtml(inputId)}', this)">
                <span class="value-row-label">${escapeHtml(item.label)}</span>
                <span class="value-row-now">${escapeHtml(item.display == null ? '—' : item.display)}</span>
              </button>`;
}

function renderCatalogNode(node, inputId, selectedId) {
  // Beim Server-Render nur die Kette bis zum ausgewählten Wert öffnen; der
  // gemerkte Zustand wird clientseitig beim Öffnen des Dialogs angewandt.
  const open = subtreeContainsSelected(node, selectedId);
  const rows = node.items.map((item) => renderRow(item, inputId, selectedId, node.key)).join('\n');
  const children = node.children.map((child) => renderCatalogNode(child, inputId, selectedId)).join('\n');
  const body = [rows, children].filter(Boolean).join('\n');
  return `            <div class="value-cat${node.depth ? ' value-cat--nested' : ''}${open ? ' is-open' : ''}" style="--tree-depth:${node.depth}" data-cat-key="${escapeHtml(node.key)}">
              <button type="button" class="value-cat-head" aria-expanded="${open ? 'true' : 'false'}" onclick="valueCatalogToggle(this)">
                <span class="value-cat-caret" aria-hidden="true">▸</span>
                <span class="value-cat-name">${escapeHtml(node.name)}</span>
                <span class="value-cat-count">${node.count}</span>
              </button>
              <div class="value-cat-body">
${body}
              </div>
            </div>`;
}

// renderValueCatalog({ values, inputId, name, selectedId, label })
// values: [{ id, label, display, category }]
function renderValueCatalog({ values = [], inputId, name, selectedId = '', label = 'Interner Wert' } = {}) {
  const fieldName = name || inputId;
  const tree = buildValueCatalogTree(values);
  const selected = values.find((value) => value.id === selectedId) || null;
  const categories = tree.map((node) => renderCatalogNode(node, inputId, selectedId)).join('\n');

  const emptyHint = values.length
    ? ''
    : '<p class="muted form-hint">Noch keine internen Werte verfuegbar. Bitte zuerst MQTT-Quellen konfigurieren.</p>';

  return `          <div class="field-block value-catalog" id="catalog-${escapeHtml(inputId)}" data-input="${escapeHtml(inputId)}">
            <span>${escapeHtml(label)}</span>
            <input type="hidden" id="${escapeHtml(inputId)}" name="${escapeHtml(fieldName)}" value="${escapeHtml(selectedId)}">
            <div class="value-catalog-bar">
              <input type="text" class="value-catalog-search" placeholder="Wert suchen…" oninput="valueCatalogFilter('${escapeHtml(inputId)}', this.value)">
              <span class="value-catalog-selected${selected ? ' has-value' : ''}" id="${escapeHtml(inputId)}-selected">${selected ? escapeHtml(selected.label) : 'Kein Wert gewählt'}</span>
            </div>
            <div class="value-catalog-cats">
${categories}
            </div>
            ${emptyHint}
          </div>`;
}

// Gemeinsame Client-Logik. Wird einmalig in den Seiten-Script eingehängt und
// von beliebig vielen Katalog-Instanzen (über die inputId adressiert) genutzt.
function valueCatalogScript() {
  return `    var VALUE_CATALOG_EXPAND_KEY = 'homeess.valuecatalog.expanded.v1';
    var valueCatalogExpandedCache = null;

    // Gemerkter Aufklapp-Zustand (Pfad -> true), gemeinsam für alle Kataloge –
    // gleiche „Merken"-Logik wie der Topic-/State-Picker.
    function valueCatalogLoadExpanded() {
      if (valueCatalogExpandedCache) return valueCatalogExpandedCache;
      try { valueCatalogExpandedCache = JSON.parse(localStorage.getItem(VALUE_CATALOG_EXPAND_KEY) || '{}') || {}; }
      catch (_) { valueCatalogExpandedCache = {}; }
      return valueCatalogExpandedCache;
    }
    function valueCatalogSaveExpanded(map) {
      valueCatalogExpandedCache = map;
      try { localStorage.setItem(VALUE_CATALOG_EXPAND_KEY, JSON.stringify(map)); } catch (_) {}
    }

    function valueCatalogSetOpen(cat, open) {
      cat.classList.toggle('is-open', !!open);
      var head = cat.querySelector(':scope > .value-cat-head');
      if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function valueCatalogToggle(head) {
      var cat = head.parentNode;
      var open = !cat.classList.contains('is-open');
      valueCatalogSetOpen(cat, open);
      var key = cat.getAttribute('data-cat-key');
      if (!key) return;
      var map = valueCatalogLoadExpanded();
      if (open) map[key] = true; else delete map[key];
      valueCatalogSaveExpanded(map);
    }

    function valueCatalogSelect(inputId, row) {
      var catalog = document.getElementById('catalog-' + inputId);
      if (!catalog) return;
      var prev = catalog.querySelector('.value-row.is-selected');
      if (prev) prev.classList.remove('is-selected');
      row.classList.add('is-selected');
      var input = document.getElementById(inputId);
      if (input) input.value = row.getAttribute('data-id');
      var sel = document.getElementById(inputId + '-selected');
      if (sel) { sel.textContent = row.getAttribute('data-label'); sel.classList.add('has-value'); }
    }

    // Gemerkten Aufklapp-Zustand auf einen Katalog anwenden und zusätzlich die
    // Kette bis zum aktuell gewählten Wert öffnen (damit die Auswahl sichtbar ist).
    function valueCatalogApplyExpanded(catalog) {
      if (!catalog) return;
      var map = valueCatalogLoadExpanded();
      var cats = catalog.querySelectorAll('.value-cat');
      for (var i = 0; i < cats.length; i++) {
        var key = cats[i].getAttribute('data-cat-key');
        valueCatalogSetOpen(cats[i], !!(key && map[key] === true));
      }
      var row = catalog.querySelector('.value-row.is-selected');
      var node = row ? row.parentNode : null;
      while (node && node !== catalog) {
        if (node.classList && node.classList.contains('value-cat')) valueCatalogSetOpen(node, true);
        node = node.parentNode;
      }
    }

    // Auswahl programmgesteuert setzen (z. B. beim Öffnen im Bearbeiten-Modus).
    function valueCatalogSync(inputId, valueId) {
      var catalog = document.getElementById('catalog-' + inputId);
      var input = document.getElementById(inputId);
      if (input) input.value = valueId || '';
      if (!catalog) return;
      var search = catalog.querySelector('.value-catalog-search');
      if (search) search.value = '';
      // Suchfilter zurücksetzen: alle Zeilen/Kategorien wieder einblenden.
      var rows = catalog.querySelectorAll('.value-row');
      for (var i = 0; i < rows.length; i++) rows[i].style.display = '';
      var cats = catalog.querySelectorAll('.value-cat');
      for (var k = 0; k < cats.length; k++) cats[k].style.display = '';
      var prev = catalog.querySelector('.value-row.is-selected');
      if (prev) prev.classList.remove('is-selected');
      var sel = document.getElementById(inputId + '-selected');
      var selectedRow = null;
      if (valueId) {
        var candidates = catalog.querySelectorAll('.value-row');
        for (var r = 0; r < candidates.length; r++) {
          if (candidates[r].getAttribute('data-id') === valueId) { selectedRow = candidates[r]; break; }
        }
      }
      if (selectedRow) {
        selectedRow.classList.add('is-selected');
        if (sel) { sel.textContent = selectedRow.getAttribute('data-label'); sel.classList.add('has-value'); }
      } else if (sel) {
        sel.textContent = 'Kein Wert gewählt';
        sel.classList.remove('has-value');
      }
      valueCatalogApplyExpanded(catalog);
    }

    // Prüft, ob eine Kategorie aktuell noch sichtbare Zeilen oder Unterkategorien
    // enthält (Unterkategorien werden – von innen nach außen bewertet – vorher
    // gesetzt, sodass ein Treffer tief im Baum den ganzen Ast sichtbar hält).
    function valueCatalogHasVisible(cat) {
      var body = cat.querySelector(':scope > .value-cat-body');
      if (!body) return false;
      var children = body.children;
      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        if (el.style.display === 'none') continue;
        if (el.classList.contains('value-row') || el.classList.contains('value-cat')) return true;
      }
      return false;
    }

    function valueCatalogFilter(inputId, query) {
      var catalog = document.getElementById('catalog-' + inputId);
      if (!catalog) return;
      var q = (query || '').trim().toLowerCase();
      // 1) Zeilen filtern (data-search = Kategorie-Pfad + Label).
      var rows = catalog.querySelectorAll('.value-row');
      for (var i = 0; i < rows.length; i++) {
        var hay = rows[i].getAttribute('data-search') || (rows[i].getAttribute('data-label') || '').toLowerCase();
        rows[i].style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
      }
      // 2) Kategorien von innen nach außen auf Sichtbarkeit prüfen.
      var cats = catalog.querySelectorAll('.value-cat');
      var deepestFirst = Array.prototype.slice.call(cats).reverse();
      for (var c = 0; c < deepestFirst.length; c++) {
        deepestFirst[c].style.display = (!q || valueCatalogHasVisible(deepestFirst[c])) ? '' : 'none';
      }
      // 3) Aufklappen: bei aktiver Suche alle sichtbaren Kategorien; beim Leeren
      //    der Suche den gemerkten Zustand wiederherstellen (alles wieder zu,
      //    außer dauerhaft geöffnete/gemerkte Ebenen).
      if (q) {
        for (var k = 0; k < cats.length; k++) {
          if (cats[k].style.display !== 'none') valueCatalogSetOpen(cats[k], true);
        }
      } else {
        valueCatalogApplyExpanded(catalog);
      }
    }`;
}

// Lazy-Variante für sehr große Kataloge: Die Seite enthält nur die Hülle. Ebenen
// und Suchtreffer werden erst bei Bedarf vom Server geholt.
function renderLazyValueCatalog({
  inputId,
  name,
  selectedId = '',
  selectedLabel = '',
  label = 'Interner Wert',
  endpoint = '/dashboard/catalog',
} = {}) {
  const fieldName = name || inputId;
  return `          <div class="field-block value-catalog value-catalog--lazy" id="catalog-${escapeHtml(inputId)}" data-input="${escapeHtml(inputId)}" data-endpoint="${escapeHtml(endpoint)}">
            <span>${escapeHtml(label)}</span>
            <input type="hidden" id="${escapeHtml(inputId)}" name="${escapeHtml(fieldName)}" value="${escapeHtml(selectedId)}">
            <div class="value-catalog-bar">
              <input type="text" class="value-catalog-search" placeholder="Wert suchen…" oninput="lazyValueCatalogSearch('${escapeHtml(inputId)}', this.value)">
              <span class="value-catalog-selected${selectedId ? ' has-value' : ''}" id="${escapeHtml(inputId)}-selected">${selectedId ? escapeHtml(selectedLabel || selectedId) : 'Kein Wert gewählt'}</span>
            </div>
            <p class="muted form-hint lazy-value-catalog-status" id="${escapeHtml(inputId)}-status">Katalog wird beim Öffnen geladen.</p>
            <div class="value-catalog-cats" id="${escapeHtml(inputId)}-tree"></div>
            <div class="value-catalog-cats" id="${escapeHtml(inputId)}-results" hidden></div>
          </div>`;
}

function lazyValueCatalogScript() {
  return `    var LAZY_VALUE_CATALOG_EXPAND_KEY = 'homeess.valuecatalog.expanded.v1';
    var lazyValueCatalogExpandedCache = null;
    var lazyValueCatalogStates = {};

    function lazyValueCatalogExpanded() {
      if (lazyValueCatalogExpandedCache) return lazyValueCatalogExpandedCache;
      try { lazyValueCatalogExpandedCache = JSON.parse(localStorage.getItem(LAZY_VALUE_CATALOG_EXPAND_KEY) || '{}') || {}; }
      catch (_) { lazyValueCatalogExpandedCache = {}; }
      return lazyValueCatalogExpandedCache;
    }

    function lazyValueCatalogSaveExpanded() {
      try { localStorage.setItem(LAZY_VALUE_CATALOG_EXPAND_KEY, JSON.stringify(lazyValueCatalogExpanded())); }
      catch (_) {}
    }

    function lazyValueCatalogState(inputId) {
      if (!lazyValueCatalogStates[inputId]) {
        lazyValueCatalogStates[inputId] = { rootPromise: null, searchTimer: null, searchSequence: 0 };
      }
      return lazyValueCatalogStates[inputId];
    }

    function lazyValueCatalogNode(inputId, suffix) {
      return document.getElementById(inputId + suffix);
    }

    function lazyValueCatalogStatus(inputId, text, error) {
      var node = lazyValueCatalogNode(inputId, '-status');
      if (!node) return;
      node.textContent = text || '';
      node.classList.toggle('error-text', !!error);
      node.hidden = !text;
    }

    function lazyValueCatalogUrl(catalog, params) {
      var url = catalog.getAttribute('data-endpoint') || '/dashboard/catalog';
      var query = [];
      Object.keys(params || {}).forEach(function (key) {
        if (params[key] == null || params[key] === '') return;
        query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
      });
      return url + (query.length ? '?' + query.join('&') : '');
    }

    function lazyValueCatalogFetch(catalog, params) {
      return fetch(lazyValueCatalogUrl(catalog, params), { headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('catalog request failed');
          return response.json();
        });
    }

    function lazyValueCatalogSetSelected(inputId, valueId, label) {
      var catalog = document.getElementById('catalog-' + inputId);
      var input = document.getElementById(inputId);
      if (input) input.value = valueId || '';
      var selected = lazyValueCatalogNode(inputId, '-selected');
      if (selected) {
        selected.textContent = valueId ? (label || valueId) : 'Kein Wert gewählt';
        selected.classList.toggle('has-value', !!valueId);
      }
      if (!catalog) return;
      var rows = catalog.querySelectorAll('.value-row');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.toggle('is-selected', !!valueId && rows[i].getAttribute('data-id') === valueId);
      }
    }

    function lazyValueCatalogCreateRow(inputId, item) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'value-row';
      row.setAttribute('data-id', item.id || '');
      row.setAttribute('data-label', item.label || item.id || '');
      if (item.category) row.title = item.category;
      var name = document.createElement('span');
      name.className = 'value-row-label';
      name.textContent = item.label || item.id || '';
      var value = document.createElement('span');
      value.className = 'value-row-now';
      value.textContent = item.display == null ? '—' : item.display;
      row.appendChild(name);
      row.appendChild(value);
      row.addEventListener('click', function () {
        lazyValueCatalogSetSelected(inputId, item.id || '', item.label || item.id || '');
      });
      var selected = document.getElementById(inputId);
      if (selected && selected.value === item.id) row.classList.add('is-selected');
      return row;
    }

    function lazyValueCatalogDepth(path) {
      return Math.max(0, String(path || '').split(' / ').filter(Boolean).length - 1);
    }

    function lazyValueCatalogSetOpen(cat, open) {
      cat.classList.toggle('is-open', !!open);
      var head = cat.querySelector(':scope > .value-cat-head');
      if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function lazyValueCatalogCreateCategory(inputId, node) {
      var depth = lazyValueCatalogDepth(node.path);
      var cat = document.createElement('div');
      cat.className = 'value-cat' + (depth ? ' value-cat--nested' : '');
      cat.style.setProperty('--tree-depth', String(depth));
      cat.setAttribute('data-cat-key', node.path);
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'value-cat-head';
      head.setAttribute('aria-expanded', 'false');
      var caret = document.createElement('span');
      caret.className = 'value-cat-caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▸';
      var name = document.createElement('span');
      name.className = 'value-cat-name';
      name.textContent = node.name || '';
      var count = document.createElement('span');
      count.className = 'value-cat-count';
      count.textContent = node.count == null ? '' : String(node.count);
      var body = document.createElement('div');
      body.className = 'value-cat-body';
      head.appendChild(caret);
      head.appendChild(name);
      head.appendChild(count);
      cat.appendChild(head);
      cat.appendChild(body);
      head.addEventListener('click', function () { lazyValueCatalogToggle(inputId, cat); });
      if (lazyValueCatalogExpanded()[node.path] === true) {
        lazyValueCatalogSetOpen(cat, true);
        setTimeout(function () { lazyValueCatalogLoadCategory(inputId, cat); }, 0);
      }
      return cat;
    }

    function lazyValueCatalogAppendPage(inputId, container, data, replace) {
      if (replace) container.textContent = '';
      if (replace) {
        (data.nodes || []).forEach(function (node) {
          container.appendChild(lazyValueCatalogCreateCategory(inputId, node));
        });
      }
      (data.items || []).forEach(function (item) {
        container.appendChild(lazyValueCatalogCreateRow(inputId, item));
      });
      var oldMore = container.querySelector(':scope > .lazy-value-catalog-more');
      if (oldMore) oldMore.remove();
      if (data.nextOffset != null) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'secondary-button lazy-value-catalog-more';
        more.textContent = 'Weitere Werte laden';
        more.addEventListener('click', function () {
          more.disabled = true;
          lazyValueCatalogLoadPage(inputId, container, data.path || '', data.nextOffset);
        });
        container.appendChild(more);
      }
    }

    function lazyValueCatalogLoadPage(inputId, container, path, offset) {
      var catalog = document.getElementById('catalog-' + inputId);
      if (!catalog) return Promise.resolve();
      return lazyValueCatalogFetch(catalog, { path: path, offset: offset })
        .then(function (data) {
          lazyValueCatalogAppendPage(inputId, container, data, offset === 0);
          container.setAttribute('data-loaded', 'true');
          lazyValueCatalogStatus(inputId, '');
        })
        .catch(function () {
          lazyValueCatalogStatus(inputId, 'Werte konnten nicht geladen werden.', true);
        });
    }

    function lazyValueCatalogLoadCategory(inputId, cat) {
      var body = cat.querySelector(':scope > .value-cat-body');
      if (!body || body.getAttribute('data-loaded') === 'true' || body.getAttribute('data-loading') === 'true') return;
      body.setAttribute('data-loading', 'true');
      lazyValueCatalogStatus(inputId, 'Ebene wird geladen …');
      lazyValueCatalogLoadPage(inputId, body, cat.getAttribute('data-cat-key') || '', 0)
        .then(function () { body.removeAttribute('data-loading'); });
    }

    function lazyValueCatalogToggle(inputId, cat) {
      var open = !cat.classList.contains('is-open');
      lazyValueCatalogSetOpen(cat, open);
      var key = cat.getAttribute('data-cat-key');
      var map = lazyValueCatalogExpanded();
      if (open) {
        map[key] = true;
        lazyValueCatalogLoadCategory(inputId, cat);
      } else {
        delete map[key];
      }
      lazyValueCatalogSaveExpanded();
    }

    function lazyValueCatalogEnsure(inputId) {
      var catalog = document.getElementById('catalog-' + inputId);
      var tree = lazyValueCatalogNode(inputId, '-tree');
      if (!catalog || !tree) return Promise.resolve();
      if (tree.getAttribute('data-loaded') === 'true') return Promise.resolve();
      var state = lazyValueCatalogState(inputId);
      if (state.rootPromise) return state.rootPromise;
      lazyValueCatalogStatus(inputId, 'Katalog wird geladen …');
      state.rootPromise = lazyValueCatalogLoadPage(inputId, tree, '', 0)
        .then(function () { state.rootPromise = null; });
      return state.rootPromise;
    }

    function lazyValueCatalogSearch(inputId, rawQuery) {
      var query = (rawQuery || '').trim();
      var tree = lazyValueCatalogNode(inputId, '-tree');
      var results = lazyValueCatalogNode(inputId, '-results');
      var state = lazyValueCatalogState(inputId);
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchSequence += 1;
      var sequence = state.searchSequence;
      if (query.length < 2) {
        if (tree) tree.hidden = false;
        if (results) { results.hidden = true; results.textContent = ''; }
        lazyValueCatalogStatus(inputId, query ? 'Bitte mindestens zwei Zeichen eingeben.' : '');
        lazyValueCatalogEnsure(inputId);
        return;
      }
      if (tree) tree.hidden = true;
      if (results) results.hidden = false;
      lazyValueCatalogStatus(inputId, 'Suche läuft …');
      state.searchTimer = setTimeout(function () {
        var catalog = document.getElementById('catalog-' + inputId);
        if (!catalog) return;
        lazyValueCatalogFetch(catalog, { q: query })
          .then(function (data) {
            if (sequence !== state.searchSequence || !results) return;
            results.textContent = '';
            (data.items || []).forEach(function (item) {
              results.appendChild(lazyValueCatalogCreateRow(inputId, item));
            });
            if (!data.items || !data.items.length) {
              lazyValueCatalogStatus(inputId, 'Keine passenden Werte gefunden.');
            } else if (data.truncated) {
              lazyValueCatalogStatus(inputId, 'Es werden die ersten 100 Treffer angezeigt. Bitte Suche verfeinern.');
            } else {
              lazyValueCatalogStatus(inputId, '');
            }
          })
          .catch(function () {
            if (sequence === state.searchSequence) lazyValueCatalogStatus(inputId, 'Suche fehlgeschlagen.', true);
          });
      }, 250);
    }`;
}

module.exports = {
  renderValueCatalog,
  renderLazyValueCatalog,
  valueCatalogScript,
  lazyValueCatalogScript,
  buildValueCatalogTree,
};
