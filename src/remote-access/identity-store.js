'use strict';

// Dauerhafte, sicher gespeicherte Ed25519-Instanzidentität von homeESS.
//
// Verantwortlichkeiten (gekapselte Fachschicht — keine Datei-/Crypto-Logik in
// Routen oder Views):
//   loadOrCreateInstanceIdentity()  – Schlüssel einmalig erzeugen, sonst laden
//   getInstancePublicIdentity()     – öffentliche Identität (Base64, Fingerprint)
//   signInstancePairingProof(...)   – Instanz-Proof beim Confirm (Abschnitt 28.2)
//   signRelayChallenge(...)         – Signatur der WebSocket-Challenge (Abschnitt 33)
//   storeProvisionedIdentity(...)   – provisionierte IDs persistent speichern
//   getProvisionedIdentity()        – gespeicherte Provisioning-Daten lesen
//   clearProvisionedDeviceLink(...) – Gerätekopplung lösen (spätere Verwaltung)
//
// Speicherlayout (Verzeichnis 0700, Dateien 0600, nie im Repo, nie geloggt):
//   <IDENTITY_DIR>/instance-private-key.pk8   rohe PKCS8-DER-Bytes
//   <IDENTITY_DIR>/identity.json              Metadaten + Provisioning-Daten
//
// Der private Schlüssel wird NIE in der JSON gespeichert, nie an den Browser
// ausgegeben, nie geloggt und nie in Fehlermeldungen aufgenommen.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { RemoteAccessError } = require('./errors');
const {
  ALGORITHM,
  fingerprintHexFromSpkiDer,
  fingerprintDisplayFromHex,
  normalizeFingerprintHex,
  normalizeFingerprintLoose,
  fingerprintMatchesHex,
  fingerprintsConsistent,
  exportPublicSpkiDer,
  exportPublicSpkiBase64,
  buildInstanceProofPayload,
  buildAuthPayload,
  sha256HexUtf8,
  signPayload,
} = require('./identity-crypto');

const IDENTITY_VERSION = 1;
const PRIV_FILE = 'instance-private-key.pk8';
const JSON_FILE = 'identity.json';

// Größenlimits — eine gültige Identität ist winzig; alles Größere ist Angriff
// oder Beschädigung.
const MAX_PRIV_BYTES = 4096;
const MAX_JSON_BYTES = 64 * 1024;

// Datei-/Verzeichnisrechte.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Öffnen ohne Symlinks am letzten Pfadsegment (O_NOFOLLOW).
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

// Prozessweiter Lade-/Erzeugungs-Lock: verhindert doppelte Erzeugung bei
// parallelen Requests im selben Prozess.
let loadPromise = null;
// Serialisiert schreibende Provisioning-Operationen.
let writeChain = Promise.resolve();

// Konfigurierbares Identitätsverzeichnis (per Init gesetzt).
let identityDir = null;

function init(dir) {
  identityDir = dir;
}

function requireDir() {
  if (!identityDir) {
    throw new RemoteAccessError('remote_access_internal_error', 'Identity-Verzeichnis nicht konfiguriert.');
  }
  return identityDir;
}

// ---- Verzeichnis / atomare Schreibvorgänge ---------------------------------

// Stellt das Identitätsverzeichnis mit restriktiven Rechten sicher und lehnt
// ein per Symlink untergeschobenes Verzeichnis ab.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identity-Verzeichnis ist ein Symlink.');
  }
  if (!st.isDirectory()) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identity-Pfad ist kein Verzeichnis.');
  }
  // Rechte hart setzen (mkdir-mode wird durch umask gefiltert).
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch (_) {
    /* Best effort — z. B. wenn nicht Eigentümer. */
  }
}

// Schreibt Bytes atomar: temporäre Datei (O_EXCL|O_NOFOLLOW), fsync, Rename.
function atomicWrite(dir, name, data) {
  const finalPath = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const flags = fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL | NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(tmpPath, flags, FILE_MODE);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmpPath, FILE_MODE);
    fs.renameSync(tmpPath, finalPath);
    // Verzeichnis-Eintrag dauerhaft machen.
    try {
      const dfd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (_) { /* Best effort. */ }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* egal */ }
    throw err;
  }
}

// Liest eine reguläre Datei mit Größenlimit und Symlink-Schutz.
function readLimited(filePath, maxBytes, codeOnError) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err && err.code === 'ELOOP') {
      throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identity-Datei ist ein Symlink.');
    }
    throw new RemoteAccessError(codeOnError, 'Identity-Datei nicht lesbar.');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identity-Pfad ist keine reguläre Datei.');
    }
    if (st.size > maxBytes) {
      throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identity-Datei ist zu groß.');
    }
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

// ---- Erzeugen / Laden -------------------------------------------------------

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

// Baut die JSON-Metadaten (ohne privaten Schlüssel).
function buildMetadata(publicKey, createdAt, provisioning) {
  const spkiB64 = exportPublicSpkiBase64(publicKey);
  const fingerprint = fingerprintHexFromSpkiDer(exportPublicSpkiDer(publicKey));
  const meta = {
    version: IDENTITY_VERSION,
    algorithm: ALGORITHM,
    publicKey: spkiB64,
    fingerprint,
    createdAt,
  };
  if (provisioning) meta.provisioning = provisioning;
  return meta;
}

// Validiert geladene Metadaten und rekonstruiert das öffentliche KeyObject.
function parseAndValidateMetadata(jsonBuf) {
  let meta;
  try {
    meta = JSON.parse(jsonBuf.toString('utf8'));
  } catch (_) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'identity.json ist kein gültiges JSON.');
  }
  if (!meta || typeof meta !== 'object') {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'identity.json ist leer.');
  }
  if (meta.version !== IDENTITY_VERSION) {
    // Unbekannte (auch zukünftige) Version nicht still akzeptieren.
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'identity.json hat unbekannte Version.');
  }
  if (meta.algorithm !== ALGORITHM) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'identity.json hat falschen Algorithmus.');
  }
  let publicKey;
  try {
    const der = Buffer.from(String(meta.publicKey), 'base64');
    publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('kein ed25519');
  } catch (_) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'identity.json hat ungültigen Public Key.');
  }
  const fp = fingerprintHexFromSpkiDer(exportPublicSpkiDer(publicKey));
  if (fp !== meta.fingerprint) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Fingerprint in identity.json passt nicht.');
  }
  return { meta, publicKey, fingerprint: fp };
}

// Importiert und validiert den privaten Schlüssel, prüft die Zugehörigkeit zum
// öffentlichen Schlüssel.
function importAndCheckPrivateKey(privBuf, publicKey) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: privBuf, format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('kein ed25519');
  } catch (_) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Privater Instanzschlüssel ist ungültig.');
  }
  // Zugehörigkeit prüfen: aus dem privaten Schlüssel abgeleiteter öffentlicher
  // Schlüssel muss byte-identisch zum gespeicherten sein.
  const derivedSpki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const storedSpki = exportPublicSpkiDer(publicKey);
  if (!derivedSpki.equals(storedSpki)) {
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Privater und öffentlicher Instanzschlüssel passen nicht zusammen.');
  }
  return privateKey;
}

// Interner, synchron aufgebauter Identitätszustand (nur im Speicher).
function buildIdentity({ meta, publicKey, privateKey, fingerprint }) {
  return {
    algorithm: ALGORITHM,
    publicKey,
    privateKey,
    publicKeySpkiBase64: meta.publicKey,
    fingerprintHex: fingerprint,
    createdAt: meta.createdAt,
    provisioning: meta.provisioning || null,
  };
}

// Erzeugt einmalig ein neues Schlüsselpaar und persistiert es atomar. Wird der
// Wettlauf (parallele Erzeugung im selben Prozess ist durch loadPromise
// serialisiert; zwischen Prozessen durch O_EXCL) verloren, wird stattdessen die
// bereits vorhandene Identität geladen.
function createNew(dir) {
  const { publicKey, privateKey } = generateKeyPair();
  const createdAt = new Date().toISOString();
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const meta = buildMetadata(publicKey, createdAt, null);

  try {
    // Zuerst den privaten Schlüssel exklusiv anlegen (O_EXCL): scheitert, wenn
    // parallel bereits erzeugt.
    atomicWriteExclusive(dir, PRIV_FILE, privDer);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Ein anderer Erzeuger war schneller — vorhandene Identität laden.
      const loaded = loadExisting(dir);
      if (loaded) return loaded;
    }
    throw wrapFsError(err, 'remote_access_identity_store_corrupt');
  }
  // JSON darf überschrieben werden (atomarer Rename), der Key nicht.
  atomicWrite(dir, JSON_FILE, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
  return buildIdentity({ meta, publicKey, privateKey, fingerprint: meta.fingerprint });
}

// Wie atomicWrite, aber die Zieldatei darf noch nicht existieren (O_EXCL auf
// dem finalen Namen über den Tmp-Rename hinaus): wir schreiben in eine Tmp-
// Datei und legen das Ziel per link/rename nur an, wenn es fehlt.
function atomicWriteExclusive(dir, name, data) {
  const finalPath = path.join(dir, name);
  // Existenz vorab prüfen (ohne Symlink-Folge).
  try {
    const st = fs.lstatSync(finalPath);
    if (st) {
      const e = new Error('exists');
      e.code = 'EEXIST';
      throw e;
    }
  } catch (err) {
    if (err && err.code === 'EEXIST') throw err;
    // ENOENT ist der Normalfall.
    if (!(err && err.code === 'ENOENT')) throw err;
  }
  const flags = fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL | NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(finalPath, flags, FILE_MODE);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  try { fs.chmodSync(finalPath, FILE_MODE); } catch (_) { /* egal */ }
}

// Lädt eine vorhandene Identität; gibt null zurück, wenn (noch) keine existiert.
function loadExisting(dir) {
  const jsonBuf = readLimited(path.join(dir, JSON_FILE), MAX_JSON_BYTES, 'remote_access_identity_store_corrupt');
  const privBuf = readLimited(path.join(dir, PRIV_FILE), MAX_PRIV_BYTES, 'remote_access_identity_store_corrupt');
  if (!jsonBuf && !privBuf) return null;
  if (!jsonBuf || !privBuf) {
    // Halb vorhandene Identität: nicht automatisch neu erzeugen, kontrolliert
    // scheitern (der Betreiber muss eingreifen).
    throw new RemoteAccessError('remote_access_identity_store_corrupt', 'Identität ist unvollständig (nur eine der beiden Dateien vorhanden).');
  }
  const { meta, publicKey, fingerprint } = parseAndValidateMetadata(jsonBuf);
  const privateKey = importAndCheckPrivateKey(privBuf, publicKey);
  return buildIdentity({ meta, publicKey, privateKey, fingerprint });
}

function wrapFsError(err, code) {
  if (err instanceof RemoteAccessError) return err;
  return new RemoteAccessError(code, 'Identity-Store-Fehler.', { cause: err && err.code });
}

// Öffentliche, prozessweit einmalige Lade-/Erzeugungsfunktion.
async function loadOrCreateInstanceIdentity() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const dir = requireDir();
    ensureDir(dir);
    const existing = loadExisting(dir);
    if (existing) return existing;
    return createNew(dir);
  })();
  try {
    return await loadPromise;
  } catch (err) {
    // Fehlgeschlagenen Ladeversuch nicht cachen — ein späterer Versuch (nach
    // Betreiber-Eingriff) soll erneut laufen können.
    loadPromise = null;
    throw err instanceof RemoteAccessError ? err : new RemoteAccessError('remote_access_identity_store_corrupt', 'Identität konnte nicht geladen werden.');
  }
}

let cachedIdentity = null;
async function identity() {
  if (!cachedIdentity) cachedIdentity = await loadOrCreateInstanceIdentity();
  return cachedIdentity;
}

// Read-only-Ladepfad: erzeugt NIE einen neuen Schlüssel. Gibt die vorhandene
// Identität zurück oder null, wenn (noch) keine existiert. Für Autostart/Status,
// damit ein Boot ohne Pairing kein Schlüsselmaterial anlegt. Bei beschädigtem
// Store wird kontrolliert geworfen (keine automatische Neuerzeugung).
async function loadReadOnlyIdentity() {
  if (cachedIdentity) return cachedIdentity;
  const dir = identityDir;
  if (!dir) return null;
  const existing = loadExisting(dir);
  if (existing) cachedIdentity = existing;
  return existing;
}

// ---- Öffentliche Identität --------------------------------------------------

async function getInstancePublicIdentity() {
  const id = await identity();
  return {
    algorithm: id.algorithm,
    publicKeySpkiBase64: id.publicKeySpkiBase64,
    fingerprintHex: id.fingerprintHex,
    fingerprintDisplay: fingerprintDisplayFromHex(id.fingerprintHex, { full: true }),
    createdAt: id.createdAt,
  };
}

// ---- Signaturen -------------------------------------------------------------

// Instanz-Proof beim Confirm. Erwartet die bereits ermittelten Rohwerte; hasht
// den Origin-Token intern (der Token selbst wird nie signiert oder gespeichert).
async function signInstancePairingProof({ pairingId, originToken, deviceFingerprintHex }) {
  const id = await identity();
  const originTokenHashHex = sha256HexUtf8(originToken);
  const deviceHex = normalizeFingerprintHex(deviceFingerprintHex);
  const payload = buildInstanceProofPayload({
    pairingId,
    originTokenHashHex,
    instanceFingerprintHex: id.fingerprintHex,
    deviceFingerprintHex: deviceHex,
  });
  const proof = signPayload(id.privateKey, payload);
  return {
    proof,
    publicKeySpkiBase64: id.publicKeySpkiBase64,
    instanceFingerprintHex: id.fingerprintHex,
  };
}

// Signatur der WebSocket-Challenge (Abschnitt 33). Erwartet die exakten Werte
// aus der Challenge/`hello`.
async function signRelayChallenge(fields) {
  const id = await identity();
  const payload = buildAuthPayload(fields);
  return signPayload(id.privateKey, payload);
}

// ---- Provisioning-Persistenz ------------------------------------------------

// Persistiert nach `paired` die provisionierten IDs/Fingerprints. Prüft strenge
// Konsistenz (keine stillen Identitätswechsel) und ist idempotent.
async function storeProvisionedIdentity(input) {
  return withWriteLock(async () => {
    const id = await identity();
    const provisioning = buildProvisioningRecord(id, input);
    const meta = buildMetadata(id.publicKey, id.createdAt, provisioning);
    atomicWrite(requireDir(), JSON_FILE, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
    id.provisioning = provisioning;
    if (cachedIdentity) cachedIdentity.provisioning = provisioning;
    return cloneProvisioning(provisioning);
  });
}

function buildProvisioningRecord(id, input) {
  const {
    instanceId,
    instanceName,
    instanceFingerprint,
    device,
    relayBaseUrl,
    protocolVersion,
    pairedAt,
  } = input || {};

  if (typeof instanceId !== 'string' || !/^ins_[A-Za-z0-9_-]{4,}$/.test(instanceId)) {
    throw new RemoteAccessError('remote_access_identity_mismatch', 'Ungültige instanceId.');
  }
  // Der vom Relay gemeldete Instanzfingerprint (Anzeige- oder Hexform, ggf.
  // gekürzt) muss zum lokal berechneten Fingerprint passen — kein stiller
  // Identitätswechsel.
  if (!fingerprintMatchesHex(instanceFingerprint, id.fingerprintHex)) {
    throw new RemoteAccessError('remote_access_identity_mismatch', 'Relay-Instanzfingerprint weicht vom lokalen Schlüssel ab.');
  }
  if (!device || typeof device !== 'object') {
    throw new RemoteAccessError('remote_access_provisioning_failed', 'Gerätedaten fehlen.');
  }
  if (typeof device.deviceId !== 'string' || !/^dev_[A-Za-z0-9_-]{4,}$/.test(device.deviceId)) {
    throw new RemoteAccessError('remote_access_identity_mismatch', 'Ungültige deviceId.');
  }
  // Gerätefingerprint aus Provisioning und (falls bekannt) aus dem Claim müssen
  // konsistent sein. Der vollständige Gerätefingerprint liegt homeESS nie vor
  // (nur der Relay kennt den Geräte-Public-Key); daher Präfix-Konsistenz statt
  // Byte-Gleichheit.
  let deviceDisplay = normalizeFingerprintLoose(device.fingerprint);
  if (device.claimFingerprint) {
    if (!fingerprintsConsistent(device.fingerprint, device.claimFingerprint)) {
      throw new RemoteAccessError('remote_access_identity_mismatch', 'Gerätefingerprint weicht vom Claim ab.');
    }
    const claimNorm = normalizeFingerprintLoose(device.claimFingerprint);
    // Die längere (informativere) Form behalten.
    if (claimNorm.length > deviceDisplay.length) deviceDisplay = claimNorm;
  }

  const existing = (id.provisioning && id.provisioning.instanceId === instanceId) ? id.provisioning : null;
  const now = new Date().toISOString();
  const pairedAtIso = isoOrNow(pairedAt, now);
  // Bereits bekanntes Gerät? Dann Kopplungszeitpunkt und zuletzt bekannte
  // Verbindung erhalten — erneutes Provisioning ersetzt kein vorhandenes Gerät
  // und legt keinen Duplikateintrag an.
  const existingDevices = existing ? existing.devices : [];
  const priorDevice = existingDevices.find((d) => d.deviceId === device.deviceId) || null;

  const deviceRecord = {
    deviceId: device.deviceId,
    name: safeString(device.name, 100) || (priorDevice && priorDevice.name) || 'Gerät',
    platform: safeString(device.platform, 50) || (priorDevice && priorDevice.platform) || 'unknown',
    appVersion: safeString(device.appVersion, 50) || (priorDevice && priorDevice.appVersion) || null,
    fingerprintHex: deviceDisplay,
    pairedAt: priorDevice ? priorDevice.pairedAt : pairedAtIso,
    // Reiner Merker über die zuletzt bestätigte Relay-Verbindung; der aktuelle
    // Laufzeitstatus lebt getrennt davon (siehe device-status.js).
    lastKnownConnectedAt: priorDevice ? (priorDevice.lastKnownConnectedAt || null) : null,
    status: 'active',
  };

  const devices = existingDevices.filter((d) => d.deviceId !== deviceRecord.deviceId);
  devices.push(deviceRecord);

  return {
    version: 1,
    relayBaseUrl: safeString(relayBaseUrl, 512) || null,
    protocolVersion: safeString(protocolVersion, 16) || null,
    instanceId,
    instanceName: safeString(instanceName, 120) || (existing ? existing.instanceName : null),
    instanceFingerprintHex: id.fingerprintHex,
    pairedAt: existing ? existing.pairedAt : pairedAtIso,
    // Zuletzt akzeptierte linked_devices-Revision (Abschnitt 43) beibehalten;
    // Provisioning selbst setzt sie nicht.
    linkedDevicesRevision: existing && Number.isInteger(existing.linkedDevicesRevision) ? existing.linkedDevicesRevision : null,
    devices,
  };
}

async function getProvisionedIdentity() {
  const id = await loadReadOnlyIdentity();
  return id && id.provisioning ? cloneProvisioning(id.provisioning) : null;
}

// Schreibt den Merker `lastKnownConnectedAt` für aktuell verbundene Geräte fort.
// Rein additiv/monoton: nur bekannte Geräte (fremde deviceId wird ignoriert) und
// nur, wenn der neue Zeitstempel später liegt. Legt niemals neues
// Schlüsselmaterial an und schreibt nur bei tatsächlicher Änderung.
async function updateDeviceLastConnected(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return null;
  return withWriteLock(async () => {
    const id = await loadReadOnlyIdentity();
    if (!id || !id.provisioning) return null;
    const provisioning = cloneProvisioning(id.provisioning);
    let changed = false;
    for (const entry of list) {
      if (!entry || typeof entry.deviceId !== 'string') continue;
      const iso = isoOrNull(entry.connectedAt);
      if (!iso) continue;
      const dev = provisioning.devices.find((d) => d.deviceId === entry.deviceId);
      if (!dev) continue; // fremde/unbekannte deviceId ignorieren
      if (!dev.lastKnownConnectedAt || Date.parse(dev.lastKnownConnectedAt) < Date.parse(iso)) {
        dev.lastKnownConnectedAt = iso;
        changed = true;
      }
    }
    if (!changed) return cloneProvisioning(provisioning);
    const meta = buildMetadata(id.publicKey, id.createdAt, provisioning);
    atomicWrite(requireDir(), JSON_FILE, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
    id.provisioning = provisioning;
    if (cachedIdentity) cachedIdentity.provisioning = provisioning;
    return cloneProvisioning(provisioning);
  });
}

// Gleicht den lokalen Gerätebestand mit der autoritativen Geräteliste
// (linked_devices, Abschnitt 41/43) ab. Ausschließlich Verknüpfungen werden
// verändert — Instanzidentität, Schlüssel und andere Provisioning-Metadaten
// bleiben unangetastet. Verhalten:
//   - snapshot.instanceId muss zur provisionierten Instanz passen,
//   - ältere Revision (< zuletzt akzeptierte) wird ignoriert,
//   - complete !== true löscht/ändert nichts (kein Diff in dieser Stufe),
//   - bei gültigem, vollständigem Snapshot werden enthaltene Geräte
//     angelegt/aktualisiert und lokal gespeicherte, im Snapshot fehlende Geräte
//     entfernt (nur der Link; Fingerprint/lokale Merker bekannter Geräte bleiben).
async function reconcileLinkedDevices(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.instanceId !== 'string') return null;
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) return null;
  const snapshotDevices = Array.isArray(snapshot.devices) ? snapshot.devices : null;
  if (!snapshotDevices) return null;
  return withWriteLock(async () => {
    const id = await loadReadOnlyIdentity();
    if (!id || !id.provisioning) return null;
    const current = id.provisioning;
    // Fremde Instanz: nicht anwenden (Sicherheitsgrenze).
    if (snapshot.instanceId !== current.instanceId) return cloneProvisioning(current);
    // Ältere Revision ignorieren (außer der Reihe eintreffende, überholte Nachricht).
    if (Number.isInteger(current.linkedDevicesRevision) && snapshot.revision < current.linkedDevicesRevision) {
      return cloneProvisioning(current);
    }
    // Unvollständiger Snapshot löscht/ändert nichts.
    if (snapshot.complete !== true) return cloneProvisioning(current);

    const provisioning = cloneProvisioning(current);
    const existingById = new Map(provisioning.devices.map((d) => [d.deviceId, d]));
    const now = new Date().toISOString();
    const nextDevices = [];
    for (const sd of snapshotDevices) {
      if (!sd || typeof sd.deviceId !== 'string') continue;
      const prior = existingById.get(sd.deviceId) || null;
      const snapConnectedAt = (sd.connected && typeof sd.connectedAt === 'string') ? isoOrNull(sd.connectedAt) : null;
      nextDevices.push({
        deviceId: sd.deviceId,
        name: safeString(sd.deviceName, 100) || (prior && prior.name) || 'Gerät',
        platform: safeString(sd.platform, 50) || (prior && prior.platform) || 'unknown',
        appVersion: prior ? (prior.appVersion || null) : null,
        // linked_devices trägt keinen Fingerprint: bekannten Wert behalten.
        fingerprintHex: prior ? (prior.fingerprintHex || null) : null,
        pairedAt: (prior && prior.pairedAt) || isoOrNow(sd.pairedAt, now),
        lastKnownConnectedAt: laterIso(prior && prior.lastKnownConnectedAt, snapConnectedAt),
        status: 'active',
      });
    }
    // Geräte, die im Snapshot fehlen, verschwinden lokal (nur der Link).
    provisioning.devices = nextDevices;
    provisioning.linkedDevicesRevision = snapshot.revision;

    const meta = buildMetadata(id.publicKey, id.createdAt, provisioning);
    atomicWrite(requireDir(), JSON_FILE, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
    id.provisioning = provisioning;
    if (cachedIdentity) cachedIdentity.provisioning = provisioning;
    return cloneProvisioning(provisioning);
  });
}

// Löst eine Gerätekopplung (spätere Verwaltung/Widerruf lokal). Behält die
// Instanzidentität; nur der Gerätelink wird auf `revoked` gesetzt bzw. entfernt.
async function clearProvisionedDeviceLink(deviceId) {
  return withWriteLock(async () => {
    const id = await identity();
    if (!id.provisioning) return null;
    const provisioning = cloneProvisioning(id.provisioning);
    provisioning.devices = provisioning.devices.filter((d) => d.deviceId !== deviceId);
    const meta = buildMetadata(id.publicKey, id.createdAt, provisioning);
    atomicWrite(requireDir(), JSON_FILE, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8'));
    id.provisioning = provisioning;
    if (cachedIdentity) cachedIdentity.provisioning = provisioning;
    return cloneProvisioning(provisioning);
  });
}

// ---- Hilfsfunktionen --------------------------------------------------------

function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}

function cloneProvisioning(p) {
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

function safeString(value, maxLen) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function isoOrNow(value, fallback) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

function isoOrNull(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

// Gibt den späteren zweier ISO-Zeitstempel zurück (null-tolerant).
function laterIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

// Test-Hilfe: internen Cache/Lock zurücksetzen (nur für Tests, nie im Betrieb).
function _resetForTests(dir) {
  loadPromise = null;
  cachedIdentity = null;
  writeChain = Promise.resolve();
  identityDir = dir || null;
}

module.exports = {
  init,
  loadOrCreateInstanceIdentity,
  getInstancePublicIdentity,
  signInstancePairingProof,
  signRelayChallenge,
  storeProvisionedIdentity,
  getProvisionedIdentity,
  updateDeviceLastConnected,
  reconcileLinkedDevices,
  clearProvisionedDeviceLink,
  _internal: {
    _resetForTests,
    fingerprintDisplayFromHex,
    IDENTITY_VERSION,
    PRIV_FILE,
    JSON_FILE,
    FILE_MODE,
    DIR_MODE,
  },
};
