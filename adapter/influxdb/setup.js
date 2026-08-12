'use strict';

// Ersteinrichtung einer lokalen InfluxDB 1.x — vollständig innerhalb des
// Adapters, ohne Eingriff in homeESS oder dessen Installer.
//
// Die eigentliche Arbeit erledigt das mitgelieferte `install-influxdb.sh`. Es
// gibt genau diesen einen Weg, der auf zweierlei Art ausgelöst werden kann:
//
//   * Läuft der Adapterprozess ausnahmsweise mit Rootrechten, ruft er das
//     Skript selbst auf (Kennwort über eine Umgebungsvariable).
//   * Im Normalbetrieb läuft homeESS unprivilegiert (NoNewPrivileges,
//     ProtectSystem=strict) und kann weder Pakete installieren noch /etc
//     beschreiben. Dann nennt die Verwaltungsseite den fertigen Befehl, den der
//     Betreiber in einer Root-Konsole ausführt.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INFLUXD_CANDIDATES = ['/usr/bin/influxd', '/usr/sbin/influxd', '/usr/local/bin/influxd'];
const APT = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';
const SCRIPT_NAME = 'install-influxdb.sh';
const SCRIPT_PATH = path.join(__dirname, SCRIPT_NAME);
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

// Ist auf diesem Server bereits eine InfluxDB installiert? Nur dann darf keine
// Ersteinrichtung mehr angeboten werden — sie würde Vorhandenes überschreiben.
function localInstallationPresent() {
  return INFLUXD_CANDIDATES.some(fileExists);
}

// Kann der Adapterprozess selbst installieren? Das setzt Rootrechte und die
// Paketwerkzeuge voraus und ist im Normalbetrieb nicht gegeben.
function canInstallLocally() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === 0 && fileExists(APT) && fileExists(SYSTEMCTL) && fileExists(SCRIPT_PATH);
}

function scriptPath() {
  return SCRIPT_PATH;
}

function readScript() {
  try {
    return fs.readFileSync(SCRIPT_PATH, 'utf8');
  } catch (_) {
    return '';
  }
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

function retentionPolicy(days) {
  const value = Math.max(0, Math.round(Number(days) || 0));
  return {
    name: value > 0 ? `homeess_${value}d` : 'homeess_forever',
    duration: value > 0 ? `${value}d` : 'INF',
  };
}

function scriptArguments(config = {}) {
  return [
    '--database', String(config.database || 'homeess'),
    '--user', String(config.username || 'homeess'),
    '--port', String(Number(config.port) || 8086),
    '--retention', String(Math.max(0, Math.round(Number(config.retentionDays) || 730))),
  ];
}

// Der Befehl für die Root-Konsole. Kein `sudo`: Der Hinweis nennt ausdrücklich
// eine Root-Konsole, und auf einem Minimalsystem ist sudo nicht zwingend
// installiert. Das Kennwort steht bewusst nicht darin — das Skript fragt es
// verdeckt ab, damit es weder in der Shell-History noch in der Prozessliste
// landet.
function installCommand(config = {}) {
  const args = scriptArguments(config).map((value, index) => (index % 2 === 0 ? value : shellQuote(value)));
  return `bash ${shellQuote(SCRIPT_PATH)} ${args.join(' ')}`;
}

function validate(config) {
  const database = String(config.database || '');
  const username = String(config.username || '');
  const password = String(config.password || '');
  const port = Number(config.port) || 8086;
  if (!NAME_RE.test(database)) throw new Error('Der Datenbankname enthält unzulässige Zeichen.');
  if (!NAME_RE.test(username)) throw new Error('Der Benutzername enthält unzulässige Zeichen.');
  if (password.length < 8) throw new Error('Bitte zuerst ein Kennwort mit mindestens acht Zeichen in den Instanzeinstellungen hinterlegen.');
  if (/['"\\\n\r]/.test(password)) throw new Error('Das Kennwort enthält unzulässige Zeichen (Anführungszeichen oder Backslash).');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger Port.');
  return { database, username, password, port, retentionDays: Math.max(0, Math.round(Number(config.retentionDays) || 730)) };
}

// Das mitgelieferte Skript im eigenen Prozess ausführen — nur sinnvoll, wenn
// canInstallLocally() gilt. `report` erhält jede Ausgabezeile für die
// Fortschrittsanzeige. Das Kennwort geht über die Umgebung, nicht über die
// Befehlszeile.
function runLocalInstall(config, report = () => {}) {
  const settings = validate(config);
  if (!canInstallLocally()) {
    return Promise.reject(new Error('Für die automatische Einrichtung fehlen die Rechte.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [SCRIPT_PATH, ...scriptArguments(settings)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, INFLUX_SETUP_PASSWORD: settings.password },
    });
    let stderr = '';
    let rest = '';
    const emit = (chunk) => {
      rest += chunk.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop() || '';
      for (const line of lines) if (line.trim()) report(line.trim());
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
    child.stdout.on('data', emit);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      emit(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rest.trim()) report(rest.trim());
      if (code === 0) resolve(true);
      else reject(new Error(`Die Einrichtung endete mit Code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : '.'}`));
    });
  });
}

module.exports = {
  SCRIPT_NAME,
  localInstallationPresent,
  canInstallLocally,
  scriptPath,
  readScript,
  installCommand,
  scriptArguments,
  runLocalInstall,
  validate,
  retentionPolicy,
};
