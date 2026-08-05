'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const timeHandler = require('../time-handler');
const { fetchLatestRelease } = require('./release-client');
const { normalizeVersion, compareVersions } = require('./version');
const updateSettingsRepo = require('./settings');

const pkg = require('../../package.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTOMATION_TICK_MS = 60 * 1000;
const UPDATE_UNIT = '/etc/systemd/system/home-ess-update.path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, file);
}

class UpdateService {
  constructor(options = {}) {
    this.dataDir = options.dataDir || config.DATA_DIR;
    this.currentVersion = normalizeVersion(options.currentVersion || pkg.version);
    this.fetchLatest = options.fetchLatest || fetchLatestRelease;
    this.now = options.now || (() => Date.now());
    this.calendar = options.calendar || ((instant) => timeHandler.calendar(instant));
    this.infrastructureFile = options.infrastructureFile || UPDATE_UNIT;
    this.updateDir = path.join(this.dataDir, 'update');
    this.checkFile = path.join(this.updateDir, 'release-check.json');
    this.statusFile = path.join(this.updateDir, 'status.json');
    this.requestFile = path.join(this.updateDir, 'request.json');
    this.check = readJson(this.checkFile) || {};
    this.timer = null;
    this.automationTimer = null;
    this.started = false;
    this.checkPromise = null;
    this.db = null;
    this.settings = { ...updateSettingsRepo.DEFAULTS };
  }

  isSupported() {
    return fs.existsSync(this.infrastructureFile);
  }

  availableVersion() {
    const latest = normalizeVersion(this.check.latestVersion);
    return latest && compareVersions(latest, this.currentVersion) > 0 ? latest : null;
  }

  async checkNow({ force = false } = {}) {
    if (this.checkPromise) return this.checkPromise;
    const checkedAt = Date.parse(this.check.checkedAt || '');
    const intervalMs = updateSettingsRepo.INTERVALS[this.settings.checkInterval] || CHECK_INTERVAL_MS;
    if (!force && Number.isFinite(checkedAt) && this.now() - checkedAt < intervalMs) {
      return this.getStatus();
    }

    this.checkPromise = (async () => {
      const previous = { ...this.check };
      try {
        const release = await this.fetchLatest({ etag: force ? null : previous.etag });
        this.check = release.notModified
          ? { ...previous, checkedAt: new Date(this.now()).toISOString(), error: null }
          : {
              checkedAt: new Date(this.now()).toISOString(),
              latestVersion: release.version,
              releaseUrl: release.url,
              publishedAt: release.publishedAt,
              etag: release.etag || null,
              error: null,
              ...(previous.automaticAttemptKey ? { automaticAttemptKey: previous.automaticAttemptKey } : {}),
            };
      } catch (error) {
        this.check = {
          ...previous,
          checkedAt: new Date(this.now()).toISOString(),
          error: error && error.message ? error.message : 'Updateprüfung fehlgeschlagen.',
        };
      }
      writeJsonAtomic(this.checkFile, this.check);
      return this.getStatus();
    })().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  getStatus() {
    const operation = readJson(this.statusFile);
    return {
      currentVersion: this.currentVersion,
      availableVersion: this.availableVersion(),
      releaseUrl: this.check.releaseUrl || null,
      checkedAt: this.check.checkedAt || null,
      checkError: this.check.error || null,
      supported: this.isSupported(),
      settings: { ...this.settings },
      operation: operation && typeof operation === 'object' ? operation : null,
    };
  }

  async requestUpdate(version) {
    const wanted = normalizeVersion(version);
    if (!wanted) throw new Error('Ungültige Updateversion.');
    if (!this.isSupported()) throw new Error('Der Self-Updater ist auf diesem System nicht installiert.');
    const status = await this.checkNow({ force: true });
    if (status.availableVersion !== wanted) {
      throw new Error('Das angeforderte Release ist nicht mehr das neueste verfügbare Release.');
    }
    if (fs.existsSync(this.requestFile)) throw new Error('Ein Update wurde bereits angefordert.');
    const startedAt = new Date(this.now()).toISOString();
    writeJsonAtomic(this.statusFile, {
      state: 'requested',
      targetVersion: wanted,
      startedAt,
      updatedAt: startedAt,
      messages: [{ at: startedAt, text: `Update auf Version ${wanted} wurde angefordert.` }],
    });
    // Zuletzt und atomar anlegen: home-ess-update.path reagiert auf genau diese Datei.
    writeJsonAtomic(this.requestFile, { version: wanted, requestedAt: startedAt });
    return this.getStatus();
  }

  async init(db) {
    this.db = db;
    const settings = await updateSettingsRepo.load(db);
    this.configure(settings);
    return settings;
  }

  configure(settings) {
    this.settings = updateSettingsRepo.normalize(settings);
    if (this.started) this.scheduleNextCheck();
    return { ...this.settings };
  }

  scheduleNextCheck() {
    if (this.timer) clearTimeout(this.timer);
    const intervalMs = updateSettingsRepo.INTERVALS[this.settings.checkInterval] || CHECK_INTERVAL_MS;
    const checkedAt = Date.parse(this.check.checkedAt || '');
    const elapsed = Number.isFinite(checkedAt) ? Math.max(0, this.now() - checkedAt) : intervalMs;
    const delay = Math.max(1000, intervalMs - elapsed);
    this.timer = setTimeout(async () => {
      await this.checkNow().catch(() => {});
      await this.maybeInstallAutomatic().catch(() => {});
      this.scheduleNextCheck();
    }, delay);
    this.timer.unref();
  }

  async maybeInstallAutomatic() {
    if (!this.settings.automaticEnabled || !this.isSupported()) return false;
    const version = this.availableVersion();
    if (!version || fs.existsSync(this.requestFile)) return false;
    const operation = readJson(this.statusFile);
    if (operation && !['completed', 'failed', 'failed_rollback'].includes(operation.state)) return false;

    const calendar = this.calendar(new Date(this.now()));
    const localTime = `${String(calendar.hours).padStart(2, '0')}:${String(calendar.minutes).padStart(2, '0')}`;
    if (!updateSettingsRepo.timeInWindow(localTime, this.settings.maintenanceStart, this.settings.maintenanceEnd)) return false;
    const attemptKey = `${calendar.dateKey}:${version}`;
    if (this.check.automaticAttemptKey === attemptKey) return false;

    // Vor dem Netzaufruf merken, damit ein nicht erreichbares GitHub nicht jede
    // Minute erneut angesprochen wird. Am nächsten lokalen Kalendertag ist ein
    // neuer Versuch möglich.
    this.check = { ...this.check, automaticAttemptKey: attemptKey };
    writeJsonAtomic(this.checkFile, this.check);
    await this.requestUpdate(version);
    return true;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.checkNow().catch(() => {}).then(() => this.maybeInstallAutomatic()).catch(() => {}).finally(() => this.scheduleNextCheck());
    this.automationTimer = setInterval(() => this.maybeInstallAutomatic().catch(() => {}), AUTOMATION_TICK_MS);
    this.automationTimer.unref();
  }

  shutdown() {
    if (this.timer) clearTimeout(this.timer);
    if (this.automationTimer) clearInterval(this.automationTimer);
    this.timer = null;
    this.automationTimer = null;
    this.started = false;
  }
}

const service = new UpdateService();

module.exports = service;
module.exports.UpdateService = UpdateService;
module.exports.CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;
