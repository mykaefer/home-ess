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

module.exports = { renderValueCatalog, valueCatalogScript, buildValueCatalogTree };
