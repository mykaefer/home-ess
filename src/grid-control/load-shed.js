'use strict';

const LOAD_SHED_SETTLE_MS = 10000;
const LOAD_SHED_RECOVER_MS = 60000;
const PHASES = ['l1', 'l2', 'l3', 'three_phase'];

const providers = new Map();
const stages = {
  l1: { cutoff: null, nextEscalateAt: 0, nextRecoverAt: 0 },
  l2: { cutoff: null, nextEscalateAt: 0, nextRecoverAt: 0 },
  l3: { cutoff: null, nextEscalateAt: 0, nextRecoverAt: 0 },
};

function normalizePhase(phase, fallback = 'l1') {
  const key = String(phase || '').trim().toLowerCase();
  return PHASES.includes(key) ? key : fallback;
}

function phaseIndexes(phase) {
  const normalized = normalizePhase(phase);
  if (normalized === 'l2') return [1];
  if (normalized === 'l3') return [2];
  if (normalized === 'three_phase') return [0, 1, 2];
  return [0];
}

function resetStages() {
  Object.values(stages).forEach((stage) => {
    stage.cutoff = null;
    stage.nextEscalateAt = 0;
    stage.nextRecoverAt = 0;
  });
}

function registerProvider(key, participants) {
  if (!key) return;
  providers.set(String(key), Array.isArray(participants) ? participants.slice() : []);
}

function unregisterProvider(key) {
  providers.delete(String(key));
}

function allParticipants() {
  return [...providers.values()].flat();
}

function prioritiesForPhase(phaseKey) {
  const index = phaseKey === 'l1' ? 0 : phaseKey === 'l2' ? 1 : 2;
  const unique = new Set();
  for (const participant of allParticipants()) {
    const priority = Number(participant && participant.priority);
    if (!Number.isFinite(priority)) continue;
    if (!phaseIndexes(participant.phase).includes(index)) continue;
    unique.add(Math.round(priority));
  }
  return [...unique].sort((a, b) => b - a);
}

function nextEscalationCutoff(currentCutoff, prioritiesDesc) {
  if (!prioritiesDesc.length) return null;
  if (currentCutoff == null) return prioritiesDesc[0];
  for (const priority of prioritiesDesc) {
    if (priority < currentCutoff) return priority;
  }
  return currentCutoff;
}

function nextRecoveryCutoff(currentCutoff, prioritiesDesc) {
  if (currentCutoff == null || !prioritiesDesc.length) return null;
  const index = prioritiesDesc.indexOf(currentCutoff);
  if (index === -1) return null;
  return index === 0 ? null : prioritiesDesc[index - 1];
}

function updateStage(phaseKey, load, onThreshold, prioritiesDesc, now) {
  const stage = stages[phaseKey];
  if (!Number.isFinite(load) || !Number.isFinite(onThreshold) || !prioritiesDesc.length) {
    stage.cutoff = null;
    stage.nextEscalateAt = 0;
    stage.nextRecoverAt = 0;
    return;
  }

  const overloaded = load >= onThreshold * 0.8;
  const recoverable = load < onThreshold * 0.5;

  if (overloaded) {
    const nextCutoff = nextEscalationCutoff(stage.cutoff, prioritiesDesc);
    if (nextCutoff !== stage.cutoff && now >= stage.nextEscalateAt) {
      stage.cutoff = nextCutoff;
      stage.nextEscalateAt = now + LOAD_SHED_SETTLE_MS;
      stage.nextRecoverAt = now + LOAD_SHED_SETTLE_MS;
    }
    return;
  }

  if (recoverable && stage.cutoff != null && now >= stage.nextRecoverAt) {
    stage.cutoff = nextRecoveryCutoff(stage.cutoff, prioritiesDesc);
    stage.nextRecoverAt = now + LOAD_SHED_RECOVER_MS;
    stage.nextEscalateAt = now + LOAD_SHED_SETTLE_MS;
  }
}

function update(loads, cfg, now = Date.now()) {
  if (!cfg || !cfg.loadEnabled || !Array.isArray(loads)) {
    resetStages();
    return getStageState();
  }
  updateStage('l1', Number(loads[0]), Number(cfg.loadOnL1), prioritiesForPhase('l1'), now);
  updateStage('l2', Number(loads[1]), Number(cfg.loadOnL2), prioritiesForPhase('l2'), now);
  updateStage('l3', Number(loads[2]), Number(cfg.loadOnL3), prioritiesForPhase('l3'), now);
  return getStageState();
}

function shouldShed(phase, priority) {
  const prio = Number(priority);
  if (!Number.isFinite(prio)) return false;
  return phaseIndexes(phase).some((index) => {
    const phaseKey = index === 0 ? 'l1' : index === 1 ? 'l2' : 'l3';
    const cutoff = stages[phaseKey].cutoff;
    return cutoff != null && prio >= cutoff;
  });
}

function getStageState() {
  return {
    l1: { ...stages.l1 },
    l2: { ...stages.l2 },
    l3: { ...stages.l3 },
  };
}

function resetForTests() {
  providers.clear();
  resetStages();
}

module.exports = {
  PHASES,
  LOAD_SHED_SETTLE_MS,
  LOAD_SHED_RECOVER_MS,
  normalizePhase,
  phaseIndexes,
  registerProvider,
  unregisterProvider,
  update,
  shouldShed,
  getStageState,
  resetForTests,
};
