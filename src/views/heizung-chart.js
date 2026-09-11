'use strict';

// Temperaturverteilung der Räume als Balkendiagramm über der Räume-Kachel.
//
// Je Raum ein Balken: seine Höhe ist die Ist-Temperatur, seine Farbe der
// Regelzustand (grün = gehalten, rot = heizt, blau = kühlt). Der waagerechte
// Strich im Balken markiert die Soll-Temperatur und ist zugleich das
// Bedienelement dafür — ihn zu ziehen verstellt den Sollwert (dieselbe Route
// wie das Formular der Raumzeile, also dieselbe Berechtigung). Unter dem Balken
// steht der Raumname aufrecht (90° gedreht), ganz unten liegt eine Griffleiste,
// mit der sich die Räume waagerecht umsortieren lassen; die Reihenfolge wird in
// `heizung_rooms.position` gespeichert und betrifft nur dieses Diagramm.
//
// Die Skala wird aus den vorhandenen Werten abgeleitet und auf ganze 5-°C-
// Schritte gerundet, damit sie nicht bei jedem Messwert springt. Sie beginnt
// deshalb bewusst nicht bei 0 °C — sonst wären die Unterschiede zwischen den
// Räumen nicht zu erkennen.

const i18n = require('../i18n');
const { escapeHtml } = require('./components');
const { MIN_TEMP, MAX_TEMP, formatTemp } = require('../heizung/rooms');

// Abstand der Skalenstriche und kleinster dargestellter Bereich, beide in °C.
const STEP = 5;
const MIN_SPAN = 15;
// Ohne jeden Messwert eine ruhige Wohnraum-Skala.
const FALLBACK = { min: 15, max: 30 };

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Skalenbereich aus Ist- und Soll-Werten. Ein Puffer von 1 °C nach oben und
// unten verhindert, dass ein Balken genau an der Kante endet.
function domainFor(rooms) {
  const values = [];
  for (const room of rooms) {
    const current = number((room.state || {}).temperature);
    if (current != null) values.push(current);
    const target = number(room.targetTemp);
    if (target != null) values.push(target);
  }
  if (!values.length) return { ...FALLBACK };
  const min = Math.floor((Math.min(...values) - 1) / STEP) * STEP;
  let max = Math.ceil((Math.max(...values) + 1) / STEP) * STEP;
  if (max - min < MIN_SPAN) max = min + MIN_SPAN;
  return { min, max };
}

function percent(value, domain) {
  const span = domain.max - domain.min;
  if (!(span > 0)) return 0;
  const ratio = ((Number(value) - domain.min) / span) * 100;
  return Math.round(Math.max(0, Math.min(100, ratio)) * 10) / 10;
}

function ticks(domain) {
  const out = [];
  for (let value = domain.min; value <= domain.max; value += STEP) {
    out.push(`<span class="hz-chart-tick" style="bottom: ${percent(value, domain)}%"><i>${value} °C</i></span>`);
  }
  return out.join('');
}

// Regelzustand des Raums als Balkenfarbe. Ein gesperrter Raum steht vorn: er
// regelt gerade gar nicht, egal was seine Temperatur sagt.
function fillMode(state) {
  if (state.contactOpen) return 'blocked';
  if (state.heating || state.centralDemand) return 'heat';
  if (state.heatDemand && !state.heatAllowed) return 'blocked';
  if (state.cooling) return 'cool';
  return 'idle';
}

function barColumn(room, domain) {
  const state = room.state || {};
  const current = number(state.temperature);
  const target = number(room.targetTemp);
  const value = target == null ? 0 : target;
  // Ein Text für Beschriftung und Titel des Soll-Strichs: der Raumname steht
  // darin, deshalb läuft er über den Katalog statt über einen zusammengesetzten
  // Textknoten.
  const markHint = i18n.t('heating.chart.target_hint', { name: room.name });
  return `              <div class="hz-bar-col${current == null ? ' hz-bar-col--empty' : ''}" data-hz-bar="${room.id}"
                data-hz-value="${current == null ? '' : current}" data-hz-target="${value}"
                data-hz-post="/heizung/raum/${room.id}/soll"
                style="--hz-fill: ${current == null ? 0 : percent(current, domain)}%; --hz-mark: ${percent(value, domain)}%">
                <div class="hz-bar-track" data-hz-track>
                  <div class="hz-bar-fill hz-bar-fill--${fillMode(state)}" data-hz-fill></div>
                  <span class="hz-bar-value" data-hz-value-text>${formatTemp(current)}</span>
                  <div class="hz-bar-mark" data-hz-mark role="slider" tabindex="0"
                    aria-label="${escapeHtml(markHint)}" title="${escapeHtml(markHint)}"
                    aria-valuemin="${MIN_TEMP}" aria-valuemax="${MAX_TEMP}" aria-valuenow="${value}"
                    aria-valuetext="${escapeHtml(formatTemp(value))}">
                    <span class="hz-bar-mark-value" data-hz-mark-value>${formatTemp(value)}</span>
                  </div>
                </div>
                <div class="hz-bar-name"><span>${escapeHtml(room.name)}</span></div>
                <button type="button" class="hz-bar-grip" data-hz-grip aria-label="Raum verschieben" title="Raum verschieben"><span aria-hidden="true">⠿</span></button>
              </div>`;
}

// Reihenfolge des Diagramms: die gespeicherte Position, bei Gleichstand die
// Reihenfolge der Liste (alphabetisch).
function inOrder(rooms) {
  return rooms.map((room, index) => ({ room, index }))
    .sort((left, right) => (Number(left.room.position || 0) - Number(right.room.position || 0))
      || (left.index - right.index))
    .map((entry) => entry.room);
}

function chartCard(rooms = []) {
  if (!rooms.length) return '';
  const ordered = inOrder(rooms);
  const domain = domainFor(ordered);
  const steps = Math.max(1, Math.round((domain.max - domain.min) / STEP));
  return `        <div class="hz-chart" id="heizungChart">
          <div class="hz-chart-head">
            <strong>Temperaturverteilung</strong>
            <div class="hz-chart-legend">
              <span class="hz-legend-item hz-legend-item--idle">Gehalten</span>
              <span class="hz-legend-item hz-legend-item--heat">Heizen</span>
              <span class="hz-legend-item hz-legend-item--cool">Kühlen</span>
              <span class="hz-legend-item hz-legend-item--blocked">Gesperrt</span>
              <span class="hz-legend-item hz-legend-item--target">Soll</span>
            </div>
          </div>
          <div class="hz-chart-plot" style="--hz-steps: ${steps}">
            <div class="hz-chart-scale" data-hz-scale>${ticks(domain)}</div>
            <div class="hz-chart-viewport">
              <div class="hz-chart-bars" id="heizungChartBars">
${ordered.map((room) => barColumn(room, domain)).join('\n')}
              </div>
            </div>
          </div>
        </div>`;
}

// Browserteil. Er hängt sich an das Skript der Übersichtsseite und benutzt
// deren `heizungTemp()` und `heizungPoll()`.
function chartScript(rooms = []) {
  const domain = domainFor(inOrder(rooms));
  return `
    // Temperaturdiagramm: Skala, Balken, Soll-Strich und das Umsortieren der
    // Räume. Alle Stellungen laufen über zwei CSS-Variablen je Spalte
    // (--hz-fill, --hz-mark); die Werte selbst stehen als data-Attribute an der
    // Spalte, damit Skala und Balken aus derselben Quelle entstehen.
    var hzChartStep = ${STEP};
    var hzChartSpan = ${MIN_SPAN};
    var hzChartMinTemp = ${MIN_TEMP};
    var hzChartMaxTemp = ${MAX_TEMP};
    var hzChartDomain = { min: ${domain.min}, max: ${domain.max} };
    // Laufendes Ziehen: am Soll-Strich bzw. an der Griffleiste. Solange eines
    // läuft, bleibt die Skala stehen — ein springender Maßstab unter dem Finger
    // wäre nicht bedienbar.
    var hzChartAdjust = null;
    var hzChartMove = null;
    var hzChartSaveTimer = null;
    // Schrittweite der Pfeiltasten am Soll-Strich, in °C.
    var hzChartKeySteps = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5 };

    function hzChartColumns() {
      var bars = document.getElementById('heizungChartBars');
      return bars ? [].slice.call(bars.querySelectorAll('.hz-bar-col')) : [];
    }
    // Spalten in ihrer sichtbaren Reihenfolge. Verschoben wird über die Ordnung
    // des Rasters (style.order) und nicht über den DOM-Baum: ein Umhängen
    // während des Ziehens nimmt der Griffleiste ihre Zeigererfassung, und das
    // Ziehen bräche nach dem ersten Platz ab.
    function hzChartOrderedColumns() {
      return hzChartColumns().sort(function (left, right) {
        return left.getBoundingClientRect().left - right.getBoundingClientRect().left;
      });
    }
    function hzChartApplyOrder(list) {
      for (var i = 0; i < list.length; i++) list[i].style.order = String(i);
    }
    function hzChartNumber(node, name) {
      var raw = node.getAttribute(name);
      if (raw == null || raw === '') return null;
      var value = Number(raw);
      return isFinite(value) ? value : null;
    }
    function hzChartPercent(value) {
      var span = hzChartDomain.max - hzChartDomain.min;
      if (!(span > 0)) return 0;
      var ratio = (Number(value) - hzChartDomain.min) / span * 100;
      return Math.max(0, Math.min(100, ratio));
    }
    function hzChartUpdateDomain() {
      if (hzChartAdjust || hzChartMove) return;
      var values = [];
      hzChartColumns().forEach(function (col) {
        var current = hzChartNumber(col, 'data-hz-value');
        if (current != null) values.push(current);
        var target = hzChartNumber(col, 'data-hz-target');
        if (target != null) values.push(target);
      });
      if (!values.length) { hzChartDomain = { min: ${FALLBACK.min}, max: ${FALLBACK.max} }; return; }
      var min = Math.floor((Math.min.apply(null, values) - 1) / hzChartStep) * hzChartStep;
      var max = Math.ceil((Math.max.apply(null, values) + 1) / hzChartStep) * hzChartStep;
      if (max - min < hzChartSpan) max = min + hzChartSpan;
      hzChartDomain = { min: min, max: max };
    }
    function hzChartDrawScale() {
      var scale = document.querySelector('[data-hz-scale]');
      var plot = document.querySelector('.hz-chart-plot');
      if (!scale) return;
      var html = '';
      for (var value = hzChartDomain.min; value <= hzChartDomain.max; value += hzChartStep) {
        html += '<span class="hz-chart-tick" style="bottom: ' + hzChartPercent(value) + '%"><i>' + value + ' \\u00b0C</i></span>';
      }
      scale.innerHTML = html;
      if (plot) plot.style.setProperty('--hz-steps', String(Math.max(1, Math.round((hzChartDomain.max - hzChartDomain.min) / hzChartStep))));
    }
    // Schmale Spalten tragen keine Zahl über dem Balken — sie stünde über der
    // Nachbarspalte. Gemessen wird die tatsächliche Breite, nicht die
    // Fensterbreite: sie hängt auch an der Anzahl der Räume.
    function hzChartMeasure() {
      var plot = document.querySelector('.hz-chart-plot');
      var viewport = document.querySelector('.hz-chart-viewport');
      var bars = document.getElementById('heizungChartBars');
      var first = hzChartColumns()[0];
      if (!plot || !first) return;
      plot.classList.toggle('hz-chart-plot--dense', first.getBoundingClientRect().width < 48);
      // Nicht scrollWidth verwenden: auch der seitlich überstehende Soll-Griff
      // und dessen unsichtbare Beschriftung fließen dort ein. Maßgeblich ist,
      // ob Mindestbreite plus Spaltenabstände wirklich in den Ausschnitt passen.
      if (viewport && bars && typeof getComputedStyle !== 'undefined' && viewport.clientWidth) {
        var plotStyle = getComputedStyle(plot);
        var barsStyle = getComputedStyle(bars);
        var minWidth = parseFloat(plotStyle.getPropertyValue('--hz-col-min')) || 0;
        var gap = parseFloat(barsStyle.columnGap) || 0;
        var count = hzChartColumns().length;
        var needed = count * minWidth + Math.max(0, count - 1) * gap;
        viewport.classList.toggle('hz-chart-viewport--scroll', needed > viewport.clientWidth + 1);
      }
    }
    function hzChartRender() {
      hzChartMeasure();
      hzChartColumns().forEach(function (col) {
        var current = hzChartNumber(col, 'data-hz-value');
        var target = hzChartNumber(col, 'data-hz-target');
        col.classList.toggle('hz-bar-col--empty', current == null);
        col.style.setProperty('--hz-fill', (current == null ? 0 : hzChartPercent(current)) + '%');
        col.style.setProperty('--hz-mark', hzChartPercent(target == null ? 0 : target) + '%');
        var valueNode = col.querySelector('[data-hz-value-text]');
        if (valueNode) valueNode.textContent = heizungTemp(current);
        var markValue = col.querySelector('[data-hz-mark-value]');
        if (markValue) markValue.textContent = heizungTemp(target);
        var mark = col.querySelector('[data-hz-mark]');
        if (mark && target != null) {
          mark.setAttribute('aria-valuenow', String(target));
          mark.setAttribute('aria-valuetext', heizungTemp(target));
        }
      });
    }
    // Live-Werte der Übersicht in das Diagramm übernehmen.
    function heizungChartApply(rooms) {
      var byId = {};
      (rooms || []).forEach(function (room) { byId[String(room.id)] = room; });
      hzChartColumns().forEach(function (col) {
        var id = col.getAttribute('data-hz-bar');
        var room = byId[id];
        if (!room) return;
        var current = room.temperature == null || isNaN(Number(room.temperature)) ? null : Number(room.temperature);
        col.setAttribute('data-hz-value', current == null ? '' : String(current));
        // Der Sollwert kann sich am Thermostat geändert haben; ein Strich unter
        // dem Finger bleibt unangetastet.
        var adjusting = hzChartAdjust && hzChartAdjust.id === id;
        if (!adjusting && room.targetTemp != null) col.setAttribute('data-hz-target', String(Number(room.targetTemp)));
        var fill = col.querySelector('[data-hz-fill]');
        if (fill) {
          // Dieselbe Rangfolge wie beim Aufbau der Seite: gesperrt schlägt
          // heizen und kühlen.
          var mode = 'idle';
          if (room.contactOpen) mode = 'blocked';
          else if (room.heating || room.centralDemand) mode = 'heat';
          else if (room.heatDemand && !room.heatAllowed) mode = 'blocked';
          else if (room.cooling) mode = 'cool';
          fill.className = 'hz-bar-fill hz-bar-fill--' + mode;
        }
      });
      hzChartUpdateDomain();
      hzChartDrawScale();
      hzChartRender();
    }

    // Temperatur an der Zeigerposition, in halben Grad und innerhalb der Skala.
    function hzChartTempAt(track, clientY) {
      var box = track.getBoundingClientRect();
      if (!box.height) return null;
      var ratio = (box.bottom - clientY) / box.height;
      var value = Math.round((hzChartDomain.min + ratio * (hzChartDomain.max - hzChartDomain.min)) * 2) / 2;
      var low = Math.max(hzChartMinTemp, hzChartDomain.min);
      var high = Math.min(hzChartMaxTemp, hzChartDomain.max);
      return Math.max(low, Math.min(high, value));
    }
    // Soll-Temperatur speichern — dieselbe Route wie das Formular der Raumzeile.
    function hzChartSaveTarget(col) {
      var id = col.getAttribute('data-hz-bar');
      var value = hzChartNumber(col, 'data-hz-target');
      if (value == null) return;
      fetch(col.getAttribute('data-hz-post'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'targetTemp=' + encodeURIComponent(String(value)),
      })
        .then(function () {
          var input = document.querySelector('[data-room-id="' + id + '"] input[name="targetTemp"]');
          if (input && document.activeElement !== input) input.value = value;
          setTimeout(heizungPoll, 300);
        })
        .catch(function () {});
    }
    // Tastaturschritte sammeln sich, statt je Tastendruck zu schreiben.
    function hzChartSaveTargetSoon(col) {
      if (hzChartSaveTimer) clearTimeout(hzChartSaveTimer);
      hzChartSaveTimer = setTimeout(function () { hzChartSaveTimer = null; hzChartSaveTarget(col); }, 400);
    }
    function hzChartSetTarget(col, value) {
      col.setAttribute('data-hz-target', String(value));
      hzChartRender();
    }
    // Reihenfolge der Spalten sichern (reine Anordnung, keine Regelung).
    function hzChartSaveOrder() {
      var ids = hzChartOrderedColumns().map(function (col) { return Number(col.getAttribute('data-hz-bar')); });
      fetch('/heizung/raeume/reihenfolge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ order: ids }),
      }).catch(function () {});
    }

    function hzChartBind(col) {
      var id = col.getAttribute('data-hz-bar');
      var track = col.querySelector('[data-hz-track]');
      var mark = col.querySelector('[data-hz-mark]');
      var grip = col.querySelector('[data-hz-grip]');
      if (mark && track) {
        mark.addEventListener('pointerdown', function (event) {
          event.preventDefault();
          if (mark.setPointerCapture) mark.setPointerCapture(event.pointerId);
          hzChartAdjust = { id: id, pointer: event.pointerId, changed: false };
          col.classList.add('hz-bar-col--adjusting');
        });
        mark.addEventListener('pointermove', function (event) {
          if (!hzChartAdjust || hzChartAdjust.pointer !== event.pointerId) return;
          var value = hzChartTempAt(track, event.clientY);
          if (value == null || value === hzChartNumber(col, 'data-hz-target')) return;
          hzChartAdjust.changed = true;
          hzChartSetTarget(col, value);
        });
        var release = function (event) {
          if (!hzChartAdjust || hzChartAdjust.pointer !== event.pointerId) return;
          var changed = hzChartAdjust.changed;
          hzChartAdjust = null;
          col.classList.remove('hz-bar-col--adjusting');
          if (changed) hzChartSaveTarget(col);
        };
        mark.addEventListener('pointerup', release);
        mark.addEventListener('pointercancel', release);
        mark.addEventListener('lostpointercapture', release);
        // Ohne Zeigegerät bedienbar: Pfeiltasten in halben Grad.
        mark.addEventListener('keydown', function (event) {
          var step = hzChartKeySteps[event.key];
          if (!step) return;
          event.preventDefault();
          var current = hzChartNumber(col, 'data-hz-target');
          if (current == null) return;
          hzChartSetTarget(col, Math.max(hzChartMinTemp, Math.min(hzChartMaxTemp, current + step)));
          hzChartSaveTargetSoon(col);
        });
      }
      if (grip) {
        grip.addEventListener('pointerdown', function (event) {
          event.preventDefault();
          if (grip.setPointerCapture) grip.setPointerCapture(event.pointerId);
          hzChartMove = { pointer: event.pointerId, moved: false };
          col.classList.add('hz-bar-col--moving');
        });
        grip.addEventListener('pointermove', function (event) {
          if (!hzChartMove || hzChartMove.pointer !== event.pointerId) return;
          var current = hzChartOrderedColumns();
          var others = current.filter(function (node) { return node !== col; });
          // Einfügestelle ist die erste Spalte, deren Mitte rechts vom Zeiger
          // liegt; sonst ganz nach hinten. Waagerecht gescrollt wird der ganze
          // Ausschnitt, Zeiger und Rechtecke liegen also im selben Bezugssystem.
          var index = others.length;
          for (var i = 0; i < others.length; i++) {
            var box = others[i].getBoundingClientRect();
            if (event.clientX < box.left + box.width / 2) { index = i; break; }
          }
          others.splice(index, 0, col);
          var changed = others.some(function (node, position) { return node !== current[position]; });
          if (!changed) return;
          hzChartApplyOrder(others);
          hzChartMove.moved = true;
        });
        // Auch ein verlorengegangenes Ziehen muss enden — sonst bliebe die
        // Spalte am Zeiger kleben.
        var drop = function (event) {
          if (!hzChartMove || hzChartMove.pointer !== event.pointerId) return;
          var moved = hzChartMove.moved;
          hzChartMove = null;
          col.classList.remove('hz-bar-col--moving');
          if (moved) hzChartSaveOrder();
        };
        grip.addEventListener('pointerup', drop);
        grip.addEventListener('pointercancel', drop);
        grip.addEventListener('lostpointercapture', drop);
      }
    }

    hzChartColumns().forEach(hzChartBind);
    hzChartDrawScale();
    hzChartRender();
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', hzChartMeasure);
  `;
}

module.exports = { chartCard, chartScript, domainFor, percent, inOrder };
