'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-install-'));

function writeUnit(name, body) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, body);
  return file;
}

function isLegacyHomeessUnit(file) {
  const result = spawnSync(
    'bash',
    ['-c', 'source ./install.sh; is_legacy_homeess_service_file "$1"', 'bash', file],
    { cwd: ROOT, encoding: 'utf8' }
  );
  return result.status === 0;
}

test('Installer-Script ist syntaktisch gültig und beim Sourcen nebenwirkungsfrei', () => {
  execFileSync('bash', ['-n', 'install.sh'], { cwd: ROOT });
  execFileSync('bash', ['-c', 'source ./install.sh'], { cwd: ROOT });
});

test('Installer-Einstieg funktioniert mit leerem BASH_SOURCE wie bei curl | bash', () => {
  const result = spawnSync('bash', ['-uc', `
    main() { printf 'main-called'; }
    if [[ \${BASH_SOURCE[0]:-$0} == "$0" ]]; then main; fi
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'main-called');
});

test('Legacy-Cleanup erkennt nur server.service dieser homeESS-Installation', () => {
  const homeess = writeUnit('homeess.service', `[Service]\nWorkingDirectory=/opt/home-ess\nExecStart=/usr/bin/node /opt/home-ess/server.js\n`);
  const foreign = writeUnit('foreign.service', `[Service]\nExecStart=/usr/bin/node /srv/other/server.js\n`);
  assert.equal(isLegacyHomeessUnit(homeess), true);
  assert.equal(isLegacyHomeessUnit(foreign), false);
});

test('HOME_ESS_DATA_DIR steuert alle standardmäßigen dauerhaften Pfade', () => {
  const dataDir = path.join(TMP, 'persistent-data');
  const output = execFileSync(process.execPath, ['-e', `
    const config = require('./src/config');
    process.stdout.write(JSON.stringify({
      data: config.DATA_DIR,
      db: config.DB_PATH,
      identity: config.IDENTITY_DIR,
      adapterSelection: config.ADAPTER_SELECTION_FILE,
    }));
  `], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME_ESS_DATA_DIR: dataDir,
      HOME_ESS_DB: '',
      HOME_ESS_IDENTITY_DIR: '',
    },
  });
  assert.deepEqual(JSON.parse(output), {
    data: dataDir,
    db: path.join(dataDir, 'app.db'),
    identity: path.join(dataDir, 'identity'),
    adapterSelection: path.join(dataDir, 'adapter-selection.json'),
  });
});

test('Installer richtet den ausgelagerten systemd-Self-Updater ein', () => {
  const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(script, /install_self_updater/);
  assert.match(script, /home-ess-update\.path/);
  assert.match(script, /UPDATE_HELPER_DIR="\/usr\/local\/lib\/\$\{APP_NAME\}"/);
  assert.match(script, /UPDATE_HELPER_FILE="\$\{UPDATE_HELPER_DIR\}\/self-update\.js"/);
  assert.match(script, /systemctl enable --now "\$\{APP_NAME\}-update\.path"/);
});

test('Adapterverzeichnis bleibt gezielt uploadfähig und Self-Updates erhalten Fremdadapter', () => {
  const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const updater = fs.readFileSync(path.join(ROOT, 'updater', 'self-update.js'), 'utf8');
  assert.match(script, /install -d -m 2775 -o root -g "\$\{APP_GROUP\}" "\$\{INSTALL_DIR\}\/adapter"/);
  assert.match(script, /ReadWritePaths=\$\{DATA_DIR\} \$\{INSTALL_DIR\}\/adapter/);
  assert.match(script, /reconcile_adapter_selection/);
  assert.match(script, /backup_adapter_directory/);
  assert.match(script, /RESTORE_ALL_ADAPTERS/);
  assert.match(script, /--all\) RESTORE_ALL_ADAPTERS=1/);
  assert.match(updater, /adapterSelection\.reconcileUpdate/);
  assert.match(updater, /ADAPTER_SELECTION_FILE/);
});

test('Installer akzeptiert ausschließlich den ausdrücklichen Schalter --all', () => {
  const accepted = execFileSync('bash', ['-c', 'source ./install.sh; parse_arguments --all; printf %s "$RESTORE_ALL_ADAPTERS"'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(accepted, '1');
  const rejected = spawnSync('bash', ['-c', 'source ./install.sh; parse_arguments --alles'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unbekannte Option/);
});

test('Optionale Installer-Guards behandeln „nichts zu tun“ als Erfolg', () => {
  const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(script, /LEGACY_SERVICE_FILE} \|\| -L \$\{LEGACY_SERVICE_FILE} \]\] \|\| return 0/);
  assert.match(script, /\[\[ ! -e \$\{DB_PATH} \]\] \|\| return 0/);
  assert.match(script, /LEGACY_DATA_DIR}\/app\.db && ! -L \$\{LEGACY_DATA_DIR}\/app\.db \]\] \|\| return 0/);
  assert.match(script, /Fehlgeschlagener Befehl:/);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
