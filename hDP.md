# homeESS Device Protocol (HDP) 1.0-draft

## 1. Zweck und Geltungsbereich

Dieses Dokument ist der vollständige normative Kommunikationsvertrag zwischen einem
homeESS-Adapter (im Folgenden **Adapter**) und einer HDP-Firmware auf einem lokalen
Endgerät (im Folgenden **Gerät**).

Es definiert ausschließlich:

- Erkennung über mDNS/DNS-SD,
- HTTP-Endpunkte und JSON-Strukturen,
- Kopplung und Authentifizierung,
- Hardwarekonfiguration und generische Ausgänge,
- WebSocket-Sitzungen, Pixel-Frames, Timelineprogramme und Binary-I/O-Ereignisse,
- Firmwareübertragung per OTA,
- Zustände, Timeouts, Wiederholungen und Fehlerbehandlung.

Projektorganisation, Quellcodeaufbau, Releaseprozess, Roadmap und Änderungsverlauf
gehören ausdrücklich nicht in diesen Vertrag.

Die Schlüsselwörter **MUSS**, **DARF NICHT**, **SOLL**, **SOLL NICHT** und **DARF**
sind im Sinn von RFC 2119 zu verstehen. Ein Teilnehmer ist nur dann
HDP-1.0-draft-konform, wenn er alle MUSS-Anforderungen dieses Dokuments erfüllt.

### 1.1 Verbindliche Zuständigkeitsgrenze

Der Adapter beziehungsweise das zugehörige Plugin ist allein verantwortlich für:

- die anwendungsspezifische Bedeutung von `device_type` und aller Topics;
- Datenquellen, Prozent-, Richtungs-, Schwellen- und Anzeigelogik;
- die Berechnung jedes logischen RGB-Pixelwerts;
- Farben, Übergänge, Effekte und Animationen;
- die Übersetzung dieser Ergebnisse in vollständige Frames, Pixeländerungen oder
  ein Timelineprogramm nach Abschnitt 14.

Das Gerät ist allein verantwortlich für:

- Pairing, Binding, Authentifizierung und Sitzungsverwaltung;
- Persistierung und Validierung der physischen Hardwarekonfiguration;
- Auswahl der durch `device_type` festgelegten generischen Laufzeitschicht beim
  Booten sowie Ansteuerung der konfigurierten Ein- und Ausgänge;
- zeitgesteuerte Wiedergabe bereits berechneter Timelineereignisse;
- Durchsetzung der deklarierten Größen-, Timing-, Helligkeits- und Stromgrenzen;
- sichere Offline-, Neustart- und Fehlerzustände.

Das Gerät DARF `device_type` ausschließlich zur Auswahl des normierten
Laufzeitprofils und seiner physischen Treiberschicht auswerten. Es DARF keine
Prozentanzeige, Richtungsanzeige, Topic-Logik, Farbauswahl, Toggle-, Set- oder
Counterlogik und keine anwendungsspezifische Animation selbst erzeugen. Ein
Timeline-Decoder, Pixelpuffer, Scheduler, Binary-Pin-Treiber, Entprellung und
elektrische Schutzfunktionen gelten als generische Geräteschicht.

## 2. Protokollidentität und Kompatibilität

Der exakte Protokollbezeichner lautet:

```text
1.0-draft
```

Adapter und Gerät MÜSSEN diesen Wert unverändert in mDNS, `/device`, `/manifest`,
Pairing und WebSocket verwenden. Dieser Draft definiert zwei Laufzeitprofile:

```text
pixel-timeline-v1
binary-io-v1
```

`percentage_indicator` und `argb_output` verwenden `pixel-timeline-v1`;
`binary_io` verwendet `binary-io-v1`. Mehrere Gerätetypen DÜRFEN sich ein
Laufzeitprofil teilen: Das Profil beschreibt ausschließlich die Ausgabeschicht
des Geräts, nicht die Bedeutung, die der Adapter den Bildern gibt. Das aktive
Profil wird in mDNS, `/device`, `/manifest` und im WebSocket-Hello ausgetauscht
und MUSS an allen vier Stellen identisch sein.
Dadurch bleibt das bereits persistierte HDP-1.0-Pairing unverändert, während
experimentelle Firmware- und Adapterstände mit unterschiedlicher
Ausgabeschicht keine scheinbar kompatible Steuersitzung aufbauen.

Für `1.0-draft` gilt:

- unbekannte JSON-Felder MÜSSEN ignoriert werden;
- fehlende Pflichtfelder MÜSSEN abgelehnt werden;
- unbekannte Enum-Werte MÜSSEN abgelehnt werden;
- unbekannte WebSocket-Nachrichtentypen MÜSSEN mit `UNSUPPORTED_MESSAGE_TYPE`
  beantwortet werden;
- ein anderer Protokollbezeichner MUSS mit `UNSUPPORTED_PROTOCOL_VERSION`
  abgelehnt werden;
- stillschweigende Typkonvertierung, etwa String nach Integer, ist nicht erlaubt.

Alle in Request- und Response-Beispielen gezeigten Felder sind Pflichtfelder,
sofern ihre Optionalität oder bedingte Nullbarkeit nicht ausdrücklich beschrieben
ist. Ein Sender DARF zusätzliche Felder ergänzen; ein Empfänger DARF deren
Vorhandensein nicht voraussetzen.

Solange der Bezeichner `1.0-draft` trägt und noch nicht als stabile Version 1.0
veröffentlicht wurde, darf dieser Vertrag weiter präzisiert werden. Eine
inkompatible Änderung der Laufzeitausgabe MUSS dabei mindestens ein neues
`runtime_profile` erhalten. Pairing-, Binding-, Authentifizierungs- und
Hashregeln DÜRFEN dadurch nicht stillschweigend verändert werden. Nach
Veröffentlichung der stabilen Version 1.0 erfordert jede inkompatible Änderung
einen neuen Protokollbezeichner.

## 3. Transport und Kodierung

### 3.1 Netzwerkprofil

HDP 1.0-draft verwendet ein lokales IPv4-Netzwerk.

| Kanal | Transport |
|---|---|
| Discovery | mDNS/DNS-SD |
| Metadaten und Steuerung | HTTP/1.1 |
| Laufzeitwerte und Ereignisse | WebSocket nach RFC 6455 |
| Firmwarebinärdaten | HTTP/1.1 Streaming |

TLS ist in diesem Profil nicht vorgeschrieben. Der `binding_key` wird deshalb nur
in einem vertrauenswürdigen lokalen Netz übertragen. Ein Gerät DARF dieses Profil
nicht über das öffentliche Internet exponieren.

WLAN-Provisionierung und Captive-Portal-HTML sind nicht Bestandteil von HDP
1.0-draft. Sie erfolgen vor der Discovery über einen gerätespezifischen,
außerhalb dieses Vertrags liegenden Kanal. Ein Adapter DARF keine
Portal-Route als HDP-API behandeln.

### 3.2 HTTP

- Basis-URI: `/api/v1`
- Pfade sind case-sensitive und werden ohne abschließenden Slash verwendet.
- HDP 1.0-draft definiert keine Query-Parameter.
- JSON-Encoding: UTF-8 ohne BOM
- JSON-Request-Content-Type: `application/json`; optional ist ausschließlich der
  Parameter `charset=utf-8`, Groß-/Kleinschreibung ist nicht relevant
- JSON-Response-Content-Type: `application/json`
- Binär-Content-Type: `application/octet-stream`
- jede JSON-Response MUSS `Cache-Control: no-store` enthalten
- Headernamen sind nach HTTP/1.1 case-insensitive; alle in diesem Vertrag als
  „exakt“ bezeichneten Headerwerte sind case-sensitive.
- JSON- und Binärrequests MÜSSEN `Content-Length` senden; HTTP Chunked Transfer
  Encoding ist für Request-Bodies nicht zulässig.
- API-Endpunkte DÜRFEN nicht auf Portal- oder HTML-Seiten umleiten.
- Ein JSON-Request-Body darf höchstens 3072 Bytes groß sein.
- Ein zu großer Body MUSS mit HTTP 413 und `PAYLOAD_TOO_LARGE` beantwortet werden.
- Ein JSON-Body MUSS ein Objekt als Wurzel besitzen.
- Nicht endliche Zahlen (`NaN`, `Infinity`) sind ungültig.
- Ein fehlender oder falscher Content-Type bei einem Request mit vorgeschriebenem
  JSON-Body ergibt HTTP 415 und `UNSUPPORTED_MEDIA_TYPE`.
- Ein unbekannter API-Pfad ergibt HTTP 404 und `ENDPOINT_NOT_FOUND`.
- Eine falsche Methode auf einem bekannten API-Pfad ergibt HTTP 405 und
  `METHOD_NOT_ALLOWED`.

Verletzt ein Request mehrere Regeln gleichzeitig, DARF das Gerät den zuerst
erkannten passenden Fehler aus Abschnitt 16 zurückgeben. Ein Adapter DARF sich
nicht auf die Fehlerpriorität mehrfach ungültiger Requests verlassen.

### 3.3 JSON-Datentypen

| Notation | Bedeutung |
|---|---|
| `string` | UTF-8-String |
| `uint8` | JSON-Integer 0…255 |
| `uint16` | JSON-Integer 0…65535 |
| `uint32` | JSON-Integer 0…4294967295 |
| `number` | endliche JSON-Zahl |
| `boolean` | ausschließlich `true` oder `false` |

### 3.4 Gemeinsames Erfolgs-Envelope

Jede erfolgreiche JSON-Antwort MUSS diese Form verwenden:

```json
{
  "ok": true,
  "data": {}
}
```

`data` MUSS vorhanden sein und ein Objekt sein.

### 3.5 Gemeinsames Fehler-Envelope

Jede fehlgeschlagene JSON-Antwort MUSS diese Form verwenden:

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Human-readable diagnostic",
    "details": {}
  }
}
```

- `code` MUSS einem Code aus Abschnitt 16 entsprechen.
- `message` dient Diagnosezwecken und DARF nicht maschinell ausgewertet werden.
- `details` MUSS vorhanden und ein Objekt sein.
- WLAN-Passwörter und Binding-Keys DÜRFEN nie in Responses, Discovery oder Logs
  enthalten sein.
- `instance_id` DARF nur an den in diesem Vertrag ausdrücklich gezeigten Stellen
  übertragen werden und DARF nicht in Fehlerdetails, Discovery oder Gerätelogs
  erscheinen.

## 4. Identifikatoren und kryptografische Werte

### 4.1 `device_id`

- dauerhaft pro Gerät;
- 12…64 Zeichen;
- erlaubte Zeichen: `a-z`, `0-9`, `-`;
- vom Gerät bei der Erstinbetriebnahme zufällig erzeugt;
- enthält mindestens 64 Bit Zufallsentropie;
- bleibt bei Neustart, Entkopplung und OTA erhalten;
- wird bei einem erfolgreichen Factory Reset verworfen und danach neu erzeugt;
- ist für den Adapter ein opaker Wert und DARF nicht aus MAC-Adresse, Hostname oder
  anderen Eigenschaften abgeleitet werden.

Beispiel:

```text
hdp-esp8266-a1b2c3d4e5f60718
```

### 4.2 `instance_id`

- dauerhaft pro homeESS-Installation;
- 1…64 ASCII-Zeichen;
- erlaubte Zeichen: `A-Z`, `a-z`, `0-9`, `.`, `_`, `-`;
- Doppelpunkt ist nicht erlaubt.

### 4.3 Nonces und Pairing-Session

`adapter_nonce`, `device_nonce` und `pairing_session` sind jeweils 16 zufällige
Bytes, kodiert als exakt 32 lowercase Hexzeichen.

Regulärer Ausdruck:

```text
^[0-9a-f]{32}$
```

Sie MÜSSEN mit einem kryptografisch geeigneten Zufallszahlengenerator erzeugt
werden.

### 4.4 `binding_key`

Der Adapter erzeugt 32 zufällige Bytes und kodiert sie als exakt 64 lowercase
Hexzeichen:

```text
^[0-9a-f]{64}$
```

Der gleiche 64-stellige String MUSS atomar mit der Kopplung auf Adapter und Gerät
gespeichert werden. Der Wert ist geheim und DARF nach erfolgreicher Kopplung nie in
einer Response, Discovery-Antwort oder einem Log erscheinen.

### 4.5 `binding_id`

Die Bildung ist bytegenau festgelegt:

1. Den 64-stelligen `binding_key` als Hex dekodieren.
2. Dadurch exakt 32 Bytes erhalten.
3. SHA-256 über diese 32 Bytes berechnen.
4. Den 32-Byte-Digest als exakt 64 lowercase Hexzeichen kodieren.

Formal:

```text
binding_id = lowercase_hex(SHA-256(hex_decode(binding_key)))
```

Es werden ausdrücklich **nicht** die 64 ASCII-Zeichen des Hexstrings gehasht.

`binding_id` ist ein nicht geheimes Vergleichsmerkmal und DARF öffentlich
übertragen werden.

Verbindliche Testvektoren:

| `binding_key` | `binding_id` |
|---|---|
| `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e` |
| `0000000000000000000000000000000000000000000000000000000000000000` | `66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925` |
| `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` | `4884fdaafea47c29fea7159d0daddd9c085d6200e1359e85bb81736af6b7c837` |

### 4.6 `message_id`

- 1…64 Zeichen;
- innerhalb einer WebSocket-Verbindung pro Sender eindeutig;
- erlaubte Zeichen: `A-Z`, `a-z`, `0-9`, `.`, `_`, `-`.

## 5. Persistente Zustände und Invarianten

Das Gerät MUSS mindestens folgende Werte persistent speichern:

- `device_id`,
- WLAN-Zugangsdaten,
- `owner_instance_id`,
- `binding_key`,
- Hardwarekonfiguration,
- Hardwarekonfigurationsrevision.

Eine aktive Kopplung existiert genau dann, wenn:

```text
owner_instance_id gültig
UND
binding_key gültig
```

Ein Teilnehmer DARF `paired=true` nicht allein aus einer Owner-ID, einem lokalen
Datenbankeintrag oder einer früheren Discovery-Antwort ableiten.

Die Hardwarekonfiguration MUSS Neustart, WLAN-Ausfall, Adapterausfall,
Entkopplung und OTA überstehen. Nur Factory Reset löscht sie.

Eine Hardware-Schemamigration oder Änderung des Laufzeitprofils DARF
`device_id`, WLAN-Zugangsdaten, `owner_instance_id` oder `binding_key` weder
löschen noch verändern. Pixelpuffer, laufende oder hochgeladene Timelines und
deren Upload-Staging sind flüchtige Laufzeitdaten und gehören nicht zur
persistenten Hardwarekonfiguration.

## 6. Zustandsmodelle

### 6.1 Betriebszustand

`GET /status` verwendet ausschließlich folgende lowercase Werte:

| Zustand | Bedeutung |
|---|---|
| `access_point` | Setup-AP aktiv |
| `pairable` | WLAN aktiv, nicht gekoppelt |
| `pairing` | Pairing-Session aktiv |
| `paired` | gekoppelt; Wartefrist auf die erste WS-Steuersitzung aktiv |
| `connected` | gekoppelte WS-Steuersitzung aktiv |
| `offline` | gekoppelt; WLAN oder bestätigte WS-Steuersitzung nicht verfügbar |
| `recovery_portal` | physisch ausgelöster Recovery-Modus |
| `updating` | OTA-Transaktion von `preparing` bis einschließlich `restarting` aktiv |
| `error` | nicht behebbarer Laufzeitfehler |

Zustandsübergänge ohne OTA:

- Nach Boot oder erfolgreichem Pairing wartet das Gerät im Zustand `paired`
  höchstens 45000 ms auf `session.ready`.
- Wird innerhalb dieser Frist keine Steuersitzung aktiv, wechselt es zu `offline`.
- Verlust oder Heartbeat-Timeout einer zuvor aktiven Steuersitzung bewirkt
  unmittelbar `offline`.
- Eine erfolgreiche neue `session.ready`-Antwort bewirkt `connected`.
- Bei nicht erreichbarem WLAN gilt unmittelbar `offline`, außer ein Setup- oder
  Recovery-Portal ist aktiv; diese Zustände haben Vorrang.

### 6.2 Pairing-Zustand

Discovery, `/device` und `/pairing/status` verwenden:

| Zustand | Bedeutung |
|---|---|
| `pairable` | keine vollständige persistente Kopplung |
| `pairing` | gültige unbestätigte Pairing-Session |
| `paired` | vollständige persistente Kopplung |

Der Pairing-Zustand ist unabhängig vom aktuellen WLAN- oder WebSocket-Zustand.

## 7. Discovery über mDNS/DNS-SD

### 7.1 Service

Das Gerät MUSS folgenden Dienst publizieren:

```text
_homeess-hdp._tcp.local
```

Die Veröffentlichungspflicht gilt, sobald das Gerät eine aktive
IPv4-Stationsverbindung besitzt. Im ausschließlich aktiven Setup- oder
Recovery-AP ist mDNS nicht vorgeschrieben.

Der SRV-Port ist der HTTP-API-Port. Der Hostname SOLL
`homeess-hdp-<letzte-6-Zeichen-der-device_id>.local` lauten.

### 7.2 TXT-Records

| Key | Format |
|---|---|
| `device_id` | Abschnitt 4.1 |
| `protocol_version` | exakt `1.0-draft` |
| `runtime_profile` | aktives Profil: `pixel-timeline-v1` oder `binary-io-v1` |
| `firmware_version` | SemVer |
| `platform` | nicht leerer ASCII-Identifier |
| `pairing_state` | `pairable`, `pairing`, `paired` |
| `binding_id` | 64 lowercase Hexzeichen oder leer |
| `configured_device_type` | gültiger `device_type` nach Abschnitt 12.2 oder leer |
| `hardware_config_present` | `true` oder `false` |
| `config_revision` | dezimaler `uint32` |
| `api_port` | dezimaler Port |
| `ws_port` | dezimaler Port |
| `ota_port` | dezimaler Port |

TXT-Records sind Discovery-Hinweise. Vor jeder zustandsändernden Aktion MUSS der
Adapter `/device` oder `/pairing/status` als maßgebliche Quelle abfragen.

Nach Pairing, Entkopplung oder Konfigurationsänderung MUSS das Gerät seine
TXT-Records innerhalb von 2 Sekunden aktualisieren.

Der Adapter SOLL kontinuierlich browsen und gleiche `device_id` unabhängig von
IP-Adressänderungen als dasselbe Gerät behandeln.

## 8. Authentifizierung

### 8.1 Profile

HDP 1.0-draft definiert genau ein Owner-Authentifizierungsprofil:

```text
local-binding-key-v1
```

HTTP-Requests mit Authentifizierungsklasse **A** MÜSSEN enthalten:

```text
X-HDP-Instance: <instance_id>
X-HDP-Binding-Key: <binding_key>
```

Beide Werte MÜSSEN vorhanden sein. Teilweise vorhandene Credentials ergeben
`INCOMPLETE_BINDING_CREDENTIALS`. Falsche oder fremde Credentials ergeben
`AUTH_REQUIRED`. Binding-Key-Vergleiche SOLLEN, soweit die Plattform dies
unterstützt, in konstanter Zeit erfolgen.

### 8.2 Autorisierungsmatrix

| Endpoint/Kanal | Ungekoppelt | Gekoppelt |
|---|---:|---:|
| Discovery | P | P |
| `GET /device` | P | P |
| `GET /manifest` | P | P |
| `GET /status` | P | P |
| `POST /pairing/start` | P | abgelehnt |
| `POST /pairing/confirm` | Pairing-Session | idempotent nur bei identischem Binding |
| `GET /pairing/status` | P | P; Credentials optional zum Abgleich |
| `GET /config` | P | A |
| `PUT /config` | P | A |
| `POST /unpair` | abgelehnt | A |
| `POST /restart` | P im AP/Recovery-Modus | A |
| `POST /factory-reset` | nur Recovery-Modus | nur Recovery-Modus |
| `GET /firmware` | P | P |
| `GET /firmware/status` | P | P |
| `POST /firmware/update` | abgelehnt | A |
| `POST /firmware/restart` | abgelehnt | A |
| WebSocket | abgelehnt | A |

`P` bedeutet öffentlich im lokalen Netz, `A` bedeutet Owner-authentifiziert.

## 9. HTTP-Endpunktübersicht

Alle Pfade in dieser Tabelle liegen unter `/api/v1`.

| Methode | Pfad | Erfolg |
|---|---|---:|
| GET | `/device` | 200 |
| GET | `/manifest` | 200 |
| GET | `/status` | 200 |
| POST | `/pairing/start` | 201 |
| POST | `/pairing/confirm` | 200 |
| GET | `/pairing/status` | 200 |
| GET | `/config` | 200 |
| PUT | `/config` | 200 |
| POST | `/unpair` | 202 |
| POST | `/restart` | 202 |
| POST | `/factory-reset` | 202 |
| GET | `/firmware` | 200 |
| GET | `/firmware/status` | 200 |
| POST | `/firmware/update` | 202 |
| POST | `/firmware/restart` | 202 |

## 10. Identität, Manifest und Status

### 10.1 `GET /api/v1/device`

Request-Body: keiner.

Response:

```json
{
  "ok": true,
  "data": {
    "device_id": "hdp-esp8266-a1b2c3",
    "model": "HDP Universal ESP8266",
    "platform": "esp8266",
    "firmware_version": "0.2.0",
    "protocol_version": "1.0-draft",
    "runtime_profile": "pixel-timeline-v1",
    "pairing_state": "paired",
    "paired": true,
    "binding_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "configured_device_type": "percentage_indicator",
    "hardware_config_present": true,
    "hardware_config_revision": 4
  }
}
```

Invarianten:

- `paired` ist genau bei `pairing_state == "paired"` wahr.
- `runtime_profile` entspricht exakt dem durch `configured_device_type`
  ausgewählten Profil.
- `binding_id` ist nur bei `paired=true` ein String, sonst `null`.
- `configured_device_type` ist ohne Hardwarekonfiguration `null`.
- `hardware_config_revision` ist ohne Hardwarekonfiguration `0`.

### 10.2 `GET /api/v1/manifest`

Request-Body: keiner.

Response:

```json
{
  "ok": true,
  "data": {
    "protocol_version": "1.0-draft",
    "api_version": "v1",
    "auth_profile": "local-binding-key-v1",
    "runtime_profile": "pixel-timeline-v1",
    "device_type_profile": "boot-dispatch-v1",
    "device_types": ["percentage_indicator", "argb_output", "binary_io"],
    "output_types": ["argb_strip"],
    "frame_encodings": [
      "rgb8-base64",
      "pixel-list-v1"
    ],
    "timeline_encodings": [
      "hdtl-delta-v1"
    ],
    "features": {
      "mdns": true,
      "websocket": true,
      "ota": true,
      "frame_output": true,
      "timeline_output": true,
      "timeline_loop": true,
      "runtime_brightness": true,
      "binary_input": true,
      "binary_output": true
    },
    "hardware_capabilities": {
      "argb_pins": [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
      "led_types": ["WS2812"],
      "color_orders": ["RGB", "GRB"],
      "binary_pins": [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16],
      "binary_pullup_pins": [0, 1, 2, 3, 4, 5, 12, 13, 14],
      "binary_boot_sensitive_pins": [0, 2, 15],
      "binary_serial_pins": [1, 3],
      "binary_input_types": ["switch", "button"]
    },
    "limits": {
      "maximum_json_body_bytes": 3072,
      "maximum_websocket_message_bytes": 2048,
      "maximum_outputs": 1,
      "maximum_binary_pins": 11,
      "binary_input_debounce_milliseconds": 30,
      "maximum_led_count": 300,
      "minimum_frame_interval_milliseconds": 20,
      "maximum_timeline_bytes": 65536,
      "maximum_timeline_events": 4096,
      "maximum_timeline_chunk_bytes": 512,
      "maximum_timeline_duration_milliseconds": 86400000
    }
  }
}
```

`hardware_capabilities.argb_pins` ist die für dieses konkrete Gerät verbindliche
Menge zulässiger GPIO-Nummern. Der Adapter MUSS sie statt einer eigenen
Boardtabelle verwenden. Dasselbe gilt für
`hardware_capabilities.binary_pins` bei `binary_io`. Ein GPIO, der einen
`argb_strip` treiben kann, ist auch als Binary-Ausgang zulässig; beide Mengen
dürfen sich daher decken.

Die folgenden drei Listen sind OPTIONAL und beschreiben ausschließlich
Eigenheiten einzelner GPIOs. Sie schränken die zulässige Pinauswahl NICHT ein;
ein Adapter DARF die betroffenen Pins nicht sperren, SOLL sie beim Einrichten
aber kenntlich machen. Jede vorhandene Liste MUSS eine duplikatfreie Teilmenge
von `binary_pins` sein.

| Feld | Bedeutung |
| --- | --- |
| `binary_pullup_pins` | GPIOs mit nutzbarem internem Pull-up. Ein GPIO aus `binary_pins`, der hier fehlt, benötigt als aktiv-low-Eingang einen externen Pull-up; die Firmware konfiguriert ihn dann als `INPUT` statt `INPUT_PULLUP`. |
| `binary_boot_sensitive_pins` | GPIOs, deren Pegel beim Reset den Bootmodus bestimmt. Ein bereits geschlossener Schalter kann den Start blockieren. |
| `binary_serial_pins` | GPIOs, die die serielle Konsole belegen. |

Fehlt eine Liste, macht das Gerät zu dieser Eigenschaft keine Aussage; der
Adapter MUSS ihr Fehlen als „unbekannt" und nicht als „trifft auf keinen Pin
zu" behandeln.

`runtime_profile` MUSS das Laufzeitprofil des aktiven Gerätetyps sein.
`device_type_profile=boot-dispatch-v1` bedeutet, dass die Firmware zwischen den
in `device_types` genannten Laufzeitschichten umschaltet. Das Manifest
beschreibt die Fähigkeiten aller Schichten, auch wenn immer nur eine davon
aktiv ist.

Gerätetypen mit demselben Laufzeitprofil teilen sich Hardwarevertrag und
Nachrichtensatz vollständig; sie unterscheiden sich ausschließlich in der
Bedeutung, die der Adapter der Ausgabe gibt. `percentage_indicator` und
`argb_output` sind ein solches Paar: Beide beschreiben genau einen
`argb_strip` und tauschen Frames und Timelines über `pixel-timeline-v1` aus.
Die Prozentanzeige füllt den Strang anteilig; der ARGB-Ausgang verknüpft
einzelne LEDs mit einzelnen Zuständen. Welche Pixel gesetzt werden, berechnet
in beiden Fällen ausschließlich der Adapter — das Gerät kennt weder Prozentwert
noch Zustandsquelle.

`output_types`, `frame_encodings` und `timeline_encodings` enthalten
ausschließlich die von diesem konkreten Gerät ausführbaren Profile. Alle
`limits` sind verbindliche Obergrenzen beziehungsweise beim Frameintervall eine
Untergrenze. Der Adapter MUSS diese Werte abfragen und DARF keine fest
einprogrammierte Board- oder Kapazitätstabelle an ihre Stelle setzen.

`maximum_timeline_bytes` bezeichnet die dekodierte Binärgröße eines Programms,
nicht die Länge seiner Base64-Darstellung. `maximum_timeline_chunk_bytes`
bezeichnet entsprechend die dekodierte Nutzlast eines Chunks.

### 10.3 `GET /api/v1/status`

Request-Body: keiner.

Response:

```json
{
  "ok": true,
  "data": {
    "state": "paired",
    "uptime_seconds": 123,
    "free_heap_bytes": 38240,
    "wifi_connected": true,
    "wifi_rssi_dbm": -57,
    "ip_address": "192.168.1.42",
    "paired": true,
    "last_boot": {
      "reset_reason": "software_restart",
      "reset_detail": "Software/System restart",
      "config_load_status": "ok",
      "config_load_source": "primary",
      "config_load_diagnostic": "primary=valid; temporary=missing; backup=valid",
      "storage_generation": 12
    }
  }
}
```

- `wifi_rssi_dbm` ist bei getrennter WLAN-Verbindung `null`.
- `ip_address` ist bei getrennter WLAN-Verbindung `null`.
- `uptime_seconds` ist ein `uint32` mit den seit dem letzten Boot vergangenen
  Sekunden. Ein Adapter DARF einen Rücklauf nur als Hinweis auf Neustart oder
  Plattformtimer-Wrap verwenden.
- `free_heap_bytes` ist ein `uint32`; `wifi_rssi_dbm` ist `int32|null`;
  `ip_address` ist `string|null`; `wifi_connected` und `paired` sind Boolean.

`last_boot.reset_reason` ist genau einer dieser Werte:

```text
power_on
external_reset
software_restart
watchdog
exception
brownout
deep_sleep
unknown
```

`last_boot.reset_detail` ist ein plattformspezifischer Diagnosestring oder `null`
und DARF nicht maschinell ausgewertet werden.

`last_boot.config_load_status` ist:

| Wert | Bedeutung |
|---|---|
| `ok` | primäre persistente Konfiguration gültig geladen |
| `recovered` | gültige staged/Backup-Konfiguration geladen |
| `uninitialized` | beim Boot keine persistente Konfiguration vorhanden |
| `invalid` | persistente Kandidaten vorhanden, aber keiner vollständig gültig |
| `storage_unavailable` | persistenter Speicher beim Boot nicht verfügbar |

`last_boot.config_load_source` ist `primary`, `temporary`, `backup`, `defaults`
oder `null`. `last_boot.config_load_diagnostic` ist ein Diagnose-String oder
`null` und DARF nicht maschinell ausgewertet werden.
`last_boot.storage_generation` ist der aktuell im RAM wirksame persistente
Generationszähler als `uint32`.

Bei `config_load_status == "invalid"` oder `"storage_unavailable"` DARF das Gerät
vorhandene persistente Dateien nicht mit Defaults überschreiben. Der Adapter MUSS
den Zustand als Recovery-/Servicefall anzeigen und DARF keine automatische
Konfigurationsschreiboperation auslösen. `PUT /config`, `POST /pairing/start` und
`POST /pairing/confirm` ergeben in diesem Zustand
`CONFIG_RECOVERY_REQUIRED`, bis die Daten außerhalb des normalen HDP-Ablaufs
wiederhergestellt oder per bestätigtem Factory Reset gelöscht wurden.

## 11. Pairing und Binding

### 11.1 Verbindlicher Ablauf

Der Adapter MUSS:

1. einen Datensatz mit `device_id`, `instance_id`, `adapter_nonce` und
   `binding_key` im lokalen Zustand `pending` dauerhaft speichern;
2. `POST /pairing/start` senden;
3. `POST /pairing/confirm` senden;
4. die empfangene `binding_id` lokal nach Abschnitt 4.5 berechnen und vergleichen;
5. `/pairing/status` mit beiden Binding-Headern abfragen;
6. den lokalen Zustand nur bei `binding_status == "match"` auf `active` setzen.

Das Gerät DARF `paired` erst melden, nachdem Owner-ID und Binding-Key erfolgreich
atomar persistiert wurden.

### 11.2 `POST /api/v1/pairing/start`

Request:

```json
{
  "instance_id": "homeess-main",
  "protocol_version": "1.0-draft",
  "adapter_nonce": "0123456789abcdef0123456789abcdef"
}
```

Response HTTP 201:

```json
{
  "ok": true,
  "data": {
    "pairing_session": "11111111111111111111111111111111",
    "adapter_nonce": "0123456789abcdef0123456789abcdef",
    "device_nonce": "22222222222222222222222222222222",
    "expires_in_ms": 120000,
    "security_profile": "local-binding-key-v1"
  }
}
```

Regeln:

- Die Session ist 120000 ms ab Erstellung gültig.
- Die noch unbestätigte Session ist flüchtig und MUSS bei jedem Geräteneustart
  ungültig werden. Ein Confirm für eine dadurch verlorene Session ergibt
  `PAIRING_SESSION_EXPIRED`, solange noch kein identisches Binding persistent
  aktiv ist.
- Sie ist an `instance_id` und `adapter_nonce` gebunden.
- Wiederholung mit identischer `instance_id` und identischer `adapter_nonce`
  innerhalb der Laufzeit MUSS dieselbe Session und denselben `device_nonce`
  zurückgeben; `expires_in_ms` enthält dabei die verbleibende Laufzeit.
- Eine andere Startanforderung während einer aktiven Session ergibt
  `PAIRING_IN_PROGRESS`.
- Ein bereits gekoppeltes Gerät ergibt `ALREADY_PAIRED`; `error.details` MUSS die
  aktuelle öffentliche `binding_id` enthalten.

### 11.3 `POST /api/v1/pairing/confirm`

Request:

```json
{
  "pairing_session": "11111111111111111111111111111111",
  "instance_id": "homeess-main",
  "adapter_nonce": "0123456789abcdef0123456789abcdef",
  "device_nonce": "22222222222222222222222222222222",
  "binding_key": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Response HTTP 200:

```json
{
  "ok": true,
  "data": {
    "paired": true,
    "device_id": "hdp-esp8266-a1b2c3",
    "instance_id": "homeess-main",
    "binding_id": "e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e"
  }
}
```

Regeln:

- Alle vier Sessionwerte MÜSSEN exakt mit `/pairing/start` übereinstimmen.
- Die Persistierung von Owner und Key MUSS vor der Erfolgsantwort abgeschlossen
  sein.
- Danach MUSS die Session ungültig werden.
- Geht die Erfolgsantwort verloren, MUSS eine Wiederholung mit denselben Werten
  idempotent dieselbe Erfolgsantwort liefern.
- Eine Wiederholung mit abweichender Instanz oder abweichendem Key ergibt
  `ALREADY_PAIRED`.
- Ist dasselbe Binding bereits persistent aktiv, MÜSSEN abweichende oder nicht mehr
  bekannte Session- und Nonce-Werte ignoriert werden, sofern `instance_id` und
  `binding_key` exakt passen. Dies ermöglicht die Wiederaufnahme nach einem
  Geräteneustart zwischen Persistierung und empfangener Erfolgsantwort.
  Alle Felder MÜSSEN trotzdem ihre in Abschnitt 4 definierte Syntax besitzen.
- Nach `PAIRING_SESSION_EXPIRED` MUSS der Adapter zuerst `/pairing/status` mit
  seinem persistenten Pending-Binding abfragen. Bei `match` aktiviert er dieses
  lokal; nur bei `unpaired` beginnt er mit neu erzeugtem `adapter_nonce` und neuer
  Session erneut. Bei `conflict` bricht er mit Eigentümerkonflikt ab.

### 11.4 `GET /api/v1/pairing/status`

Request-Body: keiner.

Die Header `X-HDP-Instance` und `X-HDP-Binding-Key` sind entweder beide vorhanden
oder beide abwesend. Nur einer der Header ergibt
`INCOMPLETE_BINDING_CREDENTIALS`.

Response ohne Credentials bei gekoppeltem Gerät:

```json
{
  "ok": true,
  "data": {
    "pairing_state": "paired",
    "paired": true,
    "binding_id": "e0e77a507412b120f6ede61f62295b1a7b2ff19d3dcc8f7253e51663470c888e",
    "binding_status": "not_checked",
    "paired_to_requester": null
  }
}
```

Mit Credentials ist `binding_status`:

| Gerätezustand | Credentials | `binding_status` | `paired_to_requester` |
|---|---|---|---|
| ungekoppelt | keine | `unpaired` | `null` |
| ungekoppelt | vollständig | `unpaired` | `false` |
| gekoppelt | keine | `not_checked` | `null` |
| gekoppelt | Owner und Key korrekt | `match` | `true` |
| gekoppelt | Owner oder Key falsch | `conflict` | `false` |

### 11.5 Verbindliche Wiederherstellungsmatrix

| Adapterzustand | Gerätestatus | Adapteraktion |
|---|---|---|
| kein Datensatz | `unpaired` | Pairing darf angeboten werden |
| kein Datensatz | `paired/not_checked` | als fremd anzeigen; nicht automatisch übernehmen |
| `pending` | `unpaired` | Pairing mit neuer Session fortsetzen |
| `pending` | `match` | lokalen Datensatz auf `active` setzen |
| `pending` | `conflict` | lokalen Pending-Datensatz verwerfen; Konflikt anzeigen |
| `active` | `match` | normal verbinden |
| `active` | `unpaired` | lokalen Datensatz deaktivieren; neu koppeln anbieten |
| `active` | `conflict` | lokalen Datensatz deaktivieren; Eigentümerkonflikt anzeigen |

Kein Konfliktfall DARF durch Überschreiben des Geräte-Bindings behoben werden.

## 12. Hardwarekonfiguration

### 12.1 Konfigurationsobjekt

```json
{
  "revision": 4,
  "device_type": "percentage_indicator",
  "outputs": [
    {
      "output_id": "main",
      "output_type": "argb_strip",
      "pin": 4,
      "pixel_count": 10,
      "driver": "WS2812",
      "color_order": "GRB",
      "reverse": false,
      "maximum_brightness_percent": 35,
      "maximum_current_milliamps": 500,
      "current_per_pixel_milliamps": 60,
      "offline_mode": "retain_last_frame"
    }
  ]
}
```

Für `binary_io` lautet dasselbe vollständige Konfigurationsobjekt alternativ:

```json
{
  "revision": 7,
  "device_type": "binary_io",
  "pins": [
    { "pin": 4, "direction": "input", "input_type": "switch" },
    { "pin": 5, "direction": "input", "input_type": "button" },
    { "pin": 12, "direction": "output" }
  ]
}
```

Für `argb_output` enthält dasselbe Objekt **beide** Abschnitte: `outputs`
beschreibt den Strang, `pins` die Binary-Rollen aller übrigen GPIOs.

```json
{
  "revision": 11,
  "device_type": "argb_output",
  "outputs": [ { "output_id": "main", "pin": 4, "…": "…" } ],
  "pins": [
    { "pin": 0, "direction": "input", "input_type": "button" },
    { "pin": 1, "direction": "input", "input_type": "switch" },
    { "pin": 15, "direction": "output" },
    { "pin": 16, "direction": "output" }
  ]
}
```

Für `percentage_indicator` steht ausschließlich `outputs`, für `binary_io`
ausschließlich `pins`.

### 12.2 Feldregeln

| Feld | Typ | Erlaubte Werte |
|---|---|---|
| `revision` | uint32 | nur Response |
| `device_type` | string | Eintrag aus `manifest.device_types` |
| `outputs` | array | 1…`limits.maximum_outputs` vollständige Objekte |
| `outputs[].output_id` | string | 1…32 Zeichen aus `A-Z`, `a-z`, `0-9`, `.`, `_`, `-`; innerhalb der Konfiguration eindeutig |
| `outputs[].output_type` | string | Eintrag aus `manifest.output_types` |
| `outputs[].pin` | uint8 | Eintrag aus `hardware_capabilities.argb_pins` |
| `outputs[].pixel_count` | uint16 | 1…`limits.maximum_led_count` |
| `outputs[].driver` | string | Eintrag aus `hardware_capabilities.led_types` |
| `outputs[].color_order` | string | Eintrag aus `hardware_capabilities.color_orders` |
| `outputs[].reverse` | boolean | `true`, `false` |
| `outputs[].maximum_brightness_percent` | uint8 | 0…100 |
| `outputs[].maximum_current_milliamps` | uint16 | 1…20000 |
| `outputs[].current_per_pixel_milliamps` | uint8 | 1…100 |
| `outputs[].offline_mode` | string | `retain_last_frame`, `clear`, `continue_timeline` |

Für `binary_io` gelten zusätzlich beziehungsweise anstelle von `outputs`:

| Feld | Typ | Erlaubte Werte |
|---|---|---|
| `pins` | array | 1…`limits.maximum_binary_pins` vollständige Objekte |
| `pins[].pin` | uint8 | eindeutiger Eintrag aus `hardware_capabilities.binary_pins` |
| `pins[].direction` | string | `input`, `output` |
| `pins[].input_type` | string | bei `input` Pflicht: `switch`, `button`; bei `output` verboten |

#### 12.2.1 Feste GPIO-Belegung bei `argb_output`

Bei `binary_io` ist die Pinbelegung frei. Bei `argb_output` ist sie es NICHT:
Sie folgt zwingend der Hardware, damit am Gerät außer dem Datenpin nichts zu
entscheiden bleibt. Es gilt genau eine Regel, abgeleitet allein aus
`hardware_capabilities.binary_pins` und `binary_pullup_pins`:

| GPIO | Rolle |
|---|---|
| in `binary_pins`, nicht in `binary_pullup_pins` | fest `output` — ohne nutzbaren internen Pull-up taugt er nicht als aktiv-low-Eingang, wohl aber zum Schalten von Relais oder Schützen |
| `outputs[0].pin` | ARGB-Datenleitung; MUSS in `binary_pullup_pins` enthalten sein und DARF in `pins` nicht vorkommen |
| alle übrigen aus `binary_pins` | `input` mit frei wählbarem `input_type` |

`pins` MUSS deshalb jeden Eintrag aus `binary_pins` außer dem Datenpin genau
einmal in der vorgeschriebenen Richtung enthalten. Eine unvollständige Liste,
eine abweichende Richtung oder ein Datenpin ohne Pull-up MÜSSEN mit
`INVALID_CONFIGURATION` abgelehnt werden — eine Lücke wäre eine stille
Fehlbelegung. Der Adapter leitet die Liste ab, statt sie erfragen zu lassen;
das Gerät prüft sie gegen dieselbe Regel.

Ein `argb_output`-Gerät verarbeitet damit sowohl die `output.*`- als auch die
`binary.*`-Nachrichten seines Laufzeitprofils. Welche Nachrichten ein Gerät
annimmt, folgt dem konfigurierten `device_type`; welche es überhaupt beherrscht,
steht in `features`.

`device_type` wählt ausschließlich die generische Laufzeitschicht. Jede darüber
hinausgehende Semantik bleibt beim Adapter. Ein Gerätetypwechsel MUSS persistent
gespeichert werden. Wechselt dabei auch das Laufzeitprofil, MUSS das Gerät den
neuen Typ durch einen Neustart aktivieren; die bisher aktive Laufzeitschicht
DARF nicht im laufenden Betrieb mit der neuen Pinbelegung vermischt werden.
Bleibt das Laufzeitprofil gleich — etwa zwischen `percentage_indicator` und
`argb_output` —, gilt der Wechsel wie jede andere Konfigurationsänderung: Er
wird sofort übernommen und über `config.changed` bekanntgegeben, ein Neustart
wäre hier eine grundlose Unterbrechung.

HDP 1.0-draft definiert für `output_type=argb_strip` ausschließlich
`driver=WS2812`. Pixelindizes auf dem Wire sind immer logische Indizes
`0…pixel_count-1`. Bei `reverse=false` entspricht der logische Index dem
physischen Index; bei `reverse=true` gilt:

```text
physischer_index = pixel_count - 1 - logischer_index
```

Offline-Verhalten:

| Wert | Verbindliche Wirkung beim Übergang zu `offline` |
|---|---|
| `retain_last_frame` | aktive Timeline stoppen und den zuletzt physisch ausgegebenen Frame unverändert halten |
| `clear` | aktive Timeline stoppen und alle Pixel unverzüglich auf `0,0,0` setzen |
| `continue_timeline` | eine bereits laufende, als Loop gestartete Timeline ohne Adapterverbindung lokal fortsetzen; sonst letzten Frame halten |

Bei Neustart sind Pixelpuffer und Timelines verloren; jeder Ausgang startet
schwarz. Nach `session.ready` MUSS der Adapter den gewünschten absoluten Frame
ersetzen oder eine vollständig hochgeladene Timeline starten. Eine
anwendungsspezifische Offline-Anzeige kann ausschließlich als zuvor gestartete
Loop-Timeline in Verbindung mit `continue_timeline` realisiert werden.

Binary-Eingänge verwenden `INPUT_PULLUP`; logisch `state=true` bedeutet deshalb
einen elektrisch nach GND gezogenen, aktiven Eingang. Das Gerät MUSS sowohl
Flanken zum aktiven als auch zum inaktiven Zustand 30 ms entprellen. Schalter
erzeugen nach stabiler Änderung ein Ereignis; Taster erzeugen nur beim stabilen
Übergang auf aktiv ein `pressed`-Ereignis. Binary-Ausgänge MÜSSEN beim Booten,
bei Controllerverlust und während eines Gerätetypwechsels logisch `false`/LOW
sein. Invertierung gehört ausschließlich in das Adapter-Binding.

### 12.3 `GET /api/v1/config`

Response:

```json
{
  "ok": true,
  "data": {
    "revision": 4,
    "device_type": "percentage_indicator",
    "outputs": [
      {
        "output_id": "main",
        "output_type": "argb_strip",
        "pin": 4,
        "pixel_count": 10,
        "driver": "WS2812",
        "color_order": "GRB",
        "reverse": false,
        "maximum_brightness_percent": 35,
        "maximum_current_milliamps": 500,
        "current_per_pixel_milliamps": 60,
        "offline_mode": "retain_last_frame"
      }
    ]
  }
}
```

Revision `0` bedeutet, dass noch keine explizite Hardwarekonfiguration gespeichert
wurde. `GET /config` liefert auch dann das vollständige wirksame Defaultobjekt.
Das erste Schreiben verwendet `expected_revision: 0` und erzeugt Revision `1`.

### 12.4 `PUT /api/v1/config`

Request:

```json
{
  "expected_revision": 4,
  "config": {
    "device_type": "percentage_indicator",
    "outputs": [
      {
        "output_id": "main",
        "output_type": "argb_strip",
        "pin": 4,
        "pixel_count": 10,
        "driver": "WS2812",
        "color_order": "GRB",
        "reverse": false,
        "maximum_brightness_percent": 35,
        "maximum_current_milliamps": 500,
        "current_per_pixel_milliamps": 60,
        "offline_mode": "retain_last_frame"
      }
    ]
  }
}
```

Regeln:

- `expected_revision` und `config` sind Pflichtfelder.
- `expected_revision` MUSS der aktuell gespeicherten Revision entsprechen.
- Der Request MUSS eine vollständige Konfiguration enthalten; partielle Updates
  sind nicht erlaubt.
- Validierung und Hardwareinitialisierung MÜSSEN vor der Persistierung erfolgreich
  sein.
- Der zu speichernde Kandidat MUSS exakt die aktuelle Revision plus 1 enthalten.
- Konfiguration und neue Revision MÜSSEN in einer atomaren Transaktion gespeichert
  werden.
- Erst nach erfolgreicher Persistierung dürfen neue Revision und Inhalt nach außen
  sichtbar werden und die Erfolgsantwort gesendet werden.
- Bleibt `device_type` unverändert, MUSS nach Erfolg `config.changed` per
  WebSocket gesendet und mDNS aktualisiert werden.
- Ändert sich `device_type`, MUSS das Gerät erst die Erfolgsantwort vollständig
  senden und 500…2000 ms danach neu starten. Die bestehende WebSocket-Sitzung
  endet dabei; das neue `runtime_profile` wird erst nach dem Boot per mDNS,
  `/device`, `/manifest` und neuem Hello sichtbar.
- Nach erfolgreicher Pixel-Konfigurationsänderung MUSS das Gerät aktive Timelinewiedergaben stoppen,
  alle hochgeladenen Timelines verwerfen und sämtliche neu konfigurierten
  Ausgänge schwarz initialisieren. Ein fehlgeschlagener PUT DARF den bisherigen
  Frame, die bisherige Konfiguration oder das Binding nicht verändern.

Bei Revisionskonflikt:

```json
{
  "ok": false,
  "error": {
    "code": "CONFIG_REVISION_CONFLICT",
    "message": "Configuration revision does not match.",
    "details": {
      "expected_revision": 4,
      "current_revision": 5
    }
  }
}
```

### 12.5 Verlorene Konfigurationsantwort

Nach Timeout eines `PUT /config` DARF der Adapter nicht blind erneut schreiben.
Er MUSS `GET /config` ausführen:

- Revision um 1 erhöht und Inhalt identisch: ursprünglicher Request war erfolgreich.
- Revision unverändert: Request darf mit gleichem `expected_revision` wiederholt werden.
- Andere Revision oder anderer Inhalt: Konflikt anzeigen und Benutzerentscheidung
  verlangen.

### 12.6 Verbindliche RGB- und Schutzregeln

Alle Frame- und Timelineformate verwenden unabhängig von `color_order` exakt
drei Nutzbytes pro Pixel in der Reihenfolge Rot, Grün, Blau. Das Gerät setzt
erst im Hardwaretreiber auf die physische Byteanordnung um. Jeder Nutzwert ist
ein `uint8` von 0 bis 255; es gibt keinen impliziten Alpha-, Prozent-,
Gamma- oder Helligkeitskanal.

Der Adapter berechnet sämtliche semantischen Helligkeiten bereits in diese
RGB-Nutzwerte ein. Das Gerät wendet anschließend ausschließlich die
hardwarebezogenen Schutzgrenzen an. Für einen Frame mit `N` Pixeln gilt:

```text
helligkeitsfaktor = maximum_brightness_percent / 100

rohstrom_mA =
  summe(i = 0 … N-1,
        current_per_pixel_milliamps
        × (r_i + g_i + b_i) / (3 × 255)
        × helligkeitsfaktor)
```

Liegt `rohstrom_mA` über `maximum_current_milliamps`, MUSS das Gerät alle
RGB-Komponenten des Frames zusätzlich mit demselben Faktor

```text
maximum_current_milliamps / rohstrom_mA
```

skalieren. Nach jeder Multiplikation wird auf den nächsten `uint8` gerundet und
auf 0…255 begrenzt. Dadurch bleiben Farben proportional. Frame- und
Timelineoperationen arbeiten immer auf den unskalierten logischen RGB-Werten;
die Schutzskalierung wird erst für die physische Ausgabe berechnet und verändert
den logischen Pixelpuffer nicht.

Das Gerät DARF keine weitere anwendungsspezifische Interpolation hinzufügen.
Zeitliche Zwischenwerte müssen vom Adapter als Frame oder Timelineereignis
vollständig vorgegeben werden.

## 13. Entkopplung, Neustart und Factory Reset

### 13.1 `POST /api/v1/unpair`

Authentifizierung: A.

Request:

```json
{
  "preserve_hardware_config": true
}
```

Nur `true` ist in HDP 1.0-draft zulässig.

Response HTTP 202:

```json
{
  "ok": true,
  "data": {
    "hardware_config_retained": true,
    "restart_required": true
  }
}
```

Vor der Response MUSS das Gerät Owner-ID, Binding-Key und WLAN-Zugangsdaten atomar
löschen. Hardwarekonfiguration und `device_id` bleiben erhalten. Das Gerät startet
500…2000 ms nach der Response neu. Eine aktive WebSocket-Sitzung MUSS unmittelbar
nach erfolgreicher Persistierung geschlossen werden; über das alte Binding dürfen
keine weiteren Laufzeitwerte angenommen werden.

### 13.2 `POST /api/v1/restart`

Request:

```json
{}
```

Response HTTP 202:

```json
{
  "ok": true,
  "data": {
    "restart_required": true
  }
}
```

Das Gerät startet 500…2000 ms nach der Response neu. Der Adapter DARF diesen
Endpoint nach einem Response-Timeout nicht automatisch wiederholen.

### 13.3 `POST /api/v1/factory-reset`

Dieser Endpoint ist ausschließlich im Betriebszustand `recovery_portal` zulässig.

Request:

```json
{
  "confirmation": "hdp-esp8266-a1b2c3"
}
```

`confirmation` MUSS exakt der aktuellen `device_id` entsprechen.

Response HTTP 202:

```json
{
  "ok": true,
  "data": {
    "factory_reset": true,
    "restart_required": true
  }
}
```

Das Gerät MUSS sämtliche persistenten Werte löschen und nach 500…2000 ms neu
starten. Aktive WebSocket-Sitzungen und das alte Binding werden unmittelbar nach
erfolgreichem Löschen unwirksam. Außerhalb des Recovery-Modus ergibt der Endpoint
`FACTORY_RESET_NOT_ALLOWED`.

## 14. WebSocket-Protokoll

### 14.1 Verbindung

- URI: `ws://<device-ip>:<ws_port>/api/v1/ws`
- RFC-6455-Version: 13
- Authentifizierung: HTTP Basic
- Benutzername: `instance_id`
- Passwort: `binding_key`
- Base64-Eingabe: UTF-8-Bytes von `<instance_id>:<binding_key>`
- maximal eine aktive Steuersitzung pro Gerät

Der Request-Header lautet exakt:

```http
Authorization: Basic <base64-token>
```

`<base64-token>` verwendet das Standardalphabet aus RFC 4648 einschließlich
erforderlicher `=`-Paddingzeichen. Innerhalb des Tokens sind CR, LF,
Leerzeichen und Zeilenfaltung unzulässig. Insbesondere darf ein Encoder lange
HDP-Credentials nicht nach 72 Zeichen umbrechen.

Eine neue gültig authentifizierte Steuersitzung ersetzt eine bestehende Sitzung.
Die alte Sitzung erhält `SESSION_REPLACED` und wird danach geschlossen.

Ungültige Credentials MÜSSEN den HTTP-Upgrade mit 401 ablehnen.
Die 401-Antwort MUSS syntaktisch gültiges HTTP/1.1 sein, den Header
`WWW-Authenticate: Basic realm="homeESS HDP"` enthalten und ihre Headersektion
mit `\r\n\r\n` abschließen. Falls ein Body gesendet wird, MUSS
`Content-Length` dessen exakter Bytezahl entsprechen. Eine bodylose Antwort
verwendet `Content-Length: 0`.

### 14.2 Nachrichten-Envelope

Jede Textnachricht MUSS dieses Envelope besitzen:

```json
{
  "type": "output.frame.set",
  "message_id": "adapter-42",
  "sequence": 42,
  "payload": {}
}
```

- Binärframes sind nicht erlaubt.
- Die maximale Textgröße ist
  `manifest.limits.maximum_websocket_message_bytes` UTF-8-Bytes.
- Jede HDP-Nachricht MUSS als einzelner, nicht fragmentierter RFC-6455-Textframe
  übertragen werden. Fragmentierte Datenframes sind in diesem Profil nicht
  zulässig und ergeben `INVALID_REQUEST`; danach wird die Verbindung geschlossen.
- Binäre Frame- und Timeline-Nutzdaten werden innerhalb des JSON-Envelopes mit
  dem Standardalphabet aus RFC 4648 Base64-kodiert. CR, LF, Leerzeichen,
  URL-safe Alphabet und fehlendes oder überflüssiges Padding sind unzulässig.
- `sequence` ist ein `uint32`.
- Jede Richtung besitzt eine unabhängige Sequenz.
- Die erste Sequenz jedes Senders ist 1.
- Jede weitere Sequenz ist exakt vorherige Sequenz + 1.
- Ein Sprung, Duplikat oder Rücklauf ergibt `SEQUENCE_ERROR`; danach wird die
  Verbindung geschlossen.
- Sequenzen beginnen nach jeder neuen WebSocket-Verbindung wieder bei 1.
- Vor dem Senden einer Sequenz nach `4294967295` MUSS der Sender die Verbindung
  schließen und neu aufbauen; ein Wrap auf 0 ist unzulässig.

### 14.3 Sitzungsaufbau

Unmittelbar nach dem Upgrade sendet das Gerät:

```json
{
  "type": "device.hello",
  "message_id": "device-1",
  "sequence": 1,
  "payload": {
    "device_id": "hdp-esp8266-a1b2c3",
    "protocol_version": "1.0-draft",
    "runtime_profile": "pixel-timeline-v1",
    "config_revision": 4,
    "heartbeat_interval_ms": 15000,
    "heartbeat_timeout_ms": 45000
  }
}
```

Der Adapter MUSS innerhalb von 5000 ms antworten:

```json
{
  "type": "homeess.hello",
  "message_id": "adapter-1",
  "sequence": 1,
  "payload": {
    "instance_id": "homeess-main",
    "protocol_version": "1.0-draft",
    "runtime_profile": "pixel-timeline-v1"
  }
}
```

Das Gerät antwortet:

```json
{
  "type": "session.ready",
  "message_id": "device-2",
  "sequence": 2,
  "payload": {
    "config_revision": 4,
    "runtime_profile": "pixel-timeline-v1"
  }
}
```

Die Beispiele zeigen `pixel-timeline-v1`. Für ein als `binary_io`
konfiguriertes Gerät steht an allen drei Stellen stattdessen exakt
`binary-io-v1`. Ein Profilmix innerhalb derselben Sitzung ist unzulässig.

Vor `session.ready` DARF der Adapter keine Laufzeitwerte senden. Fehler oder Timeout
schließen die Verbindung. Die Fehlerzuordnung ist:

| Verletzung | Code |
|---|---|
| innerhalb 5000 ms keine vollständige Nachricht | `SESSION_HELLO_TIMEOUT` |
| erste Nachricht ist kein vollständiges `homeess.hello` | `INVALID_REQUEST` |
| `instance_id` stimmt nicht mit dem Binding überein | `AUTH_REQUIRED` |
| `protocol_version` stimmt nicht | `UNSUPPORTED_PROTOCOL_VERSION` |
| `runtime_profile` stimmt nicht | `UNSUPPORTED_RUNTIME_PROFILE` |

Weicht `config_revision` in `device.hello` oder `session.ready` von der lokal
bekannten Revision ab, MUSS der Adapter vor der nächsten mutierenden
`output.*`- oder `binary.output.*`-Nachricht
`GET /config` ausführen.

### 14.4 Heartbeat

Der Adapter sendet spätestens alle 15000 ms:

```json
{
  "type": "ping",
  "message_id": "adapter-9",
  "sequence": 9,
  "payload": {}
}
```

Das Gerät antwortet mit eigenem `message_id` und eigener Sequenz:

```json
{
  "type": "pong",
  "message_id": "device-10",
  "sequence": 10,
  "payload": {
    "reply_to": "adapter-9"
  }
}
```

Empfängt das Gerät 45000 ms lang keine gültige Adapter-Nachricht, MUSS es
`HEARTBEAT_TIMEOUT` senden und die Verbindung schließen.

#### 14.4.1 Gerätetelemetrie

Nach `session.ready` sendet das Gerät frühestens nach 1000 ms und spätestens
nach 15000 ms eine aktuelle Telemetrie. Danach sendet es mindestens alle
15000 ms sowie nach einer physischen Ausgabeveränderung, jedoch höchstens
einmal pro 1000 ms:

```json
{
  "type": "device.status",
  "message_id": "device-12",
  "sequence": 12,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "wifi_rssi": -57,
    "effective_brightness": 20,
    "runtime_brightness": 100,
    "estimated_current_milliamps": 11.2,
    "power_limit_active": false
  }
}
```

`wifi_rssi` ist die aktuelle WLAN-Signalstärke in dBm oder `null`, wenn keine
WLAN-Verbindung besteht. `effective_brightness` ist ein `uint8` von 0 bis 100
und bezeichnet den tatsächlich auf RGB-Komponenten angewendeten
Helligkeitsfaktor nach Laufzeithelligkeit, konfiguriertem Helligkeits- und
Stromlimit. `runtime_brightness` spiegelt bei
`features.runtime_brightness=true` den zuletzt angewendeten Laufzeitfaktor von
0 bis 100.
`estimated_current_milliamps` ist eine nichtnegative Zahl und wird aus dem
logischen Pixelbild, `current_per_pixel_milliamps` und den aktiven Limits
berechnet; sie ist ausdrücklich keine Messung durch einen Stromsensor.
`power_limit_active` ist genau dann `true`, wenn das konfigurierte Stromlimit
den Ausgang zusätzlich dimmt.

`output_id` und `config_revision` bezeichnen den Zustand, auf den sich die
Ausgabetelemetrie bezieht. Das Ereignis verändert die physische Ausgabe nicht.

Im Profil `binary-io-v1` enthält `device.status` keine erfundene Helligkeits-
oder Stromtelemetrie, sondern ausschließlich:

```json
{
  "type": "device.status",
  "message_id": "device-12",
  "sequence": 12,
  "payload": {
    "config_revision": 7,
    "runtime_profile": "binary-io-v1",
    "wifi_rssi": -57
  }
}
```

Pinzustände werden verbindlich über Abschnitt 14.9 übertragen.

### 14.5 Direkte Frames

Direkte Frames sind für Initialzustände und seltene Änderungen vorgesehen.
Animationen DÜRFEN NICHT durch netzwerkgetaktete Folgen direkter Frames erzeugt
werden; dafür ist Abschnitt 14.6 zu verwenden.

#### 14.5.1 Absoluter Ersatzframe

```json
{
  "type": "output.frame.set",
  "message_id": "adapter-42",
  "sequence": 42,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "frame_id": "frame-17",
    "mode": "replace",
    "encoding": "rgb8-base64",
    "data": "AP8AAP8AAL8AAAAA",
    "pixels": null
  }
}
```

`data` dekodiert für vier Pixel zu:

```text
00 ff 00 | 00 ff 00 | 00 bf 00 | 00 00 00
```

Bei `mode=replace` gelten:

- `encoding` MUSS `rgb8-base64` sein;
- `data` MUSS ein kanonischer Base64-String sein;
- `pixels` MUSS `null` sein;
- die dekodierte Länge MUSS exakt `pixel_count × 3` Bytes betragen;
- die Bytes enthalten für logischen Index 0 beginnend jeweils R, G und B.

#### 14.5.2 Sparse Pixeländerung

```json
{
  "type": "output.frame.set",
  "message_id": "adapter-43",
  "sequence": 43,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "frame_id": "frame-18",
    "mode": "patch",
    "encoding": "pixel-list-v1",
    "data": null,
    "pixels": [
      {"index": 1, "r": 0, "g": 255, "b": 0},
      {"index": 2, "r": 0, "g": 191, "b": 0}
    ]
  }
}
```

Bei `mode=patch` gelten:

- `encoding` MUSS `pixel-list-v1` sein;
- `data` MUSS `null` sein;
- `pixels` MUSS ein nicht leeres Array sein;
- jeder Eintrag besitzt ausschließlich die Pflichtfelder `index`, `r`, `g`, `b`;
- `index` ist ein `uint16` innerhalb des konfigurierten Ausgangs;
- `r`, `g`, `b` sind `uint8`;
- Indizes MÜSSEN streng aufsteigend und dürfen nicht doppelt sein.

Für beide Modi gelten:

- `output_id` MUSS einen aktuell konfigurierten Ausgang bezeichnen;
- `config_revision` MUSS exakt der aktiven Revision entsprechen;
- `frame_id` folgt der Syntax von `message_id`;
- das Gerät MUSS den vollständigen Request validieren, bevor es Pixelpuffer oder
  physische Ausgabe verändert;
- ein akzeptierter Frame stoppt eine auf diesem Ausgang geplante oder laufende
  Timeline ohne `output.timeline.completed`;
- die Änderung wird atomar auf den logischen Puffer angewendet und verursacht
  höchstens eine physische Ausgabe;
- der Abstand zweier physischer Ausgaben darf
  `minimum_frame_interval_milliseconds` nicht unterschreiten.

Trifft ein direkter Frame vor Ablauf dieses Mindestabstands ein, ergibt er
`OUTPUT_RATE_LIMITED`; weder logischer Puffer noch physische Ausgabe dürfen sich
ändern. Timelines werden dagegen nach Abschnitt 14.7 schedulerseitig
aufgeholt.

Der erste mutierende Befehl eines Adapters pro Ausgang nach `session.ready`
MUSS `mode=replace` sein oder eine Timeline starten. Ein Patch ohne solchen
Baselinezustand ergibt `OUTPUT_BASE_FRAME_REQUIRED`. Dadurch hängt das Ergebnis
nicht von einem Frame einer früheren oder verlorenen Sitzung ab.

Antwort:

```json
{
  "type": "output.frame.applied",
  "message_id": "device-44",
  "sequence": 44,
  "payload": {
    "reply_to": "adapter-43",
    "output_id": "main",
    "frame_id": "frame-18",
    "config_revision": 4,
    "applied_at_uptime_milliseconds": 182340
  }
}
```

`applied_at_uptime_milliseconds` ist der `uint32`-Wert von der monotonen
Gerätezeit beim physischen Schreiben. Ein identisches `frame_id` mit
byteidentischem Payload ist innerhalb derselben Sitzung idempotent und liefert
dieselbe Erfolgsantwort. Dasselbe `frame_id` mit abweichendem Payload ergibt
`INVALID_OUTPUT_STATE`.

### 14.6 Timeline-Upload

Eine Timeline ist ein vom Adapter vollständig vorberechnetes, semantikfreies
Delta-Programm. Das Gerät interpretiert ausschließlich Zeitabstände und
Pixeloperationen.

#### 14.6.1 Upload beginnen

```json
{
  "type": "output.timeline.begin",
  "message_id": "adapter-50",
  "sequence": 50,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "timeline_id": "indicator-loop-7",
    "encoding": "hdtl-delta-v1",
    "duration_milliseconds": 10000,
    "event_count": 2,
    "program_size_bytes": 28,
    "program_sha256": "37657360dd397ea89a19031042604b6c6d7816e2f55826dc6ca050e3bd59a6ea"
  }
}
```

Alle Felder sind Pflichtfelder. `timeline_id` folgt der Syntax von
`message_id`. Größen, Ereigniszahl und Dauer müssen innerhalb der Manifestlimits
liegen; SHA-256 besteht aus exakt 64 lowercase Hexzeichen.

Das Gerät darf pro Sitzung nur einen Staging-Upload halten. Ein laufender oder
geplanter Zeitplan auf demselben Ausgang ergibt `OUTPUT_BUSY`; der Adapter MUSS
ihn zuerst stoppen oder durch einen direkten Frame ersetzen. Ein Begin mit
identischer Timeline-ID und byteidentischen Metadaten ist idempotent. Ein Begin
für eine andere Timeline oder mit abweichenden Metadaten ergibt
`TIMELINE_UPLOAD_IN_PROGRESS`.

Antwort:

```json
{
  "type": "output.timeline.ready",
  "message_id": "device-51",
  "sequence": 51,
  "payload": {
    "reply_to": "adapter-50",
    "output_id": "main",
    "timeline_id": "indicator-loop-7",
    "next_offset": 0,
    "maximum_chunk_bytes": 512
  }
}
```

#### 14.6.2 Chunks übertragen

```json
{
  "type": "output.timeline.chunk",
  "message_id": "adapter-52",
  "sequence": 52,
  "payload": {
    "timeline_id": "indicator-loop-7",
    "offset": 0,
    "data": "AAAAAAEABAD/ABQAAAACAAEAAACWAAEBAADIAA=="
  }
}
```

`offset` ist der `uint32`-Byteoffset in der dekodierten Programmnutzlast.
`data` MUSS zu 1…`maximum_chunk_bytes` Bytes dekodieren. Chunks müssen ohne
Lücke und in aufsteigender Reihenfolge eintreffen. Das Gerät MUSS Base64
dekodieren, Grenzen prüfen und die Bytes in einen vom aktiven Programm
getrennten Stagingbereich schreiben.

Antwort:

```json
{
  "type": "output.timeline.chunk.accepted",
  "message_id": "device-53",
  "sequence": 53,
  "payload": {
    "reply_to": "adapter-52",
    "timeline_id": "indicator-loop-7",
    "next_offset": 28
  }
}
```

Die exakte Wiederholung des zuletzt akzeptierten Offsets mit identischen
dekodierten Bytes ist idempotent und gibt denselben `next_offset` zurück. Jeder
andere Offset ergibt `TIMELINE_OFFSET_MISMATCH` mit `expected_offset` in
`details`. Bei WebSocket-Verlust wird ausschließlich der unvollständige
Staging-Upload verworfen; Binding, Hardwarekonfiguration, aktiver Frame und
bereits committed Timeline bleiben unverändert.

#### 14.6.3 Binärformat `hdtl-delta-v1`

Alle Mehrbyte-Integer sind unsigned und little-endian. Das Programm ist eine
lückenlose Folge von exakt `event_count` Ereignissen:

| Bestandteil | Größe | Bedeutung |
|---|---:|---|
| `delta_milliseconds` | uint32 | Abstand zum vorherigen Ereignisstart |
| `operation_count` | uint16 | Anzahl unmittelbar folgender Operationen |
| `operations` | variabel | exakt `operation_count` Operationen |

Die erste `delta_milliseconds` MUSS 0 sein. Jede weitere MUSS mindestens
`minimum_frame_interval_milliseconds` betragen. Die kumulierte Ereigniszeit muss
streng steigen und kleiner als `duration_milliseconds` bleiben.

Operationen:

| Opcode | Name | Nachfolgende Bytes |
|---:|---|---|
| `0x01` | `SET_PIXEL` | `index:uint16, r:uint8, g:uint8, b:uint8` |
| `0x02` | `SET_RUN` | `start:uint16, count:uint16, r:uint8, g:uint8, b:uint8` |
| `0x03` | `SET_RANGE_RGB` | `start:uint16, count:uint16`, danach `count × 3` RGB-Bytes |
| `0x04` | `FILL` | `r:uint8, g:uint8, b:uint8` |

`count` MUSS größer als 0 sein; jeder adressierte Index muss innerhalb des
Ausgangs liegen. Operationen eines Ereignisses werden in Wire-Reihenfolge auf
den logischen Puffer angewendet und danach mit höchstens einem physischen
Schreibvorgang ausgegeben.

Die erste Operation des ersten Ereignisses MUSS entweder `FILL` oder
`SET_RANGE_RGB` mit `start=0` und `count=pixel_count` sein. Damit definiert jede
Timeline bei Zeit 0 einen absoluten Baselineframe. Unbekannte Opcodes,
überzählige Bytes, vorzeitiges Datenende, ungültige Bereiche oder abweichende
Ereigniszahl ergeben `TIMELINE_INVALID_PROGRAM`.

Verbindlicher Testvektor für vier Pixel:

```text
Programmgröße: 28 Bytes
Base64: AAAAAAEABAD/ABQAAAACAAEAAACWAAEBAADIAA==
SHA-256: 37657360dd397ea89a19031042604b6c6d7816e2f55826dc6ca050e3bd59a6ea
```

Er dekodiert zu einem `FILL(0,255,0)` bei 0 ms und zwei `SET_PIXEL`-Operationen
bei 20 ms.

#### 14.6.4 Commit und Abbruch

Nach Übertragung aller Bytes sendet der Adapter:

```json
{
  "type": "output.timeline.commit",
  "message_id": "adapter-54",
  "sequence": 54,
  "payload": {
    "timeline_id": "indicator-loop-7"
  }
}
```

Das Gerät MUSS Größe, SHA-256 und das vollständige Binärprogramm prüfen. Erst
danach ersetzt es die bisher committed, nicht laufende Timeline dieses Ausgangs
atomar. Ein Fehler darf die vorherige Timeline nicht verändern.

Eine abweichende empfangene Bytezahl ergibt `TIMELINE_SIZE_MISMATCH`, ein
abweichender Hash `TIMELINE_CHECKSUM_MISMATCH` und ein syntaktisch oder
semantisch ungültiges Programm `TIMELINE_INVALID_PROGRAM`. Fehlt die
referenzierte Timeline beim Start, ergibt dies `TIMELINE_NOT_FOUND`.

```json
{
  "type": "output.timeline.committed",
  "message_id": "device-55",
  "sequence": 55,
  "payload": {
    "reply_to": "adapter-54",
    "output_id": "main",
    "timeline_id": "indicator-loop-7",
    "program_sha256": "37657360dd397ea89a19031042604b6c6d7816e2f55826dc6ca050e3bd59a6ea"
  }
}
```

Ein Commit derselben bereits committed Timeline-ID mit identischem SHA-256 ist
idempotent. Ein Staging-Upload kann mit `output.timeline.abort` und dem einzigen
Payloadfeld `timeline_id` verworfen werden; das Gerät antwortet mit
`output.timeline.aborted`, `reply_to` und `timeline_id`.

### 14.7 Timeline-Wiedergabe und Ausgangsstatus

#### 14.7.1 Start

```json
{
  "type": "output.timeline.play",
  "message_id": "adapter-56",
  "sequence": 56,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "timeline_id": "indicator-loop-7",
    "loop": true,
    "start_delay_milliseconds": 0
  }
}
```

`start_delay_milliseconds` ist ein `uint16` von 0 bis 60000. Ein erfolgreicher
Start ersetzt den Baselinezustand der Sitzung und liefert:

```json
{
  "type": "output.timeline.playing",
  "message_id": "device-57",
  "sequence": 57,
  "payload": {
    "reply_to": "adapter-56",
    "output_id": "main",
    "timeline_id": "indicator-loop-7",
    "loop": true,
    "scheduled_start_uptime_milliseconds": 183000
  }
}
```

Die monotone Gerätezeit ist ein wrap-fähiger `uint32`. Startverzögerungen sind
relativ zum Empfang und dienen nicht zur geräteübergreifenden Synchronisation.

Bei jeder Wiedergabe wird das erste Ereignis am Startzeitpunkt angewendet. Bei
`loop=true` beginnt am exakten Ende von `duration_milliseconds` wieder Ereignis
0; dadurch kann kein Delta aus dem vorherigen Durchlauf fortwirken. Bei
`loop=false` bleibt nach dem letzten Ereignis der letzte Frame bis zum Stopp oder
nächsten mutierenden Befehl sichtbar.

Ist der Scheduler verspätet, MUSS er alle inzwischen fälligen Ereignisse in
Reihenfolge auf den logischen Puffer anwenden, DARF aber nur den daraus
resultierenden neuesten Frame physisch schreiben. Die Timelinezeit läuft von
der geplanten Startzeit weiter und darf nicht durch Netzwerk- oder
Renderverzögerungen dauerhaft verschoben werden.

#### 14.7.2 Stopp

```json
{
  "type": "output.timeline.stop",
  "message_id": "adapter-58",
  "sequence": 58,
  "payload": {
    "output_id": "main",
    "timeline_id": "indicator-loop-7",
    "behavior": "hold"
  }
}
```

`behavior` ist `hold` oder `clear`. Der Stopp ist idempotent.
`output.timeline.stopped` spiegelt `reply_to`, `output_id`, `timeline_id` und
`behavior`. Eine nicht geloopte Timeline sendet nach Erreichen ihrer Dauer
einmal `output.timeline.completed` mit `output_id` und `timeline_id`; der letzte
Frame bleibt sichtbar.

#### 14.7.3 Status

Der Adapter fragt ab:

```json
{
  "type": "output.status.get",
  "message_id": "adapter-60",
  "sequence": 60,
  "payload": {
    "output_id": "main"
  }
}
```

Das Gerät antwortet:

```json
{
  "type": "output.status",
  "message_id": "device-61",
  "sequence": 61,
  "payload": {
    "reply_to": "adapter-60",
    "output_id": "main",
    "config_revision": 4,
    "mode": "timeline_playing",
    "frame_id": null,
    "timeline_id": "indicator-loop-7",
    "loop": true,
    "position_milliseconds": 3250
  }
}
```

`mode` ist `idle`, `frame`, `timeline_scheduled` oder `timeline_playing`.
`frame_id` ist nur bei `frame` ein String. `timeline_id`, `loop` und
`position_milliseconds` sind nur in den beiden Timelinemodi nicht `null`.
Der Status verändert die Ausgabe nicht.

#### 14.7.4 Laufzeithelligkeit

Wenn `features.runtime_brightness=true` ist, sendet der Adapter die dynamische
Plugin-Helligkeit getrennt vom logischen RGB-Puffer:

```json
{
  "type": "output.brightness.set",
  "message_id": "adapter-62",
  "sequence": 62,
  "payload": {
    "output_id": "main",
    "config_revision": 4,
    "brightness_percent": 72
  }
}
```

`brightness_percent` ist ein `uint8` von 0 bis 100. Das Gerät multipliziert
diesen Laufzeitfaktor mit dem konfigurierten Helligkeits- und Stromlimit erst
beim physischen Rendern. Der logische RGB-Puffer sowie Frame-, Timeline- und
Schedulerzustand dürfen dadurch nicht verändert werden.

Das Gerät bestätigt mit `output.brightness.applied`; der Payload enthält
`reply_to`, `output_id`, `config_revision`, `brightness_percent` und
`applied_at_uptime_milliseconds`. `device.status.runtime_brightness` spiegelt
den aktiven Laufzeitfaktor. `effective_brightness` enthält bei dieser Capability
bereits den resultierenden Gesamtfaktor einschließlich Laufzeithelligkeit.

### 14.8 `config.changed`

Nach erfolgreichem `PUT /config` sendet das Gerät:

```json
{
  "type": "config.changed",
  "message_id": "device-44",
  "sequence": 44,
  "payload": {
    "config_revision": 5
  }
}
```

Bei aktiver Sitzung MUSS genau ein Ereignis gesendet werden. Ohne aktive Sitzung
geht der Hinweis verloren; die Revision in `device.hello` übernimmt beim nächsten
Verbindungsaufbau die Synchronisation. Der Adapter MUSS nach dem Ereignis
`GET /config` ausführen.

RFC-6455-Ping/Pong-Control-Frames DÜRFEN jederzeit zusätzlich verwendet werden,
auch zwischen Upgrade und `homeess.hello`. Ein Ping MUSS nach RFC 6455 mit einem
Pong beantwortet werden; ein Pong MUSS ohne HDP-Fehler akzeptiert werden.
Control-Frames besitzen kein HDP-Envelope, verbrauchen keine HDP-Sequenz und
setzen weder den 5000-ms-Hello-Timeout noch den in Abschnitt 14.4 definierten
Anwendungs-Heartbeat zurück.

### 14.9 Binary-I/O

Alle Nachrichten dieses Abschnitts sind ausschließlich bei aktivem
`binary-io-v1` erlaubt. GPIO-Nummern beziehen sich direkt auf die eindeutigen
`pins[].pin`-Werte der aktiven Konfigurationsrevision.

#### 14.9.1 Eingangssnapshot

Frühestens 1000 ms und spätestens 2000 ms nach `session.ready` sendet das Gerät
genau einen entprellten Eingangssnapshot:

```json
{
  "type": "binary.input.snapshot",
  "message_id": "device-3",
  "sequence": 3,
  "payload": {
    "config_revision": 7,
    "captured_at_uptime_milliseconds": 1842,
    "inputs": [
      { "pin": 4, "input_type": "switch", "state": false },
      { "pin": 5, "input_type": "button", "state": true }
    ],
    "outputs": [
      { "pin": 12, "state": false }
    ]
  }
}
```

Vor diesem Snapshot sendet das Gerät in der neuen Sitzung keine
`binary.input.event`-Nachricht. Der Snapshot ist der Abgleichpunkt; offline oder
vor dem Snapshot aufgetretene Tasterereignisse werden nicht gepuffert.

#### 14.9.2 Aktive Eingangsereignisse

Nach jeder entprellten Schalteränderung sendet das Gerät:

```json
{
  "type": "binary.input.event",
  "message_id": "device-8",
  "sequence": 8,
  "payload": {
    "pin": 4,
    "input_type": "switch",
    "event": "changed",
    "state": true,
    "event_sequence": 19,
    "occurred_at_uptime_milliseconds": 15220,
    "config_revision": 7
  }
}
```

Ein Taster sendet nur für den entprellten aktiven Übergang ein Ereignis mit
`input_type="button"`, `event="pressed"` und `state=true`. Das Loslassen wird
entprellt und intern übernommen, erzeugt aber kein Ereignis.

`event_sequence` ist ein bootlokaler, bei 1 beginnender `uint32`-Zähler der
erkannten Ereignisse. Beobachtete Lücken sind zulässig; der Zähler ist keine
Exactly-once-Zustellgarantie und wird nach einem Boot zurückgesetzt. Der Adapter
MUSS `config_revision`, Pinrichtung und Eingangstyp prüfen, bevor er das Ereignis
verarbeitet.

Topics, Toggle-/Set-/Counterregeln, Zielwerte, Skalierungen und sonstige
Automationssemantik sind ausdrücklich kein Bestandteil des Wire-Payloads. Sie
MÜSSEN ausschließlich im Adapter gespeichert und ausgeführt werden.

#### 14.9.3 Ausgang setzen

Der Adapter setzt einen Ausgang mit:

```json
{
  "type": "binary.output.set",
  "message_id": "adapter-12",
  "sequence": 12,
  "payload": {
    "pin": 12,
    "state": true,
    "config_revision": 7
  }
}
```

Nach physischer Übernahme antwortet das Gerät:

```json
{
  "type": "binary.output.applied",
  "message_id": "device-13",
  "sequence": 13,
  "payload": {
    "reply_to": "adapter-12",
    "pin": 12,
    "state": true,
    "config_revision": 7,
    "applied_at_uptime_milliseconds": 16640
  }
}
```

Die Bestätigung MUSS den tatsächlich ausgegebenen logischen Zustand enthalten.
Der Adapter DARF den Befehl nur an einen als `output` konfigurierten Pin senden.

#### 14.9.4 Statusabfrage

`binary.status.get` verwendet ein leeres Payloadobjekt. Das Gerät antwortet mit
`binary.status`; dessen Payload entspricht `binary.input.snapshot`, enthält
zusätzlich `reply_to` und listet sowohl Eingänge als auch Ausgänge. Die Abfrage
verändert keinen Pin.

#### 14.9.5 Fehler und Offline-Verhalten

- unbekannter Pin: `BINARY_PIN_NOT_FOUND`;
- als Eingang konfigurierter Zielpin: `BINARY_PIN_DIRECTION_MISMATCH`;
- falsche Revision: `BINARY_CONFIG_REVISION_MISMATCH`;
- mutierender Ausgangsbefehl während OTA: `DEVICE_BUSY`.

Bei Verlust der aktiven Steuersitzung setzt das Gerät alle Binary-Ausgänge ohne
weitere Wire-Nachricht auf `false`. Nach der nächsten Sitzung MUSS der Adapter
aus seinen Topicwerten erneut absolute Ausgangszustände senden.

### 14.10 OTA-Ereignisse

Erlaubte Typen:

```text
firmware.update.started
firmware.update.progress
firmware.update.verifying
firmware.update.ready
firmware.update.failed
firmware.update.completed
```

OTA-Ereignisse sind Best-Effort-Hinweise auf einer gerade aktiven Sitzung.
`GET /firmware/status` ist immer maßgeblich. Insbesondere kann
`firmware.update.completed` wegen des Neustarts vor dem Aufbau der neuen
WebSocket-Sitzung verloren gehen.

Jedes OTA-Ereignis verwendet dieses Payload:

```json
{
  "type": "firmware.update.progress",
  "message_id": "device-51",
  "sequence": 51,
  "payload": {
    "target_version": "0.3.0",
    "received_bytes": 241152,
    "total_bytes": 482304,
    "progress_percent": 50,
    "error_code": null,
    "message": null
  }
}
```

`target_version` ist `string|null`; die Bytewerte sind `uint32`;
`progress_percent` ist `uint8` im Bereich 0…100. `error_code` und `message` sind
nur bei `firmware.update.failed` Strings, sonst `null`.

### 14.11 WebSocket-Fehler

```json
{
  "type": "error",
  "message_id": "device-52",
  "sequence": 52,
  "payload": {
    "reply_to": "adapter-50",
    "code": "TIMELINE_OFFSET_MISMATCH",
    "message": "Timeline chunk offset does not match.",
    "details": {
      "expected_offset": 512
    }
  }
}
```

`reply_to` ist die `message_id` des verursachenden Requests oder `null`, wenn kein
einzelner Request zugeordnet werden kann.

| Fehlerklasse | Verhalten nach Error-Nachricht |
|---|---|
| ungültiges Envelope, Binärframe oder Nachricht über Manifestlimit | Verbindung schließen |
| `SEQUENCE_ERROR` | Verbindung schließen |
| Hello-Fehler oder Hello-Timeout | Verbindung schließen |
| ungültiger Output-, Frame- oder Timelinebefehl | Verbindung offen lassen |
| `DEVICE_BUSY` | Verbindung offen lassen |
| `UNSUPPORTED_MESSAGE_TYPE` | Verbindung offen lassen |
| `HEARTBEAT_TIMEOUT` oder `SESSION_REPLACED` | Verbindung schließen |

## 15. Firmware-Update per OTA

### 15.1 Metadaten

`GET /api/v1/firmware`:

```json
{
  "ok": true,
  "data": {
    "name": "hdp-firmware",
    "version": "0.2.0",
    "channel": "development",
    "platform": "esp8266",
    "board": "d1_mini",
    "variant": "generic",
    "build_id": "20260728-181524",
    "build_timestamp": "2026-07-28T18:15:24Z",
    "protocol_version": "1.0-draft",
    "config_schema_version": 1,
    "ota_supported": true,
    "ota_port": 8080,
    "maximum_image_size_bytes": 1044464,
    "free_update_space_bytes": 900000,
    "signature_verification": "not_configured",
    "signature_algorithm": null,
    "signature_key_id": null
  }
}
```

`signature_verification` ist `enabled`, `not_configured` oder `unsupported`.
`build_timestamp` ist ein UTC-Zeitstempel im RFC-3339-Format. Versionsfelder
verwenden SemVer 2.0.0.

Bei `signature_verification == "enabled"` ist `signature_algorithm` exakt
`ed25519-sha256` und `signature_key_id` ein nicht leerer ASCII-Identifier für den
im Gerät hinterlegten Vertrauensschlüssel. Andernfalls sind beide Felder `null`.

### 15.2 OTA-Status

`GET /api/v1/firmware/status`:

```json
{
  "ok": true,
  "data": {
    "state": "idle",
    "target_version": null,
    "received_bytes": 0,
    "total_bytes": 0,
    "progress_percent": 0,
    "restart_required": false,
    "signature_status": null,
    "last_error": null
  }
}
```

Zustände:

```text
idle
preparing
receiving
verifying
ready_to_restart
restarting
completed
failed
```

Zulässige Zustandsfolge:

```text
idle|failed|completed
→ preparing
→ receiving
→ verifying
→ ready_to_restart
→ restarting
→ completed
```

Aus `preparing`, `receiving`, `verifying`, `ready_to_restart` oder `restarting`
kann ein Fehler nach `failed` führen. Ein neuer Upload ist nur aus `idle`,
`failed` oder `completed` zulässig.

Solange der Betriebszustand `updating` ist, ergeben `PUT /config`,
`POST /pairing/start`, `POST /pairing/confirm`, `POST /unpair`,
`POST /restart`, `POST /factory-reset` sowie alle mutierenden
WebSocket-Nachrichten mit Präfix `output.` sowie `binary.output.set` den Fehler
`DEVICE_BUSY`.
`output.status.get` und HTTP-Leseoperationen bleiben zulässig.
`POST /firmware/restart` bleibt in `ready_to_restart` ausdrücklich zulässig.

`target_version` ist ein SemVer-String oder `null`, wenn noch keine syntaktisch
gültige Zielversion bekannt ist.
`received_bytes` und `total_bytes` sind `uint32`; `progress_percent` ist `uint8`
von 0 bis 100. `restart_required` ist genau in `ready_to_restart` und
`restarting` wahr. `signature_status` ist einer der Werte
`signature_verified`, `signature_not_configured`, `signature_invalid` oder
`null`. `last_error` ist ausschließlich im Zustand `failed` ein Objekt mit den
Pflichtfeldern `code` und `message`, sonst `null`.

### 15.3 Firmwareübertragung

Endpoint:

```text
POST http://<device-ip>:<ota_port>/api/v1/firmware/update
```

Pflichtheader:

```text
Content-Type: application/octet-stream
Content-Length: <exact image bytes>
X-HDP-Instance: <instance_id>
X-HDP-Binding-Key: <binding_key>
X-HDP-Firmware-Name: <name>
X-HDP-Firmware-Version: <semver>
X-HDP-Firmware-Channel: stable|beta|development
X-HDP-Platform: <platform>
X-HDP-Board: <board>
X-HDP-Variant: <variant>
X-HDP-Protocol-Version: 1.0-draft
X-HDP-Config-Schema-Version: <uint16>
X-HDP-Firmware-Size: <exact image bytes>
X-HDP-Firmware-SHA256: <64 lowercase hex>
```

`Content-Type` MUSS exakt `application/octet-stream` sein; andernfalls gilt
`UNSUPPORTED_MEDIA_TYPE`.

Optionale Header:

```text
X-HDP-Firmware-Signature: <detached signature>
X-HDP-Allow-Downgrade: true|false
X-HDP-Restart-After-Success: true|false
```

Fehlende Boolean-Header bedeuten `false`.

Ist `signature_verification == "enabled"`, ist
`X-HDP-Firmware-Signature` Pflicht. Der Wert ist die kanonische, gepaddete
Base64-Kodierung nach RFC 4648 einer 64-Byte-Ed25519-Signatur. Signiert werden
exakt die 32 rohen Bytes, die durch Dekodieren von
`X-HDP-Firmware-SHA256` entstehen. Fehlende, syntaktisch falsche oder nicht zum
in `/firmware` genannten Schlüssel passende Signaturen ergeben
`OTA_SIGNATURE_INVALID`.

Bei `not_configured` oder `unsupported` DARF der Header fehlen und wird vom Gerät
nicht als Vertrauensnachweis verwendet. Der Adapter MUSS in diesem Fall die
Authentizität des Releaseartefakts vor dem Upload über seinen Releasekanal
prüfen.

Vor dem ersten Flash-Write MUSS das Gerät prüfen:

- Owner-Authentifizierung,
- Firmwarefamilie, Plattform, Board und Variante,
- exakte Protokollversion,
- kompatibles Config-Schema,
- gültiges SemVer,
- Downgrade-Regel,
- Imagegröße gegen statisches und aktuelles Limit,
- syntaktisch gültigen SHA-256.

Während des Streams:

- Header-Timeout: 5000 ms;
- maximale Pause zwischen zwei Datenblöcken: 10000 ms;
- empfangene Bytes MÜSSEN gleichzeitig gehasht und geschrieben werden;
- deklarierte, HTTP- und tatsächlich empfangene Länge MÜSSEN identisch sein.

Nach vollständigem Empfang:

1. SHA-256 prüfen;
2. Signatur prüfen, wenn `signature_verification == "enabled"`;
3. persistenten Pending-Validation-Datensatz schreiben;
4. Firmwareimage finalisieren;
5. Zustand `ready_to_restart` setzen.

Response HTTP 202:

```json
{
  "ok": true,
  "data": {
    "state": "ready_to_restart",
    "restart_required": true
  }
}
```

Bei `X-HDP-Restart-After-Success: false` bleibt das Gerät in
`ready_to_restart`, bis der Adapter den Restart-Endpoint aufruft. Bei `true`
wechselt es unmittelbar nach der Response zu `restarting` und startet nach
500…2000 ms neu; der Adapter DARF dann keinen zusätzlichen Restart senden.

### 15.4 OTA-Neustart

`POST /api/v1/firmware/restart` ist ausschließlich in `ready_to_restart` zulässig.

Request:

```json
{}
```

Response HTTP 202:

```json
{
  "ok": true,
  "data": {
    "state": "restarting"
  }
}
```

Nach Rediscovery MUSS der Adapter `/firmware` und `/firmware/status` abfragen.
Erfolg liegt nur vor, wenn die laufende Version der Zielversion entspricht und
der Status `completed` meldet.

### 15.5 OTA-Wiederholung

| Fehlerklasse | Automatische Wiederholung |
|---|---|
| Verbindung vor erstem Byte fehlgeschlagen | erlaubt |
| Transfer unterbrochen/Timeout | erlaubt, kompletter Neuversuch |
| Authentifizierung | nicht erlaubt |
| Plattform/Board/Variante | nicht erlaubt |
| Protokoll/Config-Schema | nicht erlaubt |
| Größe/SHA/Signatur | nicht erlaubt |
| `ready_to_restart` erreicht | Upload nicht wiederholen |

## 16. Fehlerregister

| Code | HTTP | Bedeutung |
|---|---:|---|
| `INVALID_REQUEST` | 400/WS | ungültiges JSON, Typ, Envelope oder Pflichtfeld |
| `ENDPOINT_NOT_FOUND` | 404 | API-Pfad unbekannt |
| `METHOD_NOT_ALLOWED` | 405 | Methode für bekannten API-Pfad unzulässig |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Content-Type fehlt oder ist unzulässig |
| `PAYLOAD_TOO_LARGE` | 413 | Request-Body überschreitet das Limit |
| `UNSUPPORTED_PROTOCOL_VERSION` | 426/WS | Protokollversion inkompatibel |
| `UNSUPPORTED_RUNTIME_PROFILE` | WS | Laufzeitprofil inkompatibel |
| `AUTH_REQUIRED` | 401/WS | Owner-Credentials fehlen oder sind falsch |
| `INCOMPLETE_BINDING_CREDENTIALS` | 400 | nur einer der beiden Binding-Header vorhanden |
| `ALREADY_PAIRED` | 409 | Gerät besitzt bereits ein anderes Binding |
| `PAIRING_IN_PROGRESS` | 409 | andere Pairing-Session aktiv |
| `PAIRING_SESSION_EXPIRED` | 410 | Session fehlt, ist abgelaufen oder verbraucht |
| `INVALID_BINDING_KEY` | 422 | Binding-Key nicht exakt 64 lowercase Hexzeichen |
| `NOT_PAIRED` | 409 | Aktion erfordert Kopplung |
| `INVALID_CONFIGURATION` | 422 | Konfiguration ungültig |
| `CONFIG_REVISION_CONFLICT` | 409 | erwartete Revision stimmt nicht |
| `CONFIG_RECOVERY_REQUIRED` | 409 | persistente Konfiguration muss vor Schreibzugriff manuell behandelt werden |
| `OUTPUT_NOT_FOUND` | WS | `output_id` existiert in der aktiven Konfiguration nicht |
| `OUTPUT_CONFIG_REVISION_MISMATCH` | WS | Befehl bezieht sich nicht auf die aktive Konfigurationsrevision |
| `INVALID_OUTPUT_STATE` | WS | Output-/Frame-Payload ungültig oder ID mit anderem Inhalt wiederverwendet |
| `OUTPUT_BASE_FRAME_REQUIRED` | WS | Patch ist ohne Baselineframe der Sitzung unzulässig |
| `OUTPUT_RATE_LIMITED` | WS | physische Framefrequenz würde das Manifestlimit verletzen |
| `OUTPUT_BUSY` | WS | Output führt eine mit dem Befehl unvereinbare Timeline aus |
| `BINARY_PIN_NOT_FOUND` | WS | GPIO gehört nicht zur aktiven Binary-Konfiguration |
| `BINARY_PIN_DIRECTION_MISMATCH` | WS | mutierender Befehl adressiert keinen Ausgang |
| `BINARY_CONFIG_REVISION_MISMATCH` | WS | Befehl bezieht sich nicht auf die aktive Binary-Konfigurationsrevision |
| `TIMELINE_UPLOAD_IN_PROGRESS` | WS | ein anderer Staging-Upload ist in derselben Sitzung aktiv |
| `TIMELINE_NOT_FOUND` | WS | referenzierte Timeline ist nicht committed |
| `TIMELINE_OFFSET_MISMATCH` | WS | Chunkoffset weicht von `details.expected_offset` ab |
| `TIMELINE_SIZE_MISMATCH` | WS | empfangene Programmlänge stimmt nicht mit den Metadaten überein |
| `TIMELINE_CHECKSUM_MISMATCH` | WS | SHA-256 des Timelineprogramms stimmt nicht |
| `TIMELINE_INVALID_PROGRAM` | WS | binäres Timelineprogramm verletzt `hdtl-delta-v1` |
| `TIMELINE_CAPACITY_EXCEEDED` | WS | Manifestlimit oder verfügbarer Stagingspeicher reicht nicht |
| `UNSUPPORTED_MESSAGE_TYPE` | WS | Nachrichtentyp unbekannt |
| `SEQUENCE_ERROR` | WS | Sequenz nicht exakt monoton |
| `SESSION_HELLO_TIMEOUT` | WS | `homeess.hello` nicht innerhalb von 5000 ms empfangen |
| `HEARTBEAT_TIMEOUT` | WS | 45000 ms keine gültige Adapter-Nachricht |
| `SESSION_REPLACED` | WS | neue authentifizierte Steuersitzung hat die alte ersetzt |
| `DEVICE_BUSY` | 423/WS | Zustandsänderung während laufender OTA-Transaktion |
| `FACTORY_RESET_NOT_ALLOWED` | 403 | Gerät nicht im Recovery-Modus |
| `INTERNAL_ERROR` | 500/WS | persistenter oder interner Fehler |
| `OTA_AUTH_REQUIRED` | 401 | OTA-Owner-Authentifizierung fehlgeschlagen |
| `OTA_ALREADY_RUNNING` | 423 | OTA bereits aktiv oder restartbereit |
| `OTA_INVALID_METADATA` | 400/422 | Metadaten fehlen oder sind ungültig |
| `OTA_FIRMWARE_NAME_MISMATCH` | 422 | falsche Firmwarefamilie |
| `OTA_PLATFORM_MISMATCH` | 422 | falsche Plattform |
| `OTA_BOARD_MISMATCH` | 422 | falsches Board |
| `OTA_VARIANT_MISMATCH` | 422 | falsche Variante |
| `OTA_PROTOCOL_INCOMPATIBLE` | 422 | Protokoll inkompatibel |
| `OTA_CONFIG_SCHEMA_INCOMPATIBLE` | 422 | Config-Schema nicht migrierbar |
| `OTA_DOWNGRADE_NOT_ALLOWED` | 422 | Downgrade nicht freigegeben |
| `OTA_IMAGE_TOO_LARGE` | 413 | statisches Imagelimit überschritten |
| `OTA_INSUFFICIENT_SPACE` | 413 | aktuell zu wenig OTA-Platz |
| `OTA_TRANSFER_FAILED` | 400 | Verbindung oder Inter-Chunk-Timeout |
| `OTA_SIZE_MISMATCH` | 400 | Längen stimmen nicht überein |
| `OTA_CHECKSUM_MISMATCH` | 422 | SHA-256 stimmt nicht |
| `OTA_SIGNATURE_INVALID` | 422 | Signatur ungültig |
| `OTA_WRITE_FAILED` | 500 | Flash-Schreibfehler |
| `OTA_FINALIZE_FAILED` | 500 | Finalisierung/Persistierung fehlgeschlagen |
| `OTA_RESTART_NOT_READY` | 409 | kein verifiziertes Image restartbereit |
| `OTA_BOOT_VALIDATION_FAILED` | 500 | Validierung nach Neustart fehlgeschlagen |

Nicht registrierte Fehlercodes sind in HDP 1.0-draft unzulässig.

## 17. Verbindliche Timeouts und Retryregeln

### 17.1 Adapter-Timeouts

| Operation | Connect-Timeout | Response-Timeout |
|---|---:|---:|
| mDNS-Auflösung | – | 3000 ms |
| öffentliche GETs | 2000 ms | 5000 ms |
| Pairing start/confirm/status | 2000 ms | 5000 ms |
| GET/PUT config | 2000 ms | 10000 ms |
| unpair/restart/factory-reset | 2000 ms | 5000 ms |
| WebSocket-Upgrade | 3000 ms | 5000 ms bis `session.ready` |
| `output.frame.set` | – | 5000 ms |
| `binary.output.set`, `binary.status.get` | – | 5000 ms |
| Timeline begin/chunk/play/stop/status | – | 5000 ms |
| Timeline commit | – | 10000 ms |
| OTA-Metadaten/Status | 2000 ms | 5000 ms |
| OTA-Upload | 5000 ms | nach Abschnitt 15.3 |
| Rediscovery nach Neustart | – | 60000 ms |

### 17.2 Allgemeine Wiederholung

- GET-Requests DÜRFEN höchstens dreimal mit 250 ms, 500 ms und 1000 ms
  Wartezeit plus 0…100 ms Jitter wiederholt werden.
- Zustandsändernde Requests DÜRFEN nur nach den ausdrücklich beschriebenen
  Recoveryregeln wiederholt werden.
- `POST /pairing/confirm` ist mit identischem Payload idempotent.
- `PUT /config` wird nach Abschnitt 12.5 abgeglichen.
- `POST /restart`, `/unpair` und `/factory-reset` werden nach Timeout nicht blind
  wiederholt.
- HTTP 4xx wird nicht automatisch wiederholt, außer ausdrücklich beschrieben.
- HTTP 5xx DARF maximal einmal nach 1000…2000 ms wiederholt werden, sofern die
  Operation idempotent oder vorher abgeglichen ist.

### 17.3 Operationsspezifische Wiederherstellung

| Unsicherer Ausgang | Verbindliche Adapteraktion |
|---|---|
| `/pairing/start` ohne Response | exakt denselben Request innerhalb 120000 ms höchstens zweimal erneut senden |
| `/pairing/confirm` ohne Response | zuerst `/pairing/status` mit Pending-Credentials; bei `match` aktivieren, bei `unpaired` identischen Confirm erneut senden, bei `conflict` abbrechen |
| `PUT /config` ohne Response | ausschließlich Verfahren aus Abschnitt 12.5 |
| `output.frame.set` ohne Response | mit derselben `frame_id` und byteidentischem Payload einmal erneut senden; bei erneutem Verbindungsverlust nach neuer Sitzung absoluten Replace-Frame senden |
| `binary.output.set` ohne Response | nach neuer Sitzung `binary.status.get` senden und nur bei abweichendem Ausgangszustand den absoluten Befehl erneut senden |
| Timeline begin/chunk/commit ohne Response | in derselben Sitzung denselben idempotenten Request wiederholen; nach Sitzungsverlust Upload mit `begin` und Offset 0 neu beginnen |
| `output.timeline.play` ohne Response | `output.status.get` senden; nur starten, wenn nicht bereits dieselbe `timeline_id` mit demselben `loop`-Wert läuft oder geplant ist |
| `output.timeline.stop` ohne Response | `output.status.get` senden; bei `idle` oder `frame` als Erfolg behandeln, andernfalls denselben Stopp wiederholen |
| `/unpair` ohne Response | bis 60000 ms rediscovern und `/pairing/status` prüfen; bei `unpaired` als Erfolg behandeln, sonst Benutzerentscheidung |
| `/restart` ohne Response | bis 60000 ms rediscovern; Request nicht wiederholen |
| `/factory-reset` ohne Response | alten Fund bis 60000 ms beobachten und nach neuer `device_id` suchen; Request nicht wiederholen |
| `/firmware/restart` ohne Response | bis 60000 ms rediscovern und Version/Status prüfen; Request nicht wiederholen |

Nach unerwartetem WebSocket-Verlust mit weiterhin aktivem Binding verwendet der
Adapter folgende Reconnect-Abstände:

```text
1000 ms, 2000 ms, 5000 ms, 10000 ms, danach 30000 ms
```

Zu jedem Wert kommen 0…250 ms Jitter. Vor jedem Versuch MUSS die aktuelle
Geräteadresse über den vorhandenen mDNS-Fund aktualisiert werden. Nach
`AUTH_REQUIRED` oder einem Binding-`conflict` werden automatische Reconnects
beendet. Nach `SESSION_REPLACED` wartet die ersetzte Sitzung mindestens 30000 ms
und darf nur erneut verbinden, wenn die eigene Adapterinstanz weiterhin die
aktive Steuerrolle beansprucht; dadurch wird ein gegenseitiges Verdrängen zweier
lokaler Prozesse verhindert.

## 18. Konformitätsanforderungen

Eine Adapter- und Firmwarekombination gilt erst dann als konform, wenn mindestens
folgende Ende-zu-Ende-Fälle bestanden sind:

1. Discovery eines ungekoppelten Geräts.
2. Erfolgreiches Pairing mit übereinstimmender `binding_id`.
3. Verlorene Confirm-Response und Wiederaufnahme über `/pairing/status`.
4. Fremde Owner-ID bei gleichem Key ergibt `conflict`.
5. Gleiche Owner-ID bei falschem Key ergibt `conflict`.
6. Nur ein Binding-Header ergibt `INCOMPLETE_BINDING_CREDENTIALS`.
7. Authentifizierter und nicht authentifizierter Zugriff auf jede A-Route.
8. Konfigurationsschreiben mit korrekter Revision.
9. Konfigurationskonflikt und verlorene PUT-Response.
10. Neustart mit erhaltener Kopplung und Hardwarekonfiguration.
11. Entkopplung mit erhaltener Hardwarekonfiguration.
12. WebSocket-Handshake, Sequenzprüfung, Heartbeat und Reconnect.
13. Boot-Umschaltung zwischen `pixel-timeline-v1` und `binary-io-v1` ohne
    Vermischung der Pin-Treiber.
14. 30-ms-Entprellung, Schalteränderung, ausschließliches Taster-Pressed-Ereignis
    und Eingangssnapshot nach Sitzungsaufbau.
15. Binary-Ausgangsbestätigung sowie LOW-Sicherheitszustand bei Boot und
    Controllerverlust.
16. Runtime-Profilabgleich und Ablehnung eines inkompatiblen Profils.
17. Absoluter Replace-Frame, idempotente Wiederholung, Patch und fehlender
    Baselineframe.
18. Ablehnung falscher Output-ID, Konfigurationsrevision, Framegröße und
    Pixeldatentypen ohne Teilanwendung.
19. Chunkweiser Upload des verbindlichen Timeline-Testvektors einschließlich
    Offset-, Größen-, Hash- und Programmfehlern.
20. Timeline-Start, Loopgrenze, Scheduler-Aufholen, Stopp, Statusabgleich und
    Wiederaufnahme nach verlorener Response.
21. Offlineverhalten und Verlust aller flüchtigen Frames, Timelines und
    Stagingdaten nach Neustart bei unverändertem Binding und unveränderter
    Hardwarekonfiguration.
22. Helligkeits- und Strombegrenzung ohne Veränderung des logischen Puffers.
23. OTA-Erfolg, Transferabbruch, falsche Größe und falscher SHA-256.
24. Rediscovery und Versionsbestätigung nach OTA.

Beispiele in diesem Dokument sind normativ hinsichtlich Feldnamen, Datentypen und
Einheiten. Beispielwerte sind nicht normativ.
