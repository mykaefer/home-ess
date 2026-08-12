# ADAPTER.md — Regelwerk für homeESS-Adapter

> Adapter verbinden homeESS mit Geräten und Diensten (z. B. Modbus, REST, eine
> serielle Schnittstelle). Sie sind **portabel** und **codebasis-fremd**: ein
> Adapter ist ein eigenständiges Verzeichnis unter `/adapter/` und kommt ohne
> jede Änderung am homeESS-Quellcode aus. Dieselben Adapterdateien funktionieren
> in jeder homeESS-Installation.

Inhalt: [Überblick](#überblick) · [Verzeichnislayout](#verzeichnislayout) ·
[Manifest](#das-manifest-adapterjson) · [Einstiegsdatei](#die-einstiegsdatei-indexjs) ·
[Host-API](#die-host-api) · [State-Tabs](#optional-eigener-tab-im-eigenschaften-dialog-eines-states) ·
[Hardwaredialoge](#capability-gesteuerte-hardwaredialoge) ·
[States & Adressen](#states--adressen) ·
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
  eigenständigen **States-Hauptseite** neben der Gruppe **System** als Baum und
  lassen sich hinter jedem Topic-Feld per **State-Picker** auswählen. Dashboard
  und Output greifen auf denselben zentralen States-Bestand zu.
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
    languages/             ← optional: adaptereigene Übersetzungen
      de.json
      en.json
```

Das Verzeichnis ist standardmäßig `/<repo>/adapter`. Es lässt sich per Umgebungs­
variable `HOME_ESS_ADAPTER_DIR` umlenken.

### Installation als ZIP-Paket

Administratoren können portable Adapter auf der Adapterseite als ZIP-Datei
hochladen. Das Archiv enthält entweder die Adapterdateien direkt oder genau
einen umschließenden Ordner:

```text
mein-adapter.zip
└── mein-adapter/
    ├── adapter.json
    ├── index.js
    └── ...
```

Für Uploadpakete müssen `id`, `name`, `prefix`, `version` und `main` im Manifest
explizit gesetzt sein. `adapter.json` und die mit `main` bezeichnete reguläre
JavaScript-Datei sind Pflicht. Benötigte JavaScript-Abhängigkeiten müssen im
Paket enthalten sein; homeESS führt beim Upload weder `npm install` noch
Adaptercode aus.

Vor der Installation prüft homeESS das gesamte Archiv in einem temporären,
isolierten Verzeichnis: ZIP-Struktur und Prüfsummen, Größenlimits, sichere
relative Pfade, reguläre Dateien ohne Symlinks, Manifeststruktur, eindeutige ID
und eindeutigen Prefix sowie die JavaScript-Syntax der Einstiegdatei. Erst nach
vollständigem Erfolg wird der geprüfte Ordner nach `/adapter/<id>/` übernommen
und die Registry neu geladen. Vorhandene Adapter werden nicht überschrieben.
Fehlerhafte Pakete hinterlassen keinen Ordner im Adapterverzeichnis. Hochgeladene
Adapter bleiben bei einem homeESS-Update erhalten, solange ein späteres Release
nicht selbst einen Adapter mit derselben ID mitliefert.

Administratoren können einen Adapter auf derselben Seite wieder löschen. Aus
Sicherheitsgründen müssen zuvor alle zugehörigen Instanzen einzeln entfernt und
im Löschdialog die exakte Adapter-ID eingegeben werden. Erst danach entfernt
homeESS das komplette Adapterverzeichnis dauerhaft. Diese Aktion kann nicht
rückgängig gemacht werden; persistente Instanzdaten werden nicht automatisch als
Teil einer Adapterlöschung ausgewählt oder mitgelöscht.

Die entfernte Adapter-ID wird außerhalb des Programmverzeichnisses dauerhaft
gespeichert. Sowohl der Curl-Installer als auch die interne Updatefunktion
aktualisieren weiterhin installierte offizielle Adapter, übernehmen eigene
Adapter und lassen bewusst entfernte IDs aus. Neue offizielle Adapter werden
normal hinzugefügt. Nur der ausdrücklich mit `--all` gestartete Curl-Installer
hebt diese Entfernungsauswahl auf und stellt alle offiziellen Adapter wieder
her:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash -s -- --all
```

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

Ein **Feldschlüssel** (`key`) wird zum HTML-Attribut und zum Datenbankschlüssel
und muss deshalb der Form `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` genügen. Felder
mit abweichendem Schlüssel verwirft homeESS beim Laden des Manifests und
protokolliert das. Das gilt für `settings`, `stateEditor.columns` und
`stateOptions.fields` gleichermaßen.

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

### Optional: Eigener Tab im Eigenschaften-Dialog eines States

Auf der States-Seite öffnet die Stiftschaltfläche neben jedem Wert einen Dialog
mit Tableiste. Der erste Tab **Allgemein** gehört homeESS (Nachkommastellen,
Rundung, Einheit). **Jede aktive Adapterinstanz kann einen weiteren Tab
anhängen** — hängt kein Adapter etwas an, bleibt es allein bei „Allgemein".

Der Adapter liefert dafür ausschließlich ein **Formularschema**. Das Rendern,
Prüfen und Speichern übernimmt homeESS; der Adapterprozess wird beim Öffnen des
Dialogs nicht befragt und liefert kein Markup.

#### Das Schema

```js
{
  label: 'InfluxDB · homeess',   // optional, Überschrift im Tab. Default 'Adapter'
  hint: 'Historie dieses States.', // optional, Erklärtext unter der Überschrift
  enabledField: 'enabled',       // optional, Feld, das den Tab als belegt markiert
  fields: [                      // Pflicht, mindestens ein gültiges Feld
    { key: 'enabled', label: 'Aufzeichnen', type: 'checkbox', default: false },
    { key: 'alias',   label: 'Messreihe',   type: 'text',     default: '', hint: '…' },
    { key: 'mode',    label: 'Speichern',   type: 'select',   default: 'change',
      options: [{ value: 'change', label: 'Bei Änderung' }, { value: 'interval', label: 'Intervall' }] },
    { key: 'intervalSeconds', label: 'Abstand (s)', type: 'number', default: 60 },
  ],
}
```

| Feld | Pflicht | Bedeutung |
|------|:------:|-----------|
| `fields` | ja | Liste der Formularfelder. Ein Schema ohne gültiges Feld wird verworfen — der Tab erscheint dann nicht. |
| `label` | nein | Überschrift im Tab-Inhalt. Die **Tab-Beschriftung selbst ist immer der Instanzname**, damit mehrere Instanzen unterscheidbar bleiben. |
| `hint` | nein | Erklärtext unter der Überschrift. |
| `enabledField` | nein | Schlüssel eines `checkbox`-Feldes. Ist es `true`, markiert homeESS den Tab als belegt (farbiger Punkt). Ohne Angabe gilt der Tab als belegt, sobald irgendein Wert gespeichert ist. |

**Feldobjekt:** `key` (Pflicht), `label`, `type`, `default`, `hint`, bei
`select` zusätzlich `options`. Typen und Schreibweise sind identisch zu den
Instanz-Einstellungen: `text`, `number`, `checkbox`, `select`, `password`.
Für `key` gilt dieselbe Form wie überall im Manifest
(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`); Felder mit abweichendem Schlüssel
verwirft homeESS.

#### Zwei Wege, ein Schema

**Statisch im Manifest** — der Tab existiert, sobald die Instanz aktiviert ist,
auch vor ihrem ersten Start:

```json
"stateOptions": {
  "label": "InfluxDB",
  "enabledField": "enabled",
  "fields": [ { "key": "enabled", "label": "Aufzeichnen", "type": "checkbox", "default": false } ]
}
```

**Zur Laufzeit über die Host-API** — für Felder, die erst im Betrieb feststehen
(vorhandene Datenbanken, erkannte Kanäle, Auswahllisten aus dem Gerät):

```js
host.setStateOptionsSchema(schema);   // anmelden oder ersetzen
host.setStateOptionsSchema(null);     // Tab wieder entfernen
```

Der Aufruf ersetzt das Schema vollständig (wie `setStates`) und darf beliebig
oft erfolgen. homeESS **merkt sich das zuletzt gemeldete Schema**, sodass der
Tab auch bei gestoppter Instanz erscheint. Ein gemeldetes Schema hat Vorrang vor
dem Manifest; beides zusammen ist die empfohlene Kombination: das Manifest als
Startfassung, die API für die verfeinerte Fassung.

#### Die gepflegten Werte lesen

```js
const list = await host.listStateOptions();
// [ { topic: 'hdp://wz/temperatur', options: { enabled: true, alias: 'temp', … } }, … ]
```

Geliefert werden ausschließlich die Werte **der eigenen Instanz**, und nur für
States, zu denen etwas gespeichert wurde. Die Werte sind bereits typisiert:
`checkbox` → Boolean, `number` → Zahl, `select` → einer der deklarierten Werte,
sonst Text. Unbekannte Felder verwirft homeESS beim Speichern.

Nach jeder Änderung im Dialog ruft homeESS die **optionale** Adaptermethode
`stateOptionsChanged()` auf — ohne Neustart der Instanz:

```js
module.exports = function createAdapter(host) {
  return {
    async start() {
      host.setStateOptionsSchema({ enabledField: 'enabled', fields: [
        { key: 'enabled', label: 'Aufzeichnen', type: 'checkbox', default: false },
      ] });
      await this.stateOptionsChanged();
    },
    async stateOptionsChanged() {
      for (const { topic, options } of await host.listStateOptions()) {
        if (options.enabled) host.subscribeState(topic, (value) => { /* … */ });
      }
    },
  };
};
```

#### Regeln

- Eine Instanz erhält **keinen Tab für ihre eigenen States** (`prefix://instanz/…`);
  ein Adapter kann sich also nicht selbst als Quelle eintragen.
- Nur **aktivierte** Instanzen erscheinen. Läuft die Instanz gerade nicht, ist
  der Tab bedienbar und der Dialog weist darauf hin, dass die Änderung beim
  nächsten Start übernommen wird.
- Gespeichert wird je **(Instanz, Topic)**. Wird die Instanz gelöscht,
  verschwinden ihre Zuordnungen mit.
- Der Dialog ist für Benutzer ohne Schreibrecht lesbar, aber nicht speicherbar.

### Optional: `devicePage` (erkannte Geräte)### Optional: `devicePage` (erkannte Geräte)

Mit `"devicePage": { "storageKey": "devices", "label": "Geräte" }` aktiviert
ein Adapter eine generische Geräteseite. Er persistiert dort anzuzeigende Geräte
per `host.setStorage(storageKey, devices)`. Jeder Eintrag besitzt `address`, `name`,
`customName`, optional `type`, `generation`, `online` und `channels`; ein Kanal hat
`address`, `name` und `states` (State-Metadaten mit mindestens `address`). homeESS
stellt Live-Werte dar und speichert frei vergebene Gerätenamen in `customName`.

### Optional: `managementPage` (vollständige Adapterverwaltung)

Adapter mit Pairing-, Geräte-, Konfigurations- oder Firmwareworkflows können eine
eigene, weiterhin vom Host geschützte Verwaltungsseite deklarieren:

```json
"managementPage": {
  "label": "hDP Geräte",
  "maxUploadBytes": 8388608,
  "stylesheet": "management.css"
}
```

Der Host zeigt den Link an und leitet Requests unter
`/adapter/instance/<id>/manage/...` an die optionale Adaptermethode
`handleManagementRequest(request)` weiter. Der Adapterprozess liefert entweder
`{status,json}`, `{status,redirect}` oder `{status,view:{title,body,script}}`.
Login, Rollenprüfung, Seitenlayout und Uploadlimits bleiben Aufgabe von homeESS.
Mit dem optionalen Feld `stylesheet` bindet homeESS eine CSS-Datei aus dem
Wurzelverzeichnis des Adapters nach dem gemeinsamen Basis-Stylesheet ein. Der
Dateiname muss auf `.css` enden und darf keine Verzeichniskomponenten enthalten.
Das Stylesheet gilt damit nur für die vom Adapter gerenderte Verwaltungsseite
und reist zusammen mit dem portablen Adapter. Es sollte alle Selektoren unter
einer adapterspezifischen Wurzelklasse kapseln, beispielsweise `.mein-adapter`.
`application/octet-stream` wird nicht im RAM gepuffert, sondern in eine
restriktive temporäre Datei gestreamt; der Adapter erhält
`request.upload={path,size,filename}`. Der Host löscht die Datei nach Abschluss.
Andere Adapterdateien oder freie Serverpfade werden dadurch nicht veröffentlicht.

## Capability-gesteuerte Hardwaredialoge

Adapter mit eigener `managementPage` dürfen Geräte unterstützen, deren
Hardwarefunktion erst zur Laufzeit gewählt oder vom Gerät gemeldet wird. Solche
Adapter leiten den Dialog aus den tatsächlich ausgehandelten Fähigkeiten ab,
nicht aus einer fest verdrahteten Gesamtmenge aller theoretisch unterstützten
Optionen. Ein Protokollmanifest des Geräts kann dafür beispielsweise
Gerätetypen, Sensortypen, zulässige Pins, Busse, Adressen und Mengenlimits
ausweisen. Dieses Gerätemanifest ist vom homeESS-Manifest `adapter.json` getrennt
und bleibt Bestandteil des jeweiligen Geräteprotokolls.

Für capability-gesteuerte Formulare gelten folgende Regeln:

- Ein Gerät hat zu einem Zeitpunkt genau eine aktive Hardwarefunktion, sofern
  das Geräteprotokoll nicht ausdrücklich mehrere gleichzeitig erlaubt.
- Nach Wahl eines Geräte- oder Sensortyps zeigt der Dialog ausschließlich
  gemeinsame Felder und die für diesen Typ erforderlichen Felder. Unbelegte
  Plätze zeigen nur die Auswahl, mit der sie aktiviert werden.
- Nicht zutreffende Felder werden nicht nur verborgen, sondern im Formular
  deaktiviert und nicht übertragen. Werte eines zuvor gewählten Typs dürfen
  dadurch nicht unbemerkt in die neue Konfiguration gelangen.
- Der Adapter validiert die resultierende Konfiguration serverseitig erneut.
  Dazu gehören Typen und Wertebereiche ebenso wie eindeutige IDs, gemeinsame
  Busparameter, zulässige Adressen, Pinüberschneidungen und die vom Gerät
  gemeldeten Limits. Sichtbarkeit im Browser ist keine Sicherheits- oder
  Gültigkeitsprüfung.
- Belegt ein Gerätetyp GPIOs für feste Rollen wie Datenleitung, UART oder
  Wakeup, darf die Oberfläche diese GPIOs nicht zugleich als freie Binary-I/O
  anbieten. Rollen-Auswahlen und freie Pinliste werden bei jeder Änderung
  gegenseitig abgeglichen; die serverseitige Kollisionsprüfung bleibt dennoch
  zwingend.
- Der Adapter sendet nur den aktiven, kanonischen Konfigurationszweig an das
  Gerät. Adapterseitige Zuordnungen, Kalibrierfaktoren oder fachliche
  Umrechnungen werden getrennt persistiert, wenn sie nicht zur elektrischen
  Hardwarekonfiguration gehören.
- Ändert sich die aktive Hardwarekonfiguration, aktualisiert der Adapter seinen
  State-Katalog mit `host.setStates(...)`. Entfernte Kanäle dürfen nicht als
  scheinbar weiterhin verfügbare States stehen bleiben.

Zeitkritische elektrische Protokolle werden grundsätzlich dort ausgewertet, wo
das verlässliche Timing verfügbar ist. Bei Mikrocontrollern bedeutet das in der
Regel: Initialisierung, Buszugriff, CRC und Datenblattumrechnung laufen auf dem
Gerät; der Adapter erhält versionierte Pakete mit Status und normierten oder
ausdrücklich als roh gekennzeichneten Messwerten. Eine Übertragung einzelner
Pegelwechsel zur nachträglichen Auswertung im JavaScript-Adapter ist nur dann
zulässig, wenn das Gerät die Flanken hardwaregestützt erfasst, mit Zeitstempeln
versieht und als begrenztes, vollständig definiertes Paket überträgt. Netzwerk-
und JavaScript-Timing selbst sind keine belastbare Zeitbasis für Sensorbusse.

Der hDP-Adapter ist die Referenz für dieses Muster: Seine Universal-Firmware
meldet Fähigkeiten und wertet Sensorbusse lokal aus, während homeESS
Geräteauswahl, freie Binary-I/O-Pins, State-Veröffentlichung und fachliche
Rohwertkalibrierung übernimmt. Die konkreten hDP-Paket- und Sensortypen bleiben
im hDP-Protokolldokument beschrieben und werden nicht Teil dieser allgemeinen
Adapter-API.

Dasselbe Zuständigkeitsmodell gilt für lokale Identifikationsmodule: Zeitkritische
Erfassung, Merkmalsextraktion, Vergleich und Vorlagenspeicherung laufen im Modul
beziehungsweise in der Gerätefirmware. Der Adapter darf einen ausdrücklichen
Lern- und Löschworkflow anbieten und erhält danach nur eine Vorlagen-ID samt
Qualitätswert. Namen, State-Zuordnungen und Aktionen wie Setzen, Umschalten oder
Zählen bleiben adapterseitig. Biometrische Rohbilder oder Merkmalsdaten dürfen
nicht als normale Adaptereinstellungen persistiert oder über den State-Katalog
veröffentlicht werden.
Lern-, Lösch- und Erkennungsaktionen dürfen in der Verwaltung erst angeboten
werden, wenn das Identifikationsmodul selbst betriebsbereit gemeldet ist. Ein
verbundener Mikrocontroller allein genügt nicht. Modulfehler werden mit ihrer
konkreten Ursache und der aktuell erwarteten Schnittstellenbelegung angezeigt;
die serverseitige Aktionsprüfung bleibt auch bei deaktivierter Schaltfläche
verpflichtend.

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
| `host.setStorage(key, value)` | Persistiert dynamische Instanzmetadaten unter `settings[key]` (z. B. erkannte Geräte). Der Schlüssel wird atomar in die vorhandenen Einstellungen gemergt und bleibt beim Speichern anderer Formularfelder erhalten. |
| `await host.persistStorage(key, value)` | Wie `setStorage`, bestätigt aber erst nach erfolgreichem SQLite-Commit. Für Protokollschritte, die nachweislich erst nach dauerhafter lokaler Speicherung beginnen dürfen. Bestehende Adapter verwenden unverändert `setStorage`. |
| `host.subscribeState(topic, listener)` | Abonniert ereignisgesteuert eine MQTT- oder `prefix://`-Datenquelle und liefert eine idempotente Abmeldefunktion. Ein vorhandener Retained-Wert wird sofort zugestellt. |
| `await host.writeState(topic, value)` | Schreibt einen Wert in eine beliebige homeESS-Datenquelle (MQTT-Topic oder `prefix://`-State). MQTT-, Adapter- und Schreibschutzregeln setzt der Host zentral durch; nicht beschreibbare Ziele werden abgewiesen. |
| `host.setStateOptionsSchema(schema)` | Hängt einen **Tab an den Eigenschaften-Dialog** eines States an oder ersetzt ihn; `null` entfernt ihn. Schema und Regeln siehe [Eigener Tab im Eigenschaften-Dialog](#optional-eigener-tab-im-eigenschaften-dialog-eines-states). Das zuletzt gemeldete Schema bleibt gespeichert. |
| `await host.listStateOptions()` | Liefert die vom Benutzer je State hinterlegten **Adapteroptionen dieser Instanz** als `[{ topic, options }]`. Das Formularschema stammt aus `stateOptions` im Manifest (siehe unten). Nach einer Änderung ruft homeESS zusätzlich `stateOptionsChanged()` am Adapter auf. |
| `await host.listStates(limit?)` | Liefert den **quellenübergreifenden State-Katalog** als flache Liste `{ topic, name, category, unit, value, writable, sourceType }` — Systemwerte, Custom States und alle Adapter-Instanzen mit ihrem kanonischen Topic. Für Adapter, die States weiterreichen oder spiegeln. Werte selbst kommen weiterhin über `subscribeState`. |
| `await host.getDataDirectory()` | Instanzeigenes Datenverzeichnis (0700) für Nutzdaten, die zu groß für die Instanz-Einstellungen sind. |
| `host.getInstanceIdentity()` | Liefert die dauerhafte öffentliche homeESS-Instanz-ID und deren Fingerprint, niemals den privaten Schlüssel. |
| `host.getSecret(key)` | Liest ein Secret aus dem restriktiven, instanzgebundenen Secret-Store. |
| `host.setSecret(key, value)` | Schreibt ein Secret mit 0600/0700-Rechten außerhalb der normalen Adaptereinstellungen. |
| `host.deleteSecret(key)` | Entfernt ein Secret der eigenen Instanz. |
| `host.getConfig()` | Liefert die aktuellen **Instanz-Einstellungen** (Objekt). |
| `host.language` | Aktiver systemweiter Sprachcode als String (Read-only). |
| `host.getLanguage()` | Liefert `{code, name, locale, direction, fallback}` der systemweiten Sprachwahl. |
| `host.t(key, defaultText)` | Übersetzt einen adaptereigenen Schlüssel; `defaultText` bleibt bei einsprachigen/noch unvollständigen Adaptern erhalten. |
| `host.log(...args)` | Info-Log in die homeESS-Konsole (mit Adapter-/Instanz-Präfix). |
| `host.error(...args)` | Fehler-Log. |
| `host.debug(...args)` / `host.warn(...args)` | Debug- beziehungsweise Warn-Log; Debugausgabe wird nur bei aktivierter Adapterdiagnose geschrieben. |
| `host.name` | Name der Instanz (Read-only). |

### Optional: Mehrsprachige Adapter

Adapter können Sprachdateien unter `languages/<code>.json` mitliefern. Das
Format entspricht den homeESS-Sprachdateien:

```json
{
  "code": "en",
  "name": "English",
  "locale": "en-GB",
  "direction": "ltr",
  "messages": {
    "temperature": "Temperature",
    "measurements": "Measurements"
  }
}
```

`de.json` dient bei den mitgelieferten Adaptern zugleich als Ausgangskatalog.
Manifesttexte, generische Settings, State-Namen/-Kategorien und die optionale
Management-View werden dadurch gemeinsam mit dem System lokalisiert. Eigener
Code kann `host.t('temperature', 'Temperatur')` und
`host.getLanguage().locale` für Texte beziehungsweise Formatierung verwenden.
`handleManagementRequest(request)` erhält die Sprachinformation außerdem als
`request.language`; ein Browser-Frontend findet sie unter `GET /me/access`.
Nach einer Sprachänderung startet homeESS aktive Adapter kontrolliert neu.

Sprachdateien sind optional: Ein einsprachiger Adapter ohne `languages/` bleibt
vollständig gültig. Wer mehrere Sprachen anbietet, sollte mindestens Deutsch und
Englisch vollständig und UTF-8-kodiert mit echten Umlauten/Sonderzeichen
liefern. Fehlende Schlüssel folgen dem systemweiten Standort-Fallback.

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

### Adapter, die den States-Baum weiterreichen

Manche Adapter stellen homeESS-States nach außen bereit (z. B. der
MQTT-Broker-Adapter unter `states/`). Dafür gilt:

- Der Katalog kommt aus `host.listStates()`, die Werte aus `host.subscribeState()`
  und Schreibvorgänge ausschließlich aus `host.writeState()`.
- **Der eigene Prefix wird ausgelassen.** Sonst spiegelt der Adapter seine
  eigenen Werte zurück in sich selbst — eine Endlosschleife.
- **Die Schreibrechte der States gelten unverändert.** Nur States mit
  `writable: true` dürfen geschrieben werden; alles andere wird verworfen und
  protokolliert.
- **Im gespiegelten Baum entstehen keine neuen States.** Ein Schreib- oder
  Publish-Versuch auf ein unbekanntes Ziel wird verworfen, nicht angelegt.
- Abonniert wird bedarfsgetrieben und mengenbegrenzt: Ein Katalog mit tausenden
  States darf nicht ungefragt vollständig abonniert werden.

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

- Auf der **Adapter-Seite** lassen sich pro Adapter beliebig viele Instanzen
  anlegen und **einzeln benennen**. Der Name ist
  die Autorität im Topic: `prefix://<name>/…`.
- Jede Instanz hat **eigene Einstellungen** (gespeichert je Instanz), greift aber
  auf **dieselben Adapterdateien** zu.
- Die Einstellungsseite einer Instanz wird **generisch aus dem `settings`-Schema**
  des Manifests gerendert. Ohne Schema bleibt sie leer.
- Dynamische, nicht im Formularschema enthaltene Daten dürfen Adapter über
  `host.setStorage(key, value)` persistieren. Hauptsystem und Adapter schreiben
  dabei nur ihre jeweiligen Schlüssel; dadurch gehen z. B. erkannte Gerätelisten
  bei einer Einstellungsänderung und dem anschließenden Neustart nicht verloren.
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

## Zugriffsrechte des angemeldeten Nutzers (`GET /me/access`)

homeESS kennt ein Rollenmodell (`read` / `operate` / `write`) und einen
Administrator mit vollen Rechten. **Adapter-Kindprozesse selbst bleiben davon
unberührt** — sie stellen bislang keine Rechte bereit und die `host`-API kennt
keinen Request-Kontext. Adapter-**Frontends**, die im Browser laufen (eigene
Ansichten mit demselben Session-Cookie), können die Rechte des gerade
angemeldeten Nutzers jedoch über einen eigenen Endpunkt abfragen und ihre
Bearbeiten-/Schalt-Elemente entsprechend ein-/ausblenden:

```
GET /me/access        (Accept: application/json)
→ 200 { "user": "Name", "role": "read|operate|write",
        "isAdmin": true|false,
        "canRead": true, "canOperate": bool, "canWrite": bool }
→ 401 { "error": "Nicht angemeldet." }
```

Empfohlene Auswertung im Adapter-Frontend:

- `canWrite` → Vollzugriff (Bearbeiten, Anlegen, Löschen, Schalten).
- `canOperate` → nur Schalter/Bedienelemente aktiv, keine Konfiguration.
- sonst (`read`) → alles schreibgeschützt.

Die Durchsetzung erfolgt zusätzlich immer **serverseitig**: schreibende Requests
werden ohne ausreichende Rechte mit `403` abgewiesen. Der Endpunkt dient rein der
passenden Darstellung. Künftige Adapter können diese Prüfung so bereits heute in
ihre eigenen Oberflächen einbauen.

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
7. Bei komplexer Verwaltung `managementPage` deklarieren und
   `handleManagementRequest` implementieren; Secrets ausschließlich über den
   Secret-Store und Quellen über `subscribeState` anbinden.
8. Sollen einzelne fremde States verarbeitet werden, einen Tab im
   Eigenschaften-Dialog anhängen (`stateOptions` im Manifest und/oder
   `host.setStateOptionsSchema(...)`) und die Auswahl über
   `host.listStateOptions()` samt `stateOptionsChanged()` auswerten, statt eine
   eigene Auswahlliste zu bauen.
9. Bei capability-gesteuerter Hardware nur relevante Felder anzeigen und
   übertragen, die kanonische Konfiguration serverseitig validieren und den
   State-Katalog nach Hardwareänderungen vollständig erneuern.

Als vollständiges, lauffähiges Beispiel dient der mitgelieferte
**Demo-Adapter** unter [`/adapter/demo/`](adapter/demo/).
