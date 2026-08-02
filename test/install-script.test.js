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

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
