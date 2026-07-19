'use strict';

// Schalter-Widgets des Dashboards: schaltbare Ziele sind Geräte mit
// Schalt-Topic aus Messen + Schalten sowie Schaltgruppen. Das Schalten läuft
// über die bestehenden Mechanismen (automation.commandManual bzw.
// schaltgruppenAutomation.commandGroup) — inklusive Prioritäts-Gating; es wird
// keine eigene Schreiblogik eingeführt. Das Ziel wird als `actor:<id>` bzw.
// `schaltgruppe:<id>` in der sourceId des Widgets abgelegt.

const { listActors, getActor } = require('../messen-schalten/actors');
const { listSwitchGroups, getSwitchGroup } = require('../messen-schalten/schaltgruppen');
const { readActorValues } = require('../messen-schalten/aggregation');
const automation = require('../messen-schalten/automation');
const schaltgruppenAutomation = require('../messen-schalten/schaltgruppen-automation');

const TARGET_PATTERN = /^(actor|schaltgruppe):(\d+)$/;

// Ziel-Angabe validieren; ungültige Eingaben ergeben '' (= kein Ziel gewählt).
function normalizeSwitchTarget(value) {
  const target = String(value == null ? '' : value).trim();
  return TARGET_PATTERN.test(target) ? target : '';
}

function parseSwitchTarget(value) {
  const match = TARGET_PATTERN.exec(String(value == null ? '' : value));
  if (!match) return null;
  return { kind: match[1], id: Number(match[2]) };
}

// Auswahlliste für den Widget-Dialog: alle schaltbaren Geräte und alle
// Schaltgruppen mit stabilem Ziel-Schlüssel.
async function listSwitchTargets(db) {
  const [actors, groups] = await Promise.all([listActors(db), listSwitchGroups(db)]);
  const targets = [];
  for (const actor of actors) {
    if (!actor.switchTopic) continue;
    targets.push({ id: `actor:${actor.id}`, label: actor.name, kind: 'Gerät' });
  }
  for (const group of groups) {
    targets.push({ id: `schaltgruppe:${group.id}`, label: group.name, kind: 'Schaltgruppe' });
  }
  return targets;
}

// Ist-Zustände aller Schalter-Widgets ermitteln: je Widget { on, label }.
// on = true/false oder null (Zustand unbekannt / Ziel nicht mehr vorhanden).
async function readSwitchStates(db, cache, widgets) {
  const result = new Map();
  const switchWidgets = (widgets || []).filter((widget) => widget.type === 'switch');
  if (!switchWidgets.length) return result;

  const [actors, groups] = await Promise.all([listActors(db), listSwitchGroups(db)]);
  const values = await readActorValues(db, cache, actors);
  const statusByActorId = new Map(values.map((v) => [v.id, v.statusOn == null ? null : !!v.statusOn]));
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const widget of switchWidgets) {
    const target = parseSwitchTarget(widget.sourceId);
    if (!target) {
      result.set(widget.id, { on: null, label: 'Kein Ziel' });
      continue;
    }
    if (target.kind === 'actor') {
      const actor = actorsById.get(target.id);
      result.set(widget.id, {
        on: actor ? statusByActorId.get(actor.id) : null,
        label: actor ? actor.name : 'Gerät fehlt',
      });
      continue;
    }
    const group = groupsById.get(target.id);
    if (!group) {
      result.set(widget.id, { on: null, label: 'Schaltgruppe fehlt' });
      continue;
    }
    // Wie auf der Schaltgruppen-Seite: AN, sobald ein Gerät an ist; AUS erst,
    // wenn alle bekannt aus sind; sonst offen.
    const members = actors.filter((actor) => actor.switchGroupId === group.id);
    const on = members.some((actor) => statusByActorId.get(actor.id) === true) ? true
      : members.length && members.every((actor) => statusByActorId.get(actor.id) === false) ? false : null;
    result.set(widget.id, { on, label: group.name });
  }
  return result;
}

// Schaltbefehl über die bestehenden Mechanismen absetzen.
// Rückgabe: { ok, blocked } — blocked = Einschalten durch Priorität abgewiesen.
async function commandSwitch(db, targetValue, on) {
  const target = parseSwitchTarget(targetValue);
  if (!target) {
    const error = new Error('Ungültiges Schaltziel.');
    error.validation = true;
    throw error;
  }
  if (target.kind === 'actor') {
    const actor = await getActor(db, target.id);
    if (!actor) return { ok: false, blocked: false, missing: true };
    const accepted = await automation.commandManual(db, target.id, on);
    return { ok: true, blocked: on && !accepted && actor.alwaysOn !== true };
  }
  const group = await getSwitchGroup(db, target.id);
  if (!group) return { ok: false, blocked: false, missing: true };
  await schaltgruppenAutomation.commandGroup(db, target.id, on);
  await schaltgruppenAutomation.runNow(db).catch(() => {});
  return { ok: true, blocked: false };
}

module.exports = {
  normalizeSwitchTarget,
  parseSwitchTarget,
  listSwitchTargets,
  readSwitchStates,
  commandSwitch,
};
