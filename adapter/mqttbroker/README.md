# MQTT-Broker-Adapter

Betreibt einen eigenständigen MQTT-Broker (Server) innerhalb von homeESS.
Beliebige MQTT-Clients — ESP-Geräte, Zigbee2MQTT, Skripte, Fremdsysteme —
verbinden sich direkt mit dieser Instanz, ohne dass ein externer Broker nötig
ist. Das Regelwerk für Adapter steht in [ADAPTER.md](../../ADAPTER.md).

## Geräte legen ihre States selbst an

Jedes Topic, auf das ein verbundener Client veröffentlicht, wird zur
State-Adresse dieser Instanz:

```
MQTT-Topic   haus/wohnzimmer/temperatur
homeESS      mqttbroker://<instanz>/haus/wohnzimmer/temperatur
```

Der letzte Topic-Abschnitt ist der Anzeigename, die übrigen bilden den
Kategoriepfad unter „MQTT-Geräte" im States-Baum. Alle so entstandenen States
sind schreibbar: Schreibt homeESS darauf (Output-Engine, Bedienelement), sendet
der Broker den Wert als Retained Message an die Abonnenten des Topics.

Nutzlasten werden zu Zahl, Boolean oder Text ausgewertet (`21.5`, `ON`, `aus`).
Mit der Einstellung **JSON-Nutzlast auswerten** wird zusätzlich die
ioBroker-Form `{"val": 21.5, "ack": true}` ausgepackt.

## Idle-Haltezeit

States, die länger als die eingestellte **Idle-Haltezeit** nicht mehr
aktualisiert wurden, entfernt der Adapter vollständig: aus dem State-Katalog,
aus der eigenen Ablage und als Retained Message (leere Nachricht an die
Abonnenten). Damit hinterlässt ein umbenanntes oder abgebautes Gerät keine
Karteileichen im System. `0` schaltet die Bereinigung ab; geprüft wird einmal
pro Minute. Zusätzlich begrenzt **Maximale Anzahl Geräte-States**, wie viele
Topics eine Instanz überhaupt anlegen darf.

Ein Gerät kann seinen State auch selbst abräumen: Eine **leere Retained Message**
auf ein Topic (`publish("haus/alt", "", { retain: true })`) ist die
MQTT-Löschsemantik und entfernt den zugehörigen State sofort.

Die bekannten States werden im Datenverzeichnis der Instanz
(`device-states.json`) gesichert und beim Start wiederhergestellt — bereits
abgelaufene States werden dabei gar nicht erst übernommen.

## Systemweiter State-Zugriff (`states/`)

Mit der Einstellung **Systemweiten State-Zugriff gewähren** erscheint der
gesamte homeESS-States-Baum unterhalb von `states/`. Aus jedem Prefix wird ein
einfaches Unterverzeichnis:

```
hdp://wohnzimmer/messwerte/temperatur  →  states/hdp/wohnzimmer/messwerte/temperatur
system://homeess/pv.current            →  states/system/homeess/pv/current
system://homeess/geraet.3.leistung     →  states/system/homeess/geraet/3/leistung
custom://Heizung/Sollwert              →  states/custom/Heizung/Sollwert
```

Regeln in diesem Baum:

- **Punkte in der State-Adresse öffnen eine eigene Ebene** — genau wie
  Schrägstriche. Die homeESS-Systemwerte gliedern sich mit Punkten
  (`geraet.3.leistung`); ohne diese Regel läge der gesamte Systembaum flach in
  einem einzigen Verzeichnis. Die Rückabbildung auf die homeESS-Adresse läuft
  über eine Tabelle, bleibt also exakt.

- **Die eigene Instanz bleibt ausgespart.** Sonst käme jeder eigene Wert als
  `states/mqttbroker/<eigene Instanz>/...` zurück und würde erneut als
  Broker-Wert verarbeitet — eine Endlosschleife. **Andere Broker-Instanzen**
  sind dagegen gewöhnliche Fremd-States und erscheinen unter
  `states/mqttbroker/<instanz>/…`; ihre Geräte-States sind schreibbar.
- **Es gelten die Schreibrechte der States.** Ein Publish auf einen als
  schreibbar geführten State wird an homeESS weitergereicht; auf einen
  schreibgeschützten State wird es verworfen und einmal pro Minute protokolliert.
- **Neue States entstehen hier nicht.** Ein Publish auf ein unbekanntes
  `states/`-Topic wird verworfen — es entsteht weder ein Geräte-State noch ein
  Eintrag im Systembaum.
- **Eindeutigkeit geht vor.** Bilden zwei States auf dasselbe Topic ab (etwa
  `a.b` und `a/b`), behält der erste es; der zweite bleibt unsichtbar und wird
  im Protokoll gemeldet.
- Gespiegelt wird **nur, was ein Client abonniert hat** (Lazy-Abo). Ein Abo auf
  `states/hdp/#` bindet ausschließlich die passenden States ein.
  **Maximal gespiegelte System-States** deckelt die Menge,
  **Katalogabgleich (Sekunden)** bestimmt, wie schnell neue oder entfernte
  States nachgezogen werden.

Werte werden als Retained Messages ausgeliefert; ein neu verbundener Client
erhält den letzten Stand also sofort.

## Topic-Browser

Die Verwaltungsseite („Broker") enthält einen Topic-Browser: alle über MQTT
erreichbaren Topics dieser Instanz als aufklappbaren Verzeichnisbaum — die von
Clients angelegten Geräte-Topics und, sofern freigeschaltet, der Systembaum
unter `states/`.

Zwei Gliederungen stehen zur Wahl:

- **homeESS-Struktur** (Vorgabe): derselbe Aufbau wie der States-Baum. Die
  Verzeichnisse sind die Kategorien des States (`System / Geräte`), das Blatt
  trägt seinen Klarnamen („Poolpumpe – Leistung") und daneben den vollständigen
  MQTT-Pfad. So findet man das Topic zu einem State, den man aus der Oberfläche
  kennt.
- **MQTT-Pfad**: die Gliederung des Topics selbst (`states ▸ system ▸ homeess ▸
  geraet ▸ 3 ▸ leistung`). Hier steht der Klarname neben dem Pfadabschnitt —
  sonst hieße die Zeile nur „3".

In der homeESS-Gliederung sammelt **`MQTT-Geräte / <Instanz>`** die Topics, die
MQTT-Clients selbst anlegen — je Broker-Instanz ein Verzeichnis, die eigene
eingeschlossen. Es steht auch dann im Baum, wenn noch kein Client etwas
veröffentlicht hat: Nur dort dürfen Clients States frei anlegen, im
`states/`-Baum darunter nicht.

Weitere Eigenschaften:

- Jede Verzeichniszeile zeigt, wie viele States darunter liegen.
- Jede State-Zeile zeigt den letzten bekannten Wert und bei schreibgeschützten
  States ein Schloss; der Tooltip nennt MQTT-Pfad und homeESS-Adresse.
- Der **Kopierknopf** am Zeilenende legt den MQTT-Pfad in die Zwischenablage; bei
  Verzeichnissen der MQTT-Gliederung den passenden Abo-Filter
  (`states/system/homeess/geraet/#`). Kategorien der homeESS-Gliederung haben
  keinen eigenen Pfad und deshalb auch keinen Kopierknopf.
- Das Suchfeld filtert über Klarname und Pfad zugleich und klappt passende
  Ebenen automatisch auf.

Die Werte des Systembaums stammen aus dem letzten Katalogabgleich; für States,
die gerade ein Client abonniert hat, aus der Retained-Ablage des Brokers. Die
Diagnose-States (`$SYS/…`) erscheinen nicht: sie existieren nur in homeESS und
werden nicht über den Broker verteilt.

Ohne HTTPS gibt der Browser die Clipboard-API nicht frei; der Kopierknopf
verwendet dann einen Rückfallweg und zeigt notfalls einen Kopierdialog.

## Diagnose

Unter der Kategorie „Broker" meldet die Instanz `$SYS/clients`, `$SYS/states`,
`$SYS/mirrors` und `$SYS/online`. Clients können auf `$`-Topics weder
veröffentlichen noch werden sie von Wildcard-Abos erfasst.

Die Verwaltungsseite („Broker") zeigt verbundene Clients, alle Geräte-States mit
ihrem Alter und erlaubt Benutzern mit Schreibrecht das Entfernen einzelner oder
aller States.

## Protokollumfang

MQTT 3.1 und 3.1.1 über TCP: CONNECT/CONNACK mit Benutzername/Kennwort und
optionalem IP-Bereich, PUBLISH mit QoS 0/1/2 (eingehend vollständig quittiert,
QoS 2 exactly once), SUBSCRIBE/UNSUBSCRIBE mit `+`/`#`, Retained Messages,
Last Will, Keepalive. Ausgeliefert wird grundsätzlich mit QoS 0; Sitzungen
werden nicht über die Verbindung hinaus gehalten (`sessionPresent = 0`). TLS
bietet der Adapter nicht an — der Broker gehört ins lokale Netz, bei Bedarf
über **Netzwerkadresse** und **Erlaubter IP-Bereich** eingegrenzt.

Die Paketkodierung übernimmt `mqtt-packet` aus den homeESS-Abhängigkeiten
(wie beim Tasmota-Adapter); darüber hinaus benötigt der Adapter nichts.
