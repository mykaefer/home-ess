'use strict';

// Tests der Zweigwahl: VERSION.json als maßgebliche Versionsquelle, die feste
// Zweigliste, das Verhalten des Updatedienstes bei einem Zweigwechsel sowie die
// beiden Installer und der privilegierte Helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const branches = require('../src/update/branches');
const { parseVersionFile, readLocalVersion } = require('../src/update/version');
const { UpdateService } = require('../src/update/service');
const renderSettings = require('../src/views/settings');

const ROOT = path.join(__dirname, '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-branch-'));
  const unit = path.join(root, 'home-ess-update.path');
  fs.writeFileSync(unit, 'test');
  return { root, unit };
}

test('VERSION.json liegt im Stammverzeichnis und deckt sich mit package.json', () => {
  const file = fs.readFileSync(path.join(ROOT, 'VERSION.json'), 'utf8');
  const version = parseVersionFile(file);
  assert.ok(version, 'VERSION.json enthält eine Versionsnummer');
  // Die Datei trägt ausschließlich die Versionsangabe.
  assert.deepEqual(Object.keys(JSON.parse(file)), ['version']);
  assert.equal(readLocalVersion(ROOT), version);
  // Beide Angaben werden gemeinsam gepflegt – sonst zeigen Fußzeile und
  // Abhängigkeiten verschiedene Stände.
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, version);
});

test('Die Versionsdatei ist JSON mit dem Feld version', () => {
  assert.equal(parseVersionFile('{"version":"1.8.0"}'), '1.8.0');
  assert.equal(parseVersionFile('{\n  "version": "2.0.10"\n}\n'), '2.0.10');
  // Alles, was keine gültige Angabe ist, zählt nicht – dann greift der Rückfall.
  assert.equal(parseVersionFile('1.8.0'), null, 'blanker Text ist kein JSON');
  assert.equal(parseVersionFile('{"version":"kaputt"}'), null);
  assert.equal(parseVersionFile('{"version": 1.8}'), null);
  assert.equal(parseVersionFile('["1.8.0"]'), null);
  assert.equal(parseVersionFile('{'), null);
  assert.equal(parseVersionFile(''), null);
});

test('Ohne gültige VERSION.json gilt package.json als Rückfall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(readLocalVersion(dir), '1.2.3');
  // Unbrauchbare Datei: der Rückfall bleibt bestehen, statt ohne Version dazustehen.
  fs.writeFileSync(path.join(dir, 'VERSION.json'), '{kaputt');
  assert.equal(readLocalVersion(dir), '1.2.3');
  fs.writeFileSync(path.join(dir, 'VERSION.json'), '{"version":"1.4.0"}\n');
  assert.equal(readLocalVersion(dir), '1.4.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Nur die beiden bekannten Zweige sind wählbar; Adressen entstehen daraus', () => {
  assert.deepEqual(branches.BRANCHES, ['main', 'development']);
  assert.equal(branches.normalizeBranch('development'), 'development');
  assert.equal(branches.normalizeBranch('DEVELOPMENT'), 'development');
  // Alles Unbekannte fällt auf den stabilen Zweig zurück – aus Browserdaten
  // darf nie eine fremde Adresse entstehen.
  assert.equal(branches.normalizeBranch('../../evil'), 'main');
  assert.equal(branches.normalizeBranch('https://example.invalid'), 'main');
  assert.equal(
    branches.versionFileUrl('development'),
    'https://raw.githubusercontent.com/mykaefer/home-ess/development/VERSION.json'
  );
  assert.equal(
    branches.versionFileUrl('beliebig'),
    'https://raw.githubusercontent.com/mykaefer/home-ess/main/VERSION.json'
  );
});

test('Der installierte Zweig stammt aus .git/HEAD, sonst gilt main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-head-'));
  assert.equal(branches.installedBranch(dir), 'main');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/development\n');
  assert.equal(branches.installedBranch(dir), 'development');
  // Ein fremder Zweigname zählt nicht als bekannter Zweig.
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/xy\n');
  assert.equal(branches.installedBranch(dir), 'main');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Geprüft wird die Versionsdatei des eingestellten Zweigs', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asked = [];
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.7.3',
    installedBranch: 'main',
    infrastructureFile: unit,
    fetchLatest: async ({ branch }) => {
      asked.push(branch);
      return { version: branch === 'development' ? '1.8.0' : '1.7.4', branch, url: 'https://example.invalid/zweig' };
    },
  });

  await service.checkNow();
  assert.deepEqual(asked, ['main']);
  assert.equal(service.getStatus().availableVersion, '1.7.4');

  // Zweigwechsel: der gespeicherte Stand gilt nicht mehr, es wird sofort neu
  // geprüft – unabhängig vom Prüfintervall.
  service.configure({ branch: 'development' });
  await service.checkNow();
  assert.deepEqual(asked, ['main', 'development']);
  const status = service.getStatus();
  assert.equal(status.branch, 'development');
  assert.equal(status.installedBranch, 'main');
  assert.equal(status.branchSwitch, true);
  assert.equal(status.availableVersion, '1.8.0');
});

test('Beim Zweigwechsel zählt auch eine gleiche oder kleinere Version', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new UpdateService({
    dataDir: root,
    // Auf development installiert, dort steht die höhere Nummer.
    currentVersion: '1.9.0',
    installedBranch: 'development',
    infrastructureFile: unit,
    fetchLatest: async ({ branch }) => ({ version: '1.7.3', branch, url: 'https://example.invalid/zweig' }),
  });

  // Zurück auf den stabilen Zweig: die ältere Nummer ist trotzdem das Ziel,
  // sonst käme man von development nie wieder herunter.
  service.configure({ branch: 'main' });
  await service.checkNow({ force: true });
  assert.equal(service.getStatus().availableVersion, '1.7.3');

  // Ohne Zweigwechsel bleibt es bei „nur neuere Versionen".
  service.installedBranch = 'main';
  assert.equal(service.getStatus().availableVersion, null);
});

test('Die Updateanforderung trägt den Zweig für den privilegierten Helper', async (t) => {
  const { root, unit } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new UpdateService({
    dataDir: root,
    currentVersion: '1.7.3',
    installedBranch: 'main',
    infrastructureFile: unit,
    fetchLatest: async ({ branch }) => ({ version: '1.8.0', branch, url: 'https://example.invalid/zweig' }),
  });
  service.configure({ branch: 'development' });

  await service.requestUpdate('1.8.0');
  const request = JSON.parse(fs.readFileSync(path.join(root, 'update', 'request.json'), 'utf8'));
  assert.equal(request.version, '1.8.0');
  assert.equal(request.branch, 'development');
});

test('Die Updatekarte bietet den Zweig an und nennt den installierten', () => {
  const html = renderSettings({
    updateConfig: {
      automaticEnabled: false, maintenanceStart: '03:00', maintenanceEnd: '04:00',
      checkInterval: 'daily', branch: 'development',
    },
    updateStatus: {
      currentVersion: '1.7.3', availableVersion: '1.8.0', checkedAt: null, supported: true,
      branch: 'development', installedBranch: 'main', branchSwitch: true,
    },
  });
  assert.match(html, /id="updateBranch"/);
  assert.match(html, /<option value="development" selected>/);
  assert.match(html, /id="settingsUpdateBranch"/);
  assert.match(html, /Stabil \(main\)/);
  assert.match(html, /Entwicklung \(development\)/);
  // Die Auswahl steht in derselben Karte wie das Prüfintervall.
  assert.ok(html.indexOf('id="updateBranch"') < html.indexOf('id="updateCheckInterval"'));
});

test('Beide Installer sind gültig, nebenwirkungsfrei und kennen nur die zwei Zweige', () => {
  execFileSync('bash', ['-n', 'install.sh'], { cwd: ROOT });
  execFileSync('bash', ['-n', 'install-dev.sh'], { cwd: ROOT });
  execFileSync('bash', ['-c', 'source ./install-dev.sh'], { cwd: ROOT });

  // --branch wird ausgewertet …
  const picked = execFileSync('bash', ['-c', 'source ./install.sh; parse_arguments --branch development; printf "%s" "$BRANCH"'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(picked, 'development');
  const inline = execFileSync('bash', ['-c', 'source ./install.sh; parse_arguments --branch=main --all; printf "%s:%s" "$BRANCH" "$RESTORE_ALL_ADAPTERS"'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(inline, 'main:1');

  // … ein unbekannter Zweig bricht ab, statt in die git-Aufrufe zu gelangen.
  // Der Abbruch läuft über `exit`, deshalb die Prüfung in einer Subshell.
  const rejected = execFileSync('bash', ['-c',
    'source ./install.sh; ( parse_arguments --branch bösartig ) >/dev/null 2>&1 && code=0 || code=$?; printf "%s" "$code"',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(rejected, '0', 'ein unbekannter Zweig muss abbrechen');

  // Ohne Angabe bleibt es beim stabilen Zweig.
  const fallback = execFileSync('bash', ['-c', 'source ./install.sh; printf "%s" "$BRANCH"'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(fallback, 'main');

  // Der Entwicklungs-Installer bringt keine zweite Installationslogik mit,
  // sondern ruft den regulären Installer desselben Zweigs auf.
  const dev = fs.readFileSync(path.join(ROOT, 'install-dev.sh'), 'utf8');
  assert.match(dev, /readonly BRANCH="development"/);
  assert.match(dev, /home-ess\/\$\{BRANCH\}\/install\.sh/);
  assert.match(dev, /bash "\$\{installer\}" --branch "\$\{BRANCH\}"/);
  // Die geladene Adresse wird aus der festen Konstante gebildet.
  const url = execFileSync('bash', ['-c', 'source ./install-dev.sh; printf "%s" "$INSTALLER_URL"'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(url, 'https://raw.githubusercontent.com/mykaefer/home-ess/development/install.sh');
});

test('Der Installer klont und aktualisiert genau den gewählten Zweig', () => {
  const script = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  assert.match(script, /git clone --depth 1 --branch "\$\{BRANCH\}"/);
  assert.match(script, /git fetch --depth 1 origin "\$\{BRANCH\}"/);
  assert.match(script, /git checkout -B "\$\{BRANCH\}" FETCH_HEAD/);
  // Ein Update ohne ausdrückliche Angabe bleibt auf dem installierten Zweig.
  assert.match(script, /adopt_existing_branch/);
});

test('Der Installer liest die Versionsdatei als JSON, mit package.json als Rückfall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-installer-'));
  const ask = (sub) => execFileSync('bash', ['-c', `source ./install.sh; printf '%s' "$(installed_version '${path.join(dir, sub)}')"`], {
    cwd: ROOT, encoding: 'utf8',
  });
  const put = (sub, files) => {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, sub, name), content);
  };

  put('normal', { 'VERSION.json': '{\n  "version": "1.7.3"\n}\n', 'package.json': '{"version":"1.6.9"}' });
  put('kompakt', { 'VERSION.json': '{"version":"2.0.10"}' });
  put('kaputt', { 'VERSION.json': '{kaputt', 'package.json': '{"version":"1.6.9"}' });
  put('ungueltig', { 'VERSION.json': '{"version":"x"}', 'package.json': '{"version":"1.6.9"}' });
  put('nur_paket', { 'package.json': '{"version":"1.6.9"}' });
  put('leer', {});

  // Die Versionsdatei hat Vorrang …
  assert.equal(ask('normal'), '1.7.3');
  assert.equal(ask('kompakt'), '2.0.10');
  // … ist sie unbrauchbar oder fehlt sie, greift package.json …
  assert.equal(ask('kaputt'), '1.6.9');
  assert.equal(ask('ungueltig'), '1.6.9');
  assert.equal(ask('nur_paket'), '1.6.9');
  // … und ohne beides bleibt eine klare Aussage statt einer leeren Zeile.
  assert.equal(ask('leer'), 'unbekannt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Der privilegierte Helper prüft Zweig und Versionsdatei statt eines Release-Tags', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'updater', 'self-update.js'), 'utf8');
  assert.doesNotThrow(() => new Function(helper.replace(/^#!.*\n/, ''))); // eslint-disable-line no-new-func
  // Repository und Zweigliste stehen fest im Helper.
  assert.match(helper, /mykaefer\/home-ess\.git/);
  assert.match(helper, /const BRANCHES = \['main', 'development'\]/);
  assert.match(helper, /raw\.githubusercontent\.com\/mykaefer\/home-ess/);
  // Gelesen wird dieselbe JSON-Datei wie in der Anwendung.
  assert.match(helper, /VERSION\.json/);
  assert.match(helper, /JSON\.parse\(String\(text \|\| ''\)\)/);
  // Der Zweig der Anforderung wird gegen die Liste geprüft.
  assert.match(helper, /branchOf\(body\.branch\)/);
  assert.match(helper, /git', \['clone', '--depth', '1', '--branch', branch/);
  // Kein Rückfall auf die alte Release-API.
  assert.doesNotMatch(helper, /releases\/latest|tag_name/);
  assert.doesNotMatch(helper, /body\.(?:url|repository|repo)/);
});

test('README nennt beide Installer', () => {
  for (const file of ['README.md', 'README_de.md']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(text, /home-ess\/main\/install\.sh/, `${file}: regulärer Installer`);
    assert.match(text, /home-ess\/development\/install-dev\.sh/, `${file}: Entwicklungs-Installer`);
  }
});
