#!/usr/bin/env node
'use strict';

// Privilegierter, kurzlebiger Update-Helper. Er wird vom Installer außerhalb
// des austauschbaren Anwendungsverzeichnisses abgelegt und ausschließlich von
// home-ess-update.path gestartet. Browserdaten bestimmen nie Repository/URL.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = '/opt/home-ess';
const BACKUP_DIR = '/opt/home-ess.previous';
const FAILED_DIR = '/opt/home-ess.failed-update';
const DATA_DIR = process.env.HOME_ESS_DATA_DIR || '/var/lib/home-ess';
const UPDATE_DIR = path.join(DATA_DIR, 'update');
const REQUEST_FILE = path.join(UPDATE_DIR, 'request.json');
const STATUS_FILE = path.join(UPDATE_DIR, 'status.json');
const ADAPTER_SELECTION_FILE = path.join(DATA_DIR, 'adapter-selection.json');
const REPOSITORY_URL = 'https://github.com/mykaefer/home-ess.git';
const RELEASE_API = 'https://api.github.com/repos/mykaefer/home-ess/releases/latest';
const INSTALLED_HELPER = '/usr/local/lib/home-ess/self-update.js';
const SYSTEMD_DIR = '/etc/systemd/system';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

let status = { state: 'starting', messages: [] };
let stageDir = null;

function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} wurde mit Code ${code} beendet${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : '.'}`));
    });
  });
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, file);
  try { fs.chownSync(file, 0, fs.statSync(UPDATE_DIR).gid); } catch (_) { /* Lesemodus genügt */ }
}

function report(state, text, extra = {}) {
  const at = new Date().toISOString();
  status = {
    ...status,
    ...extra,
    state,
    updatedAt: at,
    messages: [...(status.messages || []), { at, text }].slice(-100),
  };
  atomicJson(STATUS_FILE, status);
}

async function latestVersion() {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'homeESS-self-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub antwortet mit HTTP ${response.status}.`);
  const body = await response.json();
  const version = String(body.tag_name || '').replace(/^v/, '');
  if (!VERSION_RE.test(version) || body.draft || body.prerelease) {
    throw new Error('GitHub liefert kein gültiges stabiles Release.');
  }
  return version;
}

function readRequest() {
  const body = JSON.parse(fs.readFileSync(REQUEST_FILE, 'utf8'));
  fs.unlinkSync(REQUEST_FILE);
  const version = String(body.version || '');
  if (!VERSION_RE.test(version)) throw new Error('Die Updateanforderung enthält keine gültige Version.');
  return version;
}

async function waitForVersion(version, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3000/update/health', {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      });
      if (response.ok) {
        const body = await response.json();
        if (body.version === version) return true;
      }
    } catch (_) {
      // Während des kontrollierten Neustarts normal.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function installUpdaterInfrastructure(sourceDir) {
  const helperSource = path.join(sourceDir, 'updater', 'self-update.js');
  if (!fs.existsSync(helperSource)) return;
  fs.mkdirSync(path.dirname(INSTALLED_HELPER), { recursive: true, mode: 0o755 });
  const nextHelper = `${INSTALLED_HELPER}.next`;
  fs.copyFileSync(helperSource, nextHelper);
  fs.chmodSync(nextHelper, 0o755);
  fs.renameSync(nextHelper, INSTALLED_HELPER);

  for (const unit of ['home-ess-update.service', 'home-ess-update.path']) {
    const source = path.join(sourceDir, 'updater', unit);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(SYSTEMD_DIR, unit);
    const temporary = `${destination}.next`;
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o644);
    fs.renameSync(temporary, destination);
  }
  await command('/usr/bin/systemctl', ['daemon-reload']);
  await command('/usr/bin/systemctl', ['enable', 'home-ess-update.path']);
}

async function rollback(error, targetVersion) {
  report('rolling_back', `Die neue Version konnte nicht gestartet werden: ${error.message} Rollback läuft.`);
  await command('/usr/bin/systemctl', ['stop', 'home-ess.service']).catch(() => {});
  if (fs.existsSync(FAILED_DIR)) fs.rmSync(FAILED_DIR, { recursive: true, force: true });
  if (fs.existsSync(APP_DIR)) fs.renameSync(APP_DIR, FAILED_DIR);
  if (fs.existsSync(BACKUP_DIR)) fs.renameSync(BACKUP_DIR, APP_DIR);
  await command('/usr/bin/systemctl', ['start', 'home-ess.service']);
  const restoredVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const restored = await waitForVersion(restoredVersion, 60000);
  if (fs.existsSync(FAILED_DIR)) fs.rmSync(FAILED_DIR, { recursive: true, force: true });
  report(restored ? 'failed' : 'failed_rollback', restored
    ? `Update auf ${targetVersion} fehlgeschlagen. Version ${restoredVersion} wurde wiederhergestellt.`
    : 'Update und automatischer Rollback sind fehlgeschlagen. Bitte den Dienst manuell prüfen.', {
    finishedAt: new Date().toISOString(),
  });
}

async function main() {
  const requestedVersion = readRequest();
  const previous = (() => {
    try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch (_) { return {}; }
  })();
  status = { ...previous, targetVersion: requestedVersion, startedAt: previous.startedAt || new Date().toISOString() };

  report('validating', 'Release wird unabhängig bei GitHub geprüft.');
  const latest = await latestVersion();
  if (latest !== requestedVersion) throw new Error(`Version ${requestedVersion} ist nicht das aktuelle stabile Release ${latest}.`);

  stageDir = `/opt/.home-ess-update-${process.pid}`;
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  report('downloading', `Version ${requestedVersion} wird von GitHub geladen.`);
  await command('/usr/bin/git', ['clone', '--depth', '1', '--branch', `v${requestedVersion}`, '--single-branch', REPOSITORY_URL, stageDir], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'));
  if (stagedPackage.version !== requestedVersion) {
    throw new Error(`Release-Tag und package.json stimmen nicht überein (${stagedPackage.version}).`);
  }

  report('dependencies', 'Produktionsabhängigkeiten werden im neuen Release installiert.');
  await command('/usr/bin/npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stageDir });
  const testDir = path.join(stageDir, 'test');
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  await command('/usr/bin/chown', ['-R', 'root:root', stageDir]);
  await command('/usr/bin/chmod', ['-R', 'u=rwX,go=rX', stageDir]);

  let oldInstallationMoved = false;
  try {
    report('switching', 'Download ist vollständig. homeESS wird für den Versionswechsel kurz angehalten.');
    await command('/usr/bin/systemctl', ['stop', 'home-ess.service']);
    if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    fs.renameSync(APP_DIR, BACKUP_DIR);
    oldInstallationMoved = true;
    fs.renameSync(stageDir, APP_DIR);
    stageDir = null;
    // Offizielle Adapter werden aus dem neuen Release aktualisiert, eigene
    // Adapter aus dem Altbestand ergänzt und bewusst entfernte IDs anhand der
    // dauerhaften Auswahl weiterhin ausgelassen.
    const oldAdapters = path.join(BACKUP_DIR, 'adapter');
    const nextAdapters = path.join(APP_DIR, 'adapter');
    const adapterSelection = require(path.join(APP_DIR, 'src', 'adapters', 'selection-policy'));
    const adapterResult = adapterSelection.reconcileUpdate({
      previousAdapterDir: oldAdapters,
      nextAdapterDir: nextAdapters,
      selectionFile: ADAPTER_SELECTION_FILE,
    });
    report('switching', `${adapterResult.preserved} eigene Adapter übernommen; ${adapterResult.removed} bewusst entfernte Adapter bleiben entfernt.`);
    await command('/usr/bin/chown', ['root:homeess', nextAdapters]);
    await command('/usr/bin/chmod', ['2775', nextAdapters]);
    report('restarting', `Version ${requestedVersion} ist installiert. homeESS wird neu gestartet.`);
    await command('/usr/bin/systemctl', ['start', 'home-ess.service']);
    if (!(await waitForVersion(requestedVersion))) throw new Error('Der neue Server wurde nicht rechtzeitig betriebsbereit.');
  } catch (error) {
    if (oldInstallationMoved) {
      await rollback(error, requestedVersion);
      return;
    }
    throw error;
  }

  try {
    await installUpdaterInfrastructure(APP_DIR);
  } catch (error) {
    report('finishing', `Die Anwendung läuft, aber die Updater-Infrastruktur konnte nicht erneuert werden: ${error.message}`);
  }
  try {
    if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  } catch (error) {
    report('finishing', `Die alte Arbeitskopie konnte noch nicht entfernt werden: ${error.message}`);
  }
  report('completed', `Update auf Version ${requestedVersion} wurde erfolgreich abgeschlossen.`, {
    finishedAt: new Date().toISOString(),
  });
}

main().catch(async (error) => {
  if (stageDir && fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  report('failed', error && error.message ? error.message : 'Das Update ist fehlgeschlagen.', {
    finishedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
});
