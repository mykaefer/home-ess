'use strict';

// Zentralheizung des Moduls „Heizung & Klima": Ansteuerung (Modbus/State oder
// Schaltaktor mit Vor-/Rücklaufüberwachung), Verbrauch und Preis für die
// Heizkosten, Schornsteinfeger-Modus und das Brenner-Laufzeitprotokoll.

const { renderLayout } = require('./layout');
const { escapeHtml, statusText } = require('./components');
const {
  MIN_FLOW_WINDOW_SECONDS, MAX_FLOW_WINDOW_SECONDS, MAX_HOLD_MINUTES, SWEEP_TARGET_TEMP,
  MAX_PUMP_LEAD_SECONDS, MAX_PUMP_LAG_SECONDS, FIRING_SOURCES,
} = require('../heizung/central');

function temp(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1).replace('.', ',')} °C`;
}

function number(value, digits = 2) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits).replace('.', ',');
}

function hours(ms) {
  const total = Math.max(0, Number(ms) || 0) / 3600000;
  const full = Math.floor(total);
  const minutes = Math.round((total - full) * 60);
  return `${full} h ${String(minutes).padStart(2, '0')} min`;
}

function stamp(value) {
  return value ? new Date(Number(value)).toLocaleString('de-DE') : '—';
}

function statsRow(label, entry, unit) {
  return `              <div class="adapter-row hz-item-row hz-stats-row">
                <span class="adapter-col-name"><strong>${label}</strong></span>
                <span>${hours(entry.runtimeMs)}</span>
                <span>${number(entry.consumption)} ${escapeHtml(unit)}</span>
                <span>${number(entry.cost)} €</span>
              </div>`;
}

function statsBlock(stats, firingSource) {
  const basis = FIRING_SOURCES[firingSource] || FIRING_SOURCES.switch;
  return `          <div class="adapter-block">
            <div class="adapter-block-head"><div class="adapter-block-title"><strong>Brennerlaufzeit und Heizkosten</strong><span class="muted">Gezählt wird allein, was der Brenner tatsächlich feuert (${escapeHtml(basis)}). Verbrauch = Laufzeit × Verbrauch je Betriebsstunde.</span></div></div>
            <div class="adapter-rows">
              <div class="adapter-row hz-item-row hz-stats-row adapter-row--head"><span>Zeitraum</span><span>Laufzeit</span><span>Verbrauch</span><span>Kosten</span></div>
${statsRow('Heute', stats.today, stats.unit)}
${statsRow('Letzte 30 Tage', stats.month, stats.unit)}
${statsRow('Laufendes Jahr', stats.year, stats.unit)}
${statsRow('Gesamt', stats.total, stats.unit)}
            </div>
          </div>`;
}

function runsBlock(runs) {
  const rows = runs.length
    ? runs.map((run) => `              <div class="adapter-row hz-item-row hz-run-row">
                <span class="adapter-col-name">${stamp(run.started_at)}</span>
                <span>${stamp(run.ended_at)}</span>
                <span>${hours(run.duration_ms)}</span>
                <span class="muted">${escapeHtml(run.reason || '')}</span>
              </div>`).join('\n')
    : '              <div class="adapter-row adapter-row--empty"><span class="muted">Noch keine Brennerlaufzeit aufgezeichnet.</span></div>';
  return `          <div class="adapter-block">
            <div class="adapter-block-head"><div class="adapter-block-title"><strong>Letzte Brennerläufe</strong><span class="muted">Die 20 jüngsten Einträge.</span></div></div>
            <div class="adapter-rows">
              <div class="adapter-row hz-item-row hz-run-row adapter-row--head"><span>Start</span><span>Ende</span><span>Dauer</span><span>Anlass</span></div>
${rows}
            </div>
          </div>`;
}

function statusCard(config, state, demandRooms) {
  const names = demandRooms.map((room) => escapeHtml(room.name)).join(', ');
  return `        <div class="hz-central-card">
          <div>
            <strong>Zustand</strong>
            <p class="muted">Außen ${temp(state.outdoorTemp)} · Vorlauf ${temp(state.flowTemp)} · Rücklauf ${temp(state.returnTemp)}${state.note ? ` · ${escapeHtml(state.note)}` : ''}</p>
            <p class="muted">${demandRooms.length ? `Wärmeanforderung aus: ${names}` : 'Keine Wärmeanforderung.'}</p>
          </div>
          <div class="hz-central-state">
            <span class="adapter-badge adapter-badge--${state.boilerOn ? 'on' : 'off'}">Kessel ${state.boilerOn ? 'ein' : 'aus'}</span>
            <span class="adapter-badge adapter-badge--${state.burnerOn ? 'on' : 'off'}">Brenner ${state.burnerOn ? 'an' : 'aus'}</span>
            ${config.mode === 'relais' && config.pumpTopic ? `<span class="adapter-badge adapter-badge--${state.pumpOn ? 'on' : 'off'}">Pumpe ${state.pumpOn ? 'läuft' : 'aus'}</span>` : ''}
            ${config.sweepEnabled ? '<span class="adapter-badge adapter-badge--warn">Schornsteinfeger-Modus</span>' : ''}
            <form action="/heizung/zentrale/schornsteinfeger" method="POST" class="hz-inline-form">
              <input type="hidden" name="on" value="${config.sweepEnabled ? '0' : '1'}">
              <button type="submit" class="secondary-button">Schornsteinfeger-Modus ${config.sweepEnabled ? 'beenden' : 'starten'}</button>
            </form>
          </div>
        </div>`;
}

function settingsForm(config) {
  const enabled = config.enabled ? ' checked' : '';
  const relais = config.mode !== 'modbus';
  return `        <form action="/heizung/zentrale" method="POST" class="hz-settings">
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Ansteuerung</h4>
              <label class="remember-row condition-section-toggle"><input type="hidden" name="enabled" value="0"><input type="checkbox" name="enabled" value="1"${enabled}><span>Zentralheizung verwenden</span></label>
            </div>
            <p class="muted condition-section-hint">Der <strong>Kessel</strong> wird eingeschaltet, sobald mindestens ein Raum Wärme anfordert. Abgeschaltet wird er erst, wenn keine Anforderung mehr besteht <strong>und</strong> der Brenner als aus erkannt ist. Ob ein Raum seine Wärme von hier oder von seinem lokalen Gerät bekommt, entscheidet die <strong>Außentemperatur</strong> gegen die je Raum eingestellte Grenztemperatur. Verwendet wird die systemweite Außentemperatur aus <em>Einstellungen → MQTT</em>; das Feld unten überschreibt sie nur für die Heizung.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Art der Ansteuerung</span>
                <select name="mode" id="heizungCentralMode" onchange="syncHeizungMode()">
                  <option value="relais"${relais ? ' selected' : ''}>Schaltaktor (mit Vor-/Rücklaufüberwachung)</option>
                  <option value="modbus"${relais ? '' : ' selected'}>Modbus/State (Anlage regelt selbst)</option>
                </select></label>
              <label class="field-block condition-topic-field"><span>Schalt-State der Heizung</span><input name="switchTopic" value="${escapeHtml(config.switchTopic)}" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label>
              <label class="field-block condition-topic-field"><span>Rückmeldung des Brenners (optional)</span><span class="field-hint">Flammensignal oder „Brenner an"-Kontakt. Bestimmt die Zeiten für die Heizkosten; ohne sie wird der steigende Vorlauf als Ersatz herangezogen</span><input name="burnerFeedbackTopic" value="${escapeHtml(config.burnerFeedbackTopic || '')}" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
              <label class="field-block condition-topic-field"><span>Außentemperatur (optional)</span><span class="field-hint">Leer = systemweite Außentemperatur aus den MQTT-Einstellungen</span><input name="outdoorTopic" value="${escapeHtml(config.outdoorTopic || '')}" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
            </div>
          </div>
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Vor- und Rücklauf</h4></div>
            <p class="muted condition-section-hint" id="heizungFlowHint">Beim Schaltaktor werden beide Temperaturen <strong>zwingend</strong> überwacht. Ohne Rückmeldung des Brenners erkennt homeESS an der <strong>Vorlauftemperatur</strong>, ob er läuft: mehrere Messwerte hintereinander nach oben bedeuten „Brenner an" (eine einzelne Schwankung reicht nicht), die anschließende Halte-Phase zählt weiter dazu, und erst mehrere Messwerte in Folge nach unten beenden die Brennphase. Solange der Brenner läuft, bleibt der Kessel eingeschaltet. Der Rücklauf hinkt einen ganzen Kreislauf hinterher — er wird angezeigt und protokolliert, entscheidet aber nichts.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block condition-topic-field"><span>Vorlauftemperatur</span><input name="flowTopic" value="${escapeHtml(config.flowTopic)}" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
              <label class="field-block condition-topic-field"><span>Rücklauftemperatur</span><span class="field-hint">Wird überwacht und angezeigt; über das Abschalten entscheidet der Vorlauf</span><input name="returnTopic" value="${escapeHtml(config.returnTopic)}" data-state-picker autocomplete="off" placeholder="State auswählen…"></label>
              <label class="field-block"><span>Mindest-Änderung je Messwert (°C)</span><span class="field-hint">Kleinere Unterschiede gelten als Rauschen und zählen für die Brennererkennung nicht</span><input name="flowDropDelta" type="number" value="${config.flowDropDelta}" min="0.05" max="10" step="0.05" data-no-state-picker></label>
              <label class="field-block"><span>Wartezeit ohne Brennererkennung (Sekunden)</span><span class="field-hint">Nur maßgeblich, wenn weder Rückmeldung noch Vorlauftemperatur vorliegen</span><input name="flowWindowSeconds" type="number" value="${config.flowWindowSeconds}" min="${MIN_FLOW_WINDOW_SECONDS}" max="${MAX_FLOW_WINDOW_SECONDS}" step="10" data-no-state-picker></label>
              <label class="field-block"><span>Notabschaltung (Minuten)</span><span class="field-hint">0 = keine: der Kessel bleibt an, solange der Brenner als laufend erkannt wird</span><input name="maxHoldMinutes" type="number" value="${config.maxHoldMinutes}" min="0" max="${MAX_HOLD_MINUTES}" step="5" data-no-state-picker></label>
            </div>
          </div>
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Umwälzpumpe</h4></div>
            <p class="muted condition-section-hint">Optionales zweites Schaltziel beim Schaltaktor. Ist es gesetzt, gilt zwingend: <strong>erst läuft die Pumpe, dann startet der Brenner</strong> — und nach dem Abschalten des Brenners läuft die Pumpe die eingestellte Zeit weiter, bevor auch sie abschaltet. Meldet der State den Pumpenzustand zurück, wartet der Brenner zusätzlich auf diese Rückmeldung.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block condition-topic-field"><span>Umwälzpumpe (optional)</span><input name="pumpTopic" value="${escapeHtml(config.pumpTopic || '')}" data-state-picker data-state-picker-writable autocomplete="off" placeholder="State auswählen…"></label>
              <label class="field-block"><span>Vorlauf vor dem Brennerstart (Sekunden)</span><input name="pumpLeadSeconds" type="number" value="${config.pumpLeadSeconds}" min="0" max="${MAX_PUMP_LEAD_SECONDS}" step="5" data-no-state-picker></label>
              <label class="field-block"><span>Nachlauf nach dem Brenner (Sekunden)</span><input name="pumpLagSeconds" type="number" value="${config.pumpLagSeconds}" min="0" max="${MAX_PUMP_LAG_SECONDS}" step="10" data-no-state-picker></label>
            </div>
          </div>
          <div class="dialog-section">
            <div class="dialog-section-head"><h4>Verbrauch und Preis</h4></div>
            <p class="muted condition-section-hint">Aus der protokollierten Brennerlaufzeit werden mit diesen Angaben Verbrauch und Heizkosten berechnet.</p>
            <div class="dialog-grid dialog-grid--two">
              <label class="field-block"><span>Verbrauch je Betriebsstunde</span><input name="consumptionPerHour" type="number" value="${config.consumptionPerHour}" min="0" step="0.01" data-no-state-picker></label>
              <label class="field-block"><span>Einheit</span><span class="field-hint">z. B. l, m³, kWh</span><input name="unit" value="${escapeHtml(config.unit)}" maxlength="20" data-no-state-picker></label>
              <label class="field-block"><span>Preis je Einheit (€)</span><input name="pricePerUnit" type="number" value="${config.pricePerUnit}" min="0" step="0.001" data-no-state-picker></label>
            </div>
          </div>
          <div class="button-row"><button type="submit">Speichern</button></div>
        </form>`;
}

function renderHeizungZentrale({
  central: config = {}, state = {}, stats = null, runs = [], demandRooms = [], error = '', message = '',
} = {}) {
  const body = `        <div class="panel-head">
          <div>
            <h1>Zentralheizung</h1>
            <p class="muted">Im Schornsteinfeger-Modus stellt homeESS alle Räume auf ${SWEEP_TARGET_TEMP} °C, hält die dezentralen Geräte aus und lässt die Zentralheizung durchlaufen.</p>
          </div>
          <div class="dashboard-toolbar"><a class="secondary-button" href="/heizung">Zurück zu den Räumen</a></div>
        </div>
        ${statusText(error)}${statusText(message, 'success')}
${statusCard(config, state, demandRooms)}
${settingsForm(config)}
        <div class="adapter-list hz-lists">
${stats ? statsBlock(stats, state.firingSource) : ''}
${runsBlock(runs)}
        </div>`;

  const script = `
    function syncHeizungMode() {
      var mode = document.getElementById('heizungCentralMode').value;
      var hint = document.getElementById('heizungFlowHint');
      if (hint) hint.classList.toggle('muted', true);
      document.querySelectorAll('input[name="flowTopic"], input[name="returnTopic"]').forEach(function (node) {
        node.required = mode === 'relais';
      });
    }
    syncHeizungMode();
  `;
  return renderLayout({ title: 'Zentralheizung', activePath: '/heizung', body, script });
}

module.exports = renderHeizungZentrale;
