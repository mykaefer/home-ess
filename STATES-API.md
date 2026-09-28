# homeESS States API (v1)

Diese Dokumentation beschreibt die **States API** von homeESS vollständig. Sie
richtet sich an Entwickler, die einen eigenen Client schreiben möchten – etwa
eine Desktop-Widgetleiste, ein Skript zur Hausautomation oder eine Anbindung
an ein anderes System.

## Inhalt

1. [Einführung](#1-einführung)
2. [Basis-URL](#2-basis-url)
3. [Authentifizierung](#3-authentifizierung)
4. [State-Pfade und Verzeichnisse](#4-state-pfade-und-verzeichnisse)
5. [Endpunkte](#5-endpunkte)
6. [State-Datenmodell](#6-state-datenmodell)
7. [Zugriffsbeschränkungen](#7-zugriffsbeschränkungen)
8. [Fehlerformat und Fehlercodes](#8-fehlerformat-und-fehlercodes)
9. [Beispiele](#9-beispiele)
10. [Sicherheitshinweise und Grenzen](#10-sicherheitshinweise-und-grenzen)
11. [API-Versionierung](#11-api-versionierung)

---

## 1. Einführung

### Zweck

homeESS führt alle Werte der Anlage in einem zentralen **State-Baum**:
berechnete Systemwerte (PV-Leistung, Verbrauchssummen, Wetter …), frei
angelegte *Custom States* und die States aller Adapter-Instanzen. Die States
API macht genau diesen Baum für externe Programme zugänglich:

- den Baum hierarchisch durchsuchen (für einen State-Picker),
- alle freigegebenen States mit Wert und Metadaten auflisten,
- einzelne States lesen,
- beschreibbare States setzen.

Die API ist eine reine Zugriffsschicht. Sie führt keine eigenen Werte, sondern
liest und schreibt über dieselben zentralen Funktionen wie die homeESS-
Oberfläche (Seite *States*). Ein über die API geschriebener Wert wird daher
genauso verarbeitet wie ein Schaltvorgang in der Weboberfläche – einschließlich
Weiterleitung an den zuständigen Adapter oder MQTT-Broker.

### Lokaler Einsatzzweck

Die API ist für Clients im **lokalen Netz** gedacht. Sie vertraut dennoch keinem
Gerät implizit: Jeder Zugriff auf States erfordert eine Anmeldung mit dem
API-Passwort und ein gültiges Zugriffstoken.

### Aktivierung in homeESS

Die API ist **standardmäßig ausgeschaltet**. Ein Administrator aktiviert sie in
der Weboberfläche unter

**Einstellungen → States API**

1. Unter *API-Passwort* ein Passwort (mindestens 8, höchstens 256 Zeichen)
   eingeben, wiederholen und speichern.
2. *States API aktivieren* anhaken und speichern.
3. Optional im *States-Katalog* States oder Verzeichnisse vom Zugriff
   ausschließen (siehe [Abschnitt 7](#7-zugriffsbeschränkungen)).

Ohne gesetztes Passwort lässt sich die API nicht einschalten. Die Karte zeigt
außerdem die Basis-URL, unter der der Browser homeESS gerade erreicht, und die
Token-Gültigkeit.

### Authentifizierungsprinzip

Es gibt genau **einen** Zugang, geschützt durch das API-Passwort. Ein Client
sendet das Passwort einmal an `POST /api/v1/auth` und erhält ein zeitlich
begrenztes **Bearer-Token**. Alle weiteren Aufrufe senden nur noch dieses Token:

```
Authorization: Bearer <token>
```

Das Passwort wird nicht bei jedem Request übertragen. Die Cookie-Anmeldung der
Weboberfläche spielt für die API keine Rolle.

---

## 2. Basis-URL

homeESS ist ein einzelner HTTP-Server. Die API liegt auf demselben Host und
Port wie die Weboberfläche, unter dem festen Präfix `/api/v1`:

```
http://<homeess-host>:<port>/api/v1
```

| Teil             | Bedeutung                                                                 |
|------------------|---------------------------------------------------------------------------|
| `<homeess-host>` | Hostname oder IP-Adresse des Rechners, auf dem homeESS läuft              |
| `<port>`         | Port der Weboberfläche; Standard `3000` (Umgebungsvariable `PORT`)        |
| `/api/v1`        | Versioniertes Präfix der States API                                       |

Beispiel: Wird die Oberfläche unter `http://homeess.local:3000/` aufgerufen,
lautet die Basis-URL `http://homeess.local:3000/api/v1`.

homeESS selbst spricht HTTP. Wer homeESS hinter einem Reverse Proxy mit TLS
betreibt (z. B. `https://homeess.example/`), erreicht die API unverändert unter
`https://homeess.example/api/v1` – die API erzeugt keine absoluten URLs und ist
damit vollständig HTTPS-kompatibel. Für einen Betrieb außerhalb des eigenen
Netzes wird HTTPS dringend empfohlen, weil Passwort und Token sonst im Klartext
übertragen werden.

Alle Antworten sind `application/json; charset=utf-8` (Ausnahme:
`204 No Content`) und tragen `Cache-Control: no-store`.

---

## 3. Authentifizierung

### Login-Request

```http
POST /api/v1/auth
Content-Type: application/json

{ "password": "mein-api-passwort" }
```

| Feld       | Typ    | Pflicht | Beschreibung                                   |
|------------|--------|---------|------------------------------------------------|
| `password` | string | ja      | Das in homeESS festgelegte API-Passwort (1–256 Zeichen) |

Der Body muss als `application/json` gesendet werden.

### Login-Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

{
  "token": "p1lQ3pVtY0m9Jc8H7nC4x0u1RkQh2x3m4n5o6p7q8r9",
  "tokenType": "Bearer",
  "expiresIn": 43200,
  "expiresAt": "2026-09-26T16:58:39.943Z"
}
```

| Feld        | Typ    | Beschreibung                                               |
|-------------|--------|------------------------------------------------------------|
| `token`     | string | Zugriffstoken (43 Zeichen, base64url, 256 Bit Zufall)      |
| `tokenType` | string | immer `"Bearer"`                                           |
| `expiresIn` | number | Gültigkeit in Sekunden ab Ausstellung                      |
| `expiresAt` | string | Ablaufzeitpunkt (ISO 8601, UTC)                            |

### Verwendung des Bearer-Tokens

Jeder weitere Request sendet das Token im `Authorization`-Header:

```http
GET /api/v1/states
Authorization: Bearer p1lQ3pVtY0m9Jc8H7nC4x0u1RkQh2x3m4n5o6p7q8r9
```

Token als Query-Parameter oder Cookie werden nicht akzeptiert.

### Token-Gültigkeit

- Ein Token ist **12 Stunden** (43 200 s) ab Ausstellung gültig. Die Frist
  verlängert sich durch Nutzung nicht.
- Ein Token wird vorzeitig ungültig, wenn
  - das API-Passwort geändert wird,
  - die API ausgeschaltet wird,
  - der Client sich mit `POST /api/v1/auth/logout` abmeldet,
  - homeESS neu gestartet wird (Tokens liegen nur im Arbeitsspeicher).
- Es können mehrere Tokens gleichzeitig gültig sein (mehrere Clients). Ab
  100 gleichzeitig gültigen Tokens verdrängt jede neue Anmeldung das älteste.

Empfohlenes Client-Verhalten: Bei `401` mit `token_expired` oder
`token_invalid` einmal neu anmelden und den Request wiederholen.

Dasselbe Token berechtigt auch zum **Audio Bus** (WebSocket
`/api/v1/audio/ws`, Token im `Authorization`-Header des Upgrade-Requests).
Protokoll und Grenzen: [AUDIO-BUS.md](AUDIO-BUS.md).

### Abmelden

```http
POST /api/v1/auth/logout
Authorization: Bearer <token>
```

Antwort: `204 No Content`. Das Token ist danach ungültig.

### Begrenzung fehlgeschlagener Anmeldungen

- Je Client-Adresse sind innerhalb von 15 Minuten höchstens **5**
  Fehlversuche erlaubt. Danach ist die Adresse für **15 Minuten** gesperrt.
- Zusätzlich gilt eine gemeinsame Obergrenze von 50 Fehlversuchen in
  15 Minuten über alle Adressen; wird sie erreicht, sind Anmeldungen für alle
  Adressen 15 Minuten gesperrt.
- Während einer Sperre beantwortet `POST /api/v1/auth` jeden Versuch – auch mit
  richtigem Passwort – mit `429 too_many_attempts` und dem Header
  `Retry-After: <Sekunden>`.
- Eine erfolgreiche Anmeldung setzt den Zähler der Adresse zurück.

### Mögliche Authentifizierungsfehler

| HTTP | `error`                  | Wann                                                         |
|------|--------------------------|--------------------------------------------------------------|
| 403  | `api_disabled`           | API in homeESS ausgeschaltet                                 |
| 415  | `unsupported_media_type` | Login-Body nicht als `application/json` gesendet             |
| 400  | `invalid_request`        | Feld `password` fehlt, ist leer, kein String oder zu lang; Body kein gültiges JSON |
| 401  | `invalid_credentials`    | Passwort falsch                                              |
| 429  | `too_many_attempts`      | Zu viele Fehlversuche (siehe oben), mit `Retry-After`        |
| 401  | `unauthorized`           | Geschützter Endpunkt ohne `Authorization: Bearer …`          |
| 401  | `token_invalid`          | Token unbekannt, widerrufen, nach Passwortwechsel oder Neustart ungültig |
| 401  | `token_expired`          | Token abgelaufen                                             |

Antworten mit `401` tragen zusätzlich einen `WWW-Authenticate: Bearer …`-Header.

---

## 4. State-Pfade und Verzeichnisse

Die API verwendet ausschließlich die Bezeichner, die homeESS selbst verwendet.

### State-Topic (kanonischer State-Pfad)

Jeder State wird über sein **Topic** adressiert – denselben Bezeichner, den die
homeESS-Seite *States*, Dashboards und Bedingungen verwenden:

| Quelle        | Form                                   | Beispiel                                      |
|---------------|----------------------------------------|-----------------------------------------------|
| Systemwert    | `system://homeess/<id>`                | `system://homeess/pv.current`                 |
| Custom State  | `custom://<verzeichnis>/…/<name>`      | `custom://Wohnzimmer/Licht`                   |
| Adapter       | `<prefix>://<instanz>/<adresse>`       | `shelly://keller/relay/0`                     |
| Modul-States  | modulspezifisches Schema               | `schaltgruppe://…`                            |

Clients sollten Topics als undurchsichtige Zeichenketten behandeln und sie
genau so verwenden, wie die API sie liefert. homeESS normalisiert Topics
(z. B. Groß-/Kleinschreibung des Schemas, Leerzeichen in Adapter-Adressen);
maßgeblich ist immer die von der API gelieferte Schreibweise.

**In URLs** enthält ein Topic `://` und `/`. Es wird deshalb als **ein**
URL-kodiertes Pfadsegment übergeben (`encodeURIComponent`):

```
system://homeess/pv.current  →  /api/v1/states/system%3A%2F%2Fhomeess%2Fpv.current
```

Unkodierte Topics (`/api/v1/states/system://homeess/pv.current`) werden
ebenfalls angenommen, sind aber nicht empfohlen, weil Proxys und HTTP-
Bibliotheken doppelte Schrägstriche verändern können.

### Verzeichnispfad

Der State-Baum ist in Verzeichnisse gegliedert – dieselbe Gliederung wie auf der
homeESS-Seite *States*. Ein Verzeichnis wird durch seinen **Pfad** bezeichnet:
Die Namen von der Wurzel bis zum Verzeichnis, getrennt durch ` / `
(Leerzeichen, Schrägstrich, Leerzeichen).

Die oberste Ebene besteht aus:

| Wurzel               | Inhalt                                                  |
|----------------------|---------------------------------------------------------|
| `System`             | Berechnete homeESS-Werte und Modul-States               |
| `Custom`             | Custom States (Verzeichnisse wie in *States → Custom States*) |
| `Adapter: <Instanz>` | States einer Adapter-Instanz                            |

Beispiele: `System / Photovoltaik`, `Custom / Heizung / Wohnzimmer`,
`Adapter: keller / Relais`.

Regeln:

- Die leere Zeichenkette `""` bezeichnet die Wurzel des Baums.
- Leerraum um die Trennzeichen ist unerheblich: `Custom/Heizung` und
  `Custom /  Heizung` bezeichnen dasselbe Verzeichnis wie `Custom / Heizung`.
- Die Namen selbst sind exakt (Groß-/Kleinschreibung zählt).
- Ein Verzeichnis existiert nur, solange es mindestens einen (freigegebenen)
  State enthält.

---

## 5. Endpunkte

Übersicht:

| Methode | URL                               | Auth   | Zweck                                   |
|---------|-----------------------------------|--------|-----------------------------------------|
| GET     | `/api/v1`                         | nein   | Status und Version der API              |
| POST    | `/api/v1/auth`                    | nein\* | Anmelden, Token erhalten                |
| POST    | `/api/v1/auth/logout`             | Token  | Token verwerfen                         |
| GET     | `/api/v1/folders?path=…`          | Token  | Inhalt eines Verzeichnisses             |
| GET     | `/api/v1/states?path=…&q=…`       | Token  | Flache State-Liste (Katalog)            |
| GET     | `/api/v1/states/{topic}`          | Token  | Einzelnen State lesen                   |
| PUT     | `/api/v1/states/{topic}`          | Token  | Beschreibbaren State setzen             |

\* erfordert das API-Passwort im Body.

Für jeden Endpunkt gilt zusätzlich: Ist die API ausgeschaltet, antworten alle
Endpunkte außer `GET /api/v1` mit `403 api_disabled`. Nicht unterstützte
Methoden liefern `405 method_not_allowed` mit `Allow`-Header, unbekannte Pfade
unter `/api/v1` `404 not_found`, unerwartete Fehler `500 internal_error`.

### 5.1 `GET /api/v1` – Status

Ohne Anmeldung abrufbar, verrät keine States.

**Response `200`**

```json
{ "name": "homeESS States API", "version": "v1", "enabled": true }
```

`enabled` ist `true`, wenn die API eingeschaltet ist und ein Passwort hat.

### 5.2 `POST /api/v1/auth` – Anmelden

Siehe [Abschnitt 3](#3-authentifizierung).

| Status | Bedeutung |
|--------|-----------|
| 200 | Token ausgestellt |
| 400 | `invalid_request` |
| 401 | `invalid_credentials` |
| 403 | `api_disabled` |
| 415 | `unsupported_media_type` |
| 429 | `too_many_attempts` |

### 5.3 `POST /api/v1/auth/logout` – Abmelden

Kein Body. **Response `204`** ohne Inhalt.

| Status | Bedeutung |
|--------|-----------|
| 204 | Token verworfen |
| 401 | `unauthorized`, `token_invalid`, `token_expired` |
| 403 | `api_disabled` |

### 5.4 `GET /api/v1/folders` – Verzeichnisinhalt

Liefert die direkten Unterverzeichnisse und die States eines Verzeichnisses.
Damit lässt sich ein State-Browser Ebene für Ebene aufbauen.

**Query-Parameter**

| Name   | Typ    | Pflicht | Beschreibung                                         |
|--------|--------|---------|------------------------------------------------------|
| `path` | string | nein    | Verzeichnispfad; leer oder weggelassen = Wurzel (max. 1000 Zeichen) |

**Response `200`**

```json
{
  "path": "Custom / Heizung",
  "name": "Heizung",
  "parent": "Custom",
  "folders": [
    { "name": "Wohnzimmer", "path": "Custom / Heizung / Wohnzimmer", "stateCount": 1, "folderCount": 0 },
    { "name": "Bad", "path": "Custom / Heizung / Bad", "stateCount": 1, "folderCount": 0 }
  ],
  "states": []
}
```

| Feld                   | Typ            | Beschreibung                                                      |
|------------------------|----------------|-------------------------------------------------------------------|
| `path`                 | string         | Kanonischer Pfad des Verzeichnisses (`""` = Wurzel)                |
| `name`                 | string         | Name des Verzeichnisses (`""` = Wurzel)                            |
| `parent`               | string \| null | Pfad des übergeordneten Verzeichnisses; `""` = Wurzel; `null` bei der Wurzel selbst |
| `folders[]`            | array          | Direkte Unterverzeichnisse in homeESS-Reihenfolge                  |
| `folders[].name`       | string         | Name                                                              |
| `folders[].path`       | string         | Pfad (für den nächsten Aufruf)                                    |
| `folders[].stateCount` | number         | Anzahl freigegebener States darin, rekursiv                        |
| `folders[].folderCount`| number         | Anzahl direkter, freigegebener Unterverzeichnisse                  |
| `states[]`             | array          | States direkt in diesem Verzeichnis ([Datenmodell](#6-state-datenmodell)) |

| Status | Bedeutung |
|--------|-----------|
| 200 | Verzeichnis gefunden |
| 400 | `invalid_request` – `path` zu lang oder mehrfach angegeben |
| 401 | `unauthorized`, `token_invalid`, `token_expired` |
| 403 | `api_disabled` |
| 404 | `folder_not_found` – unbekannt, ausgeschlossen oder ohne freigegebene States |

### 5.5 `GET /api/v1/states` – State-Katalog

Liefert alle freigegebenen States als flache Liste, ohne dass der Client Pfade
kennen muss. Jedes Topic erscheint genau einmal.

**Query-Parameter**

| Name     | Typ     | Pflicht | Standard | Beschreibung                                              |
|----------|---------|---------|----------|-----------------------------------------------------------|
| `path`   | string  | nein    | Wurzel   | Nur States unterhalb dieses Verzeichnisses (rekursiv)     |
| `q`      | string  | nein    | –        | Suche (ohne Groß-/Kleinschreibung) in Topic, Name und Verzeichnispfad; max. 120 Zeichen |
| `offset` | integer | nein    | `0`      | Anzahl zu überspringender Treffer                         |
| `limit`  | integer | nein    | `5000`   | Maximale Anzahl Treffer (1–5000)                          |

**Response `200`**

```json
{
  "path": "",
  "total": 281,
  "offset": 0,
  "limit": 5000,
  "states": [
    {
      "topic": "system://homeess/pv.yesterday",
      "name": "PV Ertrag gestern",
      "folder": "System / Photovoltaik",
      "value": 12.4,
      "display": "12,40 kWh",
      "type": "number",
      "readable": true,
      "writable": false,
      "source": "system",
      "updatedAt": "2026-09-26T04:58:28.717Z"
    }
  ]
}
```

| Feld       | Typ    | Beschreibung                                         |
|------------|--------|------------------------------------------------------|
| `path`     | string | Kanonischer Pfad des abgefragten Verzeichnisses      |
| `total`    | number | Anzahl aller Treffer (vor `offset`/`limit`)          |
| `offset`   | number | Verwendeter Offset                                   |
| `limit`    | number | Verwendetes Limit                                    |
| `states[]` | array  | States ([Datenmodell](#6-state-datenmodell))         |

| Status | Bedeutung |
|--------|-----------|
| 200 | Liste geliefert (auch leer) |
| 400 | `invalid_request` – ungültiger Parameter |
| 401 | `unauthorized`, `token_invalid`, `token_expired` |
| 403 | `api_disabled` |
| 404 | `folder_not_found` – `path` unbekannt oder ausgeschlossen |

### 5.6 `GET /api/v1/states/{topic}` – State lesen

**Pfad-Parameter:** `topic` – kanonisches Topic, URL-kodiert (max. 1000 Zeichen).

**Response `200`** – ein State-Objekt ([Datenmodell](#6-state-datenmodell)):

```json
{
  "topic": "custom://Heizung/Wohnzimmer/Solltemperatur",
  "name": "Solltemperatur",
  "folder": "Custom / Heizung / Wohnzimmer",
  "value": 21,
  "display": "21 °C",
  "type": "number",
  "readable": true,
  "writable": true,
  "source": "custom",
  "unit": "°C",
  "control": { "type": "number" },
  "updatedAt": "2026-09-26T04:58:54.434Z"
}
```

| Status | Bedeutung |
|--------|-----------|
| 200 | State gefunden |
| 400 | `invalid_request` – Topic leer, zu lang, Steuerzeichen oder nicht dekodierbar |
| 401 | `unauthorized`, `token_invalid`, `token_expired` |
| 403 | `api_disabled` |
| 404 | `state_not_found` – unbekannt oder ausgeschlossen |

### 5.7 `PUT /api/v1/states/{topic}` – State schreiben

**Pfad-Parameter:** `topic` – kanonisches Topic, URL-kodiert.

**Request-Body** (`Content-Type: application/json`)

```json
{ "value": true }
```

| Feld    | Typ                       | Pflicht | Beschreibung                  |
|---------|---------------------------|---------|-------------------------------|
| `value` | boolean \| number \| string | ja    | Neuer Wert, passend zu `type` und `control` des States |

Vor dem Schreiben prüft homeESS in dieser Reihenfolge:

1. Existiert der State und ist er freigegeben? Sonst `404 state_not_found`.
2. Ist er beschreibbar (`writable: true`)? Sonst `403 state_not_writable`.
3. Passt der Wert zum Bedienelement (`control`)? Sonst `422 invalid_value`:

| `control.type` | zulässige Werte                                                                 |
|----------------|---------------------------------------------------------------------------------|
| `switch`       | `true` oder `false`                                                             |
| `number`       | Zahl oder numerische Zeichenkette (`"21.5"`, `"21,5"`); innerhalb `min`/`max`, passend zu `step` (Raster ab `min`, sonst ab 0) |
| `select`       | genau einer der Werte aus `control.options[].value`                             |
| `text`         | Zeichenkette, Zahl oder boolescher Wert; höchstens 500 Zeichen                  |

`null`, Objekte und Arrays sind nie zulässig.

**Response `200`**

```json
{ "topic": "custom://Wohnzimmer/Licht", "value": true, "written": true }
```

| Feld      | Typ     | Beschreibung                                                        |
|-----------|---------|---------------------------------------------------------------------|
| `topic`   | string  | Kanonisches Topic, an das geschrieben wurde                          |
| `value`   | any     | Geschriebener Wert in der Darstellung von `type`                     |
| `written` | boolean | immer `true`: Der Wert wurde an den homeESS-Schreibweg übergeben     |

`200` bedeutet, dass homeESS den Wert an den zuständigen Empfänger (Custom
State, Modul, Adapter oder MQTT-Broker) weitergegeben hat. Ob und wann ein
Gerät den neuen Zustand meldet, hängt vom Empfänger ab – der aktuelle Stand
wird anschließend mit `GET /api/v1/states/{topic}` gelesen.

| Status | Bedeutung |
|--------|-----------|
| 200 | Wert geschrieben |
| 400 | `invalid_request` – Feld `value` fehlt, Body kein JSON-Objekt oder kein gültiges JSON, Topic ungültig |
| 401 | `unauthorized`, `token_invalid`, `token_expired` |
| 403 | `api_disabled`, `state_not_writable` |
| 404 | `state_not_found` |
| 413 | `payload_too_large` – Body größer als 1 MB |
| 415 | `unsupported_media_type` – Body nicht `application/json` |
| 422 | `invalid_value` – Wert passt nicht zum State |
| 502 | `write_failed` – der Schreibweg hat den Wert nicht angenommen (z. B. MQTT-Broker oder Adapter nicht erreichbar) |

---

## 6. State-Datenmodell

Ein State-Objekt enthält nur Angaben, die homeESS tatsächlich führt.

| Feld        | Typ                         | Immer? | Beschreibung |
|-------------|-----------------------------|--------|--------------|
| `topic`     | string                      | ja     | Kanonischer, vollständiger State-Pfad (siehe [Abschnitt 4](#4-state-pfade-und-verzeichnisse)) |
| `name`      | string                      | ja     | Anzeigename des States |
| `folder`    | string                      | ja     | Verzeichnispfad, in dem der State liegt |
| `value`     | boolean \| number \| string \| object \| array \| null | ja | Aktueller Wert in der Darstellung von `type`; `null`, wenn (noch) kein Wert vorliegt |
| `display`   | string \| null              | ja     | Formatierter Wert, wie ihn die homeESS-Oberfläche zeigt (mit Einheit, Nachkommastellen, „Ein“/„Aus“ …; sprachabhängig) |
| `type`      | string \| null              | ja     | Datentyp: `boolean`, `number`, `string`, `json` (Objekt/Array) oder `null`, wenn er sich nicht bestimmen lässt |
| `readable`  | boolean                     | ja     | Immer `true` – jeder gelieferte State ist lesbar |
| `writable`  | boolean                     | ja     | `true`, wenn der State über `PUT` gesetzt werden kann |
| `source`    | string                      | ja     | Herkunft: `system` (berechneter Wert oder Modul), `custom` (Custom State), `adapter` (Adapter-Instanz) |
| `unit`      | string                      | optional | Einheit, falls hinterlegt (z. B. `W`, `°C`) |
| `decimals`  | integer                     | optional | In homeESS eingestellte Nachkommastellen für die Anzeige |
| `control`   | object                      | optional | Nur bei beschreibbaren States: wie der Wert gesetzt wird (siehe unten) |
| `updatedAt` | string                      | optional | Zeitpunkt, zu dem homeESS den aktuellen Wert zuletzt erhalten hat (ISO 8601, UTC) |

Optionale Felder fehlen im Objekt, wenn homeESS die Angabe nicht kennt.

**Bestimmung von `type`:** Beschreibbare States bringen über ihr Bedienelement
mit, wie sie gesetzt werden (`switch` → `boolean`, `number` → `number`,
`select` → `number`, wenn alle Optionen Zahlen sind, sonst `string`; `text` →
`string`). Custom States und Module legen das selbst fest; bei Adapter-States
leitet homeESS es wie auf der Seite *States* aus dem zuletzt gesehenen Wert ab.
Für reine Lesewerte bestimmt der aktuelle Wert den Typ.

**`control`-Objekt**

| Feld      | Typ    | Vorhanden bei | Beschreibung |
|-----------|--------|---------------|--------------|
| `type`    | string | immer         | `switch`, `number`, `select` oder `text` |
| `min`     | number | `number`, optional | Kleinster zulässiger Wert |
| `max`     | number | `number`, optional | Größter zulässiger Wert |
| `step`    | number | `number`, optional | Schrittweite; fehlt bei beliebiger Genauigkeit |
| `options` | array  | `select`      | Zulässige Werte: `[{ "value": 0, "label": "Aus" }, …]` |

Beispiel eines Auswahl-States – die Betriebsart einer Klimaanlage aus dem
Modul *Heizung* (Raumname und Adresse hängen von der Anlage ab):

```json
{
  "topic": "system://homeess/klima.wohnzimmer.betriebsart",
  "name": "Betriebsart",
  "folder": "System / Klima / Wohnzimmer",
  "value": 2,
  "display": "Automatik",
  "type": "number",
  "readable": true,
  "writable": true,
  "source": "system",
  "control": {
    "type": "select",
    "options": [
      { "value": 0, "label": "Aus" },
      { "value": 1, "label": "An" },
      { "value": 2, "label": "Automatik" }
    ]
  }
}
```

Welche States es gibt, hängt von den aktiven Modulen und Adaptern der
jeweiligen Anlage ab.

---

## 7. Zugriffsbeschränkungen

- **Standard:** Alle States sind für die API freigegeben.
- **Einzelne States ausschließen:** Im *States-Katalog* (Einstellungen → States
  API) das Häkchen vor einem State entfernen.
- **Ganze Verzeichnisse ausschließen:** Das Häkchen vor einem Verzeichnis
  entfernen. Der Ausschluss wirkt **rekursiv** auf alle Unterverzeichnisse und
  States darin – auch auf solche, die später neu hinzukommen.
- **Keine widersprüchlichen Regeln:** Unterhalb eines ausgeschlossenen
  Verzeichnisses lassen sich keine Einträge einzeln freigeben; die Oberfläche
  zeigt sie nicht mehr an. Einzelausschlüsse darunter werden beim Ausschließen
  des Verzeichnisses aufgelöst. Wird das Verzeichnis wieder freigegeben,
  erscheinen seine Einträge wieder – freigegeben.
- **Ausgeschlossen heißt nicht vorhanden:** Ausgeschlossene States und
  Verzeichnisse
  - erscheinen nicht in `GET /api/v1/states` (auch nicht in Suchergebnissen),
  - erscheinen nicht in `GET /api/v1/folders` und zählen nicht in
    `stateCount`/`folderCount`,
  - liefern bei direktem Zugriff `404 state_not_found` bzw.
    `404 folder_not_found` – genau wie ein nicht existierender Eintrag,
  - lassen sich nicht schreiben (`PUT` → `404 state_not_found`).
  Ein Verzeichnis, dessen States alle ausgeschlossen sind, verschwindet
  ebenfalls.
- **Serverseitig:** Die Prüfung erfolgt bei jedem Request in homeESS. Andere
  Schreibweisen eines Topics oder Pfads (Groß-/Kleinschreibung des Schemas,
  zusätzliche Leerzeichen, unkodierte Schrägstriche) werden erst auf den
  Eintrag im State-Baum aufgelöst und dann geprüft; sie führen zum selben
  Ergebnis oder zu `404`.
- **Mehrfach eingehängte States:** Taucht ein Topic an mehreren Stellen des
  Baums auf, gilt es als ausgeschlossen, sobald eine dieser Stellen
  ausgeschlossen ist.
- Änderungen an den Freigaben wirken sofort, ohne Neuanmeldung.

Gespeichert wird nur die (kompakte) Ausschlussliste: Verzeichnispfade und
State-Topics. Wird ein Verzeichnis in homeESS umbenannt (z. B. ein Custom-
States-Ordner oder eine Adapter-Instanz), passt der gespeicherte Pfad nicht mehr
und der Ausschluss muss neu gesetzt werden; einzeln ausgeschlossene Topics
bleiben ausgeschlossen, auch wenn der State vorübergehend fehlt.

---

## 8. Fehlerformat und Fehlercodes

Jeder Fehler ist ein JSON-Objekt:

```json
{
  "error": "state_not_found",
  "message": "Dieser State existiert nicht."
}
```

| Feld      | Typ    | Beschreibung |
|-----------|--------|--------------|
| `error`   | string | Stabiler, maschinenlesbarer Fehlercode (siehe Tabelle) |
| `message` | string | Menschenlesbare Beschreibung in der eingestellten homeESS-Sprache; kann sich ändern und sollte nicht ausgewertet werden |

Fehlerantworten enthalten niemals Stacktraces, Dateipfade oder andere interne
Details. Technische Ursachen werden nur im homeESS-Log festgehalten.

| `error`                  | HTTP | Bedeutung |
|--------------------------|------|-----------|
| `api_disabled`           | 403  | Die States API ist in homeESS ausgeschaltet |
| `unauthorized`           | 401  | Kein `Authorization: Bearer <token>`-Header |
| `invalid_credentials`    | 401  | API-Passwort falsch |
| `token_invalid`          | 401  | Token unbekannt oder ungültig (Passwortwechsel, Abmeldung, API ausgeschaltet, Neustart) |
| `token_expired`          | 401  | Token abgelaufen – neu anmelden |
| `too_many_attempts`      | 429  | Anmeldung wegen zu vieler Fehlversuche vorübergehend gesperrt (`Retry-After`) |
| `access_denied`          | 403  | Zugriff verweigert. In v1 reserviert: Für ausgeschlossene States und Verzeichnisse antwortet die API bewusst mit `state_not_found`/`folder_not_found`, damit ihre Existenz nicht erkennbar ist |
| `state_not_found`        | 404  | State existiert nicht oder ist ausgeschlossen |
| `folder_not_found`       | 404  | Verzeichnis existiert nicht, ist ausgeschlossen oder enthält keine freigegebenen States |
| `state_not_writable`     | 403  | State ist nur lesbar |
| `invalid_value`          | 422  | Wert passt nicht zu Datentyp, Grenzen, Schrittweite oder Optionen |
| `invalid_request`        | 400  | Anfrage fehlerhaft (fehlende Felder, ungültige Parameter, kein gültiges JSON, nicht dekodierbare URL) |
| `unsupported_media_type` | 415  | Request-Body nicht als `application/json` gesendet |
| `payload_too_large`      | 413  | Request-Body größer als 1 MB |
| `method_not_allowed`     | 405  | HTTP-Methode für den Endpunkt nicht erlaubt (siehe `Allow`-Header) |
| `not_found`              | 404  | Unbekannter Endpunkt unter `/api/v1` |
| `write_failed`           | 502  | Der Schreibweg von homeESS hat den Wert nicht angenommen |
| `internal_error`         | 500  | Unerwarteter interner Fehler |

---

## 9. Beispiele

Die Beispiele verwenden `http://homeess.local:3000` als Basis; bitte durch die
eigene Adresse ersetzen.

### curl

**Status abfragen**

```bash
curl -s http://homeess.local:3000/api/v1
```

**Anmelden und Token merken**

```bash
TOKEN=$(curl -s -X POST http://homeess.local:3000/api/v1/auth \
  -H 'Content-Type: application/json' \
  -d '{"password":"mein-api-passwort"}' | jq -r .token)
```

**Wurzel des Baums und ein Verzeichnis durchsuchen**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://homeess.local:3000/api/v1/folders

curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'path=System / Photovoltaik' \
  http://homeess.local:3000/api/v1/folders
```

**Alle States, einen Teilbaum oder eine Suche abrufen**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://homeess.local:3000/api/v1/states

curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'path=Custom / Heizung' \
  http://homeess.local:3000/api/v1/states

curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'q=temperatur' --data-urlencode 'limit=20' \
  http://homeess.local:3000/api/v1/states
```

**Einzelnen State lesen** (Topic URL-kodiert)

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://homeess.local:3000/api/v1/states/system%3A%2F%2Fhomeess%2Fpv.current
```

**State schreiben**

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":true}' \
  http://homeess.local:3000/api/v1/states/custom%3A%2F%2FWohnzimmer%2FLicht

curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":21.5}' \
  http://homeess.local:3000/api/v1/states/custom%3A%2F%2FHeizung%2FWohnzimmer%2FSolltemperatur
```

**Abmelden**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://homeess.local:3000/api/v1/auth/logout
```

### JavaScript (Node.js ≥ 18 oder Browser-Umgebung mit `fetch`)

```js
const BASE = 'http://homeess.local:3000/api/v1';
const PASSWORD = 'mein-api-passwort';

let token = null;

class ApiError extends Error {
  constructor(status, body) {
    super(body && body.message ? body.message : `HTTP ${status}`);
    this.status = status;
    this.code = body && body.error;
  }
}

async function authenticate() {
  const response = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  token = body.token;
  return body;
}

// Führt einen Request aus und meldet sich bei abgelaufenem/ungültigem Token
// einmal neu an.
async function api(path, options = {}, retry = true) {
  if (!token) await authenticate();
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (response.status === 401 && retry && ['token_expired', 'token_invalid'].includes(body.error)) {
    token = null;
    return api(path, options, false);
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

const stateUrl = (topic) => `/states/${encodeURIComponent(topic)}`;

async function main() {
  // 1. Authentifizieren
  await authenticate();

  // 2. States abrufen: Baum ebenenweise und flache Liste
  const root = await api('/folders');
  console.log('Wurzel:', root.folders.map((folder) => folder.path));
  const list = await api(`/states?q=${encodeURIComponent('temperatur')}`);
  console.log(`${list.total} Treffer`);

  // 3. Einzelnen State lesen
  const pv = await api(stateUrl('system://homeess/pv.current'));
  console.log(pv.name, pv.value, pv.unit || '', `(${pv.display})`);

  // 4. State schreiben
  const light = await api(stateUrl('custom://Wohnzimmer/Licht'));
  if (light.writable && light.type === 'boolean') {
    const result = await api(stateUrl(light.topic), {
      method: 'PUT',
      body: JSON.stringify({ value: !light.value }),
    });
    console.log('Geschrieben:', result);
  }

  await api('/auth/logout', { method: 'POST' });
}

main().catch((error) => {
  console.error(error.code || '', error.message);
  process.exitCode = 1;
});
```

Hinweis für Web-Anwendungen: Die API sendet keine CORS-Header. Ein Aufruf aus
einer Webseite eines anderen Ursprungs wird vom Browser daher blockiert; native
Programme, Skripte und Server-Anwendungen sind davon nicht betroffen.

---

## 10. Sicherheitshinweise und Grenzen

- Das API-Passwort wird ausschließlich als scrypt-Hash gespeichert und lässt
  sich in homeESS nicht wieder anzeigen.
- Tokens bestehen aus 256 Bit Zufall; homeESS hält nur ihren SHA-256-Hash im
  Arbeitsspeicher. Passwort und Tokens erscheinen nie im Log.
- homeESS protokolliert: Aktivieren/Deaktivieren der API, Passwortänderungen,
  Änderungen an den Freigaben, wiederholt fehlgeschlagene Anmeldungen und
  Sperren, technische Fehler. Einzelne Lese- und Schreibzugriffe werden nicht
  protokolliert.
- Das Rate-Limit arbeitet mit der Socket-Adresse des Clients. Ein
  `X-Forwarded-For`-Header wird bewusst ignoriert. Hinter einem Reverse Proxy
  teilen sich deshalb alle Clients die Adresse des Proxys und damit denselben
  Fehlversuchszähler.
- Rate-Limit-Zähler und Tokens liegen im Arbeitsspeicher und werden bei einem
  Neustart zurückgesetzt.
- Die API ist für das lokale Netz gedacht. Soll sie außerhalb erreichbar sein,
  gehört ein TLS-terminierender Reverse Proxy davor.

---

## 11. API-Versionierung

- Diese Beschreibung gilt für **v1**. Alle Endpunkte liegen unter `/api/v1/…`;
  es gibt keine unversionierten öffentlichen Endpunkte der States API.
- Innerhalb von v1 bleiben Endpunkte, Felder und Fehlercodes kompatibel.
  Erweiterungen sind möglich: neue Endpunkte, neue **optionale** Felder in
  Antworten und neue Fehlercodes. Clients sollten unbekannte Felder daher
  ignorieren und unbekannte Fehlercodes anhand des HTTP-Status behandeln.
- Inkompatible Änderungen (entfernte oder umbenannte Felder, geänderte
  Bedeutung, andere Pfadformen) erfolgen ausschließlich über eine neue
  API-Version, z. B. `/api/v2/…`.
- `GET /api/v1` liefert die Version (`"version": "v1"`), damit ein Client prüfen
  kann, ob homeESS die erwartete Schnittstelle anbietet.

### Raum- und Funktionszuordnung von Mess-/Schaltgeräten

Geräte-States enthalten zusätzlich `metadata` mit `deviceId`, `deviceName`,
`roomId`, `roomName`, `functionKey` und `functionLabel`. Fehlende Raum- oder
Funktionszuordnungen sind `null`. Die effektive Funktion verwendet die eigene
Gerätezuordnung, andernfalls die Funktion der Gerätegruppe (z. B. `licht` oder
`warmwasser`). Zugeordnete Geräte erscheinen unter `System / Räume / <Raum>`;
ihre `system://homeess/geraet.<id>.*`-Topics bleiben dabei unverändert.
Für „Licht in der Küche ausschalten“ müssen Clients Raum, `functionKey: "licht"`
und einen beschreibbaren booleanischen Schalt-State auswählen. Der Raum allein
ist keine Funktionsauswahl; unbekannte Funktionen sind nicht als Licht zu werten.

Räume ohne eingerichtete Soll-Temperatur dienen ausschließlich der
Gerätezuordnung. Sie besitzen keine `raeume.*`- oder `klima.*`-Regelungs-States;
die States ihrer zugeordneten Mess-/Schaltgeräte samt Metadaten bleiben vorhanden.
Erst ein gesetzter Sollwert aktiviert die Temperaturregelung und ihre States.
