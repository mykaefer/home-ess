# AGENTS.md

Anleitung für Coding-Agenten in diesem Repository. Der Inhalt ist identisch zu
[CLAUDE.md](CLAUDE.md) — bitte dort lesen.

Kernpunkte:

- **Bestand nutzen:** ein HTTP-Server, ein Auth-System (`src/auth/`), ein
  Frontend (`src/views/`, `public/styles.css`). Keine parallelen Strukturen.
- **Pflichtprüfung:** `npm test` (node --test). Es gibt keine typecheck-/build-/
  lint-/format-Skripte; keine erfinden, keine Prüfungen abschalten.
- **Versionierung:** Patch-Stelle hochzählen (kein Semver-Raten). Änderungen unter
  `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- **Commit/Push macht der Betreiber selbst.** Kein ungefragter produktiver
  Neustart, keine Änderung der realen Environment-Datei.
- **Fernzugriff/Pairing:** Datenfluss `Browser → homeESS → essrelay`; Token bleibt
  serverseitig, nie an den Browser, nie persistiert, nie geloggt; Relay-Basis-URL
  nur serverseitig (`ESS_RELAY_BASE_URL`). Dauerhafte Ed25519-Instanzidentität im
  Identity Store (`HOME_ESS_IDENTITY_DIR`, 0600/0700) — privater Schlüssel bleibt
  lokal, nur Node `crypto`. `confirmed` ist nicht terminal (Origin-Token bis
  `paired`); Confirm→Provisioning→`paired`, danach authentifizierter Origin-
  WebSocket mit Relay-Tunnel für gekoppelte Geräte. App und Relay sind ein
  eigenständiges Add-on; Internet-Nutzung erfordert die homeESS Remote Lizenz
  aus dem Google Play Store. Die App-/Relay-Schnittstelle ist proprietär und
  wird nicht öffentlich dokumentiert. Details zum homeESS-Server in
  [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md),
  [THREAT_MODEL.md](THREAT_MODEL.md).
