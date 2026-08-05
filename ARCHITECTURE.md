# homeESS – Architektur

> Ausführlicher Entwickler-Einstieg und Gesamtüberblick: siehe
> [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md). Dieses Dokument fasst die
> Architektur kompakt zusammen und beschreibt insbesondere die Fernzugriff-/
> Pairing-Schicht.

## Überblick

homeESS ist ein einzelner Node.js/Express-Server (`server.js` → `src/app.js`),
der MQTT-Topics abonniert, Zustände in einer lokalen SQLite-DB hält und ein
server-gerendertes Web-Dashboard mit vorgeschaltetem Login ausliefert. Es gibt
genau **einen** HTTP-Server und **ein** Authentifizierungssystem
(Cookie-Sessions, `src/auth/`). Neue Funktionen fügen sich in dieses Gerüst ein
(Routen unter `src/routes/`, Views unter `src/views/`, Fachlogik unter
`src/<domäne>/`).

## Bedingungen und Automationen

Das Automationssystem unter `src/conditions/` verwendet keinen eigenen Broker
und keinen parallelen Scheduler. Definitionen und Laufzeitstatus liegen in
`automation_conditions` und `automation_condition_items`; die rein
organisatorische Ablage in `automation_condition_folders` folgt demselben
Verzeichnisprinzip wie die Custom States und hat keinen Einfluss auf die
Auswertung. Über die Oberfläche sortierbar sind ausschließlich Verzeichnisse und
Bedingungen; Trigger, Wenns und Danns behalten ihre Anlagereihenfolge. Die Engine bindet
Trigger und Wenn-Prüfungen über die bestehenden Ad-hoc-Routen an den gemeinsamen
`state-bus`; dadurch funktionieren MQTT-, Adapter-, System- und Custom-States
über dieselbe Grenze. Zeittrigger verwenden ausschließlich die zentrale
homeESS-Uhr aus `time-handler.js`.

Jeder Trigger einer aktiven Automation kann ihre Auswertung starten. Danach
müssen alle Wenn-Prüfungen erfüllt sein; erst dann werden alle Dann-Aktionen in
der gespeicherten Reihenfolge über `mqtt/client.publish()` ausgegeben. Die
Bus-Änderungserkennung, eine bedingungsbezogene Laufzeitsperre und eine harte
Ausführungsgrenze pro Minute verhindern unmittelbare Wiederholungs-,
Rückkopplungs- und Automationsschleifen. Berechnete
`system://`-States bleiben schreibgeschützt.

## Internationalisierung und Sprachdateien

homeESS besitzt genau **eine systemweite Sprachwahl**. Die Registry unter
`src/i18n/` scannt beim Prozessstart die mit dem Release ausgelieferten Dateien
in `/languages` sowie die updatefesten Uploads in
`HOME_ESS_LANGUAGE_DIR` (Default `<data>/languages`). Nach einem erfolgreichen
Upload wird unmittelbar erneut gescannt. Deutsch (`de.json`) und Englisch
(`en.json`) gehören immer zur Grundversion; Uploads dürfen weitere Sprachen
ergänzen oder eine gleichnamige Basisdatei updatefest überlagern.

Eine Sprachdatei ist UTF-8-kodiertes JSON mit `code`, `name`, `locale`, optional
`direction` (`ltr`/`rtl`) und einem `messages`-Objekt aus stabilen Schlüsseln und
Texten. Uploads sind auf 1 MiB begrenzt, Dateiname und Sprachcode müssen
übereinstimmen und werden vor dem atomaren Schreiben vollständig validiert.
Texte werden beim Laden auf Unicode NFC normalisiert; Views liefern immer
`<meta charset="utf-8">` sowie passendes `lang`/`dir`. Dadurch müssen Umlaute,
Akzente und sprachübliche Sonderzeichen ausgeschrieben werden — ASCII-Ersatz
wie `ae`, `oe`, `ue` ist in Sprachdateien nicht zulässig, wenn das echte Zeichen
gemeint ist.

`i18n.t(key, params, defaultText)` löst zuerst die gewählte Sprache auf. Fehlt
ein Schlüssel (etwa weil homeESS neuer als eine hochgeladene Übersetzung ist),
folgt der Standort-Fallback: nur `Europe/Berlin` verwendet Deutsch, jede andere
konfigurierte Zeitzone Englisch. Danach wird als letzte Rückfallebene die jeweils
andere mitgelieferte Basissprache verwendet. Neue oder geänderte Seiten,
Browsermeldungen, JSON-Fehler, Module und System-State-Bezeichnungen müssen ihre
sichtbaren Texte als Schlüssel **gleichzeitig in Deutsch und Englisch** ergänzen;
locale-abhängige Zahlen, Datumswerte, Sortierungen und Pluralformen verwenden
die `locale` der aktiven Sprache. Der gemeinsame `renderLayout` lokalisiert die
servergerenderten Bestandsansichten zentral, sodass es kein zweites Frontend und
keine abweichende Sprachwahl pro Seite gibt.

Adapter bleiben eigenständige Pakete. Ein Adapter kann seine Übersetzungen in
`adapter/<id>/languages/<code>.json` mit demselben Format mitliefern. Die
Registry lokalisiert Manifest, Settings-Schema und generische Host-Seiten; der
isolierte Prozess erhält `host.language`, `host.getLanguage()` und
`host.t(key, defaultText)`. Management-Requests enthalten zusätzlich
`request.language`; Browser-Frontends lesen dieselbe Information über
`GET /me/access`. Bei einer systemweiten Sprachänderung werden aktive Adapter
kontrolliert neu geladen, damit State-Namen und Kategorien ebenfalls wechseln.
Adapter ohne Sprachdateien bleiben ausdrücklich zulässig und laufen unverändert
einsprachig weiter. Die von homeESS mitgelieferten Adapter liefern immer Deutsch
und Englisch mit.

## Fernzugriff / Pairing / Relay-Tunnel

### Datenfluss

```
Browser  →  homeESS-Server  →  essrelay
```

Der Browser spricht **nie** direkt mit dem essrelay. Der homeESS-Server ist der
**Relay-Client**: Er erstellt die Pairing-Session, hält den Origin-Token,
fragt den Origin-Status ab, bestätigt oder lehnt einen Claim ab, bricht die
Session ab und liefert dem Browser nur die für die Darstellung nötigen Daten
(Status, Ablaufzeit, Poll-Intervall, QR-PNG bzw. Claim-Anzeigedaten).

### Komponenten

| Datei | Aufgabe |
| --- | --- |
| `src/remote-access/relay-config.js` | Auflösung/Validierung der Relay-Basis-URL (SSRF-Schutz), der Origin-WebSocket-URL und des Instanznamens. |
| `src/remote-access/relay-client.js` | Serverseitiger essrelay-Client: `createPairingSession`, `readPairingSessionStatus`, `cancelPairingSession`, `confirmPairingSession` (mit Instanz-Proof-Body), `rejectPairingSession`, `provisionPairingSession`, `getCapabilities`. HTTPS-Zwang, Timeouts, keine Redirects, Größenlimit, strenge Antwortvalidierung, Fehler-Mapping. |
| `src/remote-access/identity-crypto.js` | Reine Ed25519-Kryptografie (Node `crypto`): kanonische Proof-/Auth-Nutzlasten, Signatur/Verifikation, Fingerprint (Hex/Anzeige/Präfix-Abgleich). Ohne Datei-/Netzzugriff, gegen die Testvektoren geprüft. |
| `src/remote-access/identity-store.js` | Dauerhafte Instanzidentität: Schlüssel erzeugen/laden/validieren (atomar, 0600/0700, Symlink-/Größenschutz), Instanz-Proof und Challenge signieren, provisionierte IDs persistieren (`storeProvisionedIdentity`/`getProvisionedIdentity`). |
| `src/remote-access/pairing-state.js` | In-Memory-Pairing-Zustand je Admin-Session, Orchestrierung Confirm→Provisioning, Retry/Reconciliation, `paired`-Persistenz, Promise-Lock, Cleanup, Shutdown. |
| `src/remote-access/relay-connection.js` | Origin-WebSocket-Client (State-Machine): `hello`, Challenge-Validierung, Signatur, `authenticated`, Reconnect-Backoff, Heartbeat, Tunnel-Dispatch, Shutdown. |
| `src/remote-access/origin-tunnel.js` | Origin-Ende des Relay-Tunnels: lokale HTTP-Requests validieren/ausführen, Status/Header/Body streamen, Sequenzen, Timeouts, Backpressure und Cleanup. |
| `src/remote-access/connection-service.js` | Prozessweiter Singleton-Wrapper um genau eine Origin-Verbindung (Init/Autostart/Status/Shutdown). |
| `src/update/` | Konfigurierbare, persistente GitHub-Releaseprüfung, Wartungsfenster-Automatik und unprivilegierte Anforderung eines bestätigten Updates. |
| `updater/` | Separat installierter systemd-One-shot-Helper für Staging, atomaren Wechsel, Neustartprüfung und Rollback. |
| `src/remote-access/errors.js` | Stabile interne Fehlercodes (`RemoteAccessError`). |
| `src/remote-access/redact.js` | Redaction + Logging für Fernzugriff-Ereignisse (inkl. Private Key, Signatur, Proof, Nonce, Challenge). |
| `src/routes/remote-access.js` | Kompatibilitätsroute `/remote-access` (Weiterleitung zum Einstellungs-Tab) + lokale API `/api/remote-access/pairing[/confirm|/reject|/provision]` und `/api/remote-access/connection[/connect|/disconnect]` (Auth, CSRF, `no-store`). |
| `src/views/remote-access.js` | Server-gerendertes Fernzugriff-Panel für den Einstellungs-Tab + clientseitiger Controller (Countdown/Polling/Zustände, Gerätefingerprint, Provisioning, Verbindungsstatus). |
| `src/views/settings.js` | Einstellungsseite mit Tabs; bindet das Fernzugriff-Panel ein und signalisiert Tab-Wechsel an die Fernzugriff-Controller. |

### Lokale API-Schicht

Alle Endpunkte sind nur für authentifizierte Admins erreichbar, setzen
`Cache-Control: no-store` und geben **niemals** Token, Pairing-URI oder interne
IDs an den Browser:

- `POST /api/remote-access/pairing` – Session erstellen (bzw. aktive
  wiederverwenden). Antwort: `status`, `expiresAt`, `remainingSeconds`,
  `pollIntervalSeconds`, `qrCode` (nur bei Erstellung).
- `GET /api/remote-access/pairing` – Zustand lesen und bei aktiver Session mit
  dem Relay abgleichen. Bei `awaiting_confirmation` enthält die Antwort nur
  sichere Claim-Anzeigedaten; kein QR-Bild mehr.
- `POST /api/remote-access/pairing/confirm` – Claim bestätigen (`204`), nur aus
  `awaiting_confirmation`.
- `POST /api/remote-access/pairing/reject` – Claim ablehnen (`204`), nur aus
  `awaiting_confirmation`.
- `DELETE /api/remote-access/pairing` – Session beim Relay abbrechen und lokalen
  Zustand bereinigen (`204 No Content`, idempotent).

### Serverseitige Session-Zuordnung & Token-Lebenszyklus

Der aktive Pairing-Zustand liegt **ausschließlich im Arbeitsspeicher**, je
authentifizierter Admin-Session (`req.session.id`) genau eine aktive Session.
Gespeichert werden u. a. Pairing-ID, Origin-Token, Ablaufzeit, Poll-Intervall,
Status, QR-PNG-Base64, optionale Claim-Anzeigedaten, Erstellungszeit und der
zugehörige Owner. Der Claim-Token existiert nur in der initialen
Relay-Antwort/Pairing-URI und im QR-Code; homeESS nutzt ihn nicht für
Verwaltungsoperationen. Bei Claim wird das QR-Bild entfernt; der Origin-Token
bleibt bis `paired` erhalten, weil er für das Provisioning gebraucht wird. Bei
`paired`/`rejected`/`cancelled`/`expired` werden Origin-Token und QR-Daten aus
dem Speicher entfernt.

### QR-Datenfluss

Der Relay erzeugt den QR-Code (PNG). homeESS validiert ihn (MIME `image/png`,
PNG-Signatur, gültiges Base64, plausible Größe) und reicht nur das Base64-PNG an
den authentifizierten Browser weiter, der es als `data:image/png;base64,…`
darstellt. Die im QR enthaltene `homeess://pair?…`-URI enthält den Claim-Token
und wird dem Browser **nicht** im Klartext ausgegeben; der Origin-Token steht
nie im QR oder in der URI.

### Polling

Der Browser pollt `GET /api/remote-access/pairing` gemäß dem vom Relay
gelieferten `pollIntervalSeconds` (clientseitig auf 2–30 s begrenzt), solange
`status` `pending`, `awaiting_confirmation`, `confirmed` oder `provisioning`
ist, ohne überlappende Requests.
Der homeESS-Server fragt dabei den Origin-Status mit
`Authorization: Pairing-Origin <ORIGIN_TOKEN>` ab. Bei
`paired`/`rejected`/`expired`/`cancelled`, Wechsel auf einen anderen
Einstellungs-Tab, Browser-Tab-Wechsel (`visibilitychange`) oder Unload stoppt
das Polling; ein einzelner
Relay-Aussetzer führt zu Backoff statt sofortigem Fehler.

### Countdown, Timeout, Cleanup

Der Countdown basiert auf `expiresAt` (nicht auf einem lokalen Startwert), damit
Reload und Verzögerungen korrekt bleiben. Relay-Aufrufe haben Timeouts
(Erstellung 10 s, Status/Abbruch 5 s) via `AbortController`. Ein Hintergrund-
Cleanup (`unref`-Timer) kippt abgelaufene Sessions auf `expired` und entfernt
alte terminale Einträge.

### Race-Condition-Schutz

Alle verändernden Operationen je Owner laufen über einen **Promise-Ketten-Mutex**
(`withLock`). Dadurch erzeugen Doppel-POST, gleichzeitiges POST/DELETE,
Confirm/Reject-Rennen und paralleles Pollen keine zwei Relay-Sessions und keine
inkonsistenten Zustände. Ein Doppel-POST verwendet eine noch gültige Session
wieder.

### Restart-Verhalten / keine Persistenz

Es gibt **keine Persistenz** des Pairing-Zustands (keine DB, keine Datei, kein
Browser-Speicher, kein Log). Nach einem homeESS-Neustart ist die lokale
Zuordnung verloren — für diese Stufe akzeptabel. Eine beim Relay noch bestehende
Session läuft dort nach ihrer TTL von selbst ab. Beim kontrollierten Shutdown
(SIGTERM/SIGINT) werden Speicher und Timer geleert.

## Dauerhafte Identität, Provisioning und Origin-WebSocket (essrelay 0.5.0)

### Kopplungsfluss

```
App claimt mit Geräte-Key und Proof
→ homeESS sieht den Gerätefingerprint (Origin-Status)
→ homeESS bestätigt mit Instanz-Key und Instanz-Proof (Confirm-Body)
→ homeESS provisioniert (Provision)
→ Relay erstellt Instanz/Gerät/Link, meldet instanceId/deviceId/Fingerprints
→ homeESS speichert instanceId/deviceId persistent, Status → paired
→ homeESS baut die authentifizierte Origin-WebSocket-Verbindung auf
```

### Identity Store

Die dauerhafte Ed25519-Instanzidentität liegt unter `HOME_ESS_IDENTITY_DIR`
(Default `<data>/identity`). Der private Schlüssel steht als PKCS8-DER in
`instance-private-key.pk8` (0600), Metadaten und provisionierte IDs in
`identity.json` (0600); das Verzeichnis ist 0700. Schreibvorgänge sind atomar
(Temp-Datei, `fsync`, exklusiver Rename); Laden validiert Algorithmus, Version,
Fingerprint und die Zugehörigkeit von privatem/öffentlichem Schlüssel. **Schlüssel-Lifecycle:** einmalig erzeugt, bei Neustart wiederverwendet, bei
Beschädigung kontrollierter Fehler statt automatischer Neuerzeugung (kein
stiller Identitätswechsel). Der private Schlüssel verlässt nie den Prozess.

### Provisioning-Retry und Reconciliation

Provisioning ist idempotent: sofortiger Versuch nach Confirm, begrenzter
Hintergrund-Backoff und manueller Retry. Bleibt der Zustand bei einem transienten
Fehler auf `confirmed` (Origin-Token bleibt erhalten). Bei unklarer Antwort
(z. B. Konflikt „bereits provisioniert“) gleicht homeESS den Origin-Status ab und
übernimmt eine bereits `paired`-Identität, statt lokal `paired` anzunehmen. Ein
Fingerprint-Mismatch wird als Sicherheitsfehler behandelt: kein `paired`, kein
Scrubbing des Origin-Tokens, kein WebSocket-Aufbau.

### WebSocket-State-Machine, Reconnect, Shutdown

`idle → connecting → waiting_for_challenge → authenticating → authenticated`
(plus `reconnecting`/`disconnected`/`failed`/`stopped`). Der Client sendet
`hello` (`clientType: homeess`, `identityId: ins_…`), validiert die Challenge
streng, signiert die kanonische Auth-Nutzlast und erreicht `authenticated`.
Reconnect mit begrenztem Backoff (1s…60s) und Jitter; Auth-/Idle-Timeout;
Heartbeat über `ping`/`pong`; `connection_replaced` stoppt kontrolliert;
dauerhafte Auth-Fehler enden in `failed`. Beim Server-Shutdown werden Reconnect
gestoppt, Timer gelöscht und der Socket geschlossen. Nach `authenticated` sind
Status-/Link-Nachrichten sowie bei `relayTunnel: true` die intern definierte
Tunnel-Nachrichtenfamilie zulässig.

### Trust Boundaries

- Browser ↔ homeESS: der Browser erhält nur Status/Anzeigedaten/Fingerprints/
  gekürzte IDs/Verbindungsstatus — nie Private Key, Signatur, Proof, Token,
  Challenge oder Nonce.
- homeESS ↔ Relay: der Relay ist nicht vertrauenswürdig; homeESS validiert jede
  Antwort streng und gleicht Fingerprints gegen den lokalen Schlüssel ab.
- Identity Store: nur der homeESS-Servicebenutzer; der private Schlüssel bleibt
  lokal.

### Crash-Fenster zwischen Confirm und Provisioning

Der Pairing-Zustand ist bewusst In-Memory (kein Klartext-Token auf Platte). Ein
Prozessabsturz im sehr kleinen Fenster zwischen erfolgreichem Confirm und dem
Provisioning verliert den Origin-Token; die Session läuft dann beim Relay per TTL
ab und der Nutzer erzeugt einen neuen Code. Solange der Prozess läuft, sind
Fehler nach dem Confirm retriable (Zustand bleibt `confirmed`).

### Add-on, Lizenz und Grenzen

Der Fernzugriff nutzt die Android-App aus dem Google Play Store
(<https://play.google.com/store/apps/details?id=de.mykaefer.homeess>) und den
essrelay-Server als eigenständiges Add-on. App und Relay-Server stehen nicht
unter AGPLv3 und sind nicht Teil dieses homeESS-Repositories. Für die Nutzung
über das Internet ist die homeESS Remote Lizenz über den Play Store
erforderlich. Ein Nutzeraccount, eigenes VPN, Portfreigabe oder DynDNS sind
nicht nötig.

Noch nicht Teil des homeESS-Servers sind Ende-zu-Ende-Verschlüsselung oberhalb
des verschlüsselten Transports sowie Billing-/Lizenzlogik; die Lizenzprüfung
liegt im Add-on/Relay-Kontext.
