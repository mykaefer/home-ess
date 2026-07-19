# homeESS – Sicherheit

Dieses Dokument beschreibt die sicherheitsrelevanten Eigenschaften von homeESS,
mit Schwerpunkt auf Fernzugriff, Pairing und Relay-Tunnel. Eine
Bedrohungsbetrachtung findet sich in [THREAT_MODEL.md](THREAT_MODEL.md).

## Authentifizierung der Weboberfläche

Der Zugriff auf das Dashboard und alle Fachfunktionen erfordert eine Anmeldung
(Passwort, gehasht gespeichert). Sessions sind DB-gestützte Cookie-Sessions
(`httpOnly`, `SameSite=Lax`). Der Fernzugriff-Tab in den Einstellungen und die
zugehörige API sind ausschließlich für angemeldete Administratoren erreichbar.

## Fernzugriff / Pairing

### Grundprinzip

- **Kein Browser-Direktzugriff auf essrelay.** Der Datenfluss ist strikt
  `Browser → homeESS → essrelay`. Der homeESS-Server ist der Relay-Client.
- **Der QR-Code enthält ein kurzlebiges Geheimnis** (den Claim-Token innerhalb
  der `homeess://pair?…`-URI). Er darf nicht weitergegeben oder fotografiert an
  Dritte gelangen und ist nur wenige Minuten gültig.
- **Die Erstellung allein gewährt keinen Zugriff.** Ein Smartphone-Claim muss
  von homeESS bestätigt und anschließend provisioniert werden. Erst nach
  `paired`, authentifizierter Origin-WebSocket-Verbindung und gültiger
  Verknüpfung kann der Relay-Tunnel Requests weiterleiten.

### Umgang mit Claim- und Origin-Token

- Der Claim-Token steckt nur im QR-Code bzw. in der Pairing-URI und wird von
  homeESS nach der QR-Darstellung nicht für Verwaltungsoperationen genutzt.
- Der Origin-Token bleibt **ausschließlich serverseitig im Arbeitsspeicher** und
  wird **nie** an den Browser ausgegeben.
- Kein Token wird in `localStorage`, `sessionStorage`, Cookies, URL-Parametern
  der homeESS-Weboberfläche oder HTML-Datensätzen gespeichert.
- Claim-Token, Origin-Token, Pairing-URI und QR-Base64 werden **nicht**
  persistiert (keine DB, keine Datei) und **nicht** geloggt.
- Der Browser sendet **niemals** selbst einen Authorization-Header an den
  essrelay; nur der homeESS-Server nutzt `Authorization: Pairing-Origin …`.

### Transport-/HTTP-Härtung des Relay-Clients

- **HTTPS erzwungen**; die Relay-Basis-URL muss `https://` sein.
- **Timeouts** je Aufruf (Erstellung 10 s, Status/Abbruch/Confirm/Reject 5 s) via
  `AbortController`.
- **Keine Redirects** (`redirect: 'error'`) — schützt vor Umleitung auf fremde
  Hosts.
- **Antwortgröße begrenzt**; übergroße Antworten werden abgelehnt.
- **Strenge Validierung der Relay-Antwort** (HTTP-Status, getrennte
  Claim-/Origin-Tokens, PNG-Signatur, Base64, Ablaufdatum, Poll-Intervall,
  bekannte Statuswerte und Claim-Anzeigedaten). Der Relay wird nicht blind
  vertraut; ungültige Antworten werden zu `remote_access_invalid_response`.
- **Fehler-Redaction**: interne Relay-Details erreichen den Browser nie; er
  erhält nur stabile interne Fehlercodes.

### SSRF-Schutz

Die Relay-Basis-URL wird **ausschließlich serverseitig** über
`ESS_RELAY_BASE_URL` festgelegt (Default `https://essrelay.mykaefer.net`) und
beim Start streng validiert (absolute `https://`-URL, keine Zugangsdaten, kein
Query, kein Fragment, Slash-Normalisierung, Längenbegrenzung). Sie wird
**niemals** aus einem Browser-Request übernommen; im Pairing-Request ist keine
frei wählbare Relay-URL möglich. In Verbindung mit dem Redirect-Verbot spricht
homeESS damit nur genau diesen einen, fest konfigurierten Host an.

### CSRF-Schutz

Die verändernden lokalen Endpunkte (`POST`/`DELETE /api/remote-access/pairing`
sowie `POST /api/remote-access/pairing/confirm|reject`) verlangen zusätzlich
zum `SameSite=Lax`-Session-Cookie einen Custom-Header
(`X-HomeESS-Request: 1`), den ein fremdes HTML-Formular nicht setzen kann und der
bei Cross-Origin-`fetch` einen Preflight erzwingt (ohne CORS-Freigabe blockiert).

### Cache & Response-Header

Alle lokalen Pairing-Antworten sind unspeicherbar (`Cache-Control: no-store`,
`Pragma: no-cache`, `X-Content-Type-Options: nosniff`). Es gibt keine
CORS-Freigabe für diese Endpunkte.

### Lebenszyklus

Bei Ablauf, Abbruch, Logout und kontrolliertem Shutdown werden Token und QR-Daten
aus dem Speicher entfernt. Der Origin-Token bleibt bewusst bis `paired` erhalten
(er wird für den Provisioning-Aufruf gebraucht) und wird erst bei einem terminalen
Status (`paired`/`rejected`/`cancelled`/`expired`) gescrubbt. Der In-Memory-
Pairing-Zustand wird nicht über einen Neustart hinaus persistiert.

## Dauerhafte Identität, Provisioning und Origin-WebSocket (essrelay 0.5.0)

- **Privater Instanzschlüssel bleibt lokal.** homeESS erzeugt einmalig ein
  Ed25519-Schlüsselpaar. Der private Schlüssel (PKCS8-DER) liegt ausschließlich
  im Identity Store (`HOME_ESS_IDENTITY_DIR`, Default `<data>/identity`), Datei
  0600, Verzeichnis 0700, Eigentümer = homeESS-Servicebenutzer. Er wird **nie**
  an den Relay, nie an den Browser, nie in Logs, Fehlermeldungen, Cookies oder
  URLs ausgegeben und nie in Git eingecheckt (`data/*` ist ignoriert).
- **Ed25519, keine eigene Kryptografie.** Signaturen/Verifikation ausschließlich
  über Node.js `crypto`.
- **Proof of Possession.** Beim Confirm signiert homeESS die kanonische
  Instanz-Proof-Nutzlast (`homeess-instance-pairing-proof-v1`), gebunden an
  Pairing-ID, SHA-256 des Origin-Tokens, Instanz- und Gerätefingerprint. Der
  Origin-Token selbst wird nie signiert oder gespeichert (nur sein Hash fließt
  in die Nutzlast ein).
- **Keine Schlüsselableitung aus Tokens.** Dauerhafte Identitäten entstehen nur
  aus unabhängig lokal erzeugten Schlüsselpaaren, nie aus Pairing-Tokens.
- **Atomare, integritätsgeprüfte Speicherung.** Schreibvorgänge sind atomar
  (Temp-Datei, `fsync`, exklusiver Rename, `O_NOFOLLOW`). Beim Laden werden
  Algorithmus, Version, Größe, Symlink-Status, Fingerprint und die Zugehörigkeit
  privat/öffentlich geprüft. Bei Beschädigung wird der Fernzugriff kontrolliert
  deaktiviert statt automatisch ein neuer Schlüssel erzeugt.
- **Fingerprint-Prüfung beim Provisioning.** Der vom Relay gemeldete
  Instanzfingerprint muss zum lokal berechneten passen (Präfix-Abgleich bei
  gekürzter Anzeigeform); der Gerätefingerprint muss zum Claim konsistent sein.
  Ein Mismatch verhindert `paired` und den WebSocket-Aufbau.
- **Challenge-Response mit Replay-Schutz.** Der Origin-WebSocket signiert die
  kanonische Auth-Nutzlast (`homeess-auth-v1`). Die Challenge wird streng
  validiert (bekannte Felder, `clientType: homeess`, passende `identityId`,
  Protokollversion, Zeitfenster, keine doppelte Verarbeitung).
- **Tunnel nur für gekoppelte Geräte.** Nach `authenticated` verarbeitet homeESS
  Status-/Link-Nachrichten und bei `relayTunnel: true` streng validierte
  Tunnel-Nachrichten. Jeder Request wird an die aktive Verknüpfung gebunden und
  ausschließlich gegen den lokalen homeESS-HTTP-Server ausgeführt.
- **Redaction erweitert.** Private Key, PKCS8, Signatur, Proof, Nonce, Challenge,
  vollständige Public Keys sowie Tunnel-Headerwerte, Bodies, Tokens und Cookies
  werden nie geloggt; Fingerprints und Request-IDs dürfen gekürzt erscheinen.
- **Kein unsicherer Fallback.** Bei inkompatibler Relay-Version oder Beschädigung
  wird nicht auf ein altes Schema zurückgefallen und nicht still herabgestuft.

## App, Relay und Lizenz

Die Android-App und der essrelay-Server sind ein eigenständiges Add-on und nicht
Teil des AGPLv3-lizenzierten homeESS-Servers. Für die Nutzung über das Internet
ist die homeESS Remote Lizenz über den Google Play Store erforderlich. Ein
Nutzeraccount, eigenes VPN, Portfreigabe oder DynDNS sind nicht erforderlich.
