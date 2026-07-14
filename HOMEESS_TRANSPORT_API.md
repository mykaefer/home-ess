# homeESS Transport API

Status: Draft
Protocol version: 0.1

Diese Spezifikation ist sprach-, plattform-, framework- und repositoryneutral.
Sie wird inhaltlich identisch in drei Repositories gepflegt: homeESS-Server,
homeESS-Android-App und essrelay-Server. Sie beschreibt ein transportneutrales
Anfrage-/Antwortmodell und legt bewusst keine sprachspezifischen Klassennamen
fest.

## 1. Zweck

Definition eines gemeinsamen, transportneutralen Modells, über das eine Client-
Oberfläche mit einer homeESS-Origin kommuniziert — unabhängig davon, ob die
Verbindung lokal (LAN) oder später über einen Relay verläuft. Ziel ist, dass
dieselbe Anwendungslogik über verschiedene Transporte hinweg identisch
funktioniert.

## 2. Geltungsbereich

Abgedeckt: das Anfrage-/Antwortmodell, Streaming, Abbruch, Timeouts,
Versionierung, Capability-Negotiation, stabile Fehlercodes und der
WebSocket-Handshake. Nicht abgedeckt: Billing, konkrete Authentifizierungs- und
Kryptografieverfahren, produktive Relay-Weiterleitung (siehe Abschnitt 23 und
25).

## 3. Begriffe

- **Anfrage/Antwort**: eine HTTP-artige Interaktion (Methode, Pfad, Header,
  optionaler Body) und ihre Antwort (Status, Header, optionaler Body).
- **Stream**: eine Folge von Bytes, die schrittweise übertragen wird, ohne
  vollständige Pufferung.
- **Transport**: der konkrete Übertragungsweg (lokal oder Relay), der das Modell
  umsetzt.
- **Origin**: die homeESS-Instanz, die Anfragen tatsächlich beantwortet.
- **Capability**: eine ausgehandelte, tatsächlich verfügbare Fähigkeit.

## 4. Rollen

- **Client UI**: die Oberfläche (z. B. WebView/Browser), die HTTP-artige
  Anfragen stellt.
- **App Proxy**: lokaler Vermittler in der App, der Anfragen der Client UI
  entgegennimmt und über einen Transport weiterreicht.
- **Local Transport**: spricht direkt mit einer lokalen homeESS-Origin.
- **Relay Transport**: leitet Anfragen später über den Relay-Server
  (noch nicht implementiert).
- **Relay Server**: vermittelt später zwischen App und Origin.
- **homeESS Origin**: beantwortet Anfragen.

## 5. Vertrauensgrenzen

- Die Client UI spricht in der Android-App **immer** mit einem lokalen App-Proxy,
  nie direkt mit einer entfernten Origin.
- Der App-Proxy verwendet entweder Local Transport oder später Relay Transport.
- Der Relay-Server behandelt alle Clientaussagen als nicht vertrauenswürdig und
  prüft jede sicherheitsrelevante Entscheidung selbst.
- Local Transport spricht direkt mit einer lokalen homeESS-Origin im selben
  Netz.

## 6. Protokollversionierung

Die aktuelle Protokollversion ist `0.1`. Versionen werden **explizit**
ausgehandelt. Ein Downgrade darf **nicht still** erfolgen. Wird eine Version
nicht unterstützt, ist die Verbindung mit dem stabilen Fehlercode
`unsupported_protocol_version` abzulehnen.

## 7. Capability Negotiation

Fähigkeiten werden explizit gemeldet und nur dann als verfügbar betrachtet, wenn
sie tatsächlich implementiert sind. Aktuell gemeldete Fähigkeiten (Beispiel):

```json
{
  "transportProtocolVersions": ["0.1"],
  "pairingSessionCreation": true,
  "pairingClaim": false,
  "pairingConfirmation": false,
  "relay": false,
  "billing": false,
  "endToEndEncryption": false
}
```

Pairing wird auf Teil-Fähigkeitsebene gemeldet: Nur die erste Stufe
(Pairing-Session erzeugen, Status abfragen, abbrechen — siehe Abschnitt 26) ist
implementiert (`pairingSessionCreation: true`). Das Einlösen durch die App
(`pairingClaim`) und die Bestätigung durch homeESS (`pairingConfirmation`) sind
noch nicht implementiert. Das frühere grobe Feld `pairing` wurde durch diese
feineren Felder ersetzt.

Keine zukünftige Fähigkeit darf fälschlich als verfügbar gemeldet werden.

## 8. Transportneutrales HTTP-Anfragemodell

Eine Anfrage besteht mindestens aus:

- **Methode** (Abschnitt 10)
- **Pfad** und optionaler **Query** (Abschnitt 11)
- **Header** als Liste von Name/Wert-Paaren mit möglichen Mehrfachwerten
  (Abschnitt 12)
- optionalem **Request-Body** als Stream (Abschnitt 13)
- optionalem **Abbruchsignal** (Abschnitt 16)

Das Modell ist bewusst HTTP-nah, aber transportunabhängig: derselbe logische
Request ist über Local Transport und später Relay Transport identisch
darstellbar.

## 9. Transportneutrales HTTP-Antwortmodell

Eine Antwort besteht mindestens aus:

- **Statuscode** (Abschnitt 15)
- **Header** als Liste von Name/Wert-Paaren mit möglichen Mehrfachwerten
- optionalem **Response-Body** als Stream (Abschnitt 14)

Der Body darf schrittweise geliefert werden und muss streambar bleiben.

## 10. Methoden

Unterstützt werden die üblichen HTTP-Methoden (u. a. GET, HEAD, POST, PUT, PATCH,
DELETE, OPTIONS). Methoden mit und ohne Body sind zulässig. Semantik entspricht
HTTP.

## 11. Pfad und Query

Pfad und Query werden getrennt geführt. Der Query-Anteil ist Teil der Anfrage,
darf aber nicht für sicherheitsrelevante Geheimnisse missbraucht werden (z. B.
keine Tokens im Query, die geloggt werden könnten).

## 12. Header mit Mehrfachwerten

Header können **Mehrfachwerte** besitzen. Das Modell repräsentiert Header als
geordnete Liste von Name/Wert-Paaren, nicht als einfache Abbildung Name→Wert.

- `Set-Cookie` darf **nicht** zu einem einzelnen String zusammengeführt werden;
  jeder Wert bleibt eigenständig erhalten.
- Die Reihenfolge gleichnamiger Header bleibt erhalten.

## 13. Request-Body als Stream

Der Request-Body wird als Stream modelliert und darf schrittweise gesendet
werden. Große oder unbekannt große Bodies dürfen nicht vollständig gepuffert
werden müssen.

## 14. Response-Body als Stream

Der Response-Body wird als Stream modelliert und schrittweise ausgeliefert.
Insbesondere Server-Sent Events (Abschnitt 19) dürfen nicht vollständig
gepuffert werden.

## 15. Statuscodes

Antworten führen einen HTTP-Statuscode mit üblicher Semantik (2xx Erfolg, 3xx
Weiterleitung, 4xx Clientfehler, 5xx Serverfehler). Transportfehler sind davon
getrennt und werden über stabile Fehlercodes (Abschnitt 21) signalisiert.

## 16. Abbruch

Ein Abbruch muss **transportübergreifend** möglich sein: Bricht die Client UI
eine Anfrage ab, muss der Abbruch bis zur Origin durchgereicht werden und dort
laufende Arbeit sowie Streams beenden. Der Abbruch ist ein First-Class-Signal,
nicht nur ein Verbindungsabbruch.

## 17. Timeouts

Transporte definieren sinnvolle Timeouts (Verbindungsaufbau, Handshake, Idle,
Anfrage). Ein Timeout führt zu einem definierten Fehler und zur Freigabe von
Ressourcen. Timeoutwerte sind konfigurierbar und begrenzt.

## 18. Streaming

Anfragen und Antworten unterstützen bidirektionales, schrittweises Streaming.
Ein Transport darf Streams nicht implizit vollständig puffern.

## 19. Server-Sent Events

SSE-Antworten sind ein Sonderfall des Response-Streamings und **dürfen nicht
vollständig gepuffert** werden. Ereignisse werden fortlaufend ausgeliefert, bis
die Anfrage endet oder abgebrochen wird.

## 20. Backpressure

Der Transport muss Backpressure respektieren: Ein langsamer Konsument darf einen
schnellen Produzenten drosseln. Speicher darf nicht durch unbegrenzte Pufferung
wachsen.

## 21. Stabile Fehlercodes

Transportfehler verwenden stabile, maschinenlesbare Codes. Der begleitende
Meldungstext ist **nicht** stabil und darf nicht als maschinenlesbare
Schnittstelle verwendet werden. Für den WebSocket-Handshake gelten mindestens:

```
invalid_message
message_too_large
invalid_json
invalid_handshake
client_type_mismatch
unsupported_protocol_version
handshake_timeout
authentication_not_available
rate_limit_exceeded
internal_error
```

Fehlercodes sind Teil des stabilen Protokolls; Meldungstexte nicht.

## 22. WebSocket-Handshake

Der Kanal zum Relay wird über WebSocket aufgebaut. Die erste Nachricht des
Clients muss eine kleine, streng validierte UTF-8-JSON-Nachricht sein:

```json
{ "type": "hello", "protocolVersion": "0.1", "clientType": "app" }
```

bzw. für die Origin-Rolle:

```json
{ "type": "hello", "protocolVersion": "0.1", "clientType": "homeess" }
```

Regeln:

- `type` muss exakt `hello` sein.
- `protocolVersion` muss unterstützt werden (sonst
  `unsupported_protocol_version`).
- `clientType` muss zum aufgerufenen Endpunkt passen (sonst
  `client_type_mismatch`).
- Die Nachrichtengröße wird vor dem Parsen geprüft; nur UTF-8-JSON ist zulässig,
  Binärnachrichten im Handshake werden abgelehnt.
- Fehlende Felder, falsche Typen und unbekannte Felder werden abgelehnt
  (`invalid_handshake`). Unbekannte Felder werden strikt zurückgewiesen.
- Der Handshake erfolgt nur einmal.

Nach erfolgreichem Protokoll-Handshake wird die Verbindung in dieser
Serverversion **nicht** freigeschaltet, weil Authentifizierung noch nicht
implementiert ist. Der Server sendet dann einen stabilen Fehler und schließt
kontrolliert:

```json
{
  "type": "error",
  "code": "authentication_not_available",
  "message": "Authentication is not available in this server version."
}
```

## 23. Noch nicht implementierte Relay-Erweiterung

Die eigentliche Relay-Weiterleitung (Tunnel, HTTP-over-Relay, Multiplexing
mehrerer Anfragen über eine WebSocket-Verbindung, Backpressure-Signalisierung
über den Tunnel) ist **noch nicht** definiert/implementiert. Sie wird als
Erweiterung dieses Protokolls ergänzt, sobald Authentifizierung, Pairing und
Lizenzprüfung vorhanden sind. Bis dahin stellt der Relay keinen Tunnel bereit.

## 24. Sicherheitsgrundsätze

- Der Relay-Server darf Clientaussagen nie ungeprüft vertrauen.
- Lizenzprüfung autorisiert später Relay-Nutzung, verschlüsselt aber keine
  Verbindung.
- Ein Pairing-Code ist kein dauerhafter Zugriffstoken und kein
  Verschlüsselungsschlüssel.
- Geräteidentität und homeESS-Instanzidentität sind getrennt.
- Nutzdaten sollen später Ende-zu-Ende verschlüsselt werden; konkrete
  Kryptografiealgorithmen werden noch nicht festgelegt und es wird keine eigene
  Kryptografie improvisiert.
- Auch mit späterer Ende-zu-Ende-Verschlüsselung sieht der Relay-Server weiterhin
  bestimmte Metadaten.
- Billing ist nicht Teil des Transportprotokolls.
- Protokollversionen müssen explizit ausgehandelt werden; Downgrades dürfen nicht
  still erfolgen.

## 25. Nicht abgedeckte Bereiche

Die erste Pairing-Session-Stufe (Erzeugen/Status/Abbruch, Abschnitt 26) ist Teil
dieser Spezifikation. Nicht abgedeckt sind produktives Pairing über Claim und
Confirmation, dauerhafte Geräte-/Instanzidentitäten, Lizenzprüfung, Billing,
Relay-Tunnel, HTTP-over-Relay sowie Ende-zu-Ende-Verschlüsselung und
Schlüsselverwaltung (jeweils separat bzw. später). Authentifizierung nicht
gepairter Verbindungen ist ebenfalls noch nicht abgedeckt.

## 26. Pairing-Session (erste Stufe)

Eine homeESS-Instanz kann beim Relay eine **kurzlebige Pairing-Session**
anfordern. Der Relay erzeugt daraus einen QR-Code, den homeESS später auf seiner
Fernzugriffsseite anzeigen kann. In dieser Stufe wird **noch kein Smartphone
gekoppelt**; der Status bewegt sich ausschließlich zwischen `pending`,
`expired` und `cancelled`.

### 26.1 Begriffe

- **Pairing-Session**: die kurzlebige Sitzung mit öffentlicher Pairing-ID und
  Ablaufzeit.
- **Pairing-ID**: öffentliche, nicht-geheime, nicht leicht enumerierbare Kennung
  (Präfix `pr_`). Kein Geheimnis.
- **Pairing-Token**: der kurzlebige geheime Wert der Session. Er ist **kein**
  dauerhafter Zugangsschlüssel, **kein** Geräte-Token, **kein** Instanzschlüssel,
  **kein** Verschlüsselungsschlüssel und **kein** Lizenznachweis. Nicht als
  „Pairing-Key“ bezeichnen.

### 26.2 Pairing-URI und QR-Inhalt

Der QR-Code enthält genau eine URI dieser Form:

```
homeess://pair?v=1&relay=<url-encoded relay base>&id=<PAIRING_ID>&token=<PAIRING_TOKEN>
```

- Schema exakt `homeess`, Aktion exakt `pair`.
- Genau die Parameter `v`, `relay`, `id`, `token`; keine weiteren.
- Alle Werte korrekt URL-kodiert; `relay` stammt aus der öffentlichen Basis-URL.
- Protokollversion der Pairing-URI in dieser Stufe: `1`.
- Der Pairing-Token erscheint nur im QR-Inhalt und in der initialen
  Erstellungsantwort; er wird nie geloggt, nie im Audit gespeichert und nie im
  Klartext persistiert (nur ein SHA-256-Hash wird gespeichert).

### 26.3 Session erstellen

```
POST /api/v1/pairing/sessions
Content-Type: application/json
```

ohne Authentifizierung — kein `Authorization`-Header erforderlich.

Request-Body:

```json
{ "protocolVersion": "0.1", "instanceName": "homeESS" }
```

Erfolg: `201 Created`

```json
{
  "pairingId": "pr_...",
  "pairingToken": "...",
  "pairingUri": "homeess://pair?v=1&relay=...&id=...&token=...",
  "expiresAt": "2026-07-14T12:34:56.000Z",
  "pollIntervalSeconds": 3,
  "qrCode": { "mimeType": "image/png", "base64": "iVBORw0KGgo..." }
}
```

`qrCode.base64` ist reines Base64 ohne `data:`-Präfix.

Regeln und Eigenschaften:

- Das Erstellen ist aktuell **öffentlich** und rate-limitiert. Eine Session
  gewährt allein **keinen** Zugriff.
- Claim (App löst die Session ein) und Confirmation (homeESS bestätigt) sind
  noch **nicht** implementiert.
- Der Pairing-Token wird **nur** in dieser initialen Erstellungsantwort
  ausgegeben; `pairingToken`, `pairingUri` und der QR-Code enthalten dasselbe
  Session-Geheimnis. Spätere `GET`-Antworten enthalten weder Token noch URI noch
  QR-Code.
- `pairingUri` ist exakt die URI, die auch im QR-Code kodiert ist (siehe 26.2);
  der QR-Code ist nur eine Darstellung dieser URI.
- `GET` und `DELETE` verwenden weiterhin `Authorization: Pairing
<PAIRING_TOKEN>`.
- Es dürfen **keine** Tokens im Query der HTTP-API stehen. Der Token ist nur
  innerhalb der `homeess://`-Pairing-URI enthalten; die Pairing-URI wird nicht
  als HTTP-Anfrage an den Relay gesendet.

### 26.4 Status abfragen

```
GET /api/v1/pairing/sessions/:pairingId
Authorization: Pairing <PAIRING_TOKEN>
```

Antwort bei gültigem Token:

```json
{
  "pairingId": "pr_...",
  "status": "pending",
  "expiresAt": "2026-07-14T12:34:56.000Z",
  "remainingSeconds": 532
}
```

`status` ist `pending`, `expired` oder `cancelled`; bei `expired`/`cancelled`
ist `remainingSeconds` `0`. Die Antwort enthält weder Token noch Token-Hash noch
interne IDs. Unbekannte ID und falscher Token liefern dieselbe
`pairing_session_not_found`-Antwort (keine Enumeration). Ein ~3-Sekunden-Polling
ist vorgesehen.

### 26.5 Session abbrechen

```
DELETE /api/v1/pairing/sessions/:pairingId
Authorization: Pairing <PAIRING_TOKEN>
```

Erfolg: `204 No Content`. Wiederholter Abbruch ist idempotent. Eine abgelaufene
oder bereits abgebrochene Session wird nie reaktiviert.

### 26.6 Cache- und Sicherheitsregeln

Alle Pairing-Antworten sind unspeicherbar (`Cache-Control: no-store`,
`Pragma: no-cache`) und `X-Content-Type-Options: nosniff`. Es gibt keine
CORS-Freigabe; der erwartete Weg ist homeESS-Server → essrelay-API, nicht der
Browser.

### 26.7 Stabile Pairing-Fehlercodes

```
invalid_pairing_request
unsupported_protocol_version
too_many_active_pairing_sessions
pairing_session_not_found
invalid_pairing_token
rate_limit_exceeded
internal_error
```

`too_many_active_pairing_sessions` wird zurückgegeben, wenn die Grenze
gleichzeitig aktiver Sessions je Quelle erreicht ist; `rate_limit_exceeded` gilt
für das quellbezogene und das globale Erstellungslimit. Wie überall gilt:
Fehlercodes sind stabil, Meldungstexte nicht.

### 26.8 Trennungen

- Pairing-Token ↔ dauerhafte Geräte-/Instanzidentität: getrennt; der
  Pairing-Token ist kurzlebig und einmalig.
- Pairing ↔ Lizenz: eine Pairing-Session ist kein Lizenznachweis.
- Pairing ↔ Verschlüsselung: der Pairing-Token ist kein
  Verschlüsselungsschlüssel.

### 26.9 Missbrauchsschutz der öffentlichen Erstellung

Da die Session-Erstellung öffentlich ist, ist sie mehrfach begrenzt: ein
striktes quellbezogenes Rate-Limit, ein globales Erstellungslimit und eine
Grenze gleichzeitig aktiver Sessions je Quelle. Die konkreten Werte und ihre
In-Memory-/Einzelinstanz-Einschränkung sind serverspezifisch (in essrelay über
Umgebungsvariablen konfigurierbar) und **nicht** Teil dieses plattformneutralen
Transportprotokolls; die Quelle wird nur aus vertrauenswürdigen Proxy-Angaben
abgeleitet.

## Aktueller Implementierungsstatus

Bereits implementiert:

- HTTP-Grunddienst
- Versions- und Capability-Abfrage
- WebSocket-Protokoll-Handshake
- sichere Ablehnung nicht authentifizierter Verbindungen
- Pairing-Session erzeugen (erste Stufe)
- serverseitige QR-PNG-Erzeugung
- Pairing-Status `pending`, Ablauf (`expired`), Abbruch (`cancelled`)

Noch nicht implementiert:

- App löst Pairing-Session ein (Claim)
- homeESS bestätigt Smartphone (Confirmation)
- Authentifizierung / produktive Instanz- und Geräteidentitäten
- mehrere Smartphones
- Billing
- Lizenzprüfung
- Relay-Tunnel
- HTTP-over-Relay
- Ende-zu-Ende-Verschlüsselung
