'use strict';

// Wiederverwendbarer State-Picker. Hinter ein Topic-Feld wird ein kleiner Button
// gesetzt; ein Klick öffnet einen gemeinsamen Dialog mit dem Adapter-State-Baum
// (Instanz → Kategorie → State, mit Live-Werten) und übernimmt die gewählte
// Adresse (prefix://instanz/adresse) in das zugehörige Eingabefeld.
//
// Verwendung in einer Seite:
//   1) hinter jedes Topic-Input: statePickerButton('inputId')
//   2) einmal im body: statePickerModal()
//   3) einmal ins Seiten-Script: statePickerScript()
// Der Katalog wird beim Öffnen lazy von /states/catalog.json geladen.

const { escapeHtml } = require('./components');

// Kleiner Auswahl-Button direkt hinter einem Topic-Feld (gleiche Zeile).
function statePickerButton(inputId) {
  return `<button type="button" class="state-pick-btn" title="State auswählen" onclick="statePickerOpen('${escapeHtml(inputId)}')">⊕</button>`;
}

// Einmal pro Seite: der gemeinsame Picker. Als Popover (Popover-API) umgesetzt und
// per showPopover() geöffnet, damit er im Top-Layer über auslösenden <dialog>-
// Elementen (z. B. Wallbox-/Anlagen-Dialoge) liegt. Positioniert wird er wie ein
// Dropdown direkt am Topic-Feld – je nach Platz nach unten oder oben aufklappend.
function statePickerModal() {
  return `      <div class="state-picker-pop" id="state-picker-pop" popover="auto">
        <input type="text" class="state-picker-search" id="state-picker-search" placeholder="State suchen…" oninput="statePickerFilter(this.value)">
        <div class="state-picker-body" id="state-picker-body"></div>
      </div>`;
}

// Einmal pro Seite ins Script einhängen.
function statePickerScript() {
  return `    var statePickerTarget = null;
    var statePickerData = null;
    var statePickerAnchor = null;
    var statePickerWired = false;
    var statePickerHome = null;
    var STATE_PICKER_WIDTH = 460;
    var STATE_PICKER_EXPAND_KEY = 'homeess.statepicker.expanded.v1';
    var STATE_PICKER_SCROLL_KEY = 'homeess.statepicker.scroll.v1';
    var statePickerExpandedCache = {};
    var statePickerScrollTimer = null;

    function statePickerLoadExpanded() {
      try { return JSON.parse(localStorage.getItem(STATE_PICKER_EXPAND_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function statePickerSaveExpanded(map) {
      try { localStorage.setItem(STATE_PICKER_EXPAND_KEY, JSON.stringify(map)); } catch (_) {}
    }
    function statePickerRestoreScroll() {
      var body = document.getElementById('state-picker-body');
      if (!body) return;
      var v = 0;
      try { v = parseInt(localStorage.getItem(STATE_PICKER_SCROLL_KEY) || '0', 10) || 0; } catch (_) {}
      body.scrollTop = v;
    }
    function statePickerSaveScroll() {
      var body = document.getElementById('state-picker-body');
      if (!body) return;
      try { localStorage.setItem(STATE_PICKER_SCROLL_KEY, String(body.scrollTop)); } catch (_) {}
    }

    function statePickerOpen(inputId) {
      statePickerTarget = inputId;
      var input = document.getElementById(inputId);
      statePickerAnchor = (input && input.closest && input.closest('.topic-input-row')) || input;
      var pop = document.getElementById('state-picker-pop');
      if (!pop) return;
      if (!statePickerHome) statePickerHome = pop.parentNode;
      // In modalen <dialog>-Fenstern wird alles außerhalb des Dialogs inert.
      // Der gemeinsame Picker muss daher in den aktiven Dialog umgehängt werden,
      // damit Kategorien und States darin anklickbar bleiben.
      var host = (input && input.closest && input.closest('dialog')) || statePickerHome;
      if (host && pop.parentNode !== host) host.appendChild(pop);
      if (pop.showPopover) {
        if (!pop.matches(':popover-open')) pop.showPopover();
      } else {
        pop.classList.add('is-open'); // Fallback ohne Popover-API
      }
      statePickerWire(pop);
      statePickerPosition();
      var search = document.getElementById('state-picker-search');
      if (search) { search.value = ''; setTimeout(function () { search.focus(); }, 0); }
      if (statePickerData) { statePickerRender(); statePickerPosition(); return; }
      var body = document.getElementById('state-picker-body');
      if (body) body.innerHTML = '<p class="muted" style="padding:12px;">Lade States…</p>';
      fetch('/states/catalog.json', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { statePickerData = data || { instances: [] }; statePickerRender(); statePickerPosition(); })
        .catch(function () {
          if (body) body.innerHTML = '<p class="error-text" style="padding:12px;">States konnten nicht geladen werden.</p>';
        });
    }

    function statePickerClose() {
      var pop = document.getElementById('state-picker-pop');
      if (pop) {
        if (pop.hidePopover && pop.matches(':popover-open')) pop.hidePopover();
        pop.classList.remove('is-open');
        if (statePickerHome && pop.parentNode !== statePickerHome) statePickerHome.appendChild(pop);
      }
      statePickerTarget = null;
      statePickerAnchor = null;
    }

    // Einmalig Reposition-/Schließ-Listener verdrahten.
    function statePickerWire(pop) {
      if (statePickerWired) return;
      statePickerWired = true;
      window.addEventListener('scroll', statePickerPosition, true);
      window.addEventListener('resize', statePickerPosition);
      // Letzte Scrollposition der Liste merken (gedrosselt), damit sie beim
      // nächsten Öffnen wiederhergestellt werden kann.
      var body = document.getElementById('state-picker-body');
      if (body) body.addEventListener('scroll', function () {
        if (statePickerScrollTimer) clearTimeout(statePickerScrollTimer);
        statePickerScrollTimer = setTimeout(statePickerSaveScroll, 200);
      });
      // Popover-Lightdismiss (Klick außerhalb / Esc) räumt den Zielzustand auf.
      pop.addEventListener('toggle', function (e) {
        if (e.newState === 'closed') {
          statePickerTarget = null;
          statePickerAnchor = null;
          if (statePickerHome && pop.parentNode !== statePickerHome) statePickerHome.appendChild(pop);
        }
      });
    }

    // Dropdown am Topic-Feld ausrichten: nach unten, sonst nach oben (mehr Platz).
    function statePickerPosition() {
      var pop = document.getElementById('state-picker-pop');
      if (!pop || !statePickerAnchor) return;
      var r = statePickerAnchor.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      // Feste, komfortable Breite – NICHT an die (oft schmale) Feldbreite gekoppelt,
      // damit lange State-Namen nicht abgeschnitten werden. Nur der Viewport begrenzt.
      var width = Math.min(STATE_PICKER_WIDTH, vw - 16);
      var left = Math.max(8, Math.min(r.left, vw - width - 8));
      var spaceBelow = vh - r.bottom, spaceAbove = r.top;
      var openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      var maxH = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow) - 12));
      pop.style.position = 'fixed';
      pop.style.margin = '0';
      pop.style.right = 'auto';
      pop.style.left = left + 'px';
      pop.style.width = width + 'px';
      pop.style.maxHeight = maxH + 'px';
      if (openUp) {
        pop.style.top = 'auto';
        pop.style.bottom = (vh - r.top + 4) + 'px';
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = (r.bottom + 4) + 'px';
      }
    }

    function statePickerSelect(topic) {
      if (statePickerTarget) {
        var input = document.getElementById(statePickerTarget);
        if (input) {
          input.value = topic;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      statePickerClose();
    }

    function statePickerToggle(head) {
      var cat = head.parentNode;
      cat.classList.toggle('is-open');
      var key = cat.getAttribute('data-tree-key');
      if (!key) return;
      var map = statePickerLoadExpanded();
      if (cat.classList.contains('is-open')) map[key] = true; else delete map[key];
      statePickerExpandedCache = map;
      statePickerSaveExpanded(map);
    }

    function statePickerRenderCategory(cat, depth, path, instKey) {
      var currentPath = path ? path + ' ' + cat.name : cat.name;
      var treeKey = instKey + '/' + currentPath;
      var openClass = statePickerExpandedCache[treeKey] === true ? ' is-open' : '';
      var html = '<div class="value-cat state-tree-level' + (depth ? ' value-cat--nested' : '') + openClass + '" style="--tree-depth:' + depth + '" data-tree-key="' + statePickerEsc(treeKey) + '"><button type="button" class="value-cat-head" onclick="statePickerToggle(this)"><span class="value-cat-caret">▸</span><span class="value-cat-name">' + statePickerEsc(cat.name) + '</span><span class="value-cat-count">' + (cat.stateCount == null ? cat.states.length : cat.stateCount) + '</span></button><div class="value-cat-body">';
      for (var s = 0; s < cat.states.length; s++) {
        var st = cat.states[s];
        html += '<button type="button" class="value-row" data-topic="' + statePickerEsc(st.topic) + '" data-search="' + statePickerEsc((currentPath + ' ' + st.name + ' ' + st.topic).toLowerCase()) + '" onclick="statePickerSelect(this.getAttribute(\\'data-topic\\'))"><span class="value-row-label">' + statePickerEsc(st.name) + '</span><span class="value-row-now">' + statePickerEsc(st.display == null ? '—' : st.display) + '</span></button>';
      }
      for (var c = 0; c < (cat.children || []).length; c++) html += statePickerRenderCategory(cat.children[c], depth + 1, currentPath, instKey);
      return html + '</div></div>';
    }

    function statePickerRender() {
      var body = document.getElementById('state-picker-body');
      if (!body) return;
      var data = statePickerData || { instances: [] };
      if (!data.instances || !data.instances.length) {
        body.innerHTML = '<p class="muted" style="padding:12px;">Noch keine Adapter-States vorhanden. Lege auf der Adapter-Seite eine Instanz an und aktiviere sie.</p>';
        return;
      }
      // Ein-/Ausklapp-Zustand einmal je Render laden und beim Aufbau anwenden.
      statePickerExpandedCache = statePickerLoadExpanded();
      var html = '';
      for (var i = 0; i < data.instances.length; i++) {
        var inst = data.instances[i];
        var instKey = inst.prefix + '://' + inst.instanceName;
        html += '<div class="state-inst"><div class="state-inst-name">' + statePickerEsc(instKey) + '</div>';
        for (var c = 0; c < inst.categories.length; c++) {
          html += statePickerRenderCategory(inst.categories[c], 0, '', instKey);
        }
        html += '</div>';
      }
      body.innerHTML = html;
      // Zuletzt gemerkte Scrollposition wiederherstellen (nach dem Aufbau).
      statePickerRestoreScroll();
    }

    function statePickerFilter(query) {
      var body = document.getElementById('state-picker-body');
      if (!body) return;
      var q = (query || '').trim().toLowerCase();
      var cats = body.querySelectorAll('.value-cat');
      for (var i = 0; i < cats.length; i++) {
        var any = false;
        var rows = cats[i].querySelectorAll('.value-row');
        for (var j = 0; j < rows.length; j++) {
          var match = !q || rows[j].getAttribute('data-search').indexOf(q) !== -1;
          rows[j].style.display = match ? '' : 'none';
          if (match) any = true;
        }
        cats[i].style.display = any ? '' : 'none';
        if (q) {
          // Während der Suche: Treffer-Kategorien (samt Unterkategorien) aufklappen.
          if (any) cats[i].classList.add('is-open');
        } else {
          // Suche geleert: Auto-Aufklappen zurücknehmen und den persistierten
          // Ein-/Ausklapp-Zustand wiederherstellen (alles wieder eingeklappt,
          // außer vom Nutzer dauerhaft geöffnete Kategorien).
          var key = cats[i].getAttribute('data-tree-key');
          if (key && statePickerExpandedCache[key] === true) cats[i].classList.add('is-open');
          else cats[i].classList.remove('is-open');
        }
      }
    }

    function statePickerEsc(str) {
      return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }`;
}

// Globales Auto-Attach: dekoriert automatisch jedes Topic-Eingabefeld (Name
// enthält „topic") mit einem State-Auswahl-Button und beobachtet per
// MutationObserver nachträglich eingefügte Felder (z. B. dynamisch hinzugefügte
// Anlagen-/Wallbox-Zeilen). Wird einmal global im Layout eingehängt; einzelne
// Seiten müssen nichts tun. Setzt voraus, dass statePickerScript() (Dialog-Logik)
// und statePickerModal() (Popover) ebenfalls vorhanden sind.
function statePickerAutoAttach() {
  return `    (function () {
      var TOPIC_RE = /topic/i;
      var seq = 0;
      function isTopicInput(el) {
        if (!el || el.tagName !== 'INPUT') return false;
        if (el.dataset && el.dataset.noStatePicker != null) return false;
        var type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type !== 'text' && type !== 'search') return false;
        var name = el.getAttribute('name') || '';
        return TOPIC_RE.test(name) || el.hasAttribute('data-state-picker');
      }
      function decorate(input) {
        if (input.dataset.spDone) return;
        input.dataset.spDone = '1';
        if (!input.id) input.id = 'sp-topic-' + (++seq);
        var parent = input.parentNode;
        if (!parent) return;
        var wrap;
        if (parent.classList && parent.classList.contains('topic-input-row')) {
          wrap = parent;
        } else {
          wrap = document.createElement('div');
          wrap.className = 'topic-input-row';
          parent.insertBefore(wrap, input);
          wrap.appendChild(input);
        }
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'state-pick-btn';
        btn.title = 'State auswählen';
        btn.textContent = '⊕';
        btn.addEventListener('click', function () { statePickerOpen(input.id); });
        wrap.appendChild(btn);
      }
      function scan(root) {
        if (!root || !root.querySelectorAll) return;
        var inputs = root.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) if (isTopicInput(inputs[i])) decorate(inputs[i]);
      }
      function init() {
        scan(document);
        if (window.MutationObserver && document.body) {
          new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
              var nodes = muts[i].addedNodes;
              for (var j = 0; j < nodes.length; j++) {
                var n = nodes[j];
                if (n.nodeType !== 1) continue;
                if (isTopicInput(n)) decorate(n);
                else scan(n);
              }
            }
          }).observe(document.body, { childList: true, subtree: true });
        }
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    })();`;
}

module.exports = { statePickerButton, statePickerModal, statePickerScript, statePickerAutoAttach };
