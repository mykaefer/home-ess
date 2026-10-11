# CLAUDE.md – Arbeitsanleitung für dieses Repository

Kurzanleitung für KI-Assistenten und neue Mitwirkende. Ausführlicher Kontext:
[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) · Architektur:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Projekt in einem Satz

homeESS ist ein Node.js/Express-Server (Einstieg `server.js` → `src/app.js`), der
MQTT-Topics abonniert, Zustände in SQLite hält und ein server-gerendertes
Web-Dashboard mit Login ausliefert.

## Konventionen

- **Ein** HTTP-Server, **ein** Auth-System (Cookie-Sessions, `src/auth/`), **ein**
  Frontend (server-gerenderte Views unter `src/views/`, gemeinsames Layout
  `src/views/layout.js`, Styles `public/styles.css`). Keine parallelen Frontends,
  kein zweiter Server, kein eigenes Auth-System einführen.
- Routen unter `src/routes/`, Fachlogik unter `src/<domäne>/`. Neue Seiten binden
  sich über `renderLayout(...)` und die Navigation in `layout.js` ein.
- Views escapen Ausgaben mit `escapeHtml` (`src/views/components.js`).
- Geschützte Seiten verwenden `requireAuth`; JSON-APIs geben bei fehlender Session
  `401` statt Redirect zurück.
- Deutschsprachige Kommentare und UI-Texte, passend zum Bestand.

## Pflichtprüfungen

Vor Abschluss ausführen:

```bash
npm test        # node --test über test/*.test.js
```

Es gibt derzeit **keine** `typecheck`-, `build`-, `lint`- oder `format:check`-
Skripte — nicht erfinden und keine Prüfungen abschalten, um Fehler zu umgehen.

## Versionierung

Änderungen werden zunächst ausschließlich unter `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md) eingetragen. Solange sie dort stehen, bleibt die
Versionsnummer unverändert. **Keine automatische Versionserhöhung:** Erst auf
**ausdrückliche Anweisung des Betreibers zum Hochzählen** wird die Patch-Stelle
um eins erhöht (…, 1.2.6 → 1.2.7; kein Semver-Raten).

Mit dieser Versionserhöhung wird zeitgleich der gesamte Unreleased-Block in
einen neuen Versionsabschnitt mit Datum übernommen
(`## [1.2.7] — JJJJ-MM-TT`). `## [Unreleased]` bleibt anschließend als leerer
Abschnitt für kommende Änderungen bestehen. Versionserhöhung und Versionierung
des Unreleased-Blocks erfolgen immer gemeinsam.

Maßgeblich ist [VERSION.json](VERSION.json) im Stammverzeichnis: Fußzeile der
Weboberfläche und Updateprüfung lesen von dort. Bei der ausdrücklich
angeforderten Versionserhöhung werden `VERSION.json`, `package.json` und die
Versionsangaben des Hauptpakets in `package-lock.json` gemeinsam auf denselben
Wert gesetzt. Jeder Zweig (`main`, `development`) führt seine eigene Nummer;
ein Merge darf die fremde Nummer nicht übernehmen.

## Commit/Push

Der Betreiber committet und pusht **selbst**. Assistenten nehmen nur
Working-Tree-Änderungen vor und führen keine `git commit`/`git push` ungefragt
aus. Keinen produktiven Neustart (`systemctl restart …`) ungefragt ausführen und
die reale Environment-Datei nicht verändern.

## Fernzugriff / Pairing

Siehe [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md) und
[THREAT_MODEL.md](THREAT_MODEL.md). Die App-/Relay-Schnittstelle ist Teil des
eigenständigen proprietären Add-ons und wird nicht öffentlich dokumentiert.
Wichtig:

- Datenfluss strikt `Browser → homeESS → essrelay`; der Browser spricht nie
  direkt mit dem Relay.
- Der Pairing-Token bleibt serverseitig im Speicher, wird nie an den Browser
  ausgegeben, nie persistiert und nie geloggt (siehe `src/remote-access/redact.js`).
- Relay-Basis-URL ausschließlich serverseitig über `ESS_RELAY_BASE_URL` (SSRF);
  Origin-WebSocket-URL aus der Basis-URL abgeleitet bzw. `ESS_RELAY_WS_URL`.
- Der **private Instanzschlüssel** (Ed25519, Identity Store unter
  `HOME_ESS_IDENTITY_DIR`, Default `<data>/identity`) bleibt lokal: nie an den
  Browser, nie an den Relay, nie loggen, nie in Git (0600/0700). Keine eigene
  Kryptografie — nur Node `crypto`.
- `confirmed` ist **nicht terminal**: Origin-Token bleibt bis `paired` erhalten;
  Confirm orchestriert Provisioning (idempotent/retriable) → `paired`, danach
  authentifizierter Origin-WebSocket mit Relay-Tunnel für gekoppelte Geräte.
  App und Relay sind ein eigenständiges Add-on; Internet-Nutzung erfordert die
  homeESS Remote Lizenz aus dem Google Play Store.
- Keine proprietären App-/Relay-Schnittstellendetails in öffentliche homeESS-
  Dokumentation eintragen.
