# homeESS – Threat Model (Fernzugriff / Pairing / Relay-Tunnel)

Dieses Dokument betrachtet Bedrohungen der vorbereitenden Pairing-Stufe
(`/remote-access`). Siehe auch [SECURITY.md](SECURITY.md) und
[ARCHITECTURE.md](ARCHITECTURE.md).

Legende: **[M]** mitigiert · **[T]** teilweise mitigiert · **[L]** später durch
Claim/Confirmation bzw. produktive Auth zu lösen.

## Bedrohungen

- **[M] Nicht authentifizierter Zugriff auf die Fernzugriffsseite/-API.**
  Seite und API verlangen eine gültige Admin-Session; die API antwortet
  unauthentifiziert mit `401`, die Seite leitet auf den Login um.

- **[M] CSRF löst Pairing-Erstellung/-Abbruch aus.** Verändernde Endpunkte
  verlangen einen Custom-Header (`X-HomeESS-Request: 1`) zusätzlich zum
  `SameSite=Lax`-Cookie; ohne CORS-Freigabe sind Cross-Origin-Aufrufe blockiert.

- **[M] XSS liest den Origin-Token aus.** Der Origin-Token verlässt den Server
  nie Richtung Browser; der Browser kennt nur das QR-PNG bzw. geprüfte
  Claim-Anzeigedaten. Views escapen Ausgaben; das QR-PNG wird als
  `data:`-Bild ohne HTML-Injektion gesetzt. (Ein genereller XSS-Fund bliebe
  dennoch ernst — der Origin-Token ist jedoch nicht im DOM.)

- **[T] Der QR-Code wird fotografiert / weitergegeben.** Der QR enthält ein
  kurzlebiges Geheimnis; die UI warnt ausdrücklich davor, ihn zu teilen. Das
  Risiko wird durch die kurze Gültigkeit (Minuten), die notwendige Bestätigung
  durch homeESS und den fehlenden Tunnel begrenzt.

- **[M] Browser cached die QR-/Statusantwort.** Alle lokalen Pairing-Antworten
  sind `no-store`/`no-cache`/`nosniff`; ab `awaiting_confirmation` und nach
  `expired`/`cancelled`/`confirmed`/`rejected` wird kein QR-Bild mehr
  ausgeliefert.

- **[M] Pairing-Secrets landen in Logs.** Redaction stellt sicher, dass
  Claim-/Origin-/Claimant-/alte Pairing-Tokens, Pairing-URI, QR-Base64 und
  Authorization-Header nie geloggt werden; geloggt werden nur öffentliche
  Pairing-ID, Status und technische Metadaten.

- **[M] Manipulierte Relay-Antwort.** Der Relay-Client validiert streng
  (HTTP-Status, getrennte Claim-/Origin-Tokens, PNG-Signatur, Base64,
  Ablaufdatum, Poll-Intervall-Bereich, bekannte Statuswerte,
  Claim-Anzeigedaten, Antwortgröße). Ungültiges wird zu
  `remote_access_invalid_response`, statt blind übernommen zu werden.

- **[M] Bösartige Relay-URL / SSRF.** Die Relay-Basis-URL ist serverseitig fest
  konfiguriert (`ESS_RELAY_BASE_URL`), wird streng validiert und nie aus einem
  Browser-Request übernommen; Redirects sind verboten. Es gibt keine frei
  wählbare Relay-URL im Pairing-Request.

- **[M] Doppelklick erzeugt mehrere Sessions.** Ein Promise-Lock je Owner
  serialisiert die Operationen; ein Doppel-POST verwendet die aktive Session
  wieder, statt eine zweite zu erzeugen.

- **[M] Paralleler Abbruch, Poll, Confirm und Reject.** Ebenfalls über den
  Owner-Lock serialisiert; genau ein terminaler Endzustand wird übernommen.

- **[M] Relay-Timeout / Relay nicht erreichbar.** Jeder Aufruf hat ein Timeout
  (`AbortController`); Fehler werden zu stabilen internen Codes. Ein einzelner
  Poll-Aussetzer führt zu Backoff, nicht zum sofortigen Fehlerzustand.

- **[T] homeESS-Neustart verliert die lokale Session.** Bewusst akzeptiert: kein
  Persistieren des Token-/QR-Zustands. Der Nutzer erzeugt danach einfach einen
  neuen Code.

- **[T] Relay-Session bleibt nach lokalem Neustart bis zur TTL bestehen.** Die
  beim Relay angelegte Session läuft dort nach ihrer kurzen TTL selbst ab; homeESS
  kann sie nach Neustart nicht mehr gezielt abbrechen (Origin-Token verloren). Durch die
  kurze Gültigkeit und den fehlenden Tunnel ist die Auswirkung gering.

## Dauerhafte Identität, Provisioning und Origin-WebSocket (essrelay 0.5.0)

- **[M] Diebstahl des Instanz-Private-Keys.** Der Schlüssel liegt nur lokal
  (Datei 0600, Verzeichnis 0700, Eigentümer = Servicebenutzer), verlässt nie den
  Prozess, wird nie geloggt/ausgegeben und ist über `.gitignore` von Git
  ausgeschlossen. Restrisiko bei kompromittiertem Host/Dateisystem.
- **[M] Manipulation des Identity Store / beschädigte Datei.** Laden prüft
  Algorithmus, Version, Größe, Symlink-Status, Fingerprint und Zugehörigkeit
  privat/öffentlich. Bei Inkonsistenz kontrollierter Fehler statt automatischer
  Neuerzeugung; der bestehende Schlüssel wird nie überschrieben.
- **[M] Public-/Private-Key-Mismatch.** Beim Laden wird der aus dem privaten
  Schlüssel abgeleitete Public Key byte-genau mit dem gespeicherten verglichen.
- **[M] Symlink-Angriff / Pfadtraversal / zu große Datei.** Öffnen mit
  `O_NOFOLLOW`, Größenlimits, `lstat`-Prüfungen; feststehendes, konfiguriertes
  Verzeichnis (kein aus Requests abgeleiteter Pfad).
- **[M] Manipuliertes Provisioning-Ergebnis / Gerätefingerprint-Mismatch.** Der
  Relay-Instanzfingerprint muss zum lokalen Schlüssel passen, der
  Gerätefingerprint zum Claim; ein Mismatch verhindert `paired`, scrubbt den
  Origin-Token nicht und baut keine WebSocket-Verbindung auf.
- **[M] Proof-/Challenge-Replay, doppelte/verspätete Challenge.** Proof-Nutzlasten
  binden Pairing-ID, Token-Hash und Fingerprints; die WebSocket-Challenge wird
  streng validiert (Zeitfenster, `identityId`, `clientType`, einmalige
  Verarbeitung je Verbindung).
- **[M] Falsche Pairing-ID / falscher Origin-Token-Hash.** Fließen in die
  signierte Nutzlast ein; ein falscher Wert erzeugt einen ungültigen Proof, der
  vom Relay abgelehnt wird.
- **[M] Connection Replacement / Reconnect-Sturm.** `connection_replaced` stoppt
  kontrolliert (kein wechselseitiges Verdrängen); Reconnect nur mit begrenztem
  Backoff und Jitter; dauerhafte Auth-Fehler enden in `failed`.
- **[T] Relay-Ausfall.** Der Origin-WebSocket ist ein optionaler Subdienst;
  Fehler blockieren den lokalen Betrieb nicht. Reconnect ist begrenzt und
  beobachtbar.
- **[T] Kompromittierter Relay.** homeESS behandelt den Relay als nicht
  vertrauenswürdig und prüft jede Antwort. Der Tunnel läuft über
  TLS/WebSocket-Transport und strikt validierte Nachrichten; ohne zusätzliche
  Ende-zu-Ende-Verschlüsselung bleibt der Relay jedoch eine technische
  Vertrauensgrenze für Metadaten und Transportabwicklung.
- **[T] Crash zwischen Confirm und Provisioning.** Kleines Zeitfenster; der
  In-Memory-Origin-Token geht bei Prozessabsturz verloren, die Relay-Session
  läuft per TTL ab, der Nutzer erzeugt einen neuen Code. Bewusst kein
  Klartext-Token auf Platte.

## Noch offen (spätere Stufen)

- **[L] Zusätzliche Ende-zu-Ende-Verschlüsselung** oberhalb des verschlüsselten
  Transports sowie ein öffentlicher Widerrufs-Endpunkt sind spätere
  Ausbaustufen. Lizenzprüfung/Billing liegen im eigenständigen App-/Relay-Add-on.
