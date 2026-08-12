'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const i18n = require('../src/i18n');
const renderLogin = require('../src/views/login');

test('mitgelieferte Sprachregistry enthält Deutsch und Englisch', () => {
  const languages = i18n.scan();
  assert.deepEqual(languages.map((entry) => entry.code).sort(), ['de', 'en']);
});

test('Sprachdateien werden streng validiert und Unicode wird auf NFC normalisiert', () => {
  const language = i18n.validateDocument({
    code: 'fr', name: 'Franc\u0327ais', locale: 'fr-FR',
    messages: { greeting: 'Bonjou\u0301r' },
  }, 'fr.json');
  assert.equal(language.name, language.name.normalize('NFC'));
  assert.equal(language.messages.greeting, language.messages.greeting.normalize('NFC'));
  assert.throws(() => i18n.validateDocument({ code: '../de', name: 'x', messages: {} }, '../de.json'));
  assert.throws(() => i18n.validateDocument({ code: 'fr', name: 'Français', messages: {} }, 'de.json'));
});

test('Layout und Login übernehmen die systemweite Sprache', async () => {
  await i18n.select('en');
  const html = renderLogin({ users: [] });
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, />Sign in</);
  assert.match(html, /No users available/);
  await i18n.select('de');
});

test('Adapterkataloge folgen der Systemwahl und behalten Schlüsselzugriff', async (t) => {
  // Eigener Adapter im Temp-Verzeichnis: mitgelieferte Adapter darf der
  // Betreiber jederzeit entfernen, der Test darf davon nicht abhängen.
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-i18n-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'languages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'languages', 'de.json'), JSON.stringify({
    code: 'de', name: 'Deutsch', locale: 'de-DE', messages: { temperature: 'Temperatur' },
  }));
  fs.writeFileSync(path.join(dir, 'languages', 'en.json'), JSON.stringify({
    code: 'en', name: 'English', locale: 'en-GB', messages: { temperature: 'Temperature' },
  }));

  await i18n.select('en');
  const translations = i18n.adapterTranslations(dir);
  assert.equal(translations.Temperatur, 'Temperature');
  assert.equal(translations['@temperature'], 'Temperature');
  await i18n.select('de');
});

test('JSON-Ausgaben lokalisieren nur Anzeigefelder und lassen Nutzdaten stabil', async () => {
  await i18n.select('en');
  const result = i18n.localizePayload({ error: 'Gerät nicht gefunden.', value: 'Gerät nicht gefunden.' });
  assert.equal(result.error, 'Device not found.');
  assert.equal(result.value, 'Gerät nicht gefunden.');
  await i18n.select('de');
});
