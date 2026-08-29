# homeESS v1.6.1 – Wetterprognose

**v1.6.1** bringt die neue Seite **Wetterprognose** als letzten Punkt des
Hauptmenüs: die aktuelle Wetterlage, die kommenden drei Tage ausführlich mit
Stundenverlauf, ein Verlaufsdiagramm über den gesamten Zeitraum und eine
Kurzübersicht der weiteren vier Tage. Jeder Tag nennt zusätzlich den
**erwarteten PV-Ertrag**. Alle Werte stehen als States bereit, und fürs
Dashboard gibt es eine frei zusammenstellbare **Wetter-Kachel**.

## Hinzugefügt

### Seite „Wetterprognose"

Erreichbar unter **Wetterprognose** im Hauptmenü. Die Seite zeigt die aktuelle
Lage und die **kommenden drei Tage ausführlich**: Wetterlage, Höchst- und
Tiefsttemperatur, gefühlte Temperatur, Niederschlagswahrscheinlichkeit, -menge
und -stunden, Regen- und Schneemenge, Wind, Böen und Windrichtung, UV-Index mit
Belastungsstufe, Bewölkung, Luftfeuchte, Luftdruck, Sonnenauf- und -untergang
sowie Tageslicht- und Sonnenscheindauer. Jede Größe trägt ein Piktogramm.

Die Messgrößen stehen nicht in einer langen Kachelreihe, sondern in
**thematischen Blöcken** — *Temperatur · Niederschlag · Wind · Sonne und Licht ·
Luft*. Am Schreibtisch wird jeder Block eine **Spalte**; die Werte stehen darin
platzsparend als schmucklose Zeilen untereinander, Bezeichnung links, Wert
rechtsbündig auf gemeinsamer Fluchtlinie. Am Telefon bleibt es beim
Kachelraster.

Jeder Detailtag hat zusätzlich einen **Stundenverlauf** über die volle Breite
(Symbol, Temperatur, Niederschlagswahrscheinlichkeit als Balken, Menge und
Wind). Die **weiteren vier Tage** stehen darunter als Kurzübersicht mit dem
Wichtigsten je Zeile.

### Verlaufsdiagramm über den gesamten Prognosezeitraum

Zwischen aktueller Lage und dem ersten Tag läuft ein flaches Diagramm über alle
Tage: **Temperatur** als rote Linie (linke Achse), **Sonnenintensität** als
ockergelbe Linie (rechte Achse, Globalstrahlung in W/m², zur Nulllinie hin
halbtransparent gefüllt) und **Niederschlag** je Stunde als blaue Balken
dahinter. Tagesgrenzen, Tagesnamen und die laufende Stunde sind markiert. Die
Bauform ist bewusst flach, damit der Verlauf die Tageskacheln einordnet, statt
sie zu verdrängen.

Wie alle Ansichten von homeESS entsteht es **serverseitig als Inline-SVG** —
ohne Diagrammbibliothek im Browser. Es gibt zwei Bauformen: am Schreibtisch mit
Achsen und Beschriftungen im SVG, am Telefon eine schmale Form **ohne Schrift im
SVG** (Tagesnamen und Wertebereiche stehen als HTML darüber und darunter). So
bleibt die Beschriftung bei jeder Gerätebreite unverzerrt lesbar.

### Erwarteter PV-Ertrag je Tag

Der Titel jedes Detailtages und **jede** Kurzzeile der weiteren Tage nennt den
erwarteten PV-Ertrag. Die Zahl stammt aus der bestehenden PV-Prognose und wird
über den Tagesschlüssel zugeordnet; ohne Anlagen oder ohne Prognose entfällt die
Angabe ersatzlos.

### Wetter-Widget fürs Dashboard

Der neue Widget-Typ **Wetter** zeigt wahlweise die aktuelle Lage oder einen
einzelnen Prognosetag (heute … in 6 Tagen). **Welche Werte** die Kachel zeigt,
wird im Dialog je Messgröße einzeln angehakt: Temperatur, gefühlte Temperatur,
Niederschlag samt Wahrscheinlichkeit und Dauer, Regen- und Schneemenge, Wind,
Böen und Windrichtung, Luftfeuchte, Taupunkt, Luftdruck, Bewölkung, Sichtweite,
UV-Index mit Belastungsstufe, Sonnenintensität und Einstrahlung, Sonnenschein-
und Tageslichtdauer, Sonnenauf- und -untergang sowie der erwartete PV-Ertrag.
Größen, die es in der gewählten Anzeigeart nicht gibt — Sonnenaufgang kennt nur
ein Tag, Sichtweite nur der Istzustand — blendet der Dialog aus, statt sie leer
anzuzeigen. Die Kopfzeile mit Wetterlage und Leitwert steht immer.

Die Kachel **skaliert nach der Breite ihrer Gruppe**, nicht nach der
Fensterbreite: In einer Viertel-Gruppe steht sie einspaltig mit kompaktem Kopf,
in einer halben Gruppe zwei- bis dreispaltig mit Wert rechts neben der
Bezeichnung, in einer vollen Gruppe mehrspaltig mit großem Kopf — alles aus
**einer** Bauform im Markup. Gelesen wird ausschließlich der Cache der
Wetterprognose; der Dashboard-Aufbau wartet nie auf einen Netzabruf. Ohne
hinterlegten Standort behält die Kachel ihre Form und nennt den Grund; die Werte
trägt dann das periodische Nachladen nach.

### Systemgruppe „Wetter" mit 159 States

Die Werte stehen als Systemwerte unter `system://homeess/wetter.…` bereit,
sortiert in die Untergruppen *Aktuell*, *Standort*, *Tag 1 – Heute*, *Tag 2 –
Morgen*, *Tag 3 – Übermorgen* und *Weitere Tage*. Damit sind sie auf der
States-Seite, im State-Picker, im Wertekatalog, in Bedingungen und im Output
verwendbar. Die States existieren auch ohne hinterlegten Standort; ihre Werte
bleiben dann leer.

Dazu gehört die **Sonnenintensität** als Globalstrahlung
(`wetter.aktuell.sonnenintensitaet`, `wetter.tagN.sonnenintensitaetMax`,
`wetter.tagN.einstrahlung`). Sie ist bewusst getrennt von `sun.intensity.*`:
jene States messen die reale PV-Leistung gegen den Klarhimmel-Idealwert und
gelten nur für den Istzustand, während die Wetter-States eine **Vorhersage**
sind.

### Telefonansicht ohne Seitwärtsscrollen

Weder die Seite noch ein Abschnitt darin muss seitlich gescrollt werden: das
Diagramm schaltet auf die schmale Bauform um, und der Stundenverlauf zeigt statt
24 schmaler Spalten die acht vollen **3-Stunden-Schritte** (0, 3, 6 … 21), die
sich die Breite teilen — ein Hinweis in der Legende nennt das. Karten, Blöcke
und Kacheln laufen mit strafferen Abständen; die Messgrößen stehen zweispaltig.

### Eigenes Seitenrecht „Wetterprognose"

Die Seite lässt sich in der Benutzerverwaltung wie jede andere je Benutzer
freigeben oder ausblenden. Der Knopf **Aktualisieren** gilt dabei als lesender
Zugriff und steht deshalb auch der Rolle „Lesen" offen — er holt lediglich
Fremddaten ab und verändert nichts an der Anlage.

## Geändert

### PV-Prognose reicht jetzt sieben Tage

Der Strahlungsabruf der PV-Prognose deckt statt vier nun **sieben Tage** ab und
damit denselben Zeitraum wie die Wetterseite. In der Kurzübersicht der weiteren
Tage trägt dadurch **jede** Zeile einen erwarteten Ertrag statt nur der erste
Tag; der Prognosestreifen der Seite **Photovoltaik** zeigt entsprechend sieben
Tageskarten. Unverändert bleiben die veröffentlichten States (weiterhin
heute/morgen/+2/+3) und die Batteriesimulation der Prognoseseite, die weiterhin
mit vier Tagen rechnet. Zu beachten: Die Ertragswerte der hinteren Tage sind
naturgemäß deutlich unsicherer als die der ersten Tage.

### Stand der Prognose in korrigierter Zeit

Der Stand der Prognose (Kopfzeile der Seite und State `wetter.standort.stand`)
wird in der **in homeESS korrigierten Zeit** ausgegeben und nicht mehr in der
rohen Systemzeit — die Oberfläche zeigt damit überall dieselbe Uhr.

### „Aktualisieren" folgt Post/Redirect/Get

Der Knopf leitet nach dem Abruf auf `/wetter` um, statt die Seite direkt
auszuliefern. Sonst bliebe der Client — insbesondere die WebView der App, die
sich ihre zuletzt besuchte Adresse merkt — auf einer Adresse stehen, die nur
POST beantwortet; ein späterer Aufruf endete dann in
`Cannot GET /wetter/aktualisieren`. Wird die Adresse dennoch per GET geöffnet
(gemerkte Adresse, Lesezeichen, Verlauf), führt sie jetzt zurück auf die Seite.

## Adapter

Die mitgelieferten Adapter werden eigenständig versioniert. Seit v1.6.0 neu:

- **hm-rpc 1.1.5** — behebt, dass ein einzelnes funktechnisch nicht
  erreichbares Gerät die ganze CCU-Anbindung lahmlegen konnte: Eine
  Fehlerquittung der CCU („Generic error (UNREACH)") galt als
  Verbindungsabbruch, worauf bis zum nächsten Reconnect die Steuerbefehle
  **aller** Homematic-Geräte mit „verworfen: CCU nicht verbunden" abgewiesen
  wurden. Ein CCU-Fehler mit XML-RPC-Fehlercode gilt jetzt als Geräteproblem und
  lässt die Verbindung unangetastet. Dazu ein eigenes, längeres Zeitlimit für
  Steuerbefehle (30 s) und die Wiederholbarkeit eines unbestätigten Befehls.
- **hDP 1.2.12** — Online-Firmwarekatalog samt Prüfknopf; mit der Installation
  kommt keine Firmware mehr mit.

Einzelheiten stehen im jeweiligen CHANGELOG des Adapters.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.6.1**. Adapterstände: hDP **1.2.12**,
  Zigbee **1.3.4**, InfluxDB **1.0.3**, hm-rpc **1.1.5**, Modbus **1.1.2**,
  MQTT-Broker **1.0.2**, Tasmota **1.0.2**, Renault **1.0.0**, Shelly
  **1.0.0**.
- Die Wetterprognose braucht einen **hinterlegten Standort**. Ohne ihn bleibt
  die Seite erreichbar, nennt aber den Grund; die States existieren mit leeren
  Werten.
- Die Wetterdaten stammen wie bisher von **Open-Meteo** (kostenlos, ohne
  API-Key), jedoch aus einer **eigenen** Abfrage mit eigenem 30-Minuten-Cache
  und eigenem Hintergrund-Job. Die Strahlungsabfrage der PV-Prognose bleibt
  davon getrennt; lediglich ihr Tageshorizont ist derselbe. Rohdaten der
  Prognose liefert `GET /wetter/daten`.
- Es gibt **keine Datenbankänderung**; ein manueller Eingriff ist nicht nötig.
- Die 159 Wetter-States entstehen beim ersten Start von selbst. Bestehende
  Bedingungen, Automatiken und Dashboards sind davon nicht betroffen.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten,
  damit die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
