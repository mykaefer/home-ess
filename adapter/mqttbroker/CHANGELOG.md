# Changelog – MQTT-Broker-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.0.2] — 2026-08-22

### Geändert

- **Die Verwaltungsseite folgt dem Farbthema des Benutzers.** homeESS bietet je
  Benutzer ein helles oder dunkles Farbthema an. Die Festfarben dieses Adapters
  laufen dafür jetzt über die Design-Tokens von homeESS (Flächen, Linien, Text
  und Zustandsfarben), sodass die Seite im dunklen Thema mitzieht, statt weiße
  Kästen mit dunkler Schrift stehen zu lassen. Im hellen Thema bleibt die
  Darstellung unverändert — die Tokens tragen dort dieselben Werte.

- **Die Plakette am Topic-Baum** nutzt jetzt die Textstufe des Themas statt
  eines festen Grautons und bleibt damit auch auf dunklem Grund lesbar.

## [1.0.1] — 2026-08-17

### Geändert

- **Ausgespart bleibt nur noch die eigene Instanz, nicht der gesamte eigene
  Prefix.** Andere MQTT-Broker-Instanzen sind gewöhnliche Fremd-States und
  erscheinen im `states/`-Baum unter `states/mqttbroker/<instanz>/…` — samt
  Schreibrecht, denn ihre Geräte-States sind schreibbar. Die eigene Instanz
  bleibt außen vor, sonst spiegelte sie sich selbst.
- **Punkte in der State-Adresse öffnen im `states/`-Baum eine eigene Topic-Ebene**
  (`system://homeess/geraet.3.leistung` → `states/system/homeess/geraet/3/leistung`
  statt bisher `states/system/homeess/geraet.3.leistung`). Die homeESS-
  Systemwerte gliedern sich mit Punkten; ohne diese Regel lagen mehrere hundert
  States flach in einem einzigen Verzeichnis.
  **Achtung:** Abos und Retained Messages auf die alten, punktbehafteten Pfade
  greifen nicht mehr — betroffene Clients müssen auf die neuen Topics umgestellt
  werden. Geräte-Topics und die Rückabbildung auf die homeESS-Adressen bleiben
  unverändert.
- Bilden zwei States nach dieser Regel dasselbe Topic (etwa `a.b` und `a/b`),
  behält der erste es; der zweite bleibt unsichtbar und wird protokolliert.

### Hinzugefügt

- **Topic-Browser auf der Verwaltungsseite.** Alle über MQTT erreichbaren Topics
  der Instanz stehen als aufklappbarer Verzeichnisbaum bereit: die von Clients
  angelegten Geräte-Topics und — sofern freigeschaltet — der Systembaum unter
  `states/`. Jede Ebene zeigt die Anzahl der States darunter, jede State-Zeile
  den letzten bekannten Wert und ein Schloss bei schreibgeschützten States. Ein
  Suchfeld filtert über Klarname und Pfad zugleich, „Alle aufklappen"/„Alle
  zuklappen" öffnet und schließt den Baum.
- **Zwei Gliederungen.** Vorgabe ist die **homeESS-Struktur** — dieselben Ebenen
  wie im States-Baum (Kategoriepfad) mit dem Klarnamen des States und dem
  vollständigen MQTT-Pfad daneben. Umschaltbar auf die **MQTT-Pfad**-Gliederung,
  die dem Topic folgt und den Klarnamen neben dem Pfadabschnitt zeigt.
- **Verzeichnis „MQTT-Geräte / <Instanz>" je Broker.** Dort sammeln sich die
  Topics, die MQTT-Clients selbst anlegen — für jede Broker-Instanz eines. Das
  Verzeichnis der eigenen Instanz steht auch dann im Baum, wenn noch kein Client
  etwas veröffentlicht hat: es ist der einzige Bereich, in dem Clients States
  frei anlegen dürfen (im `states/`-Baum entstehen keine neuen States).
- **Kopierknopf je Zeile.** Er legt den vollständigen MQTT-Pfad in die
  Zwischenablage — bei Verzeichnissen der MQTT-Gliederung den passenden
  Abo-Filter mit `/#`. Ohne HTTPS steht die Clipboard-API des Browsers nicht
  bereit; dann greift ein Rückfallweg, notfalls über einen Kopierdialog.
- Die Topic-Liste wird getrennt von der Seite geladen (`GET …/manage/topics`,
  Leserecht vorausgesetzt), damit große Installationen das HTML nicht aufblähen;
  jede Gliederung wird einmal geholt und danach zwischengespeichert.

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
