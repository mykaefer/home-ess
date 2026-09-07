'use strict';

// Wacht über die Zweisprachigkeit der server-gerenderten Seiten.
//
// Die Bestandsansichten werden nicht über t() geführt, sondern über den
// Katalog: i18n.localizeText() ersetzt im fertigen HTML jeden deutschen
// Ausgangstext aus languages/de.json durch seine Übersetzung. Fehlt ein
// sichtbarer Text im Katalog, bleibt er in jeder Sprache deutsch — genau das
// prüft dieser Test.
//
// Erfasst werden vollständige Textknoten (Inline-Auszeichnung eingeschlossen),
// sichtbare Attribute und die Stringliterale der eingebetteten Browserskripte.
// Kommt eine neue Seite hinzu, schlägt der Test fehl, bis ihre Texte im Katalog
// stehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEW_DIR = path.join(__dirname, '..', 'src', 'views');
const SRC_DIR = path.join(__dirname, '..', 'src');
const LANG_DIR = path.join(__dirname, '..', 'languages');

// Nicht übersetzbar oder in beiden Sprachen gleich: Eigennamen, Zeitzonen-IDs,
// Kopfzeilen, Datentypen und Bezeichner aus dem Quelltext.
const EXEMPT = new Set([
  'homeESS', 'homeess', 'http', 'https', 'kWh', 'Android', 'Smartphone', 'Server', 'Version',
  'Fingerprint', 'Remote', 'Theme', 'Picker', 'Pause', 'Operation', 'Round', 'Error',
  'Topic', 'Value', 'Value2', 'Boolean', 'Integer', 'Floating Point', 'JSON',
  'Grid actual', 'Grid by Load', 'Grid by SoC', 'Grid by Voltage',
  'MyKaefer Apps', 'Segoe UI', 'xMidYMid meet', 'DOMContentLoaded', 'Enter',
  'Content-Type', 'X-HomeESS-Request', 'X-HomeESS-Update', 'X-Upload-Filename',
  'HeizungSeq', 'heimkino://', 'input, select, textarea', 'return false;',
  'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Paris',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Athens',
  'Europe/Helsinki', 'Europe/Moscow', 'Atlantic/Reykjavik', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  '— W', '— %', '— V', '— °C', 'W/m²',
  // Fußzeile: Eigennamen der Urheberschaft.
  'Copyright (C) 2026 Kevin Käfer | MyKaefer Apps Version:',
  'Copyright (C) 2026 Kevin Käfer | MyKaefer Apps', 'Copyright (C) 2026 Kevin Käfer |', 'Login',
  // Technische Angaben ohne Sprachanteil.
  'tbody tr[data-search]', 'data-state-picker autocomplete=',
  'width=device-width, initial-scale=1, viewport-fit=cover',
  'width=device-width, initial-scale=1',
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
  'Generiert mit homeESS Version: Copyright (C) 2026 Kevin Käfer | MyKaefer Apps',
  'Paris', 'Madrid', 'Amsterdam', 'Helsinki', 'Reykjavík', 'New York', 'Chicago',
  'Denver', 'Los Angeles', 'São Paulo', 'Dubai', 'Kolkata', 'Shanghai', 'Sydney',
]);

const INLINE = 'strong|em|b|i|code|br|small|abbr|a';
const BLOCK = 'p|h1|h2|h3|h4|h5|h6|label|th|td|button|option|summary|legend|caption|small|span|div|li|a';

const hasWord = (text) => /[A-Za-zÄÖÜäöüß]{3,}/.test(text);
// Reste zerschnittener Konkatenationen und CSS-Selektoren sind kein Anzeigetext.
const isArtefact = (text) => /(^|\s)[+?]\s|\s[+?]\s*$|^[#.][A-Za-z]|^\)|\)\s*[:;]?$|[`;']|=>|\.\w+\(/.test(text)
  // Ein an einem Zitat zerschnittenes Literal trägt ein unpaariges „ oder ".
  || (text.split('„').length !== text.split('"').length);

// Sichtbarer Text oder Technik (Klassenliste, Topic, Bezeichner, Inline-CSS)?
function isDisplayLiteral(text) {
  if (text.length < 3 || text.length > 400) return false;
  if (!hasWord(text)) return false;
  if (!/[A-ZÄÖÜ]/.test(text[0]) && !/\s/.test(text)) return false;
  if (/[<>{}$]/.test(text)) return false;
  if (/^[a-z0-9_.:/-]+$/.test(text)) return false;
  if (/^[A-Z_]+$/.test(text)) return false;
  if (/^[a-z0-9_\- ]+$/.test(text)) return false;
  if (/=>|\)\s*\.|\w\(|\[\]|===|\+\s*'/.test(text)) return false;
  if (/^[.,;:+]/.test(text)) return false;
  if (isArtefact(text)) return false;
  if (/[:;]\s*[\d#]/.test(text) && /;/.test(text)) return false;
  if (/:\/\//.test(text)) return false;
  return true;
}

// Alle sichtbaren Texte einer View-Datei.
// Sätze einer Datei samt Inline-Auszeichnung — die Form, die als ein
// Katalogeintrag geführt wird.
function blockTexts(source) {
  const found = new Set();
  const blocks = new RegExp(
    `<(${BLOCK})(?:\\s[^<>]*)?>((?:[^<>]|<\\/?(?:${INLINE})(?:\\s[^<>]*)?\\s*\\/?>)*?)<\\/\\1>`, 'g');
  for (const match of source.matchAll(blocks)) {
    const text = match[2].replace(/\s+/g, ' ').trim().normalize('NFC');
    if (text) found.add(text);
  }
  return found;
}

function visibleTexts(source) {
  const found = new Set();
  const blocks = new RegExp(`<(${BLOCK})(?:\\s[^<>]*)?>((?:[^<>]|<\\/?(?:${INLINE})\\s*\\/?>)*?)<\\/\\1>`, 'g');
  // Ein <a>-Element darf Attribute tragen; der Satz bleibt trotzdem eine Einheit.
  const inlineOnly = new RegExp(`^(?:[^<>\${}]|<\\/?(?:${INLINE})(?:\\s[^<>]*)?\\s*\\/?>)+$`);
  for (const match of source.matchAll(blocks)) {
    const text = match[2].replace(/\s+/g, ' ').trim().normalize('NFC');
    if (text && hasWord(text) && inlineOnly.test(text) && !isArtefact(text)) found.add(text);
  }
  // Roher Textknoten: genau die Form, die localizeText() ersetzt. Erfasst auch
  // Beschriftungen neben verschachtelten Elementen (`<span>Titel <span>…`).
  for (const match of source.matchAll(/>([^<>${}]+)</g)) {
    const text = match[1].replace(/\s+/g, ' ').trim().normalize('NFC');
    if (text && hasWord(text) && !isArtefact(text)) found.add(text);
  }
  for (const match of source.matchAll(/(?:placeholder|title|aria-label|alt)\s*=\s*"([^"${}\n]+)"/g)) {
    const text = match[1].replace(/\s+/g, ' ').trim().normalize('NFC');
    if (text && hasWord(text) && !isArtefact(text)) found.add(text);
  }
  for (const match of source.matchAll(/'([^'\\\n]{3,400})'|"([^"\\\n]{3,400})"/g)) {
    const text = (match[1] ?? match[2]).trim().normalize('NFC');
    if (isDisplayLiteral(text)) found.add(text);
    // Beispielangaben tragen mit „z. B." einen deutschen Anteil, auch wenn der
    // Rest eine blanke Zahl ist — sie fallen sonst durch das Wortraster.
    else if (/^z\.\s?B\./.test(text)) found.add(text);
  }
  return found;
}

function readCatalog(code) {
  return JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${code}.json`), 'utf8'));
}

test('Deutsch und Englisch führen dieselben Übersetzungsschlüssel', () => {
  const de = readCatalog('de');
  const en = readCatalog('en');
  const missing = Object.keys(de.messages).filter((key) => !(key in en.messages));
  const extra = Object.keys(en.messages).filter((key) => !(key in de.messages));
  assert.deepEqual(missing, [], 'Schlüssel fehlen in en.json');
  assert.deepEqual(extra, [], 'Schlüssel fehlen in de.json');
});

test('Jeder sichtbare Text der Seiten steht im Übersetzungskatalog', () => {
  const de = readCatalog('de');
  const known = new Set([
    ...Object.values(de.messages),
    ...Object.keys(de.aliases || {}),
  ].map((text) => text.normalize('NFC')));

  const gaps = [];
  for (const file of fs.readdirSync(VIEW_DIR).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(VIEW_DIR, file), 'utf8');
    // Ein ausgezeichneter Satz steht als Ganzes im Katalog. Seine Bruchstücke
    // erscheinen zusätzlich als eigene Textknoten — sie sind damit abgedeckt.
    // Verglichen wird nur gegen Sätze dieser Datei, sonst deckt ein fremder
    // Satz eine echte Lücke zu.
    const covering = [...blockTexts(source)].filter((text) => known.has(text)).join('\n');
    for (const text of visibleTexts(source)) {
      if (known.has(text) || EXEMPT.has(text) || covering.includes(text)) continue;
      gaps.push(`${file}: ${text}`);
    }
  }
  assert.deepEqual(gaps, [], `Ohne Katalogeintrag bleiben diese Texte in jeder Sprache deutsch:\n${gaps.join('\n')}`);
});

// Meldungen aus Routen und Fachlogik erreichen den Browser über
// i18n.localizePayload(): es übersetzt die Felder error, message, title, detail
// und text — aber nur, wenn der Text im Katalog steht. Erfasst werden hier
// satzartige Texte, das trennt Meldungen zuverlässig von Bezeichnern und SQL.

const SQL = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|FROM|WHERE|VALUES|COALESCE|PRAGMA|BEGIN|SHOW)\b/;

// Reine Logtexte; sie erscheinen nie in der Oberfläche.
const LOG_ONLY_FILES = /\/(origin-tunnel|relay-connection|relay-client|identity-store|pairing-state)\.js$/;

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function messages(source) {
  const found = new Set();
  for (const match of source.matchAll(/'([^'\\\n]{10,300})'|"([^"\\\n]{10,300})"/g)) {
    const text = (match[1] ?? match[2]).trim().normalize('NFC');
    if (!text || SQL.test(text)) continue;
    if (!/\s/.test(text) || !/[.!?]$/.test(text)) continue;   // kein Satz
    if (!/[A-ZÄÖÜ]/.test(text[0])) continue;
    if (/[<>{}$]/.test(text) || /:\/\//.test(text)) continue;
    if (!/[A-Za-zÄÖÜäöüß]{3,}/.test(text)) continue;
    found.add(text);
  }
  return found;
}

test('Jede Meldung aus Routen und Fachlogik steht im Übersetzungskatalog', () => {
  const de = readCatalog('de');
  const known = new Set([
    ...Object.values(de.messages),
    ...Object.keys(de.aliases || {}),
  ].map((text) => text.normalize('NFC')));

  const gaps = [];
  for (const file of sourceFiles(SRC_DIR)) {
    if (file.includes(`${path.sep}views${path.sep}`) || LOG_ONLY_FILES.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const text of messages(source)) {
      if (known.has(text) || EXEMPT.has(text)) continue;
      gaps.push(`${path.relative(SRC_DIR, file)}: ${text}`);
    }
  }
  assert.deepEqual(gaps, [], `Diese Meldungen erreichen den Browser unübersetzt:\n${gaps.join('\n')}`);
});

// Dritte Bauform: ein Textknoten, der Beschriftung und eingesetzten Wert mischt
// (`Typ: ${wert}`). Der Katalog ersetzt nur vollständige Textknoten, deshalb
// muss die Beschriftung entweder in einem eigenen Element stehen oder der Satz
// über i18n.t() mit Platzhaltern laufen. Geprüft wird der Textrest ohne
// Einsetzungen: er muss im Katalog stehen.
test('Beschriftungen neben eingesetzten Werten sind übersetzbar', () => {
  const de = readCatalog('de');
  const known = new Set([
    ...Object.values(de.messages),
    ...Object.keys(de.aliases || {}),
  ].map((text) => text.normalize('NFC')));

  const blocks = new RegExp(
    `<(${BLOCK})(?:\\s[^<>]*)?>((?:[^<>]|<\\/?(?:${INLINE})(?:\\s[^<>]*)?\\s*\\/?>)*?)<\\/\\1>`, 'g');
  const gaps = [];
  for (const file of fs.readdirSync(VIEW_DIR).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(VIEW_DIR, file), 'utf8');
    for (const match of source.matchAll(blocks)) {
      const inner = match[2];
      if (!inner.includes('${')) continue;
      const rest = inner.replace(/\$\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ').trim().normalize('NFC');
      if (!rest || !/[A-Za-zÄÖÜäöüß]{3,}/.test(rest)) continue;
      // Verschachtelte Template-Literale zerschneidet der Ausdruck oben nicht
      // sauber; solche Reste tragen Code-Zeichen und sind kein Anzeigetext.
      if (/[`)}\]]|=>/.test(rest)) continue;
      if (known.has(rest) || EXEMPT.has(rest)) continue;
      gaps.push(`${file}: ${rest}`);
    }
  }
  assert.deepEqual(gaps, [], `Diese Beschriftungen stehen neben einem Wert und bleiben deutsch:\n${gaps.join('\n')}`);
});
