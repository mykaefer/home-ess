# ADAPTER.md — Regelwerk für homeESS-Adapter

> Adapter verbinden homeESS mit Geräten und Diensten (z. B. Modbus, REST, eine
> serielle Schnittstelle). Sie sind **portabel** und **codebasis-fremd**: ein
> Adapter ist ein eigenständiges Verzeichnis unter `/adapter/` und kommt ohne
> jede Änderung am homeESS-Quellcode aus. Dieselben Adapterdateien funktionieren
> in jeder homeESS-Installation.

Inhalt: [Überblick](#überblick) · [Verzeichnislayout](#verzeichnislayout) ·
[Manifest](#das-manifest-adapterjson) · [Einstiegsdatei](#die-einstiegsdatei-indexjs) ·
[Host-API](#die-host-api) · [States & Adressen](#states--adressen) ·
[Topics & Routing](#topics--routing) · [Instanzen & Einstellungen](#instanzen--einstellungen) ·
[Lebenszyklus & Isolation](#lebenszyklus--isolation) · [Checkliste](#checkliste-für-einen-neuen-adapter)

## Überblick

- Jeder Adapter ist **ein Unterverzeichnis** von `/adapter/` mit einer
  **`adapter.json`** (Manifest) und einer **Einstiegsdatei** (Standard `index.js`).
- homeESS scannt `/adapter/` beim Start, zeigt gefundene Adapter auf der
  **Adapter-Seite** und lässt dort **mehrere benannte Instanzen** je Adapter
  anlegen, einzeln aktivieren/deaktivieren und konfigurieren.
- Jede **aktive Instanz läuft als eigener Kindprozess** (Isolation, Auto-Restart).
- Ein Adapter meldet seine **States** (Geräte-Werte). Diese erscheinen auf der
  **States-Seite** (im Menü als Unterpunkt von **Adapter**) als Baum und lassen
  sich hinter jedem Topic-Feld per **State-Picker** auswählen; zusätzlich sind sie
  automatisch im **Wertekatalog** als Quelle für Outputs und Dashboard-Kacheln
  verfügbar.
- States werden über das Schema **`prefix://instanz/adresse`** angesprochen.
  Topics **ohne** Schema laufen weiter über den zentralen MQTT-Broker — das
  bestehende Verhalten bleibt unverändert.

## Verzeichnislayout

```
/adapter/
  modbus/                 ← ein Adapter
    adapter.json          ← Manifest (Pflicht)
    index.js              ← Einstiegsdatei (Pflicht, Name via manifest.main)
    ...                   ← weitere Dateien / node_modules nach Bedarf
  demo/                   ← Referenz-Adapter (siehe /adapter/demo)
    adapter.json
    index.js
```

Das Verzeichnis ist standardmäßig `/<repo>/adapter`. Es lässt sich per Umgebungs­
variable `HOME_ESS_ADAPTER_DIR` umlenken.

## Das Manifest (`adapter.json`)

Pflicht je Adapter. Bestimmt Anzeigename, Prefix und Einstellungs-Schema.

```json
{
  "id": "modbus",
  "name": "Modbus",
  "prefix": "modbus",
  "version": "1.0.0",
  "description": "Verbindet homeESS mit Modbus-TCP-Geräten.",
  "copyright": "Copyright (C) 2026 <Autor>",
  "multiInstance": true,
  "main": "index.js",
  "settings": [
    { "key": "host",     "label": "Geräte-IP",        "type": "text",   "default": "" },
    { "key": "port",     "label": "Port",             "type": "number", "default": 502 },
    { "key": "unitId",   "label": "Unit-ID",          "type": "number", "default": 1 }
  ]
}
```

| Feld            | Pflicht | Bedeutung |
|-----------------|:------:|-----------|
| `id`            | ja*    | Eindeutige Kennung. `^[a-z][a-z0-9_-]*$`. Default = Ordnername. |
| `prefix`        | ja*    | Schema für Topics (`prefix://…`). Gleiche Form wie `id`. Default = `id`. Muss systemweit eindeutig sein. |
| `name`          | nein   | Anzeigename auf der Adapter-Seite. |
| `version`       | nein   | Anzeige/Doku. |
| `description`   | nein   | Kurzbeschreibung. |
| `copyright`     | nein   | Copyrightvermerk des jeweiligen Adapter-Autors. Wird auf der Adapter-Seite angezeigt. |
| `multiInstance` | nein   | `false` = nur eine Instanz sinnvoll (rein informativ). Default `true`. |
| `main`          | nein   | Einstiegsdatei. Default `index.js`. |
| `settings`      | nein   | Schema der Instanz-Einstellungen (siehe unten). Leer = leere Einstellungsseite. |

\* technisch optional (Default = Ordnername), aber ungültige Werte führen dazu,
dass der Adapter verworfen wird.

**Settings-Feldtypen:** `text`, `number`, `checkbox`, `select`, `password`.
Bei `select` zusätzlich `options: ["a", "b"]` oder
`options: [{ "value": "a", "label": "A" }]`. Optionales `hint` als Hilfetext.

### Optional: `stateEditor` (States/Register-Verwaltung mit Presets)

Manche Adapter haben **viele, vom Nutzer zu pflegende** States (z. B. Modbus-
Register). Statt eine eigene UI zu bauen, deklariert der Adapter im Manifest einen
`stateEditor`; homeESS rendert daraus automatisch eine **Verwaltungs-Unterseite**:
Die angelegten States erscheinen – falls `categoryField` gesetzt – nach Kategorie
gruppiert und **einklappbar**; Anlegen/Bearbeiten läuft über einen **Dialog**. Mit
`presets: true` gibt es zusätzlich eine **eigene Preset-Seite** (Laden mit Auswahl,
„als Preset speichern", Upload vom PC), erreichbar über den Button „Presets".

```json
"stateEditor": {
  "storageKey": "registers",   // instance.settings[storageKey] = Array der Zeilen
  "keyField": "address",        // eindeutiger Schlüssel + State-Adresse
  "keyFields": ["unitId", "address"], // optional: zusammengesetzter Schlüssel (mit '/' verbunden)
  "nameField": "name",
  "categoryField": "category",  // optional: Spalte, nach der die States gruppiert werden
  "label": "Register",
  "presets": true,              // Preset-Verzeichnis presets/ aktivieren
  "columns": [
    { "key": "address",  "label": "State-Adresse", "type": "text",   "required": true },
    { "key": "name",     "label": "Name",          "type": "text",   "required": true },
    { "key": "category", "label": "Kategorie",     "type": "text" },
    { "key": "register", "label": "Register",      "type": "number" }
    /* … weitere Spalten (text/number/checkbox/select) … */
  ]
}
```

Die gepflegten Zeilen landen in `instance.settings[storageKey]` und sind die
**Live-States**, mit denen der Adapter arbeitet: In `start(config)` liest er
`config[storageKey]`, deklariert daraus per `host.setStates(...)` die States und
bedient sie. **Presets sind davon getrennt** — reine Vorlagen in `presets/`, aus
denen ausgewählte Zeilen in die Instanz übernommen werden, ohne Adressen
abzutippen. Das Preset-Dateiformat beschreibt der Adapter selbst in einer
`PRESET.md` in seinem Verzeichnis (siehe Modbus-Adapter: `adapter/modbus/PRESET.md`).

Nach jeder Änderung (Zeile gespeichert/gelöscht, Preset geladen) startet homeESS die
Instanz neu, damit der Adapter die geänderte State-Liste übernimmt.

## Die Einstiegsdatei (`index.js`)

Exportiert eine **Factory** `createAdapter(host)`, die ein Adapter-Objekt mit
Lebenszyklus-Methoden zurückgibt. **Kein IPC, keine homeESS-Imports** — die
`host`-API ist die einzige Schnittstelle.

```js
'use strict';

module.exports = function createAdapter(host) {
  let timer = null;

  return {
    // Pflicht: wird beim Start mit den Instanz-Einstellungen aufgerufen.
    async start(config) {
      host.setStates([
        { address: 'messwerte/temperatur', name: 'Temperatur', category: 'Messwerte', unit: '°C' },
        { address: 'steuerung/schalter',   name: 'Schalter',   category: 'Steuerung', writable: true },
      ]);
      // ... Verbindung zum Gerät aufbauen ...
      timer = setInterval(() => {
        host.publishState('messwerte/temperatur', readTemperature());
      }, (Number(config.interval) || 5) * 1000);
    },

    // Optional: sauberes Herunterfahren (Timer/Verbindungen schließen).
    async stop() {
      if (timer) clearInterval(timer);
    },

    // Optional: Schreibwunsch aus homeESS auf eine schreibbare Adresse.
    write(address, value) {
      if (address === 'steuerung/schalter') setRelay(value === true || value === 'true');
    },

    // Optional: aktiver Lesewunsch (Refresh einer Adresse).
    read(address) { /* aktuellen Wert via host.publishState(address, …) melden */ },
  };
};
```

Alternativ ist auch `module.exports = { createAdapter }` zulässig.

## Die Host-API

Das an die Factory übergebene `host`-Objekt:

| Methode | Zweck |
|---------|-------|
| `host.setStates(list)` | Deklariert/aktualisiert den **State-Katalog** der Instanz. `list` siehe unten. Mehrfach aufrufbar (ersetzt den Katalog). |
| `host.publishState(address, value)` | Meldet den **aktuellen Wert** einer Adresse. Erscheint im Bus unter `prefix://instanz/adresse`. |
| `host.publishStates(values)` | Meldet mehrere Werte gemeinsam als `[{ address, value }]`. Frische und Werte werden je State aktualisiert, abhängige Regeln erhalten aber nur ein gemeinsames Änderungsereignis. |
| `host.setConnected(bool, detail?)` | Meldet den **Verbindungszustand** zum Gerät/Dienst (Anzeige auf der Adapter-Seite). `detail` ist ein optionaler Tooltip-Text. |
| `host.getConfig()` | Liefert die aktuellen **Instanz-Einstellungen** (Objekt). |
| `host.log(...args)` | Info-Log in die homeESS-Konsole (mit Adapter-/Instanz-Präfix). |
| `host.error(...args)` | Fehler-Log. |
| `host.name` | Name der Instanz (Read-only). |

`host.setStates`-Eintrag:

```js
{
  address: 'messwerte/temperatur', // Pflicht – eindeutig je Instanz
  name:    'Temperatur',           // Anzeigename (Default = address)
  category:'Gerät / Messwerte',    // Pfad im States-Baum (Default 'Allgemein')
  unit:    '°C',                   // optional, für die Anzeige
  writable: false                  // optional, true = beschreibbar (write())
}
```

`category` darf mehrere, mit `/` getrennte Ebenen enthalten. homeESS stellt sie
auf der States-Seite und im Topic-Picker als einzeln ausklappbaren Verzeichnisbaum
dar (z. B. `Wohnzimmer / Thermostat / Messwerte`). Einfache Kategorien ohne `/`
bleiben vollständig abwärtskompatibel.

## States & Adressen

- Eine **Adresse** ist der gerätespezifische Pfad innerhalb der Instanz, z. B.
  `register/40001` oder `messwerte/temperatur`. Schrägstriche zur Gruppierung
  sind erlaubt.
- Der vollständige, in homeESS sichtbare Bezeichner ist
  **`prefix://instanz/adresse`** (Beispiel: `modbus://victron/register/40001`).
- States müssen über `host.setStates(...)` bekanntgegeben werden, damit sie auf
  der States-Seite und im State-Picker erscheinen. Werte ohne deklarierten State
  landen zwar im Bus, sind aber nicht auffindbar.
- Werte dürfen Zahl, Boolean oder String sein.
- Werte aus demselben Geräte-Read möglichst gemeinsam mit `host.publishStates()`
  melden. Das ändert weder Topics noch Einzelwerte, vermeidet aber unnötigen
  Regelungs-Fan-out. `publishState()` bleibt für Einzelwerte vollständig gültig.

## Topics & Routing

homeESS hat einen zentralen Werte-Bus. Der MQTT-Handler wirkt als **Router**:

- Topic **mit** Schema `prefix://…` → an die registrierte Adapter-Instanz.
- Topic **ohne** Schema → unverändert über den konfigurierten MQTT-Broker
  (volle Abwärtskompatibilität).

Überall, wo in homeESS ein Topic eingetragen wird (z. B. „Batterie-SoC"), kann
also ein Adapter-State stehen. Beispiel: trägt man `modbus://victron/soc` als
SoC-Topic ein, bezieht homeESS den Wert vom Modbus-Adapter statt vom Broker.
Schreib-Ziele (Output-Engine, Kommando-Topics) auf einer **schreibbaren** Adresse
rufen die `write(address, value)`-Methode des Adapters auf.

Der Router arbeitet dabei wie ein **kleiner interner Broker**: Sobald ein Topic
irgendwo ausgewählt wird, bekommt dieser Bezug **sofort** den zuletzt gemeldeten
Wert (auch ohne `read()`-Implementierung), und **jede** folgende Wertänderung des
Adapters wird automatisch und fortlaufend an alle Bezüge dieses Topics verteilt.

## Instanzen & Einstellungen

- Auf der **Adapter-Seite** (Hauptnavigation; „States" klappt als Unterpunkt
  darunter auf) lassen sich pro
  Adapter beliebig viele Instanzen anlegen und **einzeln benennen**. Der Name ist
  die Autorität im Topic: `prefix://<name>/…`.
- Jede Instanz hat **eigene Einstellungen** (gespeichert je Instanz), greift aber
  auf **dieselben Adapterdateien** zu.
- Die Einstellungsseite einer Instanz wird **generisch aus dem `settings`-Schema**
  des Manifests gerendert. Ohne Schema bleibt sie leer.
- Aktivieren startet die Instanz (Kindprozess), Deaktivieren stoppt sie. Das
  Speichern von Einstellungen oder Umbenennen startet die Instanz neu.

## Lebenszyklus & Isolation

- Jede **aktive Instanz läuft in einem eigenen Kindprozess**. Ein Absturz oder
  eine nicht behandelte Exception beendet **nur diesen Prozess** — homeESS selbst
  bleibt unberührt. Der Supervisor startet die Instanz mit Backoff (1 s → max
  30 s) automatisch neu.
- Reihenfolge: `start(config)` beim Aktivieren/Reload → Betrieb (`publishState`,
  `write`, `read`) → `stop()` beim Deaktivieren/Neustart. Nach `stop()` wird der
  Prozess beendet; nach einem Timeout hart gekillt.
- IPC ist ein **Implementierungsdetail** des Hosts. Adapter-Autoren sehen davon
  nichts — sie nutzen ausschließlich die `host`-API.
- **Blockiere den Event-Loop nicht** dauerhaft; nutze Timer/async für Polling.
  Räume in `stop()` Timer und Verbindungen auf.

## Checkliste für einen neuen Adapter

1. Verzeichnis `/adapter/<id>/` anlegen.
2. `adapter.json` mit eindeutigem `id`/`prefix` und ggf. `settings` schreiben.
3. `index.js` mit `createAdapter(host)` + `start`/`stop` (und bei Bedarf
   `write`/`read`) implementieren.
4. In `start` per `host.setStates(...)` den State-Katalog deklarieren und per
   `host.publishState(...)` Werte melden.
5. homeESS starten, auf der **Adapter-Seite** eine Instanz anlegen, konfigurieren,
   aktivieren.
6. Auf der **States-Seite** prüfen, dass die States mit Live-Werten erscheinen,
   und sie hinter Topic-Feldern per State-Picker auswählen.

Als vollständiges, lauffähiges Beispiel dient der mitgelieferte
**Demo-Adapter** unter [`/adapter/demo/`](adapter/demo/).
