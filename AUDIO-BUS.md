# homeESS Audio Bus

Der Audio Bus ist die zentrale, bidirektionale Audio-Infrastruktur von
homeESS. Externe Clients (Desktop-Widget, App, Browser, Sprachsatellit …)
streamen Audio an homeESS und empfangen Audio zurück; interne Plugins
abonnieren laufende Audio-Sessions und senden selbst Audio.

Der Bus ist **Transport und Routing** – kein Audio-Processing. Er
transcodiert nicht, zeichnet nichts auf und transportiert Audio nie über das
State-System. Spracherkennung, Sprachausgabe, Assistenten und Ähnliches bauen
als Plugins auf ihm auf.

```text
 Client ── Auth + WebSocket ──▶ homeESS Audio Bus ── interne Plugin-API ──▶ Plugins
        ◀──── Output-Audio ────  (Sessions, Routing,  ◀── Output-Audio ────
                                  Metadaten, Streams)
```

## Inhalt

1. [Endpunkt und Anmeldung](#1-endpunkt-und-anmeldung)
2. [Protokoll](#2-protokoll)
3. [Audioformate](#3-audioformate)
4. [Grenzen und Timeouts](#4-grenzen-und-timeouts)
5. [Fehlercodes](#5-fehlercodes)
6. [Beispiel-Client (Node.js)](#6-beispiel-client-nodejs)
7. [Plugin-API](#7-plugin-api)
8. [States, Status und Logging](#8-states-status-und-logging)
9. [Bekannte Einschränkungen](#9-bekannte-einschränkungen)

---

## 1. Endpunkt und Anmeldung

```
ws://<homeess-host>:<port>/api/v1/audio/ws
```

Der Endpunkt liegt auf demselben HTTP-Server wie Weboberfläche und
[States API](STATES-API.md). Hinter einem TLS-Reverse-Proxy entsprechend
`wss://…/api/v1/audio/ws`; der Proxy muss WebSocket-Upgrades durchreichen.

**Anmeldung = States API.** Es gibt keine eigenen Audio-Zugangsdaten:

1. `POST /api/v1/auth` mit dem API-Passwort → Bearer-Token
   ([STATES-API.md, Abschnitt 3](STATES-API.md#3-authentifizierung)).
2. WebSocket-Upgrade mit demselben Token im Header:

   ```http
   GET /api/v1/audio/ws HTTP/1.1
   Upgrade: websocket
   Authorization: Bearer <token>
   ```

Token als Query-Parameter oder Cookie werden nicht akzeptiert. Ohne gültiges
Token wird der Upgrade **vor** dem Aufbau der WebSocket-Verbindung mit dem
JSON-Fehlerformat der States API abgewiesen:

| HTTP | `error`         | Wann |
|------|-----------------|------|
| 401  | `unauthorized`  | Kein `Authorization: Bearer …`-Header |
| 401  | `token_invalid` | Token unbekannt, abgemeldet oder durch Passwortänderung ungültig |
| 401  | `token_expired` | Token abgelaufen – neu anmelden |
| 403  | `api_disabled`  | States API ausgeschaltet |
| 503  | `too_many_connections` | Zu viele gleichzeitige Audio-Verbindungen |

Ein gewöhnlicher HTTP-Aufruf ohne Upgrade erhält `426 upgrade_required`.

Das Token wird während der Verbindung laufend erneut geprüft (alle 5 s und
vor jedem `audio.start`). Läuft es ab, meldet sich der Client ab, ändert der
Administrator das API-Passwort oder schaltet er die API aus, sendet der Server
`audio.error` (`token_expired`/`token_invalid`/`api_disabled`), beendet eine
laufende Session (`reason: "auth_lost"`) und schließt mit Close-Code **4401**.

## 2. Protokoll

- **Control-Messages** sind JSON-Textframes (höchstens 4 KiB).
- **Audio** läuft ausschließlich als **binärer WebSocket-Frame** – in beide
  Richtungen, nie Base64 in JSON.
- Eine Verbindung führt höchstens **eine aktive Session**. Binärframes des
  Clients gehören immer zu dieser Session. Mehrere parallele Sessions eines
  Geräts laufen über mehrere Verbindungen; nacheinander kann eine Verbindung
  beliebig viele Sessions führen.
- Die Zuordnung Session ↔ Verbindung liegt nur im Server. Eine `session_id`
  in Client-Nachrichten wählt nie eine fremde Session aus.

### Ablauf

```text
Client                                   Server
  │── Upgrade + Authorization ─────────────▶│
  │◀──────────────────────── audio.ready ───│
  │── audio.start ─────────────────────────▶│
  │◀────────────────────── audio.started ───│  session_id
  │══ Binärframe (Mikrofon) ═══════════════▶│  → Plugins
  │══ Binärframe … ════════════════════════▶│
  │◀───────────────── audio.output.start ───│  Format des Output
  │◀════════════════ Binärframe (Output) ═══│  ← Plugin
  │◀─────────────────── audio.output.end ───│
  │── audio.end ───────────────────────────▶│
  │◀──────────────────────── audio.ended ───│
```

### Client → Server

**`audio.start`** – Session eröffnen.

```json
{
  "type": "audio.start",
  "device_id": "widgetbar-buero-pc",
  "source": "widgetbar",
  "room": "buero",
  "codec": "pcm_s16le",
  "sample_rate": 16000,
  "channels": 1,
  "metadata": { "wake_word": "hey homeess" }
}
```

| Feld          | Pflicht | Regel |
|---------------|:------:|-------|
| `device_id`   | ja   | 1–128 Zeichen `A–Z a–z 0–9 . _ : @ -`, beginnt mit Buchstabe/Ziffer |
| `source`      | ja   | 1–64 Zeichen `A–Z a–z 0–9 . _ -` (Art des Clients, z. B. `widgetbar`, `android`, `esp32`) |
| `room`        | nein | bis 64 Zeichen, keine Steuerzeichen |
| `codec`       | ja   | siehe [Audioformate](#3-audioformate) |
| `sample_rate` | ja   | ganze Zahl, siehe Audioformate |
| `channels`    | ja   | ganze Zahl, siehe Audioformate |
| `metadata`    | nein | Objekt, höchstens 16 Schlüssel `^[a-z][a-z0-9_]{0,31}$`, Werte Text (≤ 256 Zeichen), Zahl oder Wahrheitswert |

Alle Felder sind **Clientangaben**. Die authentifizierte Identität (Token)
setzt der Server getrennt davon; sie lässt sich weder über Felder noch über
`metadata` überschreiben. Eine mitgeschickte `session_id` wird ignoriert.
Unbekannte Felder werden ignoriert.

**`audio.end`** – eigene Session beenden.

```json
{ "type": "audio.end", "session_id": "550e8400-e29b-41d4-a716-446655440000" }
```

**`ping`** – Anwendungs-Keepalive, Antwort `pong`. (Zusätzlich sendet der
Server WebSocket-Pings; ein Client ohne Pong wird getrennt.)

**Binärframe** – Audio-Input der aktiven Session.

### Server → Client

| `type` | Felder | Bedeutung |
|--------|--------|-----------|
| `audio.ready` | `protocol`, `max_frame_bytes`, `idle_timeout_ms`, `max_session_ms`, `codecs` | Nach dem Verbindungsaufbau: Protokollversion (`1`), Grenzen und unterstützte Formate |
| `audio.started` | `session_id`, `codec`, `sample_rate`, `channels` | Session läuft; `session_id` ist eine serverseitig erzeugte UUID |
| `audio.output.start` | `session_id`, `codec`, `sample_rate`, `channels` | Ab jetzt folgen Output-Binärframes in diesem Format (kann vom Input abweichen) |
| `audio.output.end` | `session_id` | Output-Stream beendet |
| `audio.ended` | `session_id`, `reason` | Session beendet (Bestätigung von `audio.end` oder serverseitiges Ende) |
| `audio.error` | `code`, `message`, `session_id?` | Fehler, siehe [Fehlercodes](#5-fehlercodes) |
| `pong` | – | Antwort auf `ping` |

`reason` in `audio.ended`: `client_end`, `idle_timeout`, `session_timeout`,
`auth_lost`, `server_shutdown`, `protocol_error` (bei `disconnect` ist der
Client bereits weg).

Close-Codes: `1001` Server-Shutdown, `1008` Protokollverstöße/zu viele
Control-Messages, `1009` Nachricht über 256 KiB, `4401` Anmeldung ungültig.

## 3. Audioformate

| `codec`     | Beschreibung | `sample_rate` | `channels` |
|-------------|--------------|---------------|-----------|
| `pcm_s16le` | PCM signed 16 Bit little endian, interleaved | 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 | 1–2 |

Empfohlen für Sprache: `pcm_s16le`, 16000 Hz, mono. Ein PCM-Frame muss ganze
Samples enthalten (Länge teilbar durch 2 × Kanäle). Input und Output tragen
jeweils ein eigenes Format. Weitere Codecs (z. B. Opus) können ergänzt werden,
ohne das Protokoll zu ändern (`src/audio-bus/formats.js`).

## 4. Grenzen und Timeouts

| Grenze | Wert |
|--------|------|
| Gleichzeitige Sessions (gesamt) | 16 |
| Gleichzeitige Audio-Verbindungen | 32 |
| Input-Frame | ≤ 32 KiB (größere werden mit `frame_too_large` verworfen) |
| WebSocket-Nachricht (hart) | ≤ 256 KiB, sonst Close 1009 |
| Control-Message | ≤ 4 KiB, ≤ 60 je 10 s |
| Protokollfehler je Verbindung | > 20 → Close 1008 |
| Idle-Timeout | 30 s ohne Input und ohne Output |
| Maximale Session-Dauer | 15 min |
| Output-Chunk eines Plugins | ≤ 64 KiB |
| Ungesendeter Output je Session | ≤ 1 MiB (darüber `output_backpressure` für das Plugin) |
| Queue je Plugin | ≤ 256 Chunks und ≤ 1 MiB |

Empfohlene Frame-Länge: 20–100 ms Audio (16 kHz mono: 640–3200 Bytes).

## 5. Fehlercodes

`audio.error` lässt die Verbindung offen (Ausnahme: Anmeldung, zu viele
Fehler). Codes:

| `code` | Bedeutung |
|--------|-----------|
| `invalid_json`, `invalid_message`, `message_too_large`, `unknown_type` | Control-Message unlesbar, kein Objekt, zu groß oder unbekannter Typ |
| `invalid_device_id`, `invalid_source`, `invalid_room`, `invalid_metadata` | Feld in `audio.start` ungültig |
| `unsupported_codec`, `invalid_sample_rate`, `invalid_channels` | Format nicht unterstützt |
| `session_active` | `audio.start`, obwohl auf der Verbindung schon eine Session läuft |
| `no_active_session` | Binärframe ohne aktive Session |
| `session_not_found`, `invalid_session_id` | `audio.end` mit fehlender oder nicht zur Verbindung gehörender `session_id` |
| `frame_too_large`, `invalid_frame` | Input-Frame zu groß, leer oder ohne ganze Samples |
| `too_many_sessions` | Obergrenze gleichzeitiger Sessions erreicht |
| `token_expired`, `token_invalid`, `api_disabled` | Anmeldung verloren (Verbindung wird geschlossen) |

## 6. Beispiel-Client (Node.js)

```js
const WebSocket = require('ws');

const BASE = 'http://homeess.local:3000/api/v1';
const { token } = await (await fetch(`${BASE}/auth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.HOMEESS_API_PASSWORD }),
})).json();

const ws = new WebSocket('ws://homeess.local:3000/api/v1/audio/ws', {
  headers: { Authorization: `Bearer ${token}` },
});
let sessionId = null;

ws.on('open', () => ws.send(JSON.stringify({
  type: 'audio.start', device_id: 'demo-pc', source: 'demo', room: 'buero',
  codec: 'pcm_s16le', sample_rate: 16000, channels: 1,
})));

ws.on('message', (data, isBinary) => {
  if (isBinary) return speaker.write(data);          // Output-Audio
  const message = JSON.parse(data);
  if (message.type === 'audio.started') {
    sessionId = message.session_id;
    microphone.on('data', (pcm) => ws.send(pcm));     // Binärframes
  }
  if (message.type === 'audio.output.start') speaker.configure(message);
});

// Beenden:
ws.send(JSON.stringify({ type: 'audio.end', session_id: sessionId }));
```

## 7. Plugin-API

Plugins laufen im vertrauenswürdigen homeESS-Kontext und authentifizieren
sich nicht. Es gibt zwei Zugänge mit derselben Schnittstelle:

- **Adapter** (eigener Kindprozess): `host.audio.*`, freigeschaltet über
  `"audioBus": true` im Manifest (siehe [ADAPTER.md](ADAPTER.md#optional-audiobus-zugriff-auf-den-audio-bus)).
  Alle Aufrufe außer den `on…`-Abos liefern Promises.
- **Core-Module** (im Hauptprozess):

  ```js
  const audioBus = require('./src/audio-bus');
  const audio = audioBus.createClient('mein-plugin');
  ```

  Hier arbeiten die Aufrufe synchron und werfen Fehler mit `error.code`.

| Methode | Zweck |
|---------|-------|
| `onSessionStarted(handler)` | `handler(session)` bei jeder neuen Session. Liefert eine Abmeldefunktion. |
| `onInput(handler)` | `handler(session, chunk, info)` für jeden Input-Frame **aller** Sessions. `chunk` ist ein `Buffer` (nur lesen), `info = { seq, receivedAt, droppedBefore }`. |
| `onSessionEnded(handler)` | `handler(session, reason)` nach dem Ende einer Session. |
| `startOutput(sessionId, { codec, sampleRate, channels })` | Output-Stream beginnen; der Client erhält `audio.output.start`. |
| `sendAudio(sessionId, chunk)` | Audio-Chunk (`Buffer`/`Uint8Array`, ≤ 64 KiB, ganze Samples) an genau den Client der Session senden. |
| `endOutput(sessionId)` | Output-Stream beenden; der Client erhält `audio.output.end`. |
| `getSession(sessionId)` | Session oder `null`. |
| `listSessions()` | Alle aktiven Sessions. |
| `close()` | (Core) Alle Abos lösen, eigene Output-Streams beenden. Adapter: automatisch beim Stoppen der Instanz. |

**Session-Objekt** (eingefroren; neue Felder können hinzukommen):

```js
{
  sessionId: '550e8400-…',
  status: 'active',                     // oder 'ended'
  client: { type: 'states-api', id: '<Token-Kennung>', remoteAddress: '192.168.1.20' },
  deviceId: 'widgetbar-buero-pc',       // Clientangabe
  source: 'widgetbar',                  // Clientangabe
  room: 'buero',                        // Clientangabe oder null
  codec: 'pcm_s16le', sampleRate: 16000, channels: 1,
  metadata: { wake_word: 'hey homeess' },
  createdAt: 1790000000000, lastInputAt: 1790000000500,
  endedAt: null, endReason: null,
  output: null,                         // oder { owner, codec, sampleRate, channels, startedAt }
}
```

`client` ist die serverseitig geprüfte Identität: `id` ist eine nicht
umkehrbare Kennung des ausstellenden States-API-Tokens (nicht das Token).

**Verhalten und Regeln**

- Jedes Plugin hat eine eigene, geordnete Ereignis-Queue. Callbacks dürfen ein
  Promise liefern; das nächste Ereignis folgt erst danach. Ein langsames
  Plugin blockiert weder den WebSocket-Empfang noch andere Plugins.
- Läuft die Queue eines Plugins über, werden **neue Audio-Chunks für dieses
  Plugin verworfen**. `info.droppedBefore` des nächsten zugestellten Chunks
  nennt die Anzahl, `info.seq` zeigt die Lücke. Start- und Ende-Ereignisse
  gehen nicht verloren; `onSessionEnded` folgt immer nach dem letzten
  Input dieser Session.
- Ein Callback, der länger als 10 s nicht antwortet, gilt als Fehler; die
  Queue läuft weiter.
- Je Session sendet höchstens **ein** Plugin gleichzeitig Output. Ein zweites
  erhält `output_busy`, bis das erste `endOutput()` aufruft.
- Output-Fehler (`error.code`): `session_not_found`, `output_not_started`,
  `output_active`, `output_busy`, `unsupported_codec`, `invalid_sample_rate`,
  `invalid_channels`, `invalid_chunk`, `chunk_too_large`,
  `client_disconnected`, `output_backpressure` (Client nimmt nicht schnell
  genug ab – kurz warten und erneut senden), bei Adaptern zusätzlich
  `audio_not_permitted`.

Minimalbeispiel (Adapter, Echo):

```js
module.exports = (host) => ({
  start() {
    host.audio.onSessionStarted(async (session) => {
      await host.audio.startOutput(session.sessionId, { codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
    });
    host.audio.onInput(async (session, chunk) => {
      await host.audio.sendAudio(session.sessionId, chunk);
    });
  },
});
```

## 8. States, Status und Logging

- **State:** `system://homeess/audio.active_sessions` (Kategorie *Betrieb*)
  – Anzahl aktiver Sessions. Einzelne Sessions werden bewusst **nicht** als
  States angelegt; Details liefern `getSession()`/`listSessions()` und die
  Session-Ereignisse.
- **Status:** *Einstellungen → States API → Audio Bus* zeigt Zustand,
  WebSocket-URL, aktive Sessions, Verbindungen, Input-Abonnenten,
  Output-Streams und verworfene Chunks – ohne Geräte, Räume oder IDs.
  Programmatisch: `require('./src/audio-bus').status()`.
- **Log** (`[audio-bus]`): Session gestartet/beendet (Kurz-ID, Quelle, Format,
  Grund), Client getrennt, Plugin-Fehler, Queue-Overflow, Protokollfehler –
  jeweils gedrosselt. Nie Audioinhalte, Tokens, Gerätenamen oder Räume;
  kein Eintrag pro Frame.

## 9. Bekannte Einschränkungen

- Nur `pcm_s16le`; keine Transcodierung. Opus folgt bei Bedarf.
- Browser können beim WebSocket-Aufbau keinen `Authorization`-Header setzen.
  Ein Browser-Client braucht einen Vermittler (z. B. eine eigene Seite von
  homeESS) oder eine spätere Erweiterung der Anmeldung.
- Nicht über den Fernzugriff-Tunnel (Relay) erreichbar; der Tunnel überträgt
  keine WebSocket-Upgrades. Nutzung im lokalen Netz bzw. über eigenen
  Reverse-Proxy.
- Eine aktive Session je Verbindung.
- Sessions und Tokens liegen nur im Speicher; ein Neustart von homeESS beendet
  alle Sessions (`server_shutdown`).
- Keine eingebaute Ratenbegrenzung der Audio-Datenmenge je Client außer
  Frame-, Queue- und Sessiongrenzen.
