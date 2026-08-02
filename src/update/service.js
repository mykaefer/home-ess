'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { fetchLatestRelease } = require('./release-client');
const { normalizeVersion, compareVersions } = require('./version');

const pkg = require('../../package.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
    this.infrastructureFile = options.infrastructureFile || UPDATE_UNIT;
    this.updateDir = path.join(this.dataDir, 'update');
    this.checkFile = path.join(this.updateDir, 'release-check.json');
    this.statusFile = path.join(this.updateDir, 'status.json');
    this.requestFile = path.join(this.updateDir, 'request.json');
    this.check = readJson(this.checkFile) || {};
    this.timer = null;
    this.started = false;
    this.checkPromise = null;
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
    if (!force && Number.isFinite(checkedAt) && this.now() - checkedAt < CHECK_INTERVAL_MS) {
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

  start() {
    if (this.started) return;
    this.started = true;
    const scheduleNext = () => {
      const checkedAt = Date.parse(this.check.checkedAt || '');
      const elapsed = Number.isFinite(checkedAt) ? Math.max(0, this.now() - checkedAt) : CHECK_INTERVAL_MS;
      const delay = Math.max(1000, CHECK_INTERVAL_MS - elapsed);
      this.timer = setTimeout(async () => {
        await this.checkNow().catch(() => {});
        scheduleNext();
      }, delay);
      this.timer.unref();
    };
    this.checkNow().catch(() => {}).finally(scheduleNext);
  }

  shutdown() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }
}

const service = new UpdateService();

module.exports = service;
module.exports.UpdateService = UpdateService;
module.exports.CHECK_INTERVAL_MS = CHECK_INTERVAL_MS;
