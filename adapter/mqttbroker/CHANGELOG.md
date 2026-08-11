# Changelog – MQTT-Broker-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.0.0] — 2026-08-11

### Hinzugefügt

- **Eigenständiger MQTT-Broker.** Der Adapter betreibt einen MQTT-Server
  (MQTT 3.1 und 3.1.1 über TCP) für beliebige Clients: CONNECT mit
  Benutzername/Kennwort und optionalem IP-Bereich, PUBLISH mit QoS 0/1/2
  eingehend (QoS 2 exactly once über PUBREC/PUBREL/PUBCOMP),
  SUBSCRIBE/UNSUBSCRIBE mit `+`- und `#`-Wildcards, Retained Messages, Last Will
  und Keepalive-Überwachung. Zugestellt wird grundsätzlich mit QoS 0; Sitzungen
  werden nicht über die Verbindung hinaus gehalten.
- **Geräte legen ihre States selbst an.** Jedes Topic, auf das ein verbundener
  Client veröffentlicht, wird zur State-Adresse unter
  `mqttbroker://<instanz>/<topic>`. Der letzte Topic-Abschnitt ist der
  Anzeigename, die übrigen bilden den Kategoriepfad unter „MQTT-Geräte". Alle so
  entstandenen States sind schreibbar: Schreibt homeESS darauf, sendet der
  Broker den Wert als Retained Message an die Abonnenten.
- **Idle-Haltezeit.** States, die länger als die eingestellte Dauer nicht mehr
  aktualisiert wurden, werden vollständig entfernt — aus dem State-Katalog, aus
  der eigenen Ablage und als Retained Message. Geprüft wird einmal pro Minute,
  `0` schaltet die Bereinigung ab. Zusätzlich begrenzt eine Mengenobergrenze,
  wie viele States eine Instanz überhaupt anlegen darf.
- **Ausdrückliches Abräumen durch das Gerät.** Eine leere Retained Message auf
  ein Topic entfernt den zugehörigen State sofort (MQTT-Löschsemantik).
- **Persistenz der Geräte-States.** Bekannte States werden im Datenverzeichnis
  der Instanz (`device-states.json`) gesichert und beim Start wiederhergestellt;
  bereits abgelaufene States werden dabei nicht übernommen.
- **Optionaler systemweiter State-Zugriff.** Ist er in den Instanzeinstellungen
  aktiviert, erscheint der gesamte homeESS-States-Baum unter `states/`; aus
  jedem Prefix wird ein einfaches Unterverzeichnis (`hdp://…` →
  `states/hdp/…`, `system://…` → `states/system/…`). Der eigene Prefix
  `mqttbroker://` bleibt ausgespart, damit keine Endlosschleife entsteht.
  Es gelten die bei den States hinterlegten Schreibrechte: Publishes auf
  schreibgeschützte States werden verworfen und protokolliert. Im `states/`-Baum
  werden grundsätzlich keine neuen States angelegt.
- **Bedarfsgetriebene Spiegelung.** Abonniert wird nur, was ein Client
  tatsächlich angefragt hat; eine Obergrenze deckelt die Menge gleichzeitig
  gespiegelter States, ein Katalogabgleich zieht neue oder entfernte States
  periodisch nach.
- **Diagnose-States** `$SYS/clients`, `$SYS/states`, `$SYS/mirrors` und
  `$SYS/online` unter der Kategorie „Broker". Clients können auf `$`-Topics
  weder veröffentlichen, noch werden diese von Wildcard-Abos erfasst.
- **Verwaltungsseite „Broker"** mit Status, verbundenen Clients und allen
  Geräte-States samt Alter. Benutzer mit Schreibrecht können einzelne oder alle
  States entfernen.
- **Sprachdateien** für Deutsch und Englisch.

### Voraussetzungen

- homeESS ab 1.4.4 (`host.listStates()` in der Host-API, siehe `ADAPTER.md`).
  Fehlt die Methode, bleibt nur der systemweite State-Zugriff wirkungslos; der
  Brokerbetrieb selbst funktioniert unverändert.
