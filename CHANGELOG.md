# Changelog

Alle nennenswerten Änderungen an homeESS. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.6.2] — 2026-08-30

### Hinzugefügt

- **Klimaanlagen lassen sich übersteuern.** Ist in einem Raum von *Heizung &
  Klima* eine Klimaanlage zum Kühlen eingerichtet (eine „Kühlen ein"-Folge),
  legt homeESS unter *System* die neue Gruppe **Klima** an — mit einem
  Unterordner je Raum und darin zwei Werten:
  - **Betriebsart** (beschreibbar): `0` = Aus, `1` = An, `2` = Automatik
    (`system://homeess/klima.<Raum>.betriebsart`; auch „aus"/„an"/„auto" werden
    angenommen, ein unbrauchbarer Wert bleibt folgenlos).
  - **Aktiv** (nur lesend): ob die Anlage gerade läuft
    (`system://homeess/klima.<Raum>.aktiv`).

  In der **Raumübersicht** steht bei jedem Raum mit eingerichteter Klimaanlage
  ein **Umschalter An / Aus / Automatik** — dieselben Schaltflächen wie bei den
  Pumpenmodi der Poolsteuerung, mit der aktuellen Betriebsart markiert. Er
  schaltet ohne Seitenneuaufbau (`POST /heizung/raum/<id>/klima/<0|1|2>`) und
  zählt als **Bedienen**, steht also auch der Rolle *bedienen* offen. Räume ohne
  Kühlgerät lassen die Spalte leer.

  Je Raum lässt sich unter *Heizung & Klima → Raum → Klimaanlage* zusätzlich
  eine **Uhrzeit** hinterlegen, zu der eine Handschaltung von selbst auf
  Automatik zurückfällt (leer = keine). Maßgeblich ist die erste Fälligkeit
  **nach** dem Umschalten: wer um 23:00 Uhr auf „An" stellt, dessen Rückkehr um
  22:00 Uhr kommt am folgenden Tag. Gerechnet wird in lokaler Wandzeit über den
  zentralen Timehandler, und der Zeitpunkt der Handschaltung liegt in der
  Datenbank — ein Neustart holt eine verpasste Rückkehr nach, statt sie zu
  verlieren.

  „Aus" und „An" setzen die automatischen Aktionsschleifen des Kühlgerätes aus:
  die Anlage reagiert dann weder auf einen offenen Fenster-/Türkontakt noch auf
  die Raumtemperatur, sondern bleibt in ihrem geschalteten Zustand stehen.
  Zurück auf **Automatik** springt sie beim Erreichen der eingestellten
  **Soll-Temperatur** — und, sofern gesetzt, spätestens zur Rückkehr-Uhrzeit des
  Raums. Für die Soll-Temperatur gilt: gemeint ist der Übergang dorthin; war der
  Sollwert beim Umschalten bereits erreicht, hebt das die Handschaltung nicht
  sofort wieder auf. Vorrang behält das **Betriebslevel**: deckt es die
  Priorität des Kühlgerätes nicht ab, bleibt die Anlage auch bei „An" aus und
  läuft wieder an, sobald das Level sie freigibt. Heizen, Wärmeanforderung an
  die Zentralheizung und der Heizkörperlüfter bleiben von der Übersteuerung
  unberührt. Die eingestellte Betriebsart überlebt einen Neustart; die
  Raumübersicht zeigt eine aktive Handschaltung als Marke an.

- **Beschreibbare States lassen sich direkt auf der States-Seite bedienen.**
  Jede Zeile eines beschreibbaren States bekommt in der Übersicht ihr passendes
  Bedienelement:
  - **Ein/Aus** für Schaltzustände (Boolean-States ebenso wie 1/0-States — der
    geschriebene Wert richtet sich nach der Darstellung des Ziel-States),
  - eine **Auswahl** für Werte mit fester Bedeutung (etwa die Betriebsart einer
    Klimaanlage: Aus/An/Automatik),
  - ein **Feld mit „Setzen"** für Zahlen und Texte (Zahlenfelder übernehmen
    Grenzen und Schrittweite der Quelle, die Eingabetaste setzt ebenfalls).

  Welches Element erscheint, meldet die Quelle mit: Module liefern es zu ihren
  Schreibzielen (Soll-Temperatur, Schornsteinfeger-Modus, Klima-Betriebsart),
  Custom States leiten es aus ihrem Datentyp ab, und für Adapter-States — die
  nur melden, *dass* sie beschreibbar sind — wird es aus dem zuletzt gesehenen
  Wert abgeleitet. Geschrieben wird über `POST /states/value` und damit
  denselben Weg wie aus einer Aktionsfolge (Systemwert-Schreibziele, Custom
  States, Adapter oder Broker); angenommen werden ausschließlich States, die
  ihre Quelle als beschreibbar meldet. Das Setzen zählt als **Bedienen** und
  steht damit auch der Rolle *bedienen* offen — Leser bekommen die
  Bedienelemente gar nicht erst ausgeliefert. Die Elemente ziehen mit den
  Live-Werten nach; eine begonnene Eingabe bleibt dabei unangetastet.

- **Wert-Widgets des Dashboards nehmen eine eigene Beschriftung an.** Im
  Widget-Dialog steht unter dem State das optionale Feld *Bezeichnung*; bleibt
  es leer, trägt die Kachel wie bisher den Namen des States. Ist es gefüllt,
  zeigt die Kachel diesen Text und nennt im Tooltip zusätzlich den State, aus
  dem der Wert stammt. Gespeichert wird die Beschriftung wie beim
  Schalter-Widget als `label` in der Widget-Konfiguration — Bestands-Widgets
  bleiben unverändert.

- **Der systemweite Topic-Picker öffnet doppelt so breit**, sofern der Platz es
  zulässt: statt fester 460 px nimmt er bis zu 920 px und weicht nur dem
  Viewport (auf schmalen Geräten bleibt es wie bisher bei der verfügbaren
  Breite). Lange State-Namen und ihre Werte stehen dadurch nebeneinander,
  ohne abgeschnitten zu werden.

- **Neue Seite „Energie"** (`/energie`) an **zweiter Stelle** des Hauptmenüs,
  direkt hinter dem Dashboard. Sie fasst die Eckdaten der Energieseiten auf
  einer Seite zusammen: **Photovoltaik** (aktuelle Leistung, Ertrag heute,
  Woche, Jahr mit Vorjahresvergleich), **Stromverbrauch** (Eigenverbrauch und
  Netzbezug — aktuell, heute, Woche, Jahr) und **Batterie** (Ladezustand mit
  Mindest-SoC, Leistung, nutzbare Energie und Kapazität, Spannung und
  Temperatur, dazu der SoC-Balken). Ist das Modul **Grid-Control** aktiv, kommt
  dessen Schaltzustand dazu; den Abschluss bildet die **Prognose** mit ihrer
  Ampelbewertung als Chip (*Gut versorgt · Knapp kalkuliert · Mindeststand in
  Sicht*), PV- und Verbrauchsrest des Tages, Netzbedarf sowie SoC am Tagesende
  mit Autarkie-Angabe. Jeder Abschnitt trägt Titel und Schaltfläche als Sprung
  auf die zugehörige Seite. Die Werte aktualisieren sich wie auf den Fachseiten
  über `/energie/data` (MQTT-Ereignis und Minutentakt). Die Übersicht liest
  ausschließlich — sie schreibt keine Summen fort und stößt keinen Netzabruf an
  (Prognose wie auf der Prognoseseite nur aus dem Cache).

- **Schleifen und Pausen in den Bedingungen.** Der **Dann-** und der
  **Sonst-Zweig** sind jetzt vollwertige **Aktionsfolgen** — dieselben Bausteine
  wie in den Aktionsfolgen von *Heizung & Klima* und *Heimkino*:
  - **Wert zuweisen** wie bisher (fester Wert oder Topic, Rechenfunktion,
    Rundung), **Pause** (Sekunden) und **Schleife** mit einstellbarer Zahl an
    **Durchläufen**. Schleifen sind beliebig verschachtelbar und nehmen jede
    Aktionsart auf.
  - **Zyklische Prüfung je Schleife** (optional): im eingestellten Abstand wird
    eine Bedingung erneut bewertet; trifft sie nicht zu, wird **ausschließlich
    diese Schleife** noch einmal abgespult — die Plausibilitätsprüfung, mit der
    sich ein tatsächlich erreichter Zustand absichern lässt (z. B. „Rollladen
    meldet 100 %"). Geprüft wird nur der Zweig, der zuletzt gelaufen ist.
  - Die Folge läuft **von oben nach unten**, die **Reihenfolge zählt** deshalb:
    Aktionen tragen eine Dragfläche und lassen sich frei verschieben, auch in
    eine Schleife hinein und wieder heraus. Trigger und Wenns bleiben wie bisher
    unsortiert.
  - Solange eine Folge läuft (Pausen, Schleifen), löst dieselbe Bedingung nicht
    erneut aus; der laufende Durchgang wird zu Ende geführt.
- **Schleife als eigenständige Automation.** Neben „Bedingung hinzufügen" steht
  jetzt **„Schleife hinzufügen"** (auch je Verzeichnis, Schaltfläche `+S`): Eine
  so angelegte Automation hat **weder Trigger noch Wenn noch Sonst** — nur die
  Schleife. Ihre **zyklische Prüfung ist dort Pflicht** und zugleich die
  Ausführungsbedingung: solange die Prüfung nicht zutrifft, läuft die Schleife im
  eingestellten Abstand erneut. Anders als bei einer getriggerten Bedingung
  beginnt diese Prüfung schon **ab dem Start von homeESS** — sie wartet auf keinen
  vorherigen Lauf. In der Liste trägt eine solche Automation das Kennzeichen
  **„Zyklisch"**.
  - Die tragende Prüfung lässt sich nicht abschalten und die Schleife nicht
    löschen, solange sie die einzige Auslösequelle ist; kommt ein Trigger dazu,
    wird sie wieder zur gewöhnlichen Bedingung. Umgekehrt darf der letzte Trigger
    entfernt werden, sobald eine sich selbst auslösende Schleife da ist.

### Geändert

- **Der Topic-Picker klappt in die Richtung mit mehr Platz auf.** Liegt das
  Topic-Feld in der unteren Hälfte des Viewports — ist es also näher am unteren
  als am oberen Rand —, öffnet die Auswahl nach oben, sonst nach unten. Bisher
  klappte sie erst dann nach oben, wenn unterhalb weniger als 240 px übrig
  waren. Die nutzbare Höhe richtet sich damit ebenfalls nach der größeren
  Seite.

- **Der Sonst-Zweig darf mehrere Aktionen enthalten.** Bisher war er auf genau
  ein Element begrenzt; als Aktionsfolge nimmt er nun — wie das Dann — beliebig
  viele Aktionen auf. Die Bindung an eine aktive Wenn-Prüfung bleibt.
- **Aktionsarten haben nur noch eine Definition:** Validierung, Grenzen und
  Beschreibungstexte von *Wert · Pause · Schleife* liegen in
  `src/conditions/repository.js`; die Aktionsfolgen der Module beziehen sie von
  dort, statt sie ein zweites Mal zu führen.
- **Menü aufgeräumt:** *Stromverbrauch*, *Photovoltaik*, *Batterie* und
  *Prognose* sind keine eigenen Hauptpunkte mehr, sondern **Unterpunkte von
  „Energie"**. Bei aktivem Modul steht **Grid-Control** ebenfalls dort (vor der
  Prognose) statt im allgemeinen Modulblock. Das Hauptmenü verliert damit vier
  bis fünf Einträge.
- **Keine Fremdsoftware mehr namentlich genannt.** Wo bisher ein bestimmtes
  Broker-Produkt beim Namen genannt wurde, ist jetzt durchgängig allgemein vom
  **MQTT-Broker** die Rede — in der Oberfläche (u. a. Output-Dialog und
  Sprachkataloge), in den Adapterbeschreibungen (Zigbee, MQTT-Broker), in den
  Quelltextkommentaren sowie in der Dokumentation ([MQTT.md](MQTT.md), README,
  PROJECT_CONTEXT und den Release Notes). Die Topic-Hilfsfunktion heißt
  entsprechend `stateIdToMqttTopic`; das zugehörige Schlüsselwort ist aus
  `package.json` entfernt.
- **Output-Seite:** Die irreführende Beschreibung über das 30-Sekunden-Rücklesen
  ist aus dem Seitenkopf entfernt.
- **Output** ist keine eigene Hauptseite mehr, sondern eine **Unterseite von
  „States"** (neben *Custom States*) — es schreibt berechnete Werte an
  Ziel-States zurück und gehört damit in denselben Bereich.
- **„Wetterprognose" heißt jetzt „Wetter"** — im Menü, in der Seitenliste der
  Benutzerrechte sowie als Überschrift und Browser-Titel der Seite selbst.
- **Bedingungen** steht im Hauptmenü jetzt **zwischen „Messen + Schalten" und
  „Adapter"** — die Seite wertet die dort gepflegten Geräte aus und rückt damit
  vor die technischen Seiten (Adapter, States). Die Seitenliste der
  Benutzerrechte folgt derselben Reihenfolge wie das Menü.
- **Mobile Tab-Leiste:** *Energie* ersetzt den Direktzugriff auf *Batterie*
  (Reihenfolge: Dashboard · Energie · Strom · PV · Prognose); die Batterieseite
  bleibt über Energie und das Menü-Sheet erreichbar. Die Tab-Leiste bleibt
  bewusst ein Direktzugriff und bildet die Menühierarchie nicht nach.
- **Ampeltext der Prognose** liegt jetzt in `src/prognosis/status.js` und wird
  von Prognoseseite und Energie-Übersicht gemeinsam genutzt.
- **Seitenrechte:** „Energie" ist eine eigene Seite im Rechtemodell und lässt
  sich je Benutzer freischalten. Ist sie gesperrt, rücken die freigeschalteten
  Unterseiten wie bisher als eigene Hauptpunkte ins Menü.

## [1.6.1] — 2026-08-29

### Hinzugefügt

- **Neue Seite „Wetterprognose"** (`/wetter`) als letzter Punkt des Hauptmenüs.
  Sie zeigt die aktuelle Wetterlage und die **kommenden drei Tage ausführlich**:
  Wetterlage, Höchst- und Tiefsttemperatur, gefühlte Temperatur, Niederschlags-
  wahrscheinlichkeit, -menge und -stunden, Regen- und Schneemenge, Wind, Böen
  und Windrichtung, UV-Index mit Belastungsstufe, Bewölkung, Luftfeuchte,
  Luftdruck, Sonnenauf- und -untergang sowie Tageslicht- und Sonnenscheindauer.
  Jede Größe trägt ein Piktogramm. Die Messgrößen stehen dabei nicht in einer
  langen Kachelreihe, sondern in **thematischen Blöcken** (*Temperatur ·
  Niederschlag · Wind · Sonne und Licht · Luft*). Am Schreibtisch wird jeder
  Block eine **Spalte** und die Werte stehen darin platzsparend als schmucklose
  Zeilen untereinander (Bezeichnung links, Wert rechtsbündig auf gemeinsamer
  Fluchtlinie); am Telefon bleibt es beim Kachelraster. Jeder Detailtag hat
  zusätzlich
  einen **Stundenverlauf** über die volle Breite (Symbol, Temperatur,
  Niederschlagswahrscheinlichkeit als Balken, Menge und Wind). Die
  **weiteren vier Tage** stehen darunter als
  Kurzübersicht mit dem Wichtigsten je Zeile.
- **Erwarteter PV-Ertrag im Titel jedes Detailtages** und in **jeder** Kurzzeile
  der weiteren Tage. Die Zahl stammt aus der bestehenden PV-Prognose
  (`photovoltaik/forecast.js`) und wird über den Tagesschlüssel zugeordnet; ohne
  Anlagen oder ohne Prognose entfällt die Angabe ersatzlos.
- **Verlaufsdiagramm über den gesamten Prognosezeitraum** zwischen aktueller
  Lage und dem ersten Tag: **Temperatur** als rote Linie (linke Achse),
  **Sonnenintensität** als ockergelbe Linie (rechte Achse, Globalstrahlung in
  W/m², zur Nulllinie hin halbtransparent gefüllt) und **Niederschlag** je Stunde
  als blaue Balken dahinter. Tagesgrenzen,
  Tagesnamen und die laufende Stunde sind markiert. Die Bauform ist bewusst
  flach, damit der Verlauf die Tageskacheln einordnet statt sie zu verdrängen.
  Wie alle Ansichten von homeESS entsteht es serverseitig als Inline-SVG
  (`src/wetter/chart.js`) — ohne Diagrammbibliothek im Browser. Es gibt zwei
  Bauformen: am Schreibtisch mit Achsen und Beschriftungen im SVG, am Telefon
  eine schmale Form **ohne Schrift im SVG** (Tagesnamen und Wertebereiche stehen
  als HTML darüber und darunter). So bleibt die Beschriftung bei jeder
  Gerätebreite unverzerrt lesbar.
- Der **Stand der Prognose** (Kopfzeile der Seite und State
  `wetter.standort.stand`) wird in der **in homeESS korrigierten Zeit**
  ausgegeben (`time-handler`) und nicht mehr in der rohen Systemzeit — die
  Oberfläche zeigt damit überall dieselbe Uhr.
- **Telefonansicht ohne Seitwärtsscrollen.** Weder die Seite noch ein Abschnitt
  darin muss seitlich gescrollt werden: das Diagramm schaltet auf die schmale
  Bauform um, und der Stundenverlauf zeigt statt 24 schmaler Spalten die acht
  vollen **3-Stunden-Schritte** (0, 3, 6 … 21), die sich die Breite teilen — ein
  Hinweis in der Legende nennt das. Karten, Blöcke und Kacheln laufen mit
  strafferen Abständen; die Messgrößen stehen zweispaltig.
- Der Knopf **Aktualisieren** arbeitet nach Post/Redirect/Get: er leitet nach
  dem Abruf auf `/wetter` um, statt die Seite direkt auszuliefern. Sonst bliebe
  der Client — insbesondere die WebView der App, die sich ihre zuletzt besuchte
  Adresse merkt — auf einer Adresse stehen, die nur POST beantwortet; ein
  späterer Aufruf endete dann in `Cannot GET /wetter/aktualisieren`. Wird die
  Adresse dennoch per GET geöffnet (gemerkte Adresse, Lesezeichen, Verlauf),
  führt sie jetzt zurück auf die Seite.
- **Systemgruppe „Wetter"** mit 159 States, sauber in die Untergruppen
  *Aktuell*, *Standort*, *Tag 1 – Heute*, *Tag 2 – Morgen*, *Tag 3 – Übermorgen*
  und *Weitere Tage* sortiert (`system://homeess/wetter.…`). Sie stehen damit
  auf der States-Seite, im State-Picker, im Wertekatalog, in Bedingungen und im
  Output zur Verfügung. Die States existieren auch ohne hinterlegten Standort;
  ihre Werte bleiben dann leer. Neben Wetterlage, Temperaturen, Niederschlag,
  Wind, UV und Sonnenzeiten gehört dazu die **Sonnenintensität** als
  Globalstrahlung (`wetter.aktuell.sonnenintensitaet`,
  `wetter.tagN.sonnenintensitaetMax`, `wetter.tagN.einstrahlung`). Sie ist
  bewusst getrennt von `sun.intensity.*`: jene States messen die reale
  PV-Leistung gegen den Klarhimmel-Idealwert und gelten nur für den Istzustand,
  während die Wetter-States eine Vorhersage sind.
- Die Wetterdaten stammen wie bisher von **Open-Meteo**, jedoch aus einer
  eigenen Abfrage (`src/wetter/forecast.js`) mit eigenem 30-Minuten-Cache und
  eigenem Hintergrund-Job. Die Strahlungsabfrage der PV-Prognose
  (`src/wetter/client.js`) bleibt eine eigene Abfrage mit unverändertem
  Variablenumfang; lediglich ihr Tageshorizont ist derselbe (siehe *Geändert*).
  Rohdaten der Prognose liefert `GET /wetter/daten`.
- **Wetter-Widget für das Dashboard** (Widget-Typ *Wetter*). Im Dialog wird
  gewählt, **was** die Kachel zeigt — die aktuelle Lage oder einen einzelnen
  Prognosetag (heute … in 6 Tagen) — und **welche Werte** darin erscheinen:
  jede Messgröße ist ein eigenes Häkchen (Temperatur, gefühlte Temperatur,
  Niederschlag samt Wahrscheinlichkeit und Dauer, Regen- und Schneemenge, Wind,
  Böen und Windrichtung, Luftfeuchte, Taupunkt, Luftdruck, Bewölkung,
  Sichtweite, UV-Index mit Belastungsstufe, Sonnenintensität und Einstrahlung,
  Sonnenschein- und Tageslichtdauer, Sonnenauf- und -untergang sowie der
  **erwartete PV-Ertrag** aus der PV-Prognose). Größen, die es in der gewählten
  Anzeigeart nicht gibt — Sonnenaufgang kennt nur ein Tag, Sichtweite nur der
  Istzustand — blendet der Dialog aus, statt sie leer anzuzeigen. Die Kopfzeile
  mit Wetterlage und Leitwert steht immer.
- Die Wetter-Kachel **skaliert nach der Breite ihrer Gruppe**, nicht nach der
  Fensterbreite: Sie belegt die volle Gruppenbreite und ist selbst ein
  Größen-Container (`container-type: inline-size`). In einer Viertel-Gruppe
  steht sie einspaltig mit kompaktem Kopf, in einer halben Gruppe zwei- bis
  dreispaltig mit Wert rechts neben der Bezeichnung, in einer vollen Gruppe
  mehrspaltig mit großem Kopf — alles aus **einer** Bauform im Markup.
  Datengrundlage ist die bestehende Wetterprognose (`src/wetter/`): gelesen wird
  ausschließlich deren Cache, der Dashboard-Aufbau wartet nie auf einen
  Netzabruf. Ohne hinterlegten Standort behält die Kachel ihre Form und nennt
  den Grund; die Werte trägt dann das periodische Nachladen nach.

- **Eigenes Seitenrecht „Wetterprognose"** in der Benutzerverwaltung: Die Seite
  lässt sich wie jede andere je Benutzer freigeben oder ausblenden. Der Knopf
  **Aktualisieren** gilt dabei als lesender Zugriff und steht deshalb auch der
  Rolle „Lesen" offen — er holt lediglich Fremddaten ab und verändert nichts an
  der Anlage.

### Geändert

- **PV-Prognose reicht jetzt sieben Tage** statt vier (`wetter/client.js`,
  `forecast_days`). Damit deckt sie denselben Zeitraum ab wie die Wetterseite:
  In der Kurzübersicht der weiteren Tage trägt nun **jede** Zeile einen
  erwarteten Ertrag, statt nur der erste Tag. Der Prognosestreifen der Seite
  **Photovoltaik** zeigt entsprechend sieben Tageskarten. Unverändert bleiben
  die veröffentlichten States (weiterhin heute/morgen/+2/+3) und die
  Batteriesimulation der Prognoseseite, die weiterhin mit vier Tagen rechnet.
  Zu beachten: Die Ertragswerte der hinteren Tage sind naturgemäß deutlich
  unsicherer als die der ersten Tage.

## [1.6.0] — 2026-08-23

### Geändert

- **Aktionsfolgen sind jetzt geteilte Bausteine.** Datenschicht, Ausführung und
  Oberfläche der Aktionsfolgen liegen unter `src/automation/` bzw.
  `src/views/action-sequences.js` und werden vom Heimkino **und** von Heizung &
  Klima verwendet. Am Heimkino ändert sich dadurch nichts.

### Hinzugefügt

- **Modul „Heizung & Klima" (optional).** Unter *Einstellungen → Module*
  aktivierbar. Es verwaltet beliebig viele frei benannte Räume mit je eigener
  Soll-Temperatur, eigenen Schaltschwellen und eigener Hysterese.

  - **Temperaturerfassung.** Je Raum lassen sich beliebig viele
    Temperaturquellen zuordnen (hDP-Sensoren, Thermostat-Istwerte, beliebige
    States). Bei mehr als einer Quelle zählt ihr **Durchschnitt**; unplausible
    Werte (Sensorausfall) fallen heraus. Jeder Raum stellt Temperatur,
    Soll-Temperatur, Heizen, Kühlen, Wärmeanforderung und Fensterzustand als
    States bereit. Weil Heizung & Klima ein **Modul und kein Adapter** ist, sind
    das **Systemwerte**: sie liegen unter *System* im Ordner **Räume** mit einem
    Unterordner je Raum, **benannt nach dem Raum** statt durchnummeriert
    (`system://homeess/raeume.Wohnzimmer.temperatur`), und stehen damit auf der
    States-Seite, im State-Picker und im Wertekatalog. Die Zentralheizung hat
    daneben den Ordner **Zentralheizung**. Die Soll-Temperatur jedes Raums und
    der Schornsteinfeger-Modus sind **beschreibbar** — die erste
    Ausnahme von der Regel, dass berechnete Systemwerte reine Lesequellen sind.
    Weil der Name in der id steht, ändert ein Umbenennen die States des Raums;
    zwei Räume dürfen deshalb nicht auf dieselbe id fallen („Bad 1" und „Bad_1"
    wären dieselbe) — das wird beim Speichern gemeldet.
  - **Thermostat-Kopplung (optional).** Ein beliebiger schreibbarer State, z. B.
    ein Homematic IP Wandthermostat, hält die Soll-Temperatur bidirektional
    synchron: eine Verstellung am Thermostat übernimmt homeESS, eine Änderung in
    homeESS wird zurückgeschrieben. Nach einem Neustart ist der retained Wert des
    Thermostats die Ausgangsbasis.
  - **Fenster- und Türkontakte (optional).** Beliebig viele Kontakte je Raum,
    wahlweise invertiert. Ist einer offen, werden Heizen und Kühlen abgeschaltet
    — **sofort oder nach einer einstellbaren Verzögerung**, damit kurzes Lüften
    die Anlage nicht abschaltet. Das Schließen wirkt immer sofort.
  - **Schaltschwellen.** Heizen schaltet bei Unterschreiten von *Soll minus
    Heiz-Offset* ein, Kühlen bei Überschreiten von *Soll plus Kühl-Offset*
    (Vorgabe 0 °C bzw. 5 °C). Die je Raum einstellbare **Schalthysterese** liegt
    zwischen Ein- und Ausschaltpunkt und verhindert Takten.
  - **Mindesttemperatur zum Kühlen (optional).** Je Raum lässt sich eine
    absolute Untergrenze festlegen, unterhalb derer **nie** gekühlt wird. Damit
    weckt eine Nachtabsenkung am Wandthermostat die Klimaanlage nicht: steht die
    Grenze auf 28 °C, springt sie frühestens dort an, auch wenn die
    Soll-Temperatur nachts auf 18 °C fällt. Liegt *Soll plus Kühl-Offset*
    höher, gilt weiterhin dieser höhere Wert. Leer = keine Untergrenze.
  - **Geräte über Aktionsfolgen (optional).** Heiz- und Kühlgerät werden mit
    denselben **Aktionsfolgen wie beim Heimkino** geschaltet: Wertzuweisungen,
    Pausen und beliebig verschachtelbare Schleifen mit frei verschiebbaren
    Aktionen; eine Schleife kann zusätzlich in festem Abstand prüfen, ob der
    gewünschte Zustand tatsächlich erreicht wurde, und sich andernfalls allein
    wiederholen. Ein einzelnes An-/Aus-Topic reicht für echte Geräte nicht — eine
    Splitklimaanlage will Betriebsart, Solltemperatur und Einschaltbefehl in
    bestimmter Reihenfolge, und ein IR-Befehl kommt nicht immer an. Je Gerät gibt
    es eine Folge **ein** und eine **aus** (vier je Raum); bei jedem Wechsel läuft
    die passende einmal ab. Ein Raum hat ein Gerät genau dann, wenn seine
    „ein"-Folge Aktionen enthält — ohne Folgen erfasst er nur seine Temperatur.
  - **Priorität nach Betriebslevel je Gerät.** Heiz- und Kühlgerät bekommen je
    eine Priorität (1–5) im Sinne des Lastmanagements: sie ist das Betriebslevel,
    **ab dem** das Gerät laufen darf. Deckt das aktuelle Level die Priorität
    nicht ab, bleibt das Gerät aus und wird bei einem Levelabfall **sofort**
    abgeschaltet (die „aus"-Folge läuft unmittelbar, nicht erst im nächsten
    Takt). Der Wärme- bzw. Kühlbedarf des Raums bleibt davon unberührt — gesperrt
    ist nur, wer ihn deckt.
  - **Ersatzweise die Zentralheizung (optional).** Für das Heizgerät lässt sich
    aktivieren, dass bei nicht ausreichender Priorität **direkt die
    Zentralheizung** heizt. Solange das Betriebslevel die Priorität nicht
    abdeckt, **entfällt für diesen Raum die eingestellte Außentemperaturgrenze**
    — die Zentralheizung tritt dann an die Stelle des gesperrten lokalen
    Gerätes. Sobald das Level die Priorität wieder abdeckt, gilt die Grenze
    unverändert weiter. Die Option setzt voraus, dass der Raum die
    Zentralheizung anfordern darf.
  - **Heizkörperlüfter je Raum (optional).** In der Zentralheizungs-Karte des
    Raums lässt sich ein Schalt-State hinterlegen, der eingeschaltet wird,
    **solange dieser Raum Wärme von der Zentralheizung anfordert**, und danach
    wieder aus. Ein Lüfter ist ein einfacher Verbraucher — hier genügt deshalb
    ein Topic statt einer Aktionsfolge. Er hängt bewusst **nicht** am
    Betriebslevel: er läuft gerade dann, wenn das lokale Heizgerät gesperrt ist
    und die Zentralheizung einspringt.
  - **Zentralheizung je Raum freigeben (optional).** Per Häkchen darf ein Raum
    die Zentralheizung anfordern. Ob der Raum überhaupt Wärme braucht, entscheidet
    seine eigene Temperatur gegen die Soll-Temperatur — **wer sie liefert**,
    entscheidet allein die **Außentemperatur**: Liegt sie unter der je Raum
    festgelegten Grenztemperatur, versorgt die Zentralheizung den Raum
    **anstelle** des lokalen Gerätes, mit derselben Hysterese; darüber heizt das
    lokale Gerät. Eingestellte Werte werden nie automatisch verbogen: steht die
    Grenze auf 4 °C Außentemperatur und die Soll-Temperatur auf 21 °C, so heizt
    dazwischen allein ein lokales Gerät — ist keines hinterlegt, wird dort
    bewusst nicht geheizt.
  - **Zentralheizung zentral einrichten** (*Heizung & Klima → Zentralheizung*):
    wahlweise über **Modbus/State** (die Anlage regelt selbst) oder über einen
    **Schaltaktor**. Als **Außentemperatur** dient die systemweite aus
    *Einstellungen → MQTT*; für die Heizung lässt sie sich hier eigens
    überschreiben. Irgendeine der beiden muss vorliegen, sonst könnte kein Raum
    die Zentralheizung je anfordern. Beim Schaltaktor sind Vor- und
    Rücklauftemperatur zwingend zu überwachen, und optional hängt hier auch die
    **Umwälzpumpe** an einem zweiten Schaltaktor.
  - **Drei getrennte Zustände.** *Kessel* ist der Schaltzustand der Anlage,
    *Brenner* sagt, ob er tatsächlich feuert, *Pumpe* zeigt die Umwälzpumpe.
    Kessel und Brenner stehen immer als States `zentralheizung.kessel` und
    `…brenner` bereit; `…pumpe` kommt hinzu, sobald eine Umwälzpumpe
    eingerichtet ist. Alle drei stehen so auch in der Oberfläche.
    - Der **Kessel** wird eingeschaltet, sobald ein Raum Wärme anfordert. Er darf
      erst abschalten, wenn **keine Anforderung mehr besteht und der Brenner als
      aus erkannt ist** — damit wird er nie mitten in einer Brennphase getrennt.
    - Der **Brenner** wird aus der Rückmeldung der Steuerung gelesen. Fehlt diese
      (optionaler State: Flammensignal, „Brenner an"-Kontakt, Register), erkennt
      homeESS ihn an der Vorlauftemperatur: **mehrere Messwerte hintereinander
      nach oben** bedeuten „an" — eine einzelne Schwankung ausdrücklich nicht;
      die anschließende **Halte-Phase** zählt weiter als Brennerlauf; erst
      **mehrere Messwerte in Folge nach unten** beenden die Brennphase. Was als
      Messwertänderung zählt und was Rauschen ist, bestimmt die einstellbare
      Mindest-Änderung je Messwert.
    - Die **Pumpe** läuft immer vor dem Kessel an und nach seinem Abschalten die
      eingestellte Nachlaufzeit weiter.
  - **Brennerlaufzeiten und Heizkosten.** Grundlage ist genau diese
    Brennererkennung — gezählt wird allein, was der Brenner **tatsächlich
    feuert**, nicht die Einschaltzeit des Kessels. Ein Kessel taktet und
    moduliert; die reine Freigabezeit würde die Kosten zu hoch ausweisen. Welche
    Quelle gerade gilt (Rückmeldung oder Vorlauf), steht über der Auswertung.
    Jede Brennphase ist ein eigener Eintrag und wird im laufenden Betrieb
    fortgeschrieben, sodass ein Stromausfall höchstens den letzten Takt kostet.
    Aus **Verbrauch je Betriebsstunde**, **Einheit** und **Preis je Einheit**
    ergeben sich Verbrauch und Kosten für heute, 30 Tage, das laufende Jahr und
    gesamt.
  - **Heizkosten-Zählwerk** als eigene Kachel unten auf der Übersichtsseite. Es
    summiert Verbrauch und Kosten über einen **Abrechnungszeitraum** hinweg —
    bis der Betreiber ihn abschließt, in aller Regel zur jährlichen
    Zählerablesung. Ausgewiesen werden Verbrauch, Kosten und der
    **Monatsabschlag** (Kosten ÷ 12) sowie der zuletzt abgeschlossene Zeitraum.
    - Ein **Startwert** deckt ab, was seit der letzten Ablesung schon
      verbraucht wurde, bevor homeESS mitgezählt hat.
    - **Zeitraum abschließen** fragt sicherheitshalber nach: der laufende
      Zeitraum wandert ins Archiv, der neue beginnt bei 0. Dabei lässt sich der
      **tatsächlich abgelesene Zählerstand** eintragen; er geht dann in die
      Kosten des abgeschlossenen Zeitraums ein.
    - Per Häkchen kalibriert dieser Zählerstand zusätzlich den geschätzten
      **Verbrauch je Betriebsstunde**: verglichen wird der abgelesene Wert (ohne
      Startwert) mit dem, was homeESS gemessen hat. Ausdrücklich optional, denn
      das ergibt nur Sinn, wenn keine weiteren Verbraucher am selben Zähler
      hängen. Ein völlig unplausibler Faktor wird abgelehnt statt übernommen.
  - **Übersicht aktualisiert sich vollständig.** Hinweise je Raum, die Notiz der
    Zentralheizung, die Marke des Schornsteinfeger-Modus und die
    Soll-Temperatur werden im 5-Sekunden-Takt nachgeführt — bisher blieben sie
    bis zum nächsten Seitenaufbau stehen. Ein Soll-Feld, in dem gerade getippt
    wird, bleibt dabei unangetastet.
  - **Schornsteinfeger-Modus.** Stellt alle Räume auf 28 °C, damit die Heizungen
    aufdrehen, hält die dezentralen Geräte aus, damit sie nicht mitlaufen, und
    lässt die Zentralheizung durchlaufen. Die eingestellten Soll-Temperaturen
    bleiben dabei unverändert: beim Beenden bekommen gekoppelte Thermostate
    ihren alten Sollwert zurückgeschrieben, und damit fallen auch die
    Wärmeanforderungen der Räume wieder weg. Ein verspätet zurückgemeldeter
    Thermostat-Wert gilt kurz nach einem eigenen Schreiben als Echo und **nicht**
    als Verstellung von Hand — sonst bliebe der Nachhall der 28 °C als neue
    Soll-Temperatur stehen.

## [1.5.2] — 2026-08-22

### Hinzugefügt

- **Dunkles Farbthema je Benutzer.** Neue Einstellung **Darstellung** unter
  *Einstellungen → Allgemeine Einstellungen*: **Hell** (wie bisher, Vorgabe),
  **Dunkel** oder **Nur Dashboard dunkel**. Die Wahl gilt je Benutzer und darf
  von jeder Rolle getroffen werden — auch von „Lesen", da sie nur die eigene
  Darstellung betrifft und nichts an der Anlage ändert. Zusätzlich lässt sich
  das Thema im Benutzerdialog der Benutzerverwaltung setzen, damit ein
  Administrator es auch für Zugänge ohne Einstellungsseite vergeben kann.
  Eingefärbt wird ausschließlich die Arbeitsfläche der Seiten: **Titelleiste und
  Seitenmenü behalten in jedem Thema ihre Farben**. Das Corporate Design bleibt
  erhalten — dieselbe grün-graue Familie wie das Seitenmenü, dasselbe
  Aktionsgrün (nur so weit aufgehellt, dass es auf dunklem Grund trägt) und
  dieselbe fachliche Zuordnung der Energiearten (Batterie blau, Netz rot,
  Eigenverbrauch lila, Photovoltaik gelb) über die bereits vorhandenen
  aufgehellten Varianten. Die Anmeldeseite bleibt hell, da das Thema erst mit
  dem angemeldeten Benutzer feststeht.

  Die Verwaltungsseiten der mitgelieferten Adapter ziehen mit: hDP, Zigbee,
  MQTT-Broker und InfluxDB beziehen ihre Farben jetzt aus denselben Tokens.
  Adapter werden eigenständig versioniert — Einzelheiten stehen in deren
  CHANGELOG.

- **Flächenfüllung je Diagrammlinie.** Jede Linie einer Diagramm-Kachel lässt
  sich einzeln auf **Füllen** stellen: Der Bereich zwischen Linie und Nulllinie
  wird dann in der Linienfarbe hinterlegt, mit einer je Linie einstellbaren
  **Deckkraft** (5–80 %, Vorgabe 20 %). Alle Flächen liegen unter allen Linien,
  damit keine Fläche eine andere Linie verdeckt; Aufzeichnungslücken
  unterbrechen die Fläche genauso wie die Linie. Sobald eine Linie füllt, reicht
  die Werteachse bis zur Null — eine Fläche „bis 0" auf einer Grundlinie, die
  keine Null ist, würde die Größenverhältnisse vortäuschen.

- **Lückenbehandlung in der Diagramm-Kachel.** Neue Einstellung
  **Aufzeichnungslücken** im Diagramm-Dialog: Zeitabschnitte ohne Messwerte —
  etwa weil der Server aus war — können als **Lücke** stehen bleiben (die Linie
  bricht ab, wie bisher und weiterhin Standard), mit einer **durchgezogenen
  Linie** überbrückt, auf dem **letzten bekannten Wert gehalten** oder **auf
  Null gesetzt** werden. Die beiden letzten Varianten lässt bereits die Datenbank
  auffüllen (`fill(previous)` bzw. `fill(0)`), sodass auch das Fadenkreuz
  durchgehend Werte anzeigt.

### Geändert

- **Farben in `public/styles.css` laufen über Design-Tokens.** Flächen-, Linien-,
  Text- und Zustandsfarben sind als benannte Tokens im `:root` hinterlegt; die
  Regeln greifen darauf zu, statt Festwerte zu wiederholen. Das helle Thema
  bleibt dabei unverändert — die Tokens tragen exakt die bisherigen Werte, nur
  einzelne beinahe gleiche Grautöne sind zu einer Stufe zusammengefasst. Erst
  dadurch genügt für das dunkle Thema ein einziger Block, der die Tokens
  umdefiniert, statt hunderte Regeln zu doppeln.

## [1.5.1] — 2026-08-21

### Hinzugefügt

- **Diagramm-Kachel fürs Dashboard.** Neuer Widget-Typ **Diagramm**: zeichnet bis
  zu vier Messreihen aus der Systemdatenbank als Zeitreihe — Zeitraum 6 Stunden
  bis 30 Tage, Verdichtung wahlweise Mittelwert, Minimum, Maximum, Summe oder
  letzter Wert. Je Linie sind **Farbe und Name für die Legende frei wählbar**
  (ohne Namen steht die Messreihe dort); die Farbe hängt an der Linie, sodass
  das Entfernen einer anderen Linie die übrigen nicht umfärbt. Das SVG entsteht
  wie alle Ansichten **serverseitig**; die Kachel lädt es nach dem Seitenaufbau und danach im Minutentakt nach, sodass eine
  langsame oder nicht erreichbare Datenbank das Dashboard nie ausbremst. Die
  Legende nennt jede Linie samt aktuellem Wert, ein Fadenkreuz mit Werteanzeige
  (auch per Fingertipp) liest jeden Zeitpunkt ab, Messlücken brechen die Linie,
  statt quer darüber zu ziehen. Die vier Linienfarben sind auf
  Farbfehlsichtigkeit und Kontrast geprüft und in fester Reihenfolge vergeben.

- **Systemweite Datenbankanbindung.** homeESS kann eine InfluxDB 1.x als
  zentrale Zeitreihen-Datenbank für Diagramme und Auswertungen nutzen —
  entweder die Datenbank, in die der InfluxDB-Adapter schreibt, oder eine
  beliebige externe. Konfiguriert wird sie in *Einstellungen → Allgemein* in
  der neuen Karte **Datenbank** unterhalb der MQTT-Einstellungen, mit
  Verbindungstest. Auf der Einstellungsseite einer InfluxDB-Adapterinstanz
  übernimmt der Knopf **„Als Standard-Datenbank für homeESS übernehmen"** die
  dortigen Verbindungsdaten (einmalige Kopie; die Herkunft wird in den
  Einstellungen angezeigt). Serverseitig steht die Abfrage-API
  `src/database/` bereit (Messreihen auflisten, Zeitreihen je Zeitfenster,
  Raster und Aggregat lesen), als JSON erreichbar über `/database/status`,
  `/database/measurements` und `/database/series`. Der Browser spricht nie
  direkt mit der Datenbank; Zugangsdaten bleiben auf dem Server.

- **Systemweite Warnfunktion.** Unter *System → Betrieb* gibt es zwei neue
  States: `operating.warnungText` („Warnungstext") und `operating.warnungAktiv`
  („Warnung aktiv"). Meldet eine Automatik einen Warntext, steht er im
  Text-State und das Aktiv-Flag geht auf `true`. Solange das Flag steht, zeigt
  homeESS auf **jeder** Seite ein rotes Warnband mit dem Text und einem
  Knopf „Quittieren"; Quittieren setzt das Flag auf `false`, leert den Warntext
  und räumt zusätzlich das MQTT-Warntopic der Netzsteuerung auf. Die Warnung
  überdauert einen Neustart. Quittieren zählt als Bedienhandlung (Rolle
  „bedienen" genügt).

- **Adapterseite: Neustart je Adapter.** In der Titelzeile jedes Adapters sitzt
  oben rechts ein schmaler Knopf „↻“; die Beschriftung „Neu starten“ erscheint
  als Tooltip beim Verweilen mit der Maus. Er liest das Manifest neu ein und
  startet alle Instanzen dieses Adapters neu, sodass ausgetauschter Adaptercode
  übernommen wird, ohne homeESS neu zu starten. Der Knopf ist in der normalen
  wie in der kompakten Ansicht fest oben rechts verankert.

### Geändert

- **Netzsteuerung: Bestätigungsüberwachung deutlich träger und plausibler.**
  Sporadische „Huster" — kurze Netzwerkaussetzer oder ein spät antwortendes
  Cerbo-GX — haben bisher schon nach 20 Sekunden eine Warnung auf dem Warntopic
  und einen roten Protokolleintrag erzeugt. Neu gilt: Bis 90 Sekunden ist die
  ausbleibende Bestätigung ein normaler Roundtrip, wiederholt wird der Befehl
  alle 10 Sekunden, und **gewarnt wird erst**, wenn die Abweichung 5 Minuten
  durchgehend besteht und dabei mindestens 10 Wiederholungen erfolglos blieben.
  Ohne Broker-Verbindung läuft diese Uhr gar nicht erst weiter — ein
  Verbindungsabriss ist kein Schaltfehler. Erst der so bestätigte Dauerfehler
  erreicht Warntopic, systemweites Warnband und Protokoll; die Auflösung wird
  ebenfalls protokolliert. Eine frisch erkannte Abweichung (verlorener Write,
  externe Änderung am Ziel-Topic) wird weiterhin sofort nachgesetzt, und ein
  Rückwärtssprung der Systemzeit blockiert die Wiederholungen nicht mehr.

- **Netzsteuerung: keine unplausiblen Einspeise-Warnungen mehr.** Die
  Überschusseinspeisung wird erst oberhalb der oberen SoC-Offset-Schwelle
  gefordert. Schaltet das Netz nur wegen der Wechselrichtergrenzen, liegt gar
  kein Überschuss vor — eine fehlende Bestätigung ist dort bedeutungslos und
  warnt nicht mehr. Bei Soll „aus" meldet die Netzsteuerung nur noch einen
  aktiven Widerspruch (Broker meldet weiterhin `1`); bei Soll „ein" gilt
  unverändert jede anhaltende Abweichung.

- **Adapterseite scannt das Adapterverzeichnis bei jedem Aufruf.** Nachträglich
  abgelegte Adapter erscheinen dadurch sofort, entfernte verschwinden aus der
  Liste — bisher war dafür ein Neustart von homeESS nötig. Instanzen eines
  entfernten Adapters bleiben als eigener, rot markierter Block sichtbar und
  lassen sich weiterhin deaktivieren und löschen, statt unerreichbar
  zurückzubleiben. Ein vorübergehend unlesbares Adapterverzeichnis (etwa während
  eines Updates) verwirft den geladenen Stand nicht mehr.

## [1.5.0] — 2026-08-20

### Hinzugefügt

- **Zigbee-Adapter.** homeESS wird damit zur eigenständigen
  Zigbee-Zentrale: Netzwerk, Pairing, Geräte-Interviews und Gerätebefehle
  laufen vollständig im Adapter, der den Coordinator über Serial oder TCP
  direkt anspricht. Zigbee2MQTT, deCONZ-Server, ein MQTT-Gateway
  oder ein Cloud-Dienst werden nicht benötigt. Geräte-States entstehen
  dynamisch aus den Exposes von `zigbee-herdsman-converters`, ein bestehendes
  Netz lässt sich ohne erneutes Pairing übernehmen, und die Netzwerkkarte zeigt
  die tatsächlich gemessenen Funkstrecken samt Bedienung je Gerät. Der Adapter
  ist eigenständig versioniert (1.3.3) und in
  [adapter/zigbee/CHANGELOG.md](adapter/zigbee/CHANGELOG.md) beschrieben.
- **Adapterseite: kompakte Ansicht.** Oben rechts steht neben „Inaktive Adapter
  ausblenden“ ein zweiter Haken „Kompakte Ansicht“; die Auswahl wird browserlokal
  gespeichert (`homeess.adapters.compact.v1`). Aktiviert bleibt je Adapter eine
  einzeilige Kopfzeile aus Name, Prefix und Version, darunter die Instanzen.
  Kurzbeschreibungen der Adapter, der Copyright-Vermerk, die Kurzinfo oben auf
  der Seite, die Spaltenüberschriften sowie die Adapteraktionen (Feld „Neue
  Instanz“ samt Knopf und „Adapter löschen“) entfallen in dieser Ansicht. Auf
  Smartphones darf die Adapter-Kopfzeile umbrechen, damit Name und Version
  vollständig lesbar bleiben, statt an der Bildschirmkante abgeschnitten zu
  werden.

### Geändert

- **`.gitignore`: Adaptereigene Abhängigkeiten werden mitversioniert.** Ein
  Adapter ist laut [ADAPTER.md](ADAPTER.md) portabel und bringt seine
  JavaScript-Abhängigkeiten im eigenen Verzeichnis mit; homeESS führt für
  Adapter weder `npm install` noch einen globalen Installationsschritt aus. Die
  Regeln `node_modules/` und `dist/` hätten genau diese Dateien ausgeschlossen —
  nach Klon und Update hätten sie gefehlt. Die Ausnahme gilt eng begrenzt für
  `adapter/*/node_modules/`; für den übrigen Programmcode bleiben beide Regeln
  unverändert. Anlass ist der neue Zigbee-Adapter, der `zigbee-herdsman` und
  `zigbee-herdsman-converters` mitliefert; die Änderung gilt für alle Adapter
  gleichermaßen. Der Adapter selbst ist eigenständig versioniert und in
  [adapter/zigbee/CHANGELOG.md](adapter/zigbee/CHANGELOG.md) beschrieben.
- **Aktualisierte Adapter.** Der MQTT-Broker-Adapter (1.0.1) bringt einen
  Topic-Browser auf seiner Verwaltungsseite und gliedert Punkte in
  State-Adressen zu eigenen Topic-Ebenen — **Abos und Retained Messages auf die
  alten, punktbehafteten Pfade greifen nicht mehr**. Der hDP-Adapter (1.2.9)
  unterscheidet in der Fehlermeldung jetzt zwischen einem nicht erreichbaren
  Gerät und einem säumigen WebSocket-Upgrade. Einzelheiten in den
  Adapter-Changelogs [MQTT-Broker](adapter/mqttbroker/CHANGELOG.md) und
  [hDP](adapter/hdp/CHANGELOG.md).

## [1.4.7] — 2026-08-16

### Hinzugefügt

- **Heimkino-Modul (optional).** Unter „Einstellungen → Module“ aktivierbar.
  Es verwaltet beliebig viele frei benannte Räume; jeder Raum erhält unter
  „System / Heimkino“ einen beschreibbaren booleschen State mit seinem Namen
  (`heimkino://raeume/<id>`), der den Kinomodus zugleich anzeigt und festlegt.
  Derselbe Schaltzustand steht als Ziel „Kinomodus Raum …“ für die
  Schaltwidgets des Dashboards zur Verfügung. Das Schalten läuft dort über die
  Modullogik; eine eigene Schreiblogik führen die Widgets nicht ein.
- **Aktionsfolgen je Raum.** Ein Raum öffnet sich als eigenständige Seite
  (`/heimkino/raum/<id>`) in Liste und Design der Bedingungen, mit je einem
  Verzeichnis für die Folge „An“ und „Aus“. Jede Zustandsänderung ruft die
  passende Folge nacheinander ab. Zur Verfügung stehen **Wert zuweisen** (wie
  das „Dann“ der Bedingungen: fester Wert oder Wert eines anderen Topics,
  Rechenfunktion und Rundung), **Pause** und **Schleife**. Schleifen sind
  ineinander verschachtelbar, nehmen Aktionen auf und durchlaufen ihren Inhalt
  so oft wie eingestellt; alle Aktionen lassen sich per Dragfläche frei
  verschieben.
- **Sync-Topic je Raum (optional).** Ein frei wählbares Topic wird bidirektional
  mit dem Kinomodus synchron gehalten: Wechselt es extern auf an, schaltet der
  Raum ein (samt Aktionsfolge); wird in homeESS geschaltet, folgt das Topic
  sofort (1/0 bzw. true/false je nach seiner bisherigen Darstellung). Beim
  Neustart von homeESS — und nach jedem MQTT-Wiederverbindungsaufbau — ist der
  dort hinterlegte Zustand maßgeblich: er wird übernommen, ohne die
  Aktionsfolge zu durchlaufen.
- **Plausibilitätsprüfung in Schleifen.** Eine Schleife kann eine Bedingung in
  einem festlegbaren Abstand immer wieder prüfen (gezählt ab ihrer letzten
  Ausführung bzw. ab dem Start von homeESS). Trifft die Bedingung nicht zu,
  wird ausschließlich diese Schleife erneut abgespult — die übrige Aktionsfolge
  bleibt unberührt. So bleibt ein extern verstellter Verbraucher nicht in einem
  unbekannten Schaltzustand. Geprüft wird jeweils nur die Folge, die zum
  aktuellen Kinomodus des Raums gehört.

### Geändert

- **Module und Modulseiten stehen alphanumerisch aufsteigend** – in der
  Modulverwaltung wie in ihrem eigenen Navigationsblock unterhalb der
  Kernseiten. Auch die Heimkino-Räume sind alphanumerisch sortiert.
- **Räume im Zeilendesign der Adapterseite.** Die Heimkino-Übersicht zeigt je
  Raum Name, Kinomodus-State, Sync-Topic, Zustand und die Zahl der Aktionen in
  großzügigeren Zeilen. Die Spaltenüberschriften stehen exakt über ihren
  Spalten, und je nach Fensterbreite entfallen Spalten in Kopf- und Datenzeile
  gemeinsam. Als Schaltflächen gestaltete Links (Adapter-Zeilen, Seitenköpfe)
  sehen jetzt wie echte Buttons aus.

### Behoben

- **Mitgelieferte hDP-Stable-Firmware auf 0.7.4 angehoben.** Der bisher
  gebündelte Stand 0.7.3 konnte sein Manifest bei knappem Heap abgeschnitten
  ausliefern, sodass der Manifestabgleich nach jedem Verbindungsaufbau mit
  „Ungültige JSON-Antwort (HTTP 200)“ scheiterte. Einzelheiten im
  [Adapter-Changelog](adapter/hdp/CHANGELOG.md) (hDP-Adapter 1.2.8).

## [1.4.6] — 2026-08-16

### Hinzugefügt

- **Renault-/Dacia-Connected-Vehicle-Adapter.** Der neue Adapter bindet unter
  anderem den Dacia Spring über My Renault/My Dacia an und stellt Akku,
  Reichweite, Ladezustand, Kilometerstand sowie Klimadaten als States bereit.
  Zugangsdaten und erneuerbare Tokens bleiben im serverseitigen Secret-Store;
  optionale Schreibzugriffe für Laden und Vorklimatisierung müssen ausdrücklich
  aktiviert werden. Cloudfehler lösen keine aggressive Neustartschleife aus.
- **hDP-Infrarot-Transceiver.** hDP-Geräte können als Receiver, Blaster oder
  kombinierter Transceiver eingerichtet werden. Unterstützt werden Passthrough,
  dauerhafte benannte Aufzeichnungen, Aufnahme per Oberfläche oder Trigger-GPIO,
  Umbenennen, Löschen und Senden sowie ein beschreibbarer Blaster-State. Die
  Hardwarekonfiguration prüft GPIO-Konflikte, Trägerfrequenz und Gerätevertrag;
  die Verwaltungsseite enthält eine responsive IR-Bibliothek.
- **hDP-Firmware-Bootstrap und optionale Online-Releases.** Firmware 0.7.3 für
  ESP8266/D1 Mini wird mit dem hDP-Adapter ausgeliefert und initialisiert den
  lokalen Stable-Kanal, ohne manuell gepflegte Kanäle zu überschreiben. Eine
  optionale HTTPS-Releasequelle kann signierte Releases abrufen; Manifest und
  Artefakte werden vor der atomaren Übernahme vollständig gegen Größe, SHA-256
  und den konfigurierten Ed25519-Schlüssel geprüft. Geräte bleiben rein lokal.
- **`managementPage.asSettings`.** Ein Adapter, dessen gesamte Konfiguration in
  seiner eigenen Verwaltung liegt, kann den Einstellungsknopf der Instanz
  dorthin führen. Das betrifft nur die Verlinkung; Route, Anmeldung und
  Rollenprüfung bleiben unverändert. Siehe [ADAPTER.md](ADAPTER.md).

### Behoben

- **Dynamische Adapter-States mit Anfangswert waren nach dem Start nicht
  lesbar.** Werte, die ein Adapter bereits zusammen mit `host.setStates()`
  meldet, gelangen jetzt wie `publishState()` und `publishStates()` in den
  zentralen State-Bus samt Retained-Cache. Objektwerte werden in
  `adapter_states.last_value` als JSON statt als `[object Object]` gespeichert.
  Dadurch können Bedingungen beispielsweise einen dauerhaft gespeicherten
  hDP-IR-Code unmittelbar nach dem Adapterstart lesen und an einen
  beschreibbaren Blaster-State weiterreichen.
- **Festgefahrene hDP-Verbindung nach einem einmaligen Binding-Fehler.** Bleibt
  ein bereits gekoppeltes und weiterhin per mDNS sichtbares Gerät nach dem
  Adapterstart ohne Laufzeitverbindung, stößt sein nächstes unverändertes
  Lebenszeichen den Binding-Abgleich erneut an. Der Badge bleibt dadurch nicht
  mehr bis zu einem manuellen Adapterneustart offline.
- **Wallbox-Steuerung nach MQTT-Neustarts.** homeESS führt für das
  Steuerung-Sync-Topic nun einen lokalen Soll-Schatten. Nur ein echter,
  abweichender Schreibwunsch gilt als manuelle Bedienung; bestätigte Readbacks,
  Retained-Werte und wiederholte eigene Anforderungen setzen die Steuerung nicht
  mehr fälschlich dauerhaft auf „Aus".
- **hDP-Richtungsindikator übernahm reine Änderungen am Impulsabstand nicht.**
  Die Schleifendauer ist jetzt Bestandteil von Timeline-Identität und
  Gleichheitsprüfung, sodass ein neuer Abstand auch ohne geändertes
  Ablaufprogramm an das Gerät übertragen wird.
- **Eigenschaftendialog der States nennt die Ursache eines Fehlschlags.**
  Scheitert das Laden oder Speichern der State-Eigenschaften, steht der Fehler
  samt Stack im Log; der Dialog zeigt weiterhin nur die allgemeine Meldung. Ein
  stiller `500` war von außen nicht von einem fehlenden State zu unterscheiden
  und verdeckte insbesondere den Fall, dass ein lange laufender Dienst noch
  einen älteren Modulstand im Speicher hält.

### Geändert

- **Leerzeichen und Unterstriche sind in Adapter-State-Adressen intern
  gleichwertig.** Schema-Topics der Form `prefix://instanz/adresse` werden in
  State-Bus, Cache, States-Baum und Wertekatalog segmentweise kanonisiert;
  Leerraum und Folgen von Unterstrichen erscheinen dort einheitlich als `_`.
  Der State-Picker übernimmt ausschließlich diese kanonische Topicform und
  behandelt beide Schreibweisen auch bei der Suche identisch. Beim Lesen und
  Schreiben löst der Router das kanonische Topic wieder auf die vom Adapter
  gemeldete Originaladresse auf. Diese Aliaszuordnung wird aus dem
  persistierten State-Katalog bereits beim Start geladen. Existieren sowohl
  `A B` als auch ein echter State `A_B`, hat die bereits kanonische Adresse
  `A_B` eindeutig Vorrang und erscheint nur einmal in der State-Liste.
- **hDP-State-Namen sind automationsfreundlich vereinheitlicht.** Veröffentlichte
  Adressen, Namen und Kategorien verwenden durchgängig Unterstriche statt
  Leerzeichen oder Bindestriche; gespeicherte und kanonische Topics bleiben
  über die Aliasauflösung erreichbar.

## [1.4.5] — 2026-08-11

### Hinzugefügt

- **Eigenschaften-Dialog für jeden State.** Auf der States-Seite öffnet eine
  Stiftschaltfläche rechts neben dem Wert einen Dialog mit Tableiste. Der Tab
  **Allgemein** stellt Nachkommastellen samt Rundungsart (kaufmännisch,
  ab-, aufrunden, abschneiden) und eine Einheit ein, die in der Anzeige an den
  Wert gehängt wird und die Einheit der Quelle überschreibt. Die Angaben gelten
  quellenübergreifend für System-, Custom- und Adapter-States und wirken auf
  States-Seite, Wertekatalog und State-Picker. Gespeichert wird in der neuen
  Tabelle `state_properties`; der Rohwert bleibt unverändert.
- **Adapter hängen eigene Tabs an den Eigenschaften-Dialog.** Ein Adapter
  liefert dafür nur ein Formularschema — statisch über `stateOptions` im
  Manifest, zur Laufzeit über die neue Host-API
  `host.setStateOptionsSchema(schema)` (`null` entfernt den Tab wieder). Das
  zuletzt gemeldete Schema wird persistiert (Tabelle `adapter_state_schemas`)
  und geht dem Manifest vor, sodass der Tab auch bei gestoppter Instanz
  erscheint. Hängt kein Adapter etwas an, bleibt es beim Tab „Allgemein".
  homeESS rendert, prüft und speichert je (Instanz, Topic) in
  `state_adapter_options`; der Adapterprozess wird beim Öffnen nicht befragt und
  liefert kein Markup. Gelesen wird über `host.listStateOptions()`, und nach
  jeder Änderung ruft homeESS die optionale Adaptermethode
  `stateOptionsChanged()` auf — ohne Neustart der Instanz. Für ihre eigenen
  States erscheint eine Instanz nicht als Tab. Die vollständige Schnittstelle
  steht in [ADAPTER.md](ADAPTER.md).
- **Sichtbarer Zeitpunkt der nächsten Updateprüfung.** Der Updatestatus führt
  jetzt `nextCheckAt`; die Einstellungsseite zeigt ihn neben der letzten Prüfung
  an und führt ihn live nach.

### Behoben

- **Adapter-Verwaltungsseiten meldeten „Keine Berechtigung."** Das interne
  Zugriffsobjekt führte kein `canRead`, obwohl `GET /me/access` und
  [ADAPTER.md](ADAPTER.md) es als Vertrag beschreiben. Die Management-Brücke
  reichte deshalb für **jeden** Benutzer `canRead: false` an den Adapter durch —
  auch für Administratoren. Jeder angemeldete Benutzer hat jetzt Leserecht;
  Bedienen und Schreiben bleiben an die Rolle gebunden.
- **Verständliche Meldung bei gestoppter Instanz.** Die Verwaltungsseite eines
  nicht aktiven Adapters antwortete mit „Adapterverwaltung ist nicht
  verfügbar." Sie nennt jetzt den Grund und den nächsten Schritt (Instanz auf
  der Adapterseite aktivieren) und antwortet mit 409 statt 500.

### Geändert

- **Feldschlüssel aus Adaptermanifesten werden strikt geprüft.** `key` in
  `settings`, `stateEditor.columns` und `stateOptions.fields` muss der Form
  `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` genügen; abweichende Felder werden beim
  Laden verworfen und protokolliert. Die Schlüssel landen als HTML-Attribut in
  der Oberfläche, und Manifeste können per ZIP hochgeladen werden — ohne diese
  Prüfung ließe sich darüber Markup einschleusen. Kein mitgelieferter Adapter
  ist betroffen.
- **Updateprüfung und Installationsautomatik sind in den Einstellungen
  getrennt.** Das Prüfintervall stand bisher im Block des Wartungsfensters und
  wurde mit ihm ausgegraut, sobald die automatische Installation ausgeschaltet
  war — obwohl die Prüfung immer lief. Es steht jetzt als eigenes Feld darüber
  und ist unabhängig bedienbar. Das Wartungsfenster legt ausschließlich fest,
  wann ein bereits gefundenes Update eingespielt werden darf.
- **Fehlgeschlagene Updateprüfungen blockieren nicht mehr das ganze Intervall.**
  Nach einem Fehler wird der nächste Versuch nach spätestens 15 Minuten
  unternommen statt erst nach Ablauf des eingestellten Abstands, der wöchentlich
  oder monatlich sein kann.

## [1.4.4] — 2026-08-11

### Hinzugefügt

- **Host-API `host.listStates(limit?)`.** Adapter können den
  quellenübergreifenden State-Katalog lesen: Systemwerte, Custom States und alle
  Adapter-Instanzen als flache Liste aus `topic`, `name`, `category`, `unit`,
  `value`, `writable` und `sourceType`. Berechnete Systemwerte tragen dabei ihr
  kanonisches `system://`-Topic, sodass jeder Eintrag unmittelbar adressierbar
  ist. Gedacht für Adapter, die States weiterreichen oder spiegeln; die Werte
  selbst kommen weiterhin ereignisgetrieben über `host.subscribeState()`.
  Bestehende Adapter sind davon unberührt.

- **Selbstaktualisierender States-Baum.** Die States-Seite lud bisher im
  15-Sekunden-Takt nur die Werte; neu hinzugekommene oder entfernte States
  wurden erst nach einem manuellen Neuladen sichtbar. Weicht die Struktur von
  den gelieferten Werten ab, holt die Seite den Baum jetzt selbst über
  `/states/tree.json` nach und stellt den Auf-/Zuklappzustand wieder her.

### Geändert

- **Alphanumerische Sortierung im gesamten States-Katalog.** States,
  Kategorien, Katalogeinträge und die Prefix-Gruppen selbst werden einheitlich
  aufsteigend sortiert; Zahlenanteile zählen dabei als Zahl (`Kanal2` vor
  `Kanal10`), Groß- und Kleinschreibung spielt keine Rolle. Die Reihenfolge
  bleibt auch über Seitengrenzen des Katalogs hinweg gleich. Der System-Block
  behält wie im Wertekatalog seinen festen Platz an der Spitze.
- **Einklappbare Prefix-Gruppen auf der States-Seite.** Jede Gruppe
  (`hdp://…`, `mqttbroker://…`, `custom://` …) lässt sich wie ihre Kategorien
  auf- und zuklappen, zeigt die Anzahl ihrer States und merkt sich den Zustand
  über Seitenaufrufe hinweg.
- [ADAPTER.md](ADAPTER.md) beschreibt die neue Methode sowie die bislang nicht
  dokumentierten `host.writeState()` und `host.getDataDirectory()` und ergänzt
  die Regeln für Adapter, die den States-Baum weiterreichen: eigener Prefix
  bleibt ausgespart, hinterlegte Schreibrechte gelten unverändert, im
  gespiegelten Baum entstehen keine neuen States, und abonniert wird
  bedarfsgetrieben und mengenbegrenzt.

## [1.4.3] — 2026-08-09

### Hinzugefügt

- **Zwei neue hDP-Gerätetypen: `sensors` und `fingerprint_reader`.** Neben
  `percentage_indicator`, `argb_output` und `binary_io` meldet die
  Referenzfirmware jetzt zwei weitere Gerätetypen mit eigenen Laufzeitprofilen.
  `sensors` (`sensor-reading-v1`) liest bis zu acht lokale Messfühler:
  DHT11/22, DS18B20, BME280, SHT30/31, BH1750, INA219, HX711, VL53L0X sowie den
  Analogeingang A0. Alle I²C-Fühler teilen sich ein SDA/SCL-Paar, das gegen
  Sensor- und Binary-GPIOs abgegrenzt wird. `fingerprint_reader`
  (`fingerprint-event-v1`) bindet R503-kompatible Fingerabdruckmodule über
  einen 3,3-V-TTL-UART ein und beherrscht Anlernen, Erkennen, Vorlagenverwaltung
  und einen konfigurierbaren LED-Ring. Bei beiden Typen bleiben die nicht
  belegten GPIOs als Binary-I/O nutzbar.
- **Sensornachrichten im hDP-Protokoll.** Der Adapter fordert mit
  `sensor.status.get` den Gesamtstand an und empfängt `sensor.sample` je
  Einzelmessung sowie `sensor.status` als Sammelstand. Die Rohwerte kommen in
  ganzzahligen Basiseinheiten (Millicelsius, Millipercent, Pascal, Millilux,
  Mikrovolt, Mikroampere, Mikrowatt, Millimeter); die Umrechnung in die
  angezeigte Einheit übernimmt der Adapter.
- **Fingerabdrucknachrichten im hDP-Protokoll.** Zum Gerät gehen
  `fingerprint.status.get`, `fingerprint.enroll.begin`,
  `fingerprint.enroll.cancel` und `fingerprint.template.delete`; sie tragen
  die `config_revision` und werden bei Abweichung abgelehnt. Vom Gerät kommen
  `fingerprint.status` (Belegung, Kapazität, Modulzustand),
  `fingerprint.match` samt Konfidenz, `fingerprint.unknown`,
  `fingerprint.enroll.status` mit den Stufen des Anlernvorgangs,
  `fingerprint.template.deleted` und `fingerprint.command.accepted`.
- **Verwaltungsendpunkte für Fingerabdruckvorlagen.** Die Geräteseite bietet
  `POST …/fingerprints/enroll`, `POST …/fingerprints/cancel` und
  `POST …/fingerprints/delete/<id>`. Vorlagen liegen ausschließlich im Modul;
  homeESS speichert dazu nur Name, Ziel-State und Aktion.
- **Messwerte lassen sich auf States verknüpfen.** Die Sensorgeräteseite führt
  je Sensor und Messgröße ein State-Feld. Bei jeder Messung schreibt der Adapter
  den fertig umgerechneten Wert dorthin. Die Auswahl der Messgrößen stammt aus
  dem Sensortyp, nicht aus der letzten Messung — eine Verknüpfung kann deshalb
  angelegt werden, bevor der erste Wert eingetroffen ist. Ohne Verknüpfung
  bleibt ein Messwert wie bisher im Zustandskatalog des Adapters sichtbar.
- **Konfigurationsschema 5** für die Hardwarekonfiguration. Es trägt die
  Sensorliste, die UART- und Wakeup-Belegung des Fingerabdrucklesers sowie
  dessen fünf LED-Szenen (`idle`, `scanning`, `success`, `failure`,
  `enrolling`). Ein Gerät lehnt den Wechsel auf einen Releasekanal mit
  älterem Schema ab.

### Geändert

- **hDP-Adapter auf 1.2.0.** Die Protokollendpunkte sind um die Sensor- und
  Fingerabdruckwege erweitert worden; die Nebenversion steigt deshalb
  gemeinsam mit der Anwendungsversion, obwohl der Adapter sonst unabhängig
  gepflegt wird.
- **Gerätestatus und Update-Automatik auf allen Geräteseiten identisch.**
  Verbindung, WLAN-Signal, hDP-Version, IP-Adresse, Laufzeit, Resetgrund,
  freier Speicher, Konfigurationsrevision und Firmwarestand stehen jetzt auch
  bei Sensoren und Fingerabdrucklesern in einer gemeinsamen Statuskachel;
  gerätetypspezifische Angaben stehen darunter statt an ihrer Stelle. Ebenso
  führen alle Geräteseiten denselben Abschnitt für Updatepolitik,
  Releasekanal, Wiederholungsversuche und Wartungsfenster.

### Behoben

- **Die Geräteseite für Sensoren war nicht aufrufbar.** Sie trug die
  Auto-Aktualisierung des Fingerabdruck-Anlernens, deren Zustandsprüfung dort
  aber nicht existiert; der Aufruf endete mit `status is not defined`. Die
  Auto-Aktualisierung sitzt jetzt auf der Fingerabdruckseite, für die sie
  gedacht ist — dort hatte sie zuvor gefehlt, sodass der Anlernfortschritt nie
  nachgeladen wurde.
- **Der Releasekanal sprang beim Speichern auf „Stabil“ zurück.** Die
  Updateeinstellungen wurden bei jedem Speichern vollständig aus dem Formular
  neu gebildet. Seiten ohne Updateabschnitt schickten keine entsprechenden
  Felder mit, worauf die Vorgabewerte griffen — neben dem Kanal auch
  Updatepolitik, Wiederholungsversuche, Wartungsfenster und das Nachholen nach
  Wiederkehr. Anschließend prüfte der Adapter gegen ein Release mit älterem
  Konfigurationsschema und meldete „Kein Update verfügbar“. Fehlende Felder
  gelten jetzt als „keine Aussage“ und lassen den gespeicherten Wert stehen.
- **Eine Vorlagenzuordnung ohne zugehörige Vorlage ließ sich nicht entfernen.**
  Die Vorlagenliste vereinigt die Belegung des Moduls mit den gespeicherten
  Zuordnungen. Fehlte die Vorlage im Modul, blieb die Zuordnung sichtbar, ihr
  Löschknopf lief aber ins Leere. Meldet das Gerät die Vorlage als nicht
  belegt, wird die verwaiste Zuordnung jetzt aufgeräumt.

## [1.4.2] — 2026-08-06

### Hinzugefügt

- **Vergleichs- und Zielwerte dürfen selbst auf ein Topic verweisen.** Das
  Wertfeld einer Wenn-Prüfung und die Werte einer Dann-/Sonst-Aktion nehmen
  weiterhin feste Zahlen und Texte auf; beginnt die Eingabe dagegen mit einem
  gültigen Präfix (`prefix://instanz/adresse`, z. B. `hdp://…`), wird zur
  Laufzeit der Wert dieses Ziel-States verwendet. Hinter jedem dieser Felder
  sitzt ein State-Picker, darüber der Hinweis auf beide Eingabearten.
- **Numerische Prüfung für mathematische Verwendung.** Bei den Vergleichen
  größer/kleiner und bei jeder Rechenfunktion muss ein fest eingetragener Wert
  numerisch sein — sonst erscheint unter dem Feld „Wert muss bei mathematischen
  Operatoren numerisch sein“ und Anlegen bzw. Speichern bleibt gesperrt. Für
  Topic-Verweise gilt dieselbe Anforderung, geprüft mit dem tatsächlichen Wert
  des States; boolesche Zustände zählen dabei als numerisch, gleich ob sie als
  `true`/`false` oder als Ein/Aus geführt werden.
- **Rechenfunktionen in Dann- und Sonst-Aktionen.** Statt nur einen festen Wert
  zu schreiben, verrechnen Aktionen jetzt zwei Werte (Addition, Subtraktion,
  Multiplikation, Division, Rest, kleinerer bzw. größerer Wert) und runden das
  Ergebnis auf Wunsch auf bis zu sechs Nachkommastellen. Beide Operanden können
  fest eingetragen sein oder aus einem Topic stammen.
- **Sonst-Zweig als vierter Bereich.** Trifft die Wenn-Prüfung nicht zu, läuft
  der Sonst-Zweig. Er ist je Bedingung einmal möglich, im Anlegen-Dialog per
  Haken zuschaltbar und bleibt bis dahin ausgeblendet.

### Geändert

- **Die Wenn-Prüfung ist optional.** Ein Haken im Anlegen- und im
  Bearbeiten-Dialog schaltet sie ab; die Dann-Aktionen laufen dann bei jedem
  Trigger bedingungslos. Der ausgeschaltete Bereich bleibt im Dialog
  ausgeblendet, damit er ihn nicht überlädt. Prüfung und Wenn-Elemente bleiben
  gekoppelt: Das letzte Wenn zu entfernen schaltet die Prüfung ab, ein neues
  Wenn schaltet sie wieder ein. Unverzichtbar bleiben nur Trigger und Dann.

## [1.4.1] — 2026-08-05

### Behoben

- **Self-Update scheiterte beim Installieren der Abhängigkeiten.** Der
  privilegierte Update-Helper läuft als gehärteter systemd-Dienst mit
  `ProtectHome=true`; `/root` ist darin leer und schreibgeschützt. npm konnte
  seinen Standardcache `$HOME/.npm` deshalb weder anlegen noch beschreiben und
  brach mit `ENOENT` (Status 254) ab — sichtbar als „`/usr/bin/npm` wurde mit
  Code 254 beendet" nach der Meldung „Produktionsabhängigkeiten werden im neuen
  Release installiert". Helper und Service-Unit legen HOME und den npm-Cache
  jetzt ausdrücklich in das beschreibbare Updateverzeichnis
  (`<data>/update`). Der Cache bleibt dort erhalten und beschleunigt spätere
  Updates, ohne je in der Installation zu landen.

## [1.4.0] — 2026-08-05

### Hinzugefügt

- **Persistentes Bedingungs- und Automationssystem.** Die neue Hauptseite
  „Bedingungen“ verwaltet ausklappbare, sortierbare Automationen im gemeinsamen
  Gruppenraster. Jede Automation besitzt mindestens einen Trigger, eine
  Wenn-Prüfung und eine Dann-Aktion; weitere Elemente lassen sich über die
  zentrale Plus-Zeile ergänzen und vollständig bearbeiten. Unterstützt werden
  Intervalle und feste Wochenzeitpunkte, Wertänderungen, exakte State-Ereignisse,
  typisierte Vergleiche sowie geordnete Schreibaktionen. Auswertung und
  State-Zugriffe laufen über den zentralen Bus und Schreibweg, die Definitionen
  und letzten Ergebnisse bleiben in SQLite erhalten. Die Seite ist über die
  Benutzerverwaltung wie jede andere Hauptseite je Zugang freischaltbar.
- **State-Picker mit Schreibfilter.** Felder, die ausschließlich ein
  Schreibziel aufnehmen — etwa das Ziel einer Dann-Aktion —, zeigen im
  Auswahlbaum nur schreibbare States. Instanzen und Verzeichnisse ohne solche
  States erscheinen gar nicht, die Zähler nennen die tatsächlich wählbaren
  Einträge, und ist nichts schreibbar, sagt der Picker das ausdrücklich.
- **Dialoge behalten ihre Eingaben nach einem Fehler.** Weist der Server eine
  Eingabe in Custom States oder Bedingungen zurück, öffnet sich derselbe Dialog
  erneut mit allen bereits eingetragenen Werten und der Fehlermeldung, statt
  die Eingaben zu verwerfen.
- **Gerätespezifischer hDP-Dimmschalter.** Prozentanzeigen und ARGB-Ausgänge
  können einen optionalen homeESS-State, dessen Vergleichswert und eine
  Dimmung in Prozent hinterlegen. Trifft der Wert zu, skaliert der Adapter die
  zuvor berechnete Helligkeit vor der Übertragung; beispielsweise lässt eine
  Dimmung um 80 Prozent noch 20 Prozent übrig. Firmwareänderungen sind dafür
  nicht erforderlich, und Aktivzustand sowie Helligkeit vor der Dimmung werden
  in der gerätespezifischen State-Gruppe veröffentlicht.
- **Abgesichertes Löschen installierter Adapter.** Administratoren können
  instanzlose Adapter nach einer ausdrücklichen Sicherheitswarnung und Eingabe
  der exakten Adapter-ID dauerhaft entfernen. Serverseitig verhindern Rollen-,
  Bestätigungs-, Pfad- und Instanzprüfungen versehentliches oder unsicheres
  Löschen; die Registry wird anschließend ohne Neustart aktualisiert. Die
  Auswahl bleibt über Curl- und interne Updates erhalten: bewusst entfernte
  offizielle Adapter werden nicht erneut installiert, eigene Adapter bleiben
  bestehen und nur der explizite Installer-Schalter `--all` stellt sämtliche
  offiziellen Adapter wieder her.
- **Sicherer Upload portabler Adapterpakete.** Die Adapterseite beginnt für
  Administratoren mit einer schmalen Uploadkachel für ZIP-Dateien. Archive
  werden außerhalb von `/adapter/` vollständig auf Pfade, Symlinks,
  Prüfsummen, Größenlimits, Mindestdateien, Manifestwerte, ID-/Prefixkollisionen
  und JavaScript-Syntax geprüft; erst danach wird ein neuer Adapter atomar in
  sein eigenes Verzeichnis übernommen und die Registry neu geladen. Fehlerhafte
  Pakete erreichen das produktive Adapterverzeichnis nicht und vorhandene
  Adapter werden nie überschrieben. Installer und Self-Updater halten nur die
  Adapterwurzel gezielt beschreibbar und bewahren hochgeladene Fremdadapter bei
  Versionswechseln.
- **Systemweite Mehrsprachigkeit.** Die allgemeinen Einstellungen enthalten
  direkt unter Standort und Zeit eine Sprachkarte mit installierten Sprachen,
  sicherem JSON-Upload und Übernehmen-Aktion. Sprachdateien werden beim Start
  und nach Upload neu gescannt; Deutsch und Englisch werden mitgeliefert,
  Uploads updatefest im Datenverzeichnis gehalten. Fehlende Schlüssel fallen
  für `Europe/Berlin` auf Deutsch, sonst auf Englisch zurück. Alle gemeinsamen
  Views nutzen UTF-8, Unicode-NFC und die aktive Locale. Adapter können eigene
  Sprachdateien mitbringen und erkennen die Systemwahl über Host-API,
  Management-Request oder Browser-Zugriffs-API; alle mitgelieferten Adapter
  enthalten deutsche und englische Kataloge.
- **Direktnavigation zu hDP-Instanzen.** Ausschließlich die Geräteverwaltungen
  des universellen hDP-Adapters erscheinen mit dem jeweiligen Instanznamen als
  eigene Hauptmenüpunkte. Sie stehen alphanumerisch sortiert zwischen Adapter
  und States und sind in Desktop- und Mobilnavigation verfügbar.
- **Updateverwaltung in den allgemeinen Einstellungen.** Eine eigene Karte
  zeigt installierte und online verfügbare Version sowie den Zeitpunkt der
  letzten Prüfung. Administratoren können dort unmittelbar prüfen oder ein
  angebotenes Update starten, das Prüfintervall auf stündlich, täglich,
  wöchentlich oder monatlich stellen und automatische Installationen in einem
  täglichen Wartungsfenster aktivieren. Die Automatik ist standardmäßig aus,
  verwendet die konfigurierte homeESS-Zeitzone, unterstützt Fenster über
  Mitternacht und versucht eine Version höchstens einmal je Kalendertag.
- **Zentraler, ausfallsicherer Timehandler.** Die laufende Systemuhr ist nun die
  primäre Zeitquelle für homeESS und wird gemäß konfigurierter Zeitzone sowie
  Sommer-/Winterzeit ausgewertet. Ist ein MQTT-Zeittopic konfiguriert, bildet
  homeESS fortlaufend einen gleitenden mittleren Versatz zur Systemuhr; dieser
  bleibt auch bei MQTT-Ausfall wirksam, sodass Prognosen und Tageswechsel
  weiterlaufen. Lokale Systemzeit, interne Zeit und MQTT-Abgleich sind in den
  allgemeinen Einstellungen sichtbar. Interne Uhrzeit und Datum stehen als
  `system://homeess/operating.time` und `system://homeess/operating.date` bereit.
- **Frei verwaltbare Custom States.** Unter der neuen States-Unterseite lassen
  sich beliebig tief verschachtelte Verzeichnisse und persistente Werte für
  Counter, Betriebszustände und Zwischenberechnungen anlegen. Boolean, Integer,
  Floating Point, Text und JSON werden beim Schreiben typgeprüft; numerische
  Fließkommawerte unterstützen Einheit, Nachkommastellen und wählbares Auf-, Ab-,
  Abschneiden oder kaufmännisches Runden. Die Werte erscheinen als les- und
  schreibbare `custom://`-Topics in der States-Liste und in allen bestehenden
  State-Pickern. Der kompakte Verzeichnisbaum merkt seinen Aufklappzustand.
  Die Anlegedialoge merken außerdem das zuletzt gewählte Zielverzeichnis und
  bei States den Datentyp, solange die jeweilige Auswahl noch vorhanden ist.
- **Sicheres Self-Update mit persistenter Releaseprüfung.** homeESS prüft im
  konfigurierten Intervall das neueste stabile GitHub-Release und zeigt
  Administratoren eine hellgrüne Updateolive links neben den Leistungswerten.
  Nach ausdrücklicher Bestätigung übernimmt ein eng begrenzter, root-geführter
  systemd-One-shot-Helper: Er validiert das Release nochmals, lädt und bereitet
  es vollständig vor, schaltet die Installation erst dann um und prüft den
  Neustart. Bei einem Fehler wird automatisch auf die bisherige Version
  zurückgerollt. Die Browseransicht zeigt den persistenten Fortschritt und
  kehrt nach erfolgreichem Neustart zum Dashboard zurück; ein zweiter
  Webserver oder ein zusätzlicher offener Port ist nicht nötig.
- **Kanalauswahl beim Firmwareupload.** Beim Hochladen von Hand lässt sich
  jetzt festlegen, in welchen Kanal ein Release soll: Stabil, Beta,
  Entwicklung — oder „Nach Vorgabe im Manifest“ wie bisher. Weicht die Auswahl
  vom Manifest ab, wird dessen `release.channel` beim Ablegen umgeschrieben und
  das Release samt Artefakten im gewählten Kanal gespeichert; die abgelegte
  Datei widerspricht ihrem Ablageort also nie. Die Rückmeldung nennt die
  Umschreibung ausdrücklich. Das gilt nur für den manuellen Upload — beim
  späteren automatischen Abholen von Releases bleibt die Kanalvorgabe des
  Manifests maßgeblich.
- **hDP-Gerätetyp „ARGB-Ausgang“.** Ein frei konfigurierbar langer ARGB-Strang
  wird zur Statusanzeige: Jede LED bekommt genau einen homeESS-State und ein
  Einschaltkriterium — `= x`, `< x`, `> x` oder `x bis y` —, dazu eine An- und
  eine Aus-Farbe. Erfüllt der Wert das Kriterium, leuchtet die LED in der
  An-Farbe, sonst in der Aus-Farbe; LEDs ohne Zuordnung bleiben dunkel. `= x`
  vergleicht auch Text, die Ordnungskriterien zwingend numerisch; Booleans
  zählen als 1 und 0. Ein noch nie gelieferter State erfüllt kein Kriterium,
  damit die Anzeige keinen Zustand erfindet. Die gesamte Auswertung passiert im
  Adapter — das Gerät empfängt wie bei der Prozentanzeige nur fertige Frames
  und teilt sich mit ihr Hardwareprofil und Laufzeitprofil. Jede belegte LED
  wird zusätzlich als eigener homeESS-State `devices/<id>/argb/led-<n>`
  veröffentlicht. Setzt hDP-Firmware 0.5.0 voraus.
- **Der ARGB-Ausgang führt zusätzlich Binary-I/O.** Alle GPIOs, die nicht der
  LED-Strang belegt, sind auf einem solchen Gerät Ein- oder Ausgänge — ohne
  eigene Pinkonfiguration. Die Belegung folgt der Hardware: GPIOs ohne
  nutzbaren internen Pull-up (auf dem D1 mini GPIO 15 und 16) sind fest
  Ausgänge für Relais oder Schütze, der gewählte Datenpin trägt den Strang,
  alle übrigen werden Eingänge für Taster oder Schalter. Zu entscheiden bleibt
  je Eingang nur Taster oder Schalter; Zieltopic, Aktion (Zustand übernehmen,
  umschalten, Wert setzen, Counter erhöhen) und Setzwert werden wie beim
  Binary-I/O-Gerät verknüpft und ebenso als eigene States veröffentlicht.
  Setzt hDP-Firmware 0.5.1 voraus. **Achtung:** Damit werden auch GPIO 1 und 3
  zu Eingängen — die serielle Konsole des Geräts ist dann belegt.
- **Sammelupdate für hDP-Geräte.** Sobald mindestens ein gekoppeltes Gerät
  veraltete Firmware verwendet, bietet der Firmwarebereich der
  Geräteverwaltung „Alle aktualisieren“ an. Die betroffenen Geräte werden
  nacheinander aktualisiert; Fehler einzelner Geräte brechen die übrigen
  Updates nicht ab und werden abschließend zusammengefasst.
- **USB-Flashtool `hdp-flash`.** Ein eigenständiges Werkzeug holt die im
  Firmwarespeicher hinterlegte Firmware, prüft ihre SHA-256 gegen das Manifest,
  wählt das exakt passende Artefakt nach Plattform, Board und Variante und
  schreibt es über den seriellen Port. Der Flash wird dabei nicht gelöscht, also
  bleiben WLAN, Pairing und Hardwarekonfiguration erhalten; `--erase` erzwingt
  ein werksreines Gerät. Nötig für die Erstinbetriebnahme und für Geräte, deren
  installierte Firmware ein OTA ablehnt. Im Browser ist das bewusst nicht
  umgesetzt: Die Web Serial API setzt einen sicheren Kontext voraus und gibt es
  nur in Chromium. Das Werkzeug wird mit dem hDP-Adapter ausgeliefert und ist in
  der Geräteverwaltung unter „Firmware“ herunterladbar. Es sucht die
  homeESS-Instanz beim Start im lokalen Netz, merkt sich die gefundene Adresse
  und bietet bei mehreren Treffern eine Auswahl an; eine fest eingebaute Adresse
  gibt es bewusst nicht. Abgesucht werden die tatsächlichen Netze der
  Schnittstellen samt Netzmaske — eine `/23` umfasst zwei `/24`-Blöcke, eine
  `/32` ist eine Einzelroute ohne Nachbarn.
- **Öffentliche Adapterdateien.** Ein Adapter kann im Manifest zwei
  Unterverzeichnisse als `publicFiles` erklären: `data` im Datenverzeichnis der
  Instanz für zur Laufzeit entstehende Dateien und `assets` im
  Adapterverzeichnis für mitgelieferte. homeESS liefert beide unter
  `/adapter-public` ohne Anmeldung nur lesend aus — gedacht für Werkzeuge
  außerhalb des Browsers, die keine Sitzung führen können. Adapter ohne diese
  Erklärung geben nichts preis, Pfade außerhalb der erklärten Verzeichnisse
  werden abgewiesen. Die Antwort trägt eine Dienstkennung, damit ein Werkzeug
  beim Absuchen des Netzes eine homeESS-Instanz sicher erkennt.
- **Zentraler hDP-Firmwarespeicher statt Upload je Gerät.** Es gibt genau eine
  universelle Firmware; ein Release-Manifest beschreibt sie je Plattform, Board
  und Variante. Sie wird deshalb einmal in der Geräteverwaltung hinterlegt —
  Manifest und Artefakte werden dabei gegen Größe, SHA-256 und Signaturpolitik
  geprüft. Der Speicher hält je Release-Kanal einen Stand; ein Kanal gilt erst
  als installierbar, wenn zu jedem deklarierten Artefakt auch die Datei
  vorliegt. Ein Versionswechsel räumt die Artefakte des Vorgängers weg.
- **Ein-Klick-Update und echter automatischer Rollout.** Die Geräteseite meldet,
  ob der Kanal des Geräts einen neueren Stand bereithält, und installiert ihn auf
  Knopfdruck. Bei Updatepolitik `automatic` erledigt das der Adapter selbst:
  minütlich, nach jeder Rückkehr eines Geräts und nach jedem Hinterlegen eines
  Releases, begrenzt durch Wartungsfenster und Wiederholungszahl. Ein während
  einer Abwesenheit verpasstes Fenster wird einmalig nachgeholt. Bisher waren
  Updatepolitik, Kanal, Wartungsfenster und Wiederholungsgrenze reine Anzeige
  ohne jede Wirkung.
- **Adapter-Datenverzeichnis in der Host-API.** `getDataDirectory()` liefert
  einer Adapterinstanz ein eigenes Verzeichnis mit 0700 unter `data/adapters/`.
  Nutzdaten dieser Größenordnung gehören nicht in die Instanz-Settings: Der
  Settings-Blob wird bei jedem Persistieren vollständig neu geschrieben.
- **hDP-Gerätetypprofil `boot-dispatch-v1`.** Der Adapter akzeptiert neben
  `opaque-id-v1` auch Geräte, die mehrere Gerätetypen im Manifest anbieten, und
  verhandelt dafür den Binary-I/O-Vertrag (`binary_pins`, Eingangstypen,
  Debounce, Pinlimits) einschließlich validierter `binary.*`-Nachrichten und
  eines Host-Aufrufs `state.write` zum Rückschreiben von Eingangsereignissen.
  Ohne diese Erweiterung lehnte die Manifestprüfung Firmware 0.4.0 mit
  `INVALID_REQUEST` ab, sodass solche Geräte nicht koppelbar waren.
- **Hinweise statt Sperren bei Binary-I/O-GPIOs.** Firmware 0.4.1 gibt alle
  GPIOs des ARGB-Ausgangs auch für Binary-I/O frei und beschreibt die
  Eigenheiten einzelner Pins in den optionalen Manifestlisten
  `binary_pullup_pins`, `binary_boot_sensitive_pins` und `binary_serial_pins`.
  Die Geräteverwaltung übernimmt sie als Hinweis an der Pinauswahl („externer
  Pull-up nötig", „Boot-Pin", „serielle Konsole") samt Legende, statt Pins
  auszublenden. Fehlen die Listen — etwa bei Firmware 0.4.0 —, entfallen die
  Hinweise, ohne die Kopplung zu beeinträchtigen.
- **Portable Styles für Adapterverwaltungen.** Adapter können über
  `managementPage.stylesheet` eine eigene CSS-Datei aus ihrem Adapterverzeichnis
  deklarieren. homeESS liefert ausschließlich diese Datei über die geschützte
  Management-Route aus und bindet sie nach dem gemeinsamen Basis-Stylesheet ein.
- **Helligkeit als System-Prognose-State.** `prognose.helligkeit` bildet den
  Tagesverlauf als Trapez ab: linear von 0 auf 100 % während der bürgerlichen
  Morgendämmerung, 100-%-Plateau bei vollständig aufgegangener Sonne und linear
  zurück auf 0 % während der Abenddämmerung. Eine belastbar gemessene
  Sonnenintensität beeinflusst 60 % des Werts; 40 % diffuses Tageslicht bleiben
  selbst bei 0 % Sonnenintensität erhalten.
- **Optionaler hDP-Richtungsindikator.** Die Prozentanzeige kann getrennte
  Boolean-Topics für Rising und Falling beziehen. Geschwindigkeit,
  Impulsabstand und Schatten-Dimmung werden gemeinsam konfiguriert. Der Adapter
  rendert daraus semantikfreie, lokal geloopte `hdtl-delta-v1`-Timelines.
- **Generischer hDP-Outputclient.** `pixel-timeline-v1` unterstützt absolute und
  sparse Frames sowie Timeline-Begin, Chunk, Commit, Abort, Play, Stop und
  Status mit Manifestlimits, korrelierten Antworten und verbindlicher
  Wiederherstellung nach unsicheren Antworten oder Sitzungsverlust.
- **Eigenständiger hDP Adapter.** Der neue Adapter entdeckt
  `_homeess-hdp._tcp.local`-Geräte, koppelt sie exklusiv mit der dauerhaften
  homeESS-Identität, übernimmt vorhandene Hardwarekonfigurationen und unterstützt
  die universelle `percentage_indicator`-Anzeige einschließlich State-Auswahl,
  Skalierung, drei Farbmodi, dynamischer Helligkeit, WebSocket-Laufzeitstatus,
  Unpair und lokal verifiziertem, gestreamtem OTA.
- Die Kopplungs- und Konfigurationsseite heißt kurz **Geräteverwaltung**;
  **hDP Geräte** bleibt die kompakte Geräte-/State-Übersicht.
- **Erweiterte portable Adapter-Host-API.** Adapter können optional eine
  authentifizierte Management-Seite bereitstellen, begrenzte Binäruploads über
  temporäre Dateien verarbeiten, beliebige homeESS-States ereignisgesteuert
  abonnieren, die öffentliche globale Instanzidentität nutzen und Secrets in
  einem instanzgebundenen 0600/0700-Store ablegen. Bestehende Adapter bleiben
  unverändert kompatibel.

### Geändert

- **Bedingungen liegen in Verzeichnissen, ihre Elemente sind nicht mehr
  verschiebbar.** Die Seite „Bedingungen“ nutzt denselben Verzeichnisbaum wie
  „Messen + Schalten“ und die Custom States: Verzeichnisse lassen sich anlegen,
  umbenennen, verschachteln und samt Inhalt entfernen, Bedingungen per Drag&Drop
  zwischen ihnen einsortieren oder im Dialog zuordnen. Trigger, Wenns und Danns
  haben keine Dragfläche mehr, weil ihre Reihenfolge für die Auswertung ohne
  Bedeutung ist. Serverseitige Layoutprüfungen verhindern unvollständige Bäume,
  Zyklen und Namenskollisionen; bestehende Automationen bleiben nach dem Update
  im Wurzelverzeichnis.
- **Das Hauptmenü scrollt unabhängig vom festen Fußblock.** Bei geringer
  Bildschirmhöhe bleiben Einstellungen, Abmelden, Copyright und Version im
  Desktop- und Mobilmenü dauerhaft erreichbar, während ausschließlich die
  Hauptnavigation in ihrem eigenen Bereich scrollt. Die native Scrollbar ist
  browserübergreifend schmal und dunkel gestaltet; helle Spur und Scrollpfeile
  erscheinen nicht mehr auf der dunklen Navigation.
- **Custom States entsprechen jetzt „Messen + Schalten“.** Die Verwaltung nutzt
  dasselbe vollbreite Gruppenraster mit dunklen Verzeichnisköpfen, kompakten
  State-Zeilen und eigenen Drag-Flächen. Verzeichnisse und States lassen sich
  frei sortieren und zwischen Ebenen verschieben; Namen, Zuordnung, Datentyp,
  Einheit, Wert und Rundung bleiben nachträglich vollständig bearbeitbar.
  Serverseitige Layoutprüfungen verhindern unvollständige Bäume, Zyklen und
  Namenskollisionen.
- **Kurze zweisprachige Projekt-Startseite.** `README.md` ist nun die kompakte
  englische Einstiegsseite mit Projektzweck, Hardwareanforderungen und
  Installation; `README_de.md` enthält die spiegelgleiche deutsche Fassung.
  Der ausführliche Funktionsumfang steht getrennt in `FEATURES.md` und
  `FEATURES_de.md`. Alle vier Dokumente verlinken ihre jeweilige Sprachfassung
  direkt am Anfang, damit die Installationsinformationen nicht mehr unter einem
  langen Featureblock verborgen liegen.
- **Einheitliches gerätetypspezifisches hDP-State-Schema.** Unter „Status“
  stehen nur noch allgemeine Geräte- und Hardwareprofilwerte wie Online- und
  WLAN-Zustand, IP-Adresse, Gerätetyp, Firmware, Laufzeit sowie die physischen
  Pixellimits. Prozentanzeige, ARGB-Ausgabe, zugeordnete LEDs und Binary-I/O
  besitzen eigene Gerätegruppen; unpassende States werden für den gewählten
  Gerätetyp weder katalogisiert noch publiziert. Binary-Ein- und -Ausgänge sind
  getrennt und vollständig aufgeführt, einschließlich der festen ARGB-Ausgänge
  auf GPIO 15 und 16.
- **Updateolive nur in der PC-Ansicht.** Der Hinweis auf eine verfügbare
  Version wird im mobilen Layout vollständig ausgeblendet. Die Updatekarte in
  den allgemeinen Einstellungen bleibt dort weiterhin erreichbar.
- Die sichtbare Überschrift der hDP-Geräteverwaltung stellt nun den jeweiligen
  Instanznamen voran; Menü- und Buttonbeschriftungen bleiben unverändert.
- **Firmwarebereich der Geräteverwaltung neu aufgebaut.** Statt einer
  sechsspaltigen Tabelle, die schon auf dem Notebook nur mit Querscrollen
  lesbar war, zeigt jeder Kanal jetzt eine eigene Karte mit Version, Status,
  Veröffentlichung, Build und Artefakten. Die Karten stapeln sich, sobald die
  Breite knapp wird.
- **Geräteverwaltung auf schmalen Anzeigen benutzbar.** Mehrere Bereiche
  konnten die Seite in die Breite schieben und damit waagerechtes Scrollen über
  die gesamte Seite erzwingen: die Gerätefakten mit ihrer festen Mindestbreite,
  die Firmwaretabelle sowie lange Zeichenketten ohne Trennstellen —
  Geräte-IDs, SHA-256-Prüfsummen, Build-Kennungen und Artefaktdateinamen.
  Die betroffenen Raster brechen jetzt um, die langen Zeichenketten dürfen
  umbrechen, und Formularfelder bleiben in jedem Fall in ihrem Kasten.
- **Hardwaredialog der hDP-Geräteverwaltung.** Breite und Inhalt passen wieder
  zusammen: Bisher setzte der Dialog 760px und das Formular darin 800px, das
  Formular ragte also stets über seinen eigenen Dialog hinaus. Jetzt gibt der
  Dialog die Breite vor (880px, unterhalb von 768px weiterhin das
  Bottom-Sheet über die volle Breite) und das Formular füllt sie exakt aus. Die
  Binary-Pinzeilen stehen zudem wieder als eine Zeile aus Pin, Richtung und
  Eingangstyp statt mit umgebrochenem Eingangstyp.
- **Persistenter Adapterfilter.** Die Auswahl „Inaktive Adapter ausblenden“
  bleibt im jeweiligen Browser über Seitenwechsel, Reloads und Serverneustarts
  erhalten; ohne gespeicherte Auswahl gilt weiterhin der bisherige Standard
  „ausblenden“.
- **Installer bereinigt frühe Installationen sicher.** Eine alte
  `server.service` wird beim Installieren oder Aktualisieren nur dann gestoppt
  und entfernt, wenn ihr Startbefehl eindeutig auf homeESS zeigt. Der bisher im
  Checkout liegende komplette `data/`-Bestand – einschließlich Datenbank,
  Instanzidentität und Adapterdaten – wird bei leerem Ziel nach
  `/var/lib/home-ess` übernommen; vorhandene Zieldaten werden niemals
  überschrieben oder vermischt. `HOME_ESS_DATA_DIR` hält anschließend alle
  veränderlichen Daten konsistent außerhalb des Git-Checkouts.
- **Werte-Widgets verwenden States.** Neue und bearbeitete Wert-Kacheln wählen
  ihre Quelle über den zentralen State-Picker und speichern das kanonische
  State-Topic in einem eigenen Datenbankfeld. Beim Laden werden alte
  Wertekatalog-Bezüge erkannt, berechnete Systemwert-IDs in
  `system://homeess/...`-Topics konvertiert und der Datensatz dauerhaft im neuen
  Schema gespeichert; bereits topicförmige Adapterbezüge bleiben unverändert.
- **Freigegebene hDP-Firmwareupdates nach Abschluss oder Fehler.** Der
  Updateknopf wird nach erfolgreichen und fehlgeschlagenen Versuchen sofort
  wieder bedienbar. Nach einem Adapterneustart werden außerdem persistierte,
  nicht mehr fortsetzbare OTA-Zwischenzustände als unterbrochen freigegeben.
- **Einheitliche hDP-Schreibweise.** Der homeESS Device Protocol-Adapter,
  seine Geräteansichten, Meldungen, Dokumentation und Protokollbezeichner
  verwenden durchgehend die Markenform `hDP` mit kleinem `h`.
- **hDP-Ausgaben respektieren das physische Frame-Limit.** Direkte Frames
  werden pro Ausgang serialisiert; eine laufende Indicator-Timeline wird vor
  dem Wechsel auf einen statischen Frame explizit gestoppt. Eine dennoch vom
  Gerät gemeldete Rate-Limit-Ablehnung wird nach dem Mindestabstand einmal
  wiederholt. Veraltete Output-Hinweise verschwinden nach der nächsten
  nachweislich erfolgreichen Ausgabe.
- **Dynamische hDP-Helligkeit relativ zum Hardwaremaximum.** Dynamische und
  feste Plugin-Helligkeiten werden als Anteil der konfigurierten
  Hardware-Maximalhelligkeit ausgewiesen. Die Geräteansicht zeigt den daraus
  resultierenden Effektivwert, beispielsweise 50 % von maximal 20 % als 10 %,
  statt die Hardwaregrenze irreführend als aktuellen Helligkeitswert anzugeben.
- **Korrekte hDP-Wiederverbindung nach Neustarts.** Bereits gekoppelte Geräte
  bauen beim ersten passenden Discovery-Treffer ihre Laufzeitverbindung wieder
  auf. Offline-Geräte zeigen keine veraltete WLAN-Signalbewertung oder andere
  scheinbar aktuelle Laufzeitmesswerte mehr.
- **Prognose-Helligkeit für hDP-Anzeigen.** Dynamische Helligkeitsquellen dürfen
  Prozentwerte mit Nachkommastellen liefern. Der hDP-Adapter begrenzt den Wert
  weiterhin auf 0–100 und rundet ihn erst an der Protokollgrenze auf den von
  der Geräteausgabe geforderten ganzzahligen Prozentwert.
- **Kompakte hDP-Geräteverwaltung.** Gekoppelte Geräte stehen jetzt unabhängig
  von ihrem Verbindungsstatus in einer gemeinsamen, nach Erreichbarkeit
  sortierten Liste. Online-Status, WLAN-Signalqualität, Firmware und
  Netzwerkbezug sind auf einen Blick sichtbar; technische Leerwerte und
  Laufzeitdetails wurden aus der Übersicht entfernt. Eine Suche erleichtert die
  Verwaltung größerer Gerätebestände, neu gefundene Geräte bleiben klar
  abgesetzt. Übersicht und Geräteseiten nutzen die volle homeESS-Inhaltsbreite;
  Signal und Firmware bleiben in festen Spalten ausgerichtet.
- **Live aktualisierte hDP-Geräteliste.** Die Geräteverwaltung übernimmt
  Status-, Signal- und Discovery-Änderungen ohne Seitenreload. Der Browser fragt
  höchstens einmal pro Sekunde ab, pausiert im Hintergrund und ersetzt das
  servergerenderte Fragment nur bei geänderter Revision. Bereits bestätigte
  Geräte mit lokalem Binding-Key bleiben unmittelbar nach einem Neustart als
  offline sichtbar. Offline wird grau, kritisch schwacher WLAN-Empfang gelb
  markiert.
- **Einheitliche grüne Aktionsbuttons.** Die gemeinsame Buttonklasse der
  Adapterverwaltung verwendet nun die grünen homeESS-Corporate-Farben statt
  fest kodiertem Blau. Das gilt auch für die hDP-Geräteverwaltung.
- **hDP-Kopplung ohne parallelen Binding-Abgleich.** Während einer manuell
  gestarteten Gerätekopplung löst eine gleichzeitige mDNS-Zustandsänderung
  keinen zweiten Kopplungslauf mehr aus. Das verhindert konkurrierende
  HTTP-Verbindungen zum ESP8266 und dadurch verursachte Verbindungs-Timeouts.
- **Stabile hDP-Geräteverbindungen und Konfiguration.** Verspätete Close-Events
  ersetzter WebSocket-Sitzungen können eine bereits aktive neue Sitzung nicht
  mehr offline setzen oder deren Heartbeat stoppen. Unveränderte mDNS-Antworten
  lösen weder wiederholte Binding-HTTP-Abfragen noch Persistenzläufe aus.
  Gerätenamen werden beim generischen `pixel-timeline-v1` als lokale
  homeESS-Bezeichnung zuverlässig gespeichert.
- **Übersichtliche, portable hDP-Gerätekonfiguration.** Gerätestatus, Anzeigewert,
  Farbdarstellung, dynamische Helligkeit, Richtungsindikator und Update-Automatik
  sind als einheitliche Funktionsgruppen angeordnet. Die normalerweise nur bei
  der Ersteinrichtung benötigte Hardwarekonfiguration liegt in einem eigenen,
  responsiven Unterdialog; modusabhängige Felder werden nur bei Bedarf gezeigt.
  Das vollständige hDP-spezifische Styling liegt jetzt im Adapter selbst.
- **Adapter vor States im Hauptmenü.** Die beiden eigenständigen Menüpunkte
  wurden getauscht, sodass Adapter jetzt direkt über States steht.
- **Sonnenintensität zeigt nachts 0 %.** Wenn das Clear-Sky-Modell für alle
  berechenbaren Anlagen 0 W Idealstrahlung liefert, wird dies als gültiger
  Nullwert statt als fehlender Wert ausgegeben. Das gilt auch direkt nach einem
  Neustart, bevor eine im nächtlichen Standby befindliche Anlage erstmals einen
  Leistungswert sendet. Nachtwerte bleiben aus den Tagesmitteln ausgeschlossen.
- **Richtungsindikatoren werden zuverlässig deaktiviert.** Entfernte oder
  gewechselte Rising-/Falling-Topics setzen ihren zwischengespeicherten
  Booleanzustand sofort auf `false`. Der Adapter rendert anschließend einen
  absoluten statischen Replace-Frame, der eine laufende Indicator-Timeline
  verbindlich beendet.
- **Saubere hDP-Prozentwerte.** Binäre Gleitkommaartefakte aus der Skalierung
  werden zentral auf drei Nachkommastellen normalisiert. Status, Adapter-State
  und `state.set` zeigen damit beispielsweise `57` statt
  `56.99999999999999`.
- **hDP-Prozentwerte veralten nicht.** Der Adapter verwendet den zuletzt in
  homeESS vorhandenen Quellenwert unabhängig davon, wie lange er unverändert
  bleibt. Die sachlich falsche Fünf-Minuten-Warnung und ihr Hintergrundtimer
  wurden entfernt; bereits persistierte Warnungen werden beim Laden bereinigt.
- **hDP-Verbindungen sind transparent und dauerhaft retry-fähig.** Geräteansicht
  und States zeigen jetzt Verbindungsphase, Versuch und nächsten Retry. Fehlerhafte
  HTTP-Header beim Upgrade und eine Firmware-Ablehnung des normativen
  `homeess.hello`-Textframes werden eindeutig benannt, während der normative
  Backoff weiterläuft. Häufige Discovery-Ereignisse werden bei der
  Adapter-Persistenz zusammengefasst.
- **Eine zentrale States-Quelle.** Die bisher getrennten berechneten Systemwerte
  und Adapter-States werden über ein gemeinsames States-Repository bereitgestellt.
  Die eigenständige States-Hauptseite zeigt interne Werte unter **System** und
  daneben die Adapter-Instanzen. Dashboard, Output und die bisherigen
  Wertekatalog-APIs greifen auf dieselbe Quelle zu; gespeicherte Wert-IDs bleiben
  vollständig kompatibel. Der Topic-Picker zeigt denselben zentralen Baum;
  berechnete Werte sind dort über lesbare `system://homeess/...`-Topics
  auswählbar und werden reaktiv an konfigurierte Eingänge weitergeleitet.
- **hDP vollständig an die präzisierte `hDP.md` angeglichen.** Pairing verwendet
  ausschließlich `local-binding-key-v1`, persistiert Pending-Key und Nonce vor
  dem ersten Request, prüft die bytegenaue `binding_id` und aktiviert erst nach
  `binding_status: match`. Verlorene Pairing-, Config-, Unpair- und
  OTA-Restart-Antworten folgen den verbindlichen Recoveryregeln.
- **Klare Zuständigkeitsgrenze für hDP-Ausgaben.** Prozent-, Farb-,
  Helligkeits- und Richtungssemantik verbleibt vollständig im Adapter. Geräte
  mit exakt `pixel-timeline-v1` erhalten nur generische `output.frame.set`-
  Frames oder `hdtl-delta-v1`-Timelines; Hardwaregrenzen und physische
  Schutzparameter verbleiben in der Firmware. Bereits gekoppelte Geräte ohne
  Runtime-Profil nutzen weiterhin den isolierten, abwärtskompatiblen
  Legacy-`state.set`-Pfad. Andere explizite Runtime-Profile werden sichtbar
  abgelehnt.
- Discovery validiert den vollständigen TXT-Vertrag. HTTP, WebSocket,
  Hardwarekonfiguration und OTA erzwingen die normativen Envelopes, Typen,
  Größen, Auth-Header, Sequenzen, Timeouts und Zustandsgrenzen. Pins und
  Hardwarelimits kommen ausschließlich aus dem Gerätemanifest; Recoveryzustände
  verhindern automatische Konfigurationsschreibvorgänge.
- **Dashboard lädt auch über den Fernzugriff schlank und robust.** Der bisher
  vollständig in die Seite eingebettete Wertekatalog wird erst beim Öffnen des
  Widget-Dialogs geladen. Seine aufklappbaren Ebenen laden jeweils nur direkte
  Unterebenen und sichtbare Werte nach; große Blätter sind auf 100 Werte je
  Seite begrenzt, die Suche läuft gezielt auf dem Server. Die normalen
  Dashboard-Liveabfragen lösen nur noch die tatsächlich konfigurierten
  Widget-Werte auf. Außerdem ist der erste Dashboard-Tab bereits im
  serverseitigen HTML sichtbar und hängt nicht mehr von der Ausführung des
  Scripts am Dokumentende ab.
- **Wallbox-Ladung in der Prognose.** Ist für ein Fahrzeug ein
  Angesteckt-Topic konfiguriert, wird dessen geplanter Ladebedarf nur noch bei
  eindeutig angestecktem Fahrzeug in die Verbrauchsprognose eingerechnet. Ohne
  dieses Topic bleibt die bisherige Planung anhand des bekannten Fahrzeug-SoC
  erhalten.

### Behoben

- **Sortieren auf der Bedingungsseite schlägt nicht mehr fehl.** Das Speichern
  des Layouts lief bisher in die allgemeine Bedingungsroute und beantwortete den
  JSON-Aufruf mit einer HTML-Seite („Unexpected token '<'“). Feste Pfade
  (`/conditions/layout`, `/conditions/folder/…`) werden jetzt vor `/conditions/:id`
  ausgewertet.
- **Eindeutige hDP-Bestätigungswarnung.** Bleibt bei weiterhin aktiver
  WebSocket-Verbindung nur die Bestätigung eines Ausgabebefehls aus, wird das
  Gerät nicht mehr widersprüchlich als `DEVICE_OFFLINE` bezeichnet. Der Hinweis
  benennt stattdessen den unklaren Befehlsstatus und verschwindet nach der
  nächsten erfolgreich bestätigten Ausgabe wieder.
- **Administratorzugang bei bestehenden Installationen repariert.** Falls eine
  ältere Datenbank zwar Benutzer, aber durch einen früheren Zwischenstand kein
  gesetztes Admin-Flag enthält, wird der älteste Zugang einmalig zum
  Administrator. Dadurch erscheinen die geschützte Updatekarte und weitere
  reine Administratorfunktionen wieder zuverlässig.
- **Neuinstallation ohne veraltete Service-Unit brach ab.** Der optionale
  Cleanup für frühe `server.service`-Installationen gab im normalen
  „nicht vorhanden“-Fall Status 1 zurück, den `set -e` als Fehler behandelte.
  Alle optionalen Cleanup-/Migrations-Guards kehren jetzt ausdrücklich
  erfolgreich zurück. Der Fehler-Trap nennt künftig zusätzlich den konkret
  fehlgeschlagenen Befehl statt nur die Zeilennummer.
- **Installation über `curl | bash` brach unter `set -u` ab.** Bei einem über
  stdin ausgeführten Bash-Skript ist `BASH_SOURCE[0]` nicht zwingend gesetzt.
  Der Installer verwendet für seine Einstiegspunktprüfung jetzt `$0` als
  sicheren Fallback und bleibt beim Sourcen weiterhin nebenwirkungsfrei.
- **Erfolgreiches Firmwareupdate wurde als fehlgeschlagen gemeldet.** Die
  Nachverifikation nach dem OTA-Neustart wartete nur 60 Sekunden. Ein Gerät,
  das nach dem Neustart erst das Image kopiert, seine Konfiguration
  vervollständigt, die Pins einrichtet und dann WLAN, mDNS und WebSocket
  aufbaut, braucht länger — und jede erfolglose Runde kostete zusätzlich die
  Wiederholungen des HTTP-Clients, sodass in der Minute nur wenige Versuche
  Platz hatten. Das Fenster beträgt jetzt drei Minuten; meldet das Gerät
  dagegen selbst einen endgültigen Fehlschlag, wird sofort abgebrochen statt
  gewartet. Die Fehlermeldung nennt außerdem, welche Version das Gerät zuletzt
  in welchem Zustand gemeldet hat.
- **Eigenständiger Neustartknopf konnte nie einen Erfolg melden.** „Geprüfte
  Firmware neu starten“ verglich gegen eine nur im Arbeitsspeicher gehaltene
  Sollversion. Fehlte sie — etwa weil der Upload in einem früheren Adapterlauf
  passierte —, lief die Prüfung zwangsläufig ins Leere. Fehlt sie, gilt jetzt
  die Zielversion, die das Gerät selbst meldet.
- **Geleertes Zahlenfeld wurde als Null gespeichert.** `Number('')` ist 0, und
  die Formularauswertung der hDP-Geräteverwaltung gab deshalb bei einem
  geleerten Feld nicht den Standardwert zurück, sondern eine Null — ein
  geleerter Counter-Schritt zählte anschließend nicht mehr, eine geleerte
  LED-Anzahl wurde als 0 abgewiesen statt auf 10 zurückzufallen. Ein leeres
  Feld gilt jetzt als fehlende Angabe; eine ausdrückliche 0 bleibt eine 0.
- **Gemerkter OTA-Fehlschlag klebte dauerhaft am Gerät.** Scheiterte ein
  Firmwareupdate erst in der Nachverifikation — das Gerät war nach dem Neustart
  vorübergehend nicht erreichbar —, blieb „failed" samt Fehlertext in der
  Firmwarekarte stehen, auch nachdem das Gerät längst wieder lief und
  aktualisiert war. Aufgeräumt wurde er erst beim nächsten Updateversuch. Beim
  turnusmäßigen Firmwareabgleich wird der gemerkte Fehlschlag jetzt gegen das
  abgeglichen, was das Gerät selbst meldet: Sagt es „completed" oder „idle",
  war der gemerkte Fehlschlag überholt und verschwindet. Ein laufendes Update
  bleibt unangetastet.

## [1.3.2] — 2026-07-19

### Geändert

- **Einstellungen mit Tabs; schlankeres Menü.** Module und Fernzugriff sind keine
  eigenen Menüpunkte mehr, sondern Tabs der Einstellungsseite. Diese hat oben
  eine Tabulatorleiste (wie das Dashboard) mit „Allgemeine Einstellungen"
  (Standort/Zeit + MQTT), „Benutzerverwaltung", „Module" und „Fernzugriff". Die
  Benutzerverwaltung ist damit ein eigener Tab (aus den allgemeinen Einstellungen
  herausgelöst). Der untere Menüblock enthält dadurch nur noch „Einstellungen".
  Die alten Direktlinks `/module` und `/remote-access` leiten auf den passenden
  Tab weiter.
- **Fernzugriff-Tab pausiert Hintergrundroutinen.** Pairing-, Verbindungs- und
  Geräte-Polling laufen auf der Einstellungsseite nur noch, solange der Tab
  „Fernzugriff" aktiv ist. Beim Wechsel auf andere Einstellungstabs werden die
  Timer gestoppt und beim Zurückwechseln sauber wieder aufgenommen.
- **Responsive Gruppenbreiten.** Auf Smartphones wird Viertelbreite als halbe
  Breite dargestellt (voll bleibt voll, halb bleibt halb); Desktop unverändert.
  Kompaktere Karten, ruhigere Abstände und einheitliche Icon-Buttons im
  Dashboard.
- **Dialoge.** Widget- und Gruppen-Dialog erhalten eine Tab-Auswahl (bei
  Widgets folgt der Tab der gewählten Gruppe), der Widget-Dialog zusätzlich
  Größen- und Farbwahl sowie den neuen Schalter-Typ an zweiter Position.

### Hinzugefügt

- **Benutzerverwaltung mit Rollen.** Der bei der Erstinstallation angelegte
  Zugang ist der Administrator und trägt immer alle Rechte (nicht herabstufbar,
  nicht löschbar). In den Einstellungen ersetzt eine Benutzer-Box die bisherige
  Passwort-Box: Benutzer lassen sich anlegen, per Auswahl/Doppelklick bearbeiten
  und löschen. Jedem Benutzer werden eine Rolle und die im Menü sichtbaren Seiten
  zugewiesen. Rollen:
  - **Lesen** – alles schreibgeschützt; Bearbeiten-Dialoge und Topic-Picker
    gesperrt.
  - **Bedienen** – wie Lesen, zusätzlich dürfen Bedienelemente betätigt werden:
    Schalter in Messen + Schalten, Schaltgruppen und Dashboard-Schalter sowie
    Wallbox-Lademodi/-Steuerung und Pool-Pumpenmodi (An/Aus/Automatik).
  - **Schreiben** – Vollzugriff ohne Einschränkung.

  Die Durchsetzung erfolgt serverseitig (schreibende Requests ohne ausreichende
  Rechte werden abgewiesen, gesperrte Seiten sind nicht aufrufbar) und wird
  seitenübergreifend in der Oberfläche gespiegelt (gesperrte Felder/Buttons,
  sichtbare Schalter nur bei „Bedienen").
- **Anmeldung mit Nutzerauswahl.** Der Anmeldebildschirm zeigt die vorhandenen
  Benutzer zur Auswahl per Klick (kein Tippen des Namens mehr). „Angemeldet
  bleiben" hält die Sitzung 30 Tage und meldet den gewählten Nutzer beim nächsten
  Aufruf automatisch an.
- **Zugriffs-Endpunkt für Adapter-Frontends (`GET /me/access`).** Adapter, deren
  Oberfläche im Browser läuft, können die Rechte des angemeldeten Nutzers
  (`read`/`operate`/`write`) abfragen und ihre Bedienelemente daran ausrichten.
  Adapter-Kindprozesse selbst bleiben von der Rechtelogik unberührt; die
  eigentliche Durchsetzung bleibt serverseitig. Siehe [ADAPTER.md](ADAPTER.md).
- **Dashboard-Tabs.** Über eine Tab-Leiste oberhalb des Widget-Bereichs lassen
  sich mehrere eigenständige Dashboard-Seiten verwalten (anlegen, umbenennen,
  löschen — nie den letzten Tab). Jede Gruppe und jedes freie Widget gehört zu
  genau einem Tab (Widgets in Gruppen erben den Tab der Gruppe); bestehende
  Konfigurationen werden beim Laden automatisch dem Standard-Tab „Übersicht"
  zugeordnet. Beim Löschen eines Tabs werden enthaltene Gruppen/Widgets auf
  einen wählbaren Ziel-Tab verschoben; im Bearbeitungsmodus lassen sich die
  Tabs über einen Drag-Griff umsortieren. Der gewählte Tab bleibt je Sitzung
  erhalten; passen nicht alle Tabs in eine Zeile, bricht die Leiste mehrzeilig
  um.
- **Bearbeitungsmodus fürs Dashboard.** Ein kompakter Stift-Icon-Button ersetzt
  die großen Kopf-Buttons und aktiviert einen Bearbeitungsmodus mit
  vollflächiger Drag-Fläche je Widget (Maus, Touch und Stift über Pointer
  Events, vertikales Scrollen bleibt möglich) und dauerhaft sichtbaren
  Bearbeiten-/Löschen-Buttons. Im Bearbeitungsmodus wird der Stift zum
  Übernehmen-Button (Haken), der alle Layout-Änderungen speichert und den
  Modus nur bei Erfolg beendet; daneben erscheint der Plus-Button
  (Gruppe/Widget hinzufügen) ausschließlich im Bearbeitungsmodus. Im
  Anzeigemodus gibt es keine sichtbaren oder platzreservierenden
  Bearbeitungselemente und keine Hover-Pflicht mehr.
- **Neuer Widget-Typ „Schalter".** Großflächige Ein/Aus-Kachel für Geräte mit
  Schalt-Topic und Schaltgruppen aus Messen + Schalten (nutzt deren bestehende
  Schaltmechanismen inklusive Prioritäts-Gating). Konfigurierbar sind
  Bezeichnung, Ziel sowie Hintergrundfarben für Ein (Standard: gelb schimmernd)
  und Aus; mit Pending-Zustand, Fehleranzeige, Schutz vor Mehrfachklicks und
  Live-Aktualisierung bei externen Zustandsänderungen.
- **Größenvarianten S/M/L für Wert-Widgets.** S = Titel und Wert in einer
  Zeile, M = kompakte Zwischenstufe, L = bisherige Darstellung (Standard für
  Bestandswidgets). Auch der Schalter unterstützt die Größenwahl.
- **Konfigurierbare Wertfarbe.** Wert-Widgets können den Zahlenwert in einer
  eigenen Farbe darstellen (validierter Hex-Wert, Standard = bisherige
  Textfarbe, Titel/Rahmen bleiben unverändert).
- **Mobile Mindestbreite als Widget-Typ-Eigenschaft.** Zentrale Widget-Typ-
  Definition (`src/dashboard/widget-types.js`); die Info-Kachel erzwingt damit
  volle mobile Gruppenbreite — erweiterbar für künftige breite Widget-Typen,
  ohne Sonderfälle je Widget-Name.

### Behoben

- **OTA war über die Oberfläche gar nicht möglich.** Der Uploadpfad verlangte
  hart eine Signatur, während die Releaseartefakte unsigniert erzeugt werden —
  jeder Versuch endete mit „Das Releaseartefakt besitzt keine authentifizierbare
  Signatur.“ Erzwungen wird eine Signatur jetzt genau dann, wenn ein
  Ed25519-Prüfschlüssel konfiguriert ist. Eine vorhandene, aber ungültige
  Signatur wird weiterhin immer abgelehnt.
- **Binary-Ausgänge während eines OTA.** Der Adapter schaltete weiter Ausgänge,
  während das Gerät in einer OTA-Transaktion steckt, und protokollierte dafür
  reihenweise `DEVICE_OFFLINE` und `DEVICE_BUSY`. Die Wunschzustände werden
  jetzt zurückgehalten und nach dem Update angewendet.
- **Fehlgeschlagenes Update navigierte auf die JSON-Antwort.** Der Updateknopf
  war ein Formular-POST; bei einer Ablehnung landete der Browser auf dem rohen
  Fehlerobjekt, und der Knopf blieb im Zurück-Verlauf dauerhaft deaktiviert. Er
  löst das Update jetzt per `fetch` aus, zeigt den Fehler an Ort und Stelle,
  übersetzt die geläufigen OTA-Codes und ist danach sofort wieder bedienbar.
- **Kein Update über eine Konfigurationsschemagrenze möglich.** Der Adapter
  verlangte ein exakt gleiches `config_schema_version`, während die Firmware
  selbst `canMigrateConfigSchema()` auswertet und eine Migration mitbringt.
  Damit war zum Beispiel kein Sprung von Schema 2 (Firmware 0.3.1) auf Schema 3
  (0.4.1) möglich — betroffen war jedes Gerät vor dem Schemawechsel. Der Adapter
  verlangt jetzt nur noch, dass das Ziel nicht hinter dem aktuellen Schema
  zurückfällt; die normative Entscheidung trifft weiterhin das Gerät beim
  Empfang der Metadaten.
- **Identische Version wurde als Update angeboten.** Die Kompatibilitätsprüfung
  lässt denselben Stand bewusst durch, damit eine erneute Installation möglich
  bleibt; als Updateangebot war das falsch. Ein Kandidat muss jetzt echt neuer
  sein, eine bewusste Neuinstallation bleibt über die Downgrade-Freigabe möglich.
- **Firmwarekarte der Binary-I/O-Seite war eine Kurzfassung.** Build, Zeitstempel,
  OTA-Fähigkeit, freier Speicher, Signaturstatus und Fortschritt fehlten dort.
  Beide Geräteseiten verwenden jetzt dieselbe Karte.
- **Zwischengespeichertes hDP-Manifest nach einem Firmwareupdate.** Das Manifest
  wird persistiert, aber nie erneuert: `activate()` zog den eigenen
  Zwischenspeicher einer frischen Abfrage vor, und ein Versionswechsel löste gar
  keine Aktualisierung aus. Nach einem OTA beschrieb die Verwaltung deshalb
  dauerhaft die Fähigkeiten der Vorgängerversion — neue GPIOs, Limits und
  Features blieben unsichtbar. Das Manifest stammt jetzt ausschließlich aus dem
  Pairingergebnis oder einer frischen Abfrage, und eine geänderte
  Firmwareversion in der mDNS-Ankündigung stößt einen Abgleich an.
- **Gerätetyp in der hDP-Geräteverwaltung ist wieder ein Entweder-oder.** Der
  Hardwaredialog zeigte LED-Ausgang, Schutzwerte und Binary-Pins gleichzeitig;
  die Felder des abgewählten Typs wurden mitgesendet, sodass die Prozentanzeige
  weiter einen GPIO belegte, obwohl das Gerät als Binary-I/O lief. Sichtbar ist
  jetzt ausschließlich der Abschnitt des gewählten Typs, die übrigen Felder
  werden deaktiviert und gar nicht erst übertragen. Der Dialog enthält auf
  beiden Geräteseiten beide Abschnitte, sodass der Wechsel in jede Richtung
  funktioniert. Geräte ohne `boot-dispatch-v1` bieten Binary-I/O nicht mehr an
  und weisen einen entsprechenden Konfigurationsversuch mit 422 ab.
- **Geräteseite folgt dem konfigurierten Gerätetyp statt dem Runtime-Profil.**
  Das Profil wechselt erst mit dem Geräteneustart; bis dahin zeigte die
  Verwaltung die Prozentanzeigenoberfläche für ein bereits als Binary-I/O
  konfiguriertes Gerät und der Ausgabepfad versuchte weiter, Frames zu rendern.
  Statuspublikationen, Topic-Abonnements, Bindungsformulare und die Seitenwahl
  richten sich nun einheitlich nach `hardwareConfig.device_type`.
- **Dauerhaftes `OUTPUT_BUSY` nach einem hDP-Sitzungsneuaufbau.** `sessionStarted()`
  verwarf die Kenntnis laufender Timelines, während das Gerät seine geloopte
  Wiedergabe unverändert fortsetzte; jedes `output.timeline.begin` wurde danach
  abgelehnt und der Ausgang blieb bis zum nächsten reinen Frame blockiert. Der
  Outputclient gleicht den tatsächlichen Ausgangszustand jetzt einmal je Sitzung
  per `output.status.get` ab, übernimmt eine bereits laufende Wunschtimeline
  ohne sichtbaren Neustart, stoppt andernfalls die fremde Timeline und räumt
  einen dennoch auftretenden `OUTPUT_BUSY` beim Begin einmalig selbst frei.
- **Leeres Dashboard beim Startaufruf.** Der direkte Aufruf über `/` zeigte
  angemeldeten Nutzern zuvor nur Titel und Kopf-Buttons. `/` leitet angemeldete
  Nutzer jetzt auf die passende Landeseite weiter; `/dashboard` rendert die
  vollständig initialisierte Dashboard-Ansicht.
- **Robuster Dashboard-Start über Remote/App.** `/` rendert für angemeldete
  Nutzer nicht mehr direkt die große Dashboard-HTML-Antwort, sondern leitet klein
  auf `/dashboard` weiter. Dadurch kommt der erste Response schneller und
  mobile Relay-Clients brechen die Übertragung nicht vor Bottom-Leiste und
  Inhalt ab.
- **Dashboard-Bearbeitung bei kleinen Widgets.** Die Bearbeiten-/Löschen-Buttons
  skalieren im Bearbeitungsmodus mit der Widget-Größe mit. Lange Schalter-
  Bezeichnungen werden wie Wert-Widget-Labels gekürzt und sprengen kleine
  Kacheln nicht mehr.

## [1.3.0] — 2026-07-16

### Hinzugefügt

- **Fernzugriff über Relay-Tunnel.** homeESS kann sich per QR-Code dauerhaft mit
  der Android-App koppeln und danach HTTP-artige Tunnel-Requests der App über den
  Relay gegen den lokalen homeESS-Server beantworten. Damit ist Zugriff über das
  Internet ohne eigenes VPN, Portfreigabe oder DynDNS möglich; ein Nutzeraccount
  ist nicht erforderlich. Für die Internet-Nutzung ist die homeESS Remote Lizenz
  in der App aus dem Google Play Store erforderlich.
- **Dauerhafte Ed25519-Instanzidentität.** homeESS erzeugt einen lokalen
  Identity Store (`HOME_ESS_IDENTITY_DIR`, 0700/0600), signiert Confirm- und
  WebSocket-Challenge-Nutzlasten mit Node `crypto`, provisioniert nach Confirm
  automatisch zu `paired` und prüft Instanz-/Gerätefingerprints streng.
- **Gekoppelte Geräte und Link-Verwaltung.** `/remote-access` zeigt gekoppelte
  Geräte, Relay-Verbindung und aktive Geräte an, verarbeitet autoritative
  `linked_devices`-Snapshots sowie `connection_status` und kann Verknüpfungen
  bidirektional entfernen, ohne lokale Identität oder Schlüssel zu löschen.
- **Gehärteter serverseitiger Relay-Client.** Pairing, Confirm, Provisioning,
  Origin-WebSocket und Tunnel laufen ausschließlich serverseitig
  (`Browser → homeESS → essrelay`); Tokens, QR-URI, private Schlüssel,
  Signaturen, Headerwerte, Cookies und Bodies werden weder an den Browser
  ausgegeben noch geloggt.
- **Neues Seiten-Icon.** Das angehängte homeESS-Logo ist als skalierbares
  Browser-/App-Icon eingebunden.
- **Neue Konfiguration.** `ESS_RELAY_BASE_URL`, `ESS_RELAY_WS_URL`,
  `HOME_ESS_INSTANCE_NAME`, `HOME_ESS_IDENTITY_DIR` und
  `ESS_RELAY_CONNECTION_DISABLED` steuern Relay, WebSocket und Identity Store.
- **Mobiles Menü für die App-Hülle.** `window.homeESSApp` stellt `openMenu()`,
  `closeMenu()`, `toggleMenu()` und `isMenuOpen()` bereit; das mobile Menü-Sheet
  gleitet passend zur App-Geste ein.
- **Installationsscript kann bestehende Git-Installationen aktualisieren.** Ein
  erneuter Aufruf per `curl | sudo bash` stoppt den Dienst, aktualisiert den
  Checkout aus `main`, installiert Produktionsabhängigkeiten neu und startet
  homeESS wieder. Datenbank und Identity Store unter `/var/lib/home-ess` bleiben
  erhalten.

### Geändert

- **Version auf 1.3.0 angehoben.** Die internen Zwischenstände nach 1.2.6 werden
  als ein öffentlicher Release zusammengefasst.
- **Fernzugriff-Dokumentation konsolidiert.** README, Architektur, Security,
  Threat Model und Agentenhinweise beschreiben jetzt den fertigen homeESS-Stand
  aus Pairing, Provisioning, Geräteverwaltung, Origin-WebSocket und Relay-Tunnel
  sowie die Abgrenzung von App/Relay als eigenständigem proprietären Add-on.

### Sicherheit

- **Tunnel-Requests werden lokal begrenzt und validiert.** homeESS akzeptiert
  nur definierte Tunnel-Nachrichten, verwirft externe Ziele sowie Hop-by-Hop- und
  WebSocket-Header, begrenzt Body-/Chunk-Größen, schützt Sequenzen, Timeouts und
  Backpressure und räumt offene Requests bei Disconnects oder entfernten Links
  zuverlässig auf.
- **Gerätestatus ist an autoritative Links gebunden.** `connection_status` kann
  nur bereits bekannte, vom Relay bestätigte Geräte als aktiv markieren; entfernte
  oder unbekannte Geräte werden nicht wieder lokal angelegt.

## [1.2.6] — 2026-07-13

### Behoben

- **Prognose: Pool-Solarpumpe blähte den erwarteten Verbrauch nicht mehr auf.**
  Die Verbrauchsprognose nahm bisher an, die Pool-Solarpumpe liefe **jede Stunde
  mit PV-Ertrag** (~16 h/Tag) und rechnete mit der **gelernten** Pumpenleistung,
  die durch das Toggle-Delta-Sampling oft deutlich überzeichnet war. Dadurch
  erschienen pro Tag rund 22 kWh reine Pool-Solarlast — mehr als der reale
  Pool-Jahresverbrauch — und die Tagesprognose verdoppelte sich (z. B. „morgen
  50 statt 28 kWh"). Jetzt ergibt sich die Solarpumpen-Laufzeit aus dem
  **geometrischen Clear-Sky-Modell** (Sonnenhöhe über 5°, wolkenunabhängig) und
  die Leistung aus einer neu **konfigurierbaren Nennleistung** je Pumpe (Solar/
  Filter). Ist keine Nennleistung gesetzt, bleibt der gelernte Wert die Grundlage.
  Filterpumpe unverändert nach Zeitfenstern.

- **Wallbox: Automatik-Schaltungen am Steuerung-Sync-Topic bleiben Automatik.**
  Das Steuerung-Sync-Topic signalisiert weiterhin, ob eine Ladung aktiv ist, wird
  aber nur noch dann als Bedienaufforderung gewertet, wenn der Wertwechsel dem
  aktuellen Automatikplan widerspricht. Schaltet homeESS selbst per Automatik ein
  und der Sync-Wert springt auf **Ein**, wird daraus kein **Vollladen** mehr; schaltet
  die Automatik aus und der Sync-Wert springt auf **Aus**, entsteht keine manuelle
  Aus-Sperre. Das gilt ausdrücklich auch für erlaubte Überschussladungen im
  Beruflich-Modus oberhalb des Mindest-Ladestands. Außerdem ignoriert homeESS für
  eine kurze Schutzfrist Statusfolgen eigener Schaltbefehle: meldet dasselbe Topic
  nach einer automatischen Freigabe wieder **Aus** (z. B. weil kein Fahrzeug
  angesteckt ist und daher keine aktive Ladung entsteht), wird das nicht als
  manuelles Ausschalten gewertet. Nur echte Nutzeränderungen am entfernten Topic
  können weiterhin auf **Aus** oder **Vollladen** umschalten.
  Wichtig für die Konfiguration: Das Wallbox-Steuerung-Sync-Topic darf nicht
  parallel als Schalt- oder Remote-Topic unter **Messen + Schalten** verwendet
  werden. Wird dieselbe physische Wallbox dort zusätzlich zur Leistungserfassung
  angelegt, gehören nur Mess-/Zähler-Topics dorthin; sonst kann die zweite
  Gerätesteuerung wieder Aus-Befehle auf dasselbe Topic schreiben.
- **Wallbox: Live-Überschuss hat Vorrang vor dem Ladeplan.** Oberhalb des
  Mindest-Ladestands darf die Wallbox per Überschussladung laufen. Dieser reale
  Live-Überschuss schaltet jetzt nicht mehr gegen den vorausschauenden Ladeplan
  aus: Wenn die aktuell verfügbare Überschussleistung die Wallbox trägt und die
  Hausakku-Reserve passt, bleibt die Ladung aktiv — auch wenn die Prognose bzw.
  der Tages-Ladeplan gerade keinen flexiblen Überschuss ausweist. Das gilt auch im
  Beruflich-Modus oberhalb des Mindest-Ladestands.
- **Photovoltaik: Ertrags-Topics werden als Rohzähler ausgewertet, nicht als
  Tagesertrag.** Bisher wurde der Wert des Ertrags-Topics direkt als „Ertrag heute"
  übernommen (Annahme: ein täglich zurücksetzender Tageszähler). Bei einem
  **kumulativen Zählerstand** landete dadurch der gesamte Zählerstand als heutiger
  Ertrag — besonders auffällig beim Neu-Auswählen des Topics. Das Ertrags-Topic wird
  jetzt **wie alle anderen Zählertopics** behandelt: der Rohwert wird als kumulativer
  Zähler gelesen, und nur seine **Zuwächse** werden intern (in kWh) fortgeschrieben;
  „Ertrag heute" ist der Fortschritt seit Tagesbeginn. Rückwärtssprünge
  (Geräte-Reset) und ein **Topic-/Einheitenwechsel** basieren nur neu, ohne den
  Rohwert als Sprung in den Ertrag zu übernehmen. Ein einmalig beim Update fälschlich
  als Ertrag erfasster Zählerstand wird beim Migrieren entfernt (Woche/Jahr-Summen
  bleiben unberührt).

### Hinzugefügt

- **Photovoltaik: Einheit des Ertrags-Zählers je Anlage (Wh/kWh).** Im
  Anlagen-Dialog lässt sich einstellen, ob das Ertrags-Topic in **Wh** oder **kWh**
  liefert; intern wird immer in kWh gezählt (ein Wh-Topic wird durch 1000 geteilt).
  Vorgabe ist kWh.

## [1.2.5] — 2026-07-13

### Behoben

- **Grid-Control: keine Wechselrichterlast-Warnung mehr, wenn das Netz bereits
  zugeschaltet ist.** War das Netz schon aus einem anderen Grund geschaltet
  (SoC, Spannung, Temperatur, Notstrom), meldete die Steuerung trotzdem
  „Wechselrichterlast zu hoch". Bei zugeschaltetem Netz gibt es aber **keine
  Wechselrichter-Obergrenze mehr** — Last oberhalb der Schwelle kompensiert das
  öffentliche Netz automatisch, also ist sie **keine Warnung**. Die kritische
  Meldung erscheint jetzt nur noch, wenn die **Last der alleinige Schaltgrund**
  ist. Die **Grid-by-Load-Verriegelung** rastet dennoch ein und hält das Netz
  zugeschaltet — auch wenn der ursprüngliche Grund wegfällt —, bis **alle**
  Grid-by-Gründe aus sind, d. h. bis die überlastete Phase wieder unter ihre
  **untere Schaltschwelle** fällt.
- **Schaltgruppen (Handy): Gerätenamen werden nicht mehr abgekürzt.** Die
  Schaltgruppen-Zeilen nutzen dieselbe Statuspunkt-Klasse (`.ms-status-dot`) wie
  Messen + Schalten. Deren mobile Raster-Regel `grid-area: dot` war **unscoped**
  und zerstörte das Zeilenraster der Schaltgruppen — der Name wurde auf die
  12px-Statusspalte gequetscht (nur noch ein Buchstabe + „…"). Die Regel ist jetzt
  auf `.ms-row` eingegrenzt; die Namen erhalten wieder die volle Breite.
- **Schaltgruppen (Handy): Seite skaliert nicht mehr über die Bildschirmbreite.**
  Der Gruppenkopf (Titel, Zähler, bis zu drei Badges, Schalter, zwei
  Aktionsknöpfe) brach auf schmalen Geräten nicht um und zog die Seite breiter als
  den Viewport (horizontaler Überlauf, der die untere Tab-Bar aus dem Bild schob).
  Der Kopf bricht jetzt um (`flex-wrap`), wie bereits beim Messen-+-Schalten-Kopf.

### Geändert

- **Zoomfaktor auf 100 % festgenagelt.** Das Viewport-Meta erlaubt jetzt weder
  Rein- noch Rauszoomen (`minimum-scale=1, maximum-scale=1, user-scalable=no`), so
  dass alle Seiten auf allen Geräten in der vorgesehenen 1:1-Darstellung bleiben.

## [1.2.4] — 2026-07-13

### Behoben

- **Prognose: Selbstzählung fällt nicht mehr mit den Netzzählern aus.** Die
  verbraucherseitige **Selbstzählung** lief im Erfassungs-Job hinter dem Early-Return,
  der einen echten **Netzzähler**-Wert verlangt. Fehlten die Netzzähler (Verbindungs­abbruch/
  Inselbetrieb), wurde die grid-**unabhängige** Selbstzählung fälschlich mit übersprungen –
  Bilanz **und** Selbstzählung brachen dann gemeinsam ein und der Guard konnte nichts
  ersetzen (Symptom: einzelne Stunden mit nahezu 0 kWh trotz laufender Verbraucher). Die
  Selbstzählung wird jetzt **unabhängig** von den Netzzählern integriert; nur die zähler-/
  bilanzbasierte Erfassung braucht weiterhin einen echten Zählerwert.
- **Wallbox: An/Aus-Kanäle sauber getrennt — keine Rückkopplung mehr durch die
  Automatik (Regeln 1–3).** Bisher diente das eine **Steuer-Topic** zugleich als
  Aktor und als Rückmelde-/Bedienkanal. Dadurch konnte homeESS die eigenen
  Schalt-Readbacks (bzw. den Gerätezustand nach einem Reconnect) als Nutzerschaltung
  fehldeuten: Schaltete die Automatik ein, sprang die Steuerung fälschlich auf
  **Vollladen** und verließ den Automatikmodus (Regel 1 verletzt); ein
  Adapter-Reconnect sprang auf **Aus**. Jetzt ist das **Steuer-Topic ein reiner
  Aktor** (homeESS schaltet die Wallbox, kein Readback) und ein neues, optionales
  **Steuerung-Sync-Topic** übernimmt den bidirektionalen An/Aus-Schalter: homeESS
  spiegelt darauf den Zustand und wertet **nur eine extern ausgelöste Änderung**
  (nicht selbst geschrieben) als Bedienbefehl — EIN → Vollladen bis 100 %/
  Leistungsabfall bzw. Stecker gezogen, dann zurück auf Automatik; AUS während der
  Ladung → aus bis zum nächsten Ladebeginn am Folgetag. Schaltet die Automatik,
  bleibt es auf Automatik. Der gewählte Stand liegt neustart-resistent in der DB;
  ein **Re-Baseline-Fenster (45 s)** nach jedem MQTT-(Wieder-)Verbindungsaufbau
  stellt sicher, dass Neustart, Adapter-Reconnect oder Topic-Refresh **nie** als
  externe Schaltung gelten (nur ein direkt beobachteter, nicht selbst ausgelöster
  Wechsel zählt).
- **Wallbox: Modus-Sync-Topic ist ausschließlich der Ladeplan.** Das Modus-Sync-Topic
  hält nur den Lademodus bidirektional synchron: **1 = Privat, 2 = Beruflich,
  3 = Immer voll** (im Formular erläutert). Es schaltet die Ladung nicht ein/aus.
- **Prognose: Balken des Heizung/Klima-Diagramms sitzen auf einer Nulllinie.** Die
  Achsen-Beschriftungen lagen im Balkenfluss und verschoben beschriftete Balken
  nach oben; sie sind jetzt unter der Nulllinie verankert.
- **Messen + Schalten: Zählerstand wird nicht mehr fälschlich als „veraltet"
  markiert.** Der angezeigte Zählerstand ist ein interner, aus dem Zählerfortschritt
  gebildeter Wert – er ist immer bekannt und kann nicht veralten. Die Frische-Prüfung
  des Zähler-Topics löste bisher ein irreführendes „⚠ veraltet" aus, obwohl das Gerät
  verbunden war (nur das Zähler-Topic hatte länger nichts gesendet).
- **Messen + Schalten: Aktionen (Bearbeiten/Entfernen) sind auf Touch erreichbar.**
  Die ✎/🗑-Schaltflächen an Geräten und Gruppen waren per Hover ausgeblendet und
  damit am Handy unbenutzbar; auf Touch-Geräten (`hover: none`) sind sie jetzt
  dauerhaft sichtbar. Zudem am Handy behoben: seitlich überlaufende „Sonstige
  Verbraucher"-Zeile und umbrechende Toolbar.

### Geändert

- **Prognose: Heizung/Klima lernt mittlere Leistung je 1-°C-Temperaturfenster.**
  Die Auflösung der Außentemperaturfenster wurde von **5 °C auf 1 °C** verfeinert.
  Gelernt und geplant wird jetzt die **mittlere Leistung (W)** je Fenster statt der
  Energie: je Fenster bis zu **30 Messtage** (pro Tag die zeitgewichtete mittlere
  Leistung), der Modellwert ist deren **Mittel** — bewusst begrenzt statt eines
  dauerhaften Mittelwerts, damit die Anpassung nicht mit der Zeit abflacht. Ein
  Fenster wird nur an Tagen belegt, an denen diese Außentemperatur real auftrat, so
  überschreibt die Sommer- die Winterkurve nicht (neue Tabelle
  `mess_schalt_temperature_power`; ersetzt das frühere EWMA-Bucket-Lernen aus dem
  Stunden-Energielog). Die Prognose errechnet daraus je Stunde nach der
  prognostizierten Außentemperatur den erwarteten Verbrauch
  (`kWh = W/1000 × Stunden`). Das Diagramm zeigt je Fenster das **30-Tage-Mittel
  (W)** als Balken und den **heutigen Wert** als Markierungslinie.
- **Prognose: Heizung/Klima-Modell zusätzlich nach Tagesstunde.** Jedes
  Temperaturfenster hält nun für **jede der 24 Tagesstunden** eine eigene mittlere
  Leistung vor (Tabelle `mess_schalt_temperature_power` um die Spalte `hour`
  erweitert, PK `bucket, day_key, hour`), weil der Heiz-/Kühlbedarf je Tageszeit
  variiert (Kühlen v. a. abends, Heizen morgens zum Aufheizen stärker als abends).
  Die Prognose plant den Heizungs-/Klimabedarf je Stunde nach der **stundengenauen**
  Fensterleistung (noch ungelernte Stunden fallen auf das Fenstermittel zurück).
  Das Temperatur-Balkendiagramm zeigt weiterhin das **Mittel über alle 24 Stunden**;
  ein **Klick auf einen Balken** öffnet einen Dialog mit der **24-Stunden-Kurve**
  dieses Fensters (mittlere Leistung je Stunde plus heutige Markierung). Alt-DBs
  werden migriert, indem das bisherige Tagesmittel gleichmäßig auf alle 24 Stunden
  verteilt wird — die Balkenhöhe bleibt gleich, die Stundenkurve schärft sich beim
  Weiterlernen.

### Hinzugefügt

- **Prognose: Fehlererkennung der Verbrauchserfassung.** Kann eine Stunde nicht sauber
  erfasst werden (Verbindungsabbruch, fehlende Daten, Prozess-Downtime), wird sie erkannt
  und als **unvollständig** markiert: der Lernwert wird auf den **Vortageswert** gesetzt
  (keine falsche Kurve mehr) und die Stunde in der „Datenbasis"-Ansicht **ausgegraut**
  (die erfassten Rohwerte primary/self bleiben zur Nachschau stehen). Störungen werden
  zusätzlich in eine **Logdatei** (`data/prognosis-sampling.log`) geschrieben. Neue Spalte
  `prognosis_hourly_consumption.incomplete` und Tabelle `prognosis_sampling_state`.
- **Prognose: gestapelter Heiz-/Kühlbedarf im Stundenprofil.** Im 24-h-Stundenprofil
  der Tagesprognosen sitzt der erwartete Heizungs-/Klimabedarf je Stunde als
  **gestapelter Balken über der Grundlast** und zeigt, zu welcher Stunde mit welchem
  Zusatzbedarf zu rechnen ist. Die Grundlastberechnung selbst bleibt davon unberührt
  (reine, additive Anzeige).
- **Energiefluss-Diagramm vertikal auf schmalen Viewports (Handy).** Statt des breiten
  horizontalen Flusses (der am Handy nur seitlich scrollbar war) zeichnet die Seite bei
  ≤ 760 px einen **schmalen Stamm mit eingerückten Zweigen**, einheitlich von oben nach
  unten: Einzel-PV-Anlagen → PV gesamt → Netz → **Batterie** stehen (eingerückt) **über**
  dem Eigenverbrauch, darunter die Verbrauchergruppen (per Einrückung verschachtelt, mit
  jeder Verzweigung dünner). Jede Kante läuft in einem **eigenen senkrechten Kanal** im
  Einrück-Spalt links der Knoten (nächstes Kind außen, ferne innen), sodass die Linien
  **nebeneinander** liegen, **nie durch einen Knoten** queren und sich am Eigenverbrauch zu
  einem dickeren Bündel sammeln und nach unten ausdünnen. Die Einrückung je Ebene ist
  **dynamisch**: je mehr Kinder (z. B. Gruppen unter dem Eigenverbrauch), desto breiter der
  Kanal-Spalt und desto tiefer die Einrückung – die wenigen Quellen oben bleiben schmal.
  Die Batterie ist wie eine Quelle angebunden (genau wie die Anlagen an PV gesamt), nicht
  als Seitenlinie. Ein Knoten je Zeile → immer handy-schmal, kein horizontales Scrollen.
  Der Farb-Stift je Gruppe ist auf Touch dauerhaft sichtbar. Desktop behält das horizontale
  Layout; bei Breitenwechsel wird automatisch umgezeichnet.
- **Schaltgruppen ohne Drag & Drop bedienbar (Touch/Handy).** Jede Gruppe hat einen
  **„+ Gerät hinzufügen"**-Button, der einen Auswahldialog der freien Geräte öffnet;
  ein **„×"** je Gerätezeile löst es wieder aus der Gruppe. Beides klickbasiert und
  damit auf dem Handy nutzbar (Drag & Drop bleibt auf dem Desktop). Am Handy zeigt die
  Seite nur noch die Gruppenspalte; die freien Geräte sind über den Dialog erreichbar.
- **Messen + Schalten: dediziertes „nicht verbunden"-Signal am Gerät.** Schweigt die
  **periodische Telemetrie** eines Geräts (Leistung/Zähler) länger als 30 min, wird es
  sichtbar als **offline** markiert (roter Statuspunkt-Ring + „offline"-Kennzeichnung
  am Namen). Bewusst nur aus Telemetrie – Schalt-/Status-Topics sind ereignisgetrieben
  (ein lange ausgeschaltetes Gerät ist nicht offline).
- **Messen + Schalten: Warnung bei unplausiblem Zähler (Wh/kWh-Gegenprobe).** Für
  Geräte mit Leistungs- UND Zähler-Topic wird zusätzlich die aus der Live-Leistung
  integrierte Tagesenergie geführt. Weicht der Zähler heute stark davon ab
  (Faktor ≥ 3 ab 0,05 kWh) — typisch bei vertauschter Einheit **Wh statt kWh**
  (1000×-Fehler, der die Gruppen-Verbrauchssummen still auf ~0 zieht) —, zeigt die
  Zählerzelle ein rotes **⚠** mit erklärendem Hinweis. Die Zählung selbst bleibt
  unverändert (nur Hinweis); neue Spalten in `mess_schalt_actor_state`
  (`power_energy_kwh`, `power_energy_day_start_kwh`, `last_power_ts`).

## [1.2.2] — 2026-07-10

### Behoben

- **Poolsteuerung: Solar-/Filterpumpe schaltet zuverlässig.** Die Automatik
  vertraute bisher nur ihrem internen Soll-Glauben (`solar.output`/`filter.output`)
  und unterdrückte per `if (output !== target)` jeden erneuten Befehl. Wich der
  echte Pumpenzustand davon ab (verlorener Schaltbefehl, extern/an der CCU
  geschaltet, CCU-Neustart), blieb die Pumpe dauerhaft im falschen Zustand.
  Beide Pumpen gleichen ihre Entscheidung jetzt gegen das tatsächliche
  **Status-Topic** ab und senden bei Abweichung nach (gedrosselt über die
  2-Min-Haltesperre; ein Moduswechsel An/Aus hebt die Drossel sofort auf).
- **Poolsteuerung: veralteter Lastabwurf sperrt die Pumpe nicht mehr aus.** Der
  Grid-Control-Lastabwurf wird für die Schaltentscheidung nur noch berücksichtigt,
  solange er wirklich aktiv ist (`loadShedActive`). Ein alter Cutoff aus einer
  beendeten Grid-Control-Phase kann die Pumpe nicht länger blockieren —
  konsistent zu Messen+Schalten und Wallbox. Hand-„An"/„Aus" übersteuert das
  Betriebslevel wie vorgesehen.
- **Prognose: Bedarfsdiagramm Heizung/Klima erscheint korrekt.** Der Platzhalter
  behauptete fälschlich, es brauche gemessenen *Verbrauch*. Eine gemessene
  **0,0 kWh** ist eine gültige Beobachtung eines Temperaturfensters; das Diagramm
  erscheint jetzt, sobald Messwerte einfließen oder eine Außentemperatur vorliegt.

### Geändert

- **Prognose: Temperaturfenster ziehen träge nach.** Die gelernten
  Außentemperatur-Buckets für Heizung/Klima werden je Fenster/Stunde als
  **gleitender Mittelwert (EWMA)** über die Messreihe nachgezogen statt bei jeder
  Messung hart überschrieben (analog dem recency-gewichteten Wochentag-Grundverbrauch;
  bewusst über die Messreihe statt den Kalender, damit ein nur im Winter belegtes
  Fenster über den Sommer nicht „vergisst").

## [1.2.1] — 2026-07-10

### Neu

- **Virtuelle Zählung aus Nennleistung (Messen + Schalten).** Geräte ohne
  eigenes Leistungs- oder Zähler-Topic erhalten optional eine **Nennleistung**
  (Feld nahe den Zähler-Topics, W/kW). Fehlt ein Leistungs- und ein Zähler-Topic,
  werden Leistung und Energie daraus virtuell berechnet: Leistung = Nennleistung
  bei „an", sonst 0; die Energie wird über die Einschaltdauer in denselben
  internen Zähler (mit Tages-/Jahres-Baseline) integriert wie echte Zähler. Ohne
  Nennleistung gibt es weiterhin keine Messung. Neue Spalten
  `mess_schalt_actors.rated_power` / `rated_power_unit`.
- **Energiefluss: „Sonstige" mit Tages-/Jahreszähler.** Der „Sonstige
  Verbraucher"-Ast (global wie hinter jeder Zählergruppe) weist jetzt ebenfalls
  **Verbrauch heute und dieses Jahr** aus (baum-konsistent zur Leistung). Der
  Knotentitel ist auf **„Sonstige"** gekürzt.
- **Energiefluss-Exporte.** Unter dem Diagramm lassen sich benannte,
  **öffentlich abrufbare Live-Ansichten** anlegen, bearbeiten und löschen
  (Tabelle `energiefluss_exports`). Jeder Export hat einen Namen, ein **Theme**
  (hell wie auf der Seite oder dunkel mit schwarzem Hintergrund) und eine aus dem
  Namen abgeleitete **Export-URL** (`/energiefluss/export/<slug>`). Diese Ansicht
  zeigt nur das Diagramm ohne Titel/Erklärungen und **skaliert den kompletten
  Baum auf die Viewport-Größe**; wird es zu klein, fallen zuerst die Zählersummen
  weg, bevor die Schrift weiter schrumpft. Legende unten links, Wasserzeichen
  unten rechts. Die Zeichen-Logik liegt gemeinsam in
  `public/energiefluss-diagram.js` (Seite und Export nutzen sie).
- **Prognose: Balkendiagramm „Heizung / Klima nach Außentemperatur".** Unter der
  Datenbasis stellt ein Diagramm den gemessenen Energiebedarf der Funktionsgruppe
  Heizung / Klima über feste **5-°C-Temperaturfenster** dar (unterer Sammelbereich
  **< -20 °C**, oberer **> 50 °C**, dazwischen 5-°C-Bereiche). Genau diese Fenster
  werden in der Prognose ermittelt und **je Stunde** nach der prognostizierten
  Außentemperatur eingeplant (nicht im Tagesdurchschnitt).

### Geändert

- **Schaltgruppen „als Einheit": Cooldown gegen Blip-Rückkopplung.** Manche
  Zigbee-Aktoren melden nach dem Einschalten kurz „aus" und wieder „an". Bislang
  wertete die Gruppe das als Schaltflanke und schaltete endlos hin und her. Nach
  jeder Gruppenschaltung gilt nun ein **15-Sekunden-Fenster**, in dem selbst
  gemeldete Flanken nicht weitergereicht werden; am Fensterende wird abgeglichen,
  wobei ein **abweichender Schaltzustand** (der zuletzt betätigte Schalter) gegen
  die Mehrheit gewinnt.

### Behoben

- **Wallbox: Steuerung springt nach autonomer Freigabe wieder auf Automatik.**
  Gab die Automatik ein manuelles „Aus" selbst frei (oder schloss eine Volladung
  ab), wurde das nur im Speicher vermerkt, nicht persistiert – ein Neustart holte
  die veraltete Übersteuerung aus der DB zurück, sodass die Steuerung auf „Aus"
  hängen blieb, obwohl bereits geladen wurde. Autonome Steuerungs-Wechsel werden
  jetzt sofort persistiert.
- **Messen + Schalten: virtueller Zähler wurde ausgeblendet.** Beim Umstellen
  eines Geräts auf die Nennleistungs-Zählung verschwand der Energiezähler ganz
  (nicht einmal „0 kWh"). Der fortlaufende interne Zählerstand bleibt beim
  Umstellen erhalten und wird nun auch ohne Zähler-Topic angezeigt.

## [1.2.0] — 2026-07-09

### Neu

- **Messen + Schalten: mehrschichtige Verbrauchsgruppen.** Gruppen haben jetzt
  eine Drag-Fläche am Kopf und lassen sich – wie Verzeichnisse – beliebig tief
  ineinander schieben (`mess_schalt_groups.parent_id`, Zyklen werden
  abgewiesen). Untergruppen stehen eingerückt im Body und klappen mit der
  Elterngruppe zu. Prioritäten werden **nicht** vererbt; Geräte mit „Priorität
  der Gruppe verwenden" beziehen sie weiter von ihrer direkten Gruppe. Der Titel
  einer Gruppe mit Untergruppen zeigt verkürzt **„Ebene/Gesamt W"** (eigene
  Ebene / Gesamtleistung inkl. Untergruppen); der globale „Sonstige
  Verbraucher"-Offset zählt Untergruppen nicht doppelt.
- **Zählergruppe (Sperrschicht).** Neue Gruppenoption: Sind die eigenen Geräte
  einer Gruppe Zähler des ganzen Zweigs (`meter_group`), ist der
  Gesamtverbrauch **fix** aus diesen Zählern; die Ebene entfällt und stattdessen
  weist eine Fußzeile die **„Sonstige Verbraucher dieser Gruppe"**
  (Zählerleistung − verrechnete Untergruppen) aus. Ist der Haken „mit
  Gesamtverbrauch verrechnen" gesetzt, wirkt die Zählergruppe als
  **Sperrschicht**: Sie trägt den vollen Zweigwert zum Hausverbrauch bei, die
  Untergruppen nicht mehr zusätzlich. Der Haken einer Untergruppe steuert dann,
  ob ihr Verbrauch aus der „Sonstige"-Summe der Zählergruppe herausgerechnet
  wird.
- **Unterseite „Energiefluss"** (`/messen-schalten/energiefluss`): ein
  vollständig animiertes SVG-Flussdiagramm. Eingangsseitig bündeln sich die
  PV-Anlagen zu einem Gesamtzweig, dazu Netzbezug (bei Einspeisung negativ) und
  die Batterie als neutrale Stabstelle; zentraler Knoten ist der Eigenverbrauch;
  ausgangsseitig verzweigt der Fluss auf die (verschachtelten) Gruppen und den
  „Sonstige Verbraucher"-Rest (global sowie hinter jeder Zählergruppe), sodass
  das Bild in sich geschlossen ist. Strichbreite und Fließgeschwindigkeit folgen
  der Leistung, die Richtung dem Vorzeichen (Bezug/Einspeisung, Laden/Entladen).
  Farben aus den Systemfarben (PV, Netz, Batterie, Eigenverbrauch), je Gruppe
  eine **frei wählbare Farbe** (Stift-Button → Mini-Colorpicker,
  `mess_schalt_groups.color`); Pfade zu den Gruppen in Gruppenfarbe. Durch
  Priorität oder Lastabwurf gerade abgeschaltete Gruppen werden ausgegraut. Jeder
  Gruppen-Knoten sowie PV/Netz/Eigenverbrauch weisen **Verbrauch heute und
  dieses Jahr** aus.
- **Verbrauchssummen je Gruppe: Tag/Jahr/Vorjahr im Wertekatalog.** Aus dem
  internen Gerätezähler wird pro Gruppe sauber der Verbrauch des laufenden Tages
  und Jahres sowie der abgeschlossene Vorjahresverbrauch gebildet
  (`verbrauchssumme.<id>.verbrauchHeute` / `.verbrauchJahr` / `.verbrauchVorjahr`;
  neue Baseline-Spalten in `mess_schalt_actor_state`). Die Aggregation ist
  baum-konsistent: eine Zählergruppe zählt nur ihre eigenen Zähler, sonst
  additiv eigene Geräte + Untergruppen.

### Behoben

- **Wallbox: der Steuerungs-Schalter ist jetzt neustart-resistent.** Die
  manuelle Übersteuerung (Automatik / dauerhaft Aus / einmalig Vollladen) lag
  bisher nur im Arbeitsspeicher und stand nach einem Neustart wieder auf
  „Automatik". Sie wird jetzt persistiert (`wallboxes.control_mode`) und beim
  ersten Tick nach dem Start in den Laufzeitzustand übernommen.

### Migration

- Bestehende Datenbanken erhalten die neuen Spalten automatisch:
  `mess_schalt_groups.parent_id` (NULL = oberste Ebene), `.meter_group`
  (Default 0), `.color` (leer = Standardfarbe); `wallboxes.control_mode`
  (Default `auto`); Tages-/Jahres-Baselines in `mess_schalt_actor_state`. Ohne
  Anpassung bleibt das Verhalten wie in v1.1.3 (flache Gruppen, keine
  Zählergruppen). Der Vorjahres-Gruppenverbrauch entsteht erst mit dem ersten
  Jahreswechsel nach dem Update.

## [1.1.3] — 2026-07-08

### Behoben

- **HM-RPC: Adapter erholt sich jetzt von selbst von einem CCU-Neustart.** Nach
  einem Neustart der Zentrale verliert die CCU die Event-Registrierung des
  Adapters. Der bisherige Verbindungswächter prüfte aber nur die RPC-
  Erreichbarkeit (`system.listMethods`) — die gelingt an einer frisch
  gestarteten CCU sofort wieder, sodass der Adapter dauerhaft „verbunden"
  anzeigte, ohne je wieder ein Event zu erhalten; in Messen & Schalten
  veralteten alle Werte (⚠). Der Wächter erkennt jetzt Callback-Stille: Kommt
  innerhalb eines Reconnect-Intervalls kein einziger CCU-Callback an, erneuert
  er die Registrierung per idempotentem `init` — die listDevices-Antwort der
  CCU bestätigt die Event-Strecke dabei Ende-zu-Ende. Zusätzlich werden
  Transportfehler der Hintergrund-/Frische-Reads (`getParamset`) nicht mehr
  unbegrenzt still geschluckt: Ab drei Fehlschlägen in Folge meldet der Adapter
  die Verbindung als getrennt, sodass der normale Reconnect-Pfad greift.
  CCU-Faults einzelner Kanäle (Gerät offline o. Ä.) bleiben wie bisher still.
  Das Reconnect-Intervall ist nicht mehr auf minimal 10 s begrenzt (Default
  bleibt 30 s). (hm-rpc 1.1.4)

## [1.1.2] — 2026-07-08

### Neu

- **Wallbox: Mindest-Ladestand Beruflich.** Der Beruflich-Modus stellt das
  Fahrzeug für Arbeitstage nicht mehr zwingend voll (100 %) bereit, sondern bis
  zu einem je Box einstellbaren **Mindest-Ladestand Beruflich** (Default 100 %
  = bisheriges Verhalten). Oberhalb dieses Ladestands wird das Fahrzeug — wie
  im Privat-Modus — nur noch mit nicht speicherbarem PV-Überschuss geladen.

### Geändert

- **Wallbox: Lade-Timing im Beruflich-Modus.** Die vorbereitende Garantieladung
  für einen Arbeitstag startet unverändert rechtzeitig (nicht sofort) vor
  06:00 Uhr. Neu: Fällt der Ladestand **an** einem Arbeitstag unter den
  Mindest-Ladestand Beruflich, wird die Ladung **sofort** aktiviert statt erst
  mit dem vorbereitenden Plan für den Folgetag am Abend. Folgt auf einen
  Arbeitstag ein freier Tag, gilt ab einer ebenfalls einstellbaren Uhrzeit
  (**„Privatregel ab (Uhr) vor freiem Folgetag"**, Default 18 Uhr) nur noch die
  Privatregel — wie an Nicht-Arbeitstagen. Der gemeinsame Vorausplan
  (`planWallboxSchedule`) plant entsprechend: Pflicht ist nur die Energie bis
  zum Mindest-Ladestand Beruflich (am Arbeitstag sofort, sonst ab der
  Garantiezeit des Vorabends), der Rest bis Voll ausschließlich aus Überschuss.
- **Mobile Ansicht: Menü über das Titellogo, Photovoltaik in der Tab-Bar.**
  Der Menü-Tab in der unteren Leiste entfällt; das homeESS-Titellogo im Header
  übernimmt die Funktion der Menüschaltfläche (nur am Smartphone, am Desktop
  bleibt es funktionslos). Das Logo im Menü-Sheet hat jetzt dieselbe Größe wie
  im Titel. Die untere Tab-Bar zeigt fünf Direktzugriffe: Dashboard, Strom,
  **PV (Photovoltaik, neu auf Position 3)**, Batterie und Prognose.
- **Titelzeile (PC-Ansicht): aktuelle Leistungswerte.** Eine gemeinsame Pill
  zeigt die Momentanleistung für **PV ☀️**, **Netzbezug ⚡** (negativ =
  Einspeisung), **Eigenverbrauch 🏠** (inkl. verbraucherseitiger PV) und
  **Akkuladung 🔋** (negativ = Entladung) — Piktogramme statt Beschriftung,
  transparente Pill mit Umrandung, die Werte in aufgehellten Header-Varianten
  der hinterlegten Leistungsfarben (`--color-*-bright`).
  Aktualisierung wie die übrigen Kopfzeilenwerte über `/live/header`
  (10-s-Poll + MQTT-Push). In der mobilen Ansicht bleibt die Pill ausgeblendet.
- **Mobile Ansicht: SoC-Zahl im Akkusymbol.** Der prozentuale Ladezustand
  steht jetzt klein, weiß und mittig im Batteriesymbol des Headers statt
  daneben wie in der breiten PC-Ansicht.

## [1.1.1] — 2026-07-08

### Behoben

- **Wallbox: „nicht angesteckt" blockiert die Ladefreigabe nicht mehr.** Manche
  Fahrzeuge erkennen den Stecker erst, nachdem die Wallbox die Ladung freigegeben
  hat (Henne-Ei-Problem). Das „angesteckt"-Signal dient jetzt ausschließlich der
  Ladeüberwachung: angesteckt + Ladung aktiv + SoC unter Voll ⇒ Leistung muss
  fließen, sonst greift die bestehende Aus-/Ein-Neustart-Schleife. Konkret behoben:
  - Der gemeinsame Vorausplan (`planWallboxSchedule`) verwarf bei
    `plugged === false` den kompletten Ladebedarf; dadurch war
    `plannedFlexibleEnergyByDate` = 0 und die Privat-/Überschussladung blieb mit
    „Prognose ohne nicht speicherbaren Überschuss" dauerhaft aus. Der Bedarf
    richtet sich jetzt allein nach dem bekannten Fahrzeug-SoC.
  - Die einmalige Volladung nach manuellem Einschalten wurde durch
    `plugged === false` sofort abgebrochen, bevor das Fahrzeug den Stecker
    erkennen konnte. Sie endet jetzt nur noch über den Leistungsabfall nach
    gesehener Ladung (ein echtes Abziehen fällt genau darunter).

  Ist laut Plan oder Anforderung eine Ladung erforderlich, wird immer
  eingeschaltet — unabhängig vom „angesteckt"-Status. Die Neustart-Schleife
  läuft unverändert nur bei bestätigt angestecktem Fahrzeug.

- **Prognose: Bilanz-Datenbasis tagsüber massiv überhöht (Gleichrichter-Effekt
  behoben).** Der kumulierte bilanzbasierte Eigenverbrauch pendelt beim
  Akku-Laden minütlich auf und ab, weil PV-, Netz- und Akkuzähler nicht exakt
  synchron fortschreiten (Sägezahn). Die Stundenlernung übernahm bisher **nur
  positive Deltas** und verwarf jede Abwärtsbewegung — sie wirkte wie ein
  Gleichrichter und pumpte das Pendeln als Schein-Verbrauch in die
  PV-/Ladestunden (real belegt: Bilanz-Stunden bis > 2,5× der Selbstzählung,
  ca. +4 kWh/Tag gegenüber dem tatsächlichen kumulierten Tagesendstand).
  Kleine negative Deltas (bis 0,5 kWh) werden jetzt gegengerechnet; Stunden-
  und Tageswerte sind bei 0 nach unten begrenzt. Große Rücksprünge gelten
  unverändert als verspäteter Reset des Quellzählers und werden nur neu
  basiert. Die Bilanz folgt damit wieder dem tatsächlichen Verbrauch; der
  Selbstzählungs-Guard bleibt als Absicherung dahinter bestehen.

- **Grid-Control: kein Aus-/Ein-Takten des Netz-Schützes nach einem Neustart.**
  Bisher konnte ein eingeschaltetes Netz direkt nach dem Neustart kurz aus- und
  sofort wieder eingeschaltet werden (unnötige Schützbelastung). Jetzt gilt:
  erst Ist-Werte abfragen, dann steuern.
  - **Kein Aus-Befehl bei unbekanntem Ist-Zustand**: solange die
    Broker-Rückmeldung des Ziel-Schützes (Netz wie Überschusseinspeisung) noch
    nicht eingetroffen ist, wird kein Aus-Befehl gesendet. Ein-Befehle bleiben
    erlaubt (sicherheitsgerichtet).
  - **Hysteresefenster aus dem Ist-Zustand übernehmen**: meldet der Broker das
    Netz beim Start als EIN, gelten die SoC-/Spannungsfenster als „ausgelöst".
    Messwerte innerhalb des Hysteresebands halten das Netz wie vor dem
    Neustart; Werte außerhalb lösen regulär im selben Tick.
  - **Unvollständige Messwerte schalten nicht aus**: solange nicht alle
    aktivierten Messgrößen (SoC, Spannung, Temperaturwarnung, Lasten L1–L3)
    bekannt sind, wird ein laut Broker eingeschaltetes Netz gehalten. Fehlende
    SoC-/Spannungswerte halten zudem den letzten Fensterzustand, statt ihn auf
    „aus" zu kippen (gilt auch bei Sensor-/Adapterausfall im laufenden Betrieb).
  - Die **Ausschaltverzögerung der Wechselrichterlast** wird in jedem Fall auch
    über Neustarts eingehalten (persistierter Laufzeitzustand; bereits zuvor
    vorhanden, jetzt zusätzlich durch die Ist-Übernahme abgesichert).

### Hinzugefügt

- **Prognose: Guard-Schwellen Bilanz ↔ Selbstzählung als Modellparameter.** Die
  maximale relative Abweichung, ab der eine abgeschlossene Bilanz-Stunde durch
  die Selbstzählung ersetzt wird, war fest auf 25 % verdrahtet, die absolute
  Mindest-Abweichung auf 0,2 kWh. Beide sind jetzt in den **Modellparametern**
  der Prognoseseite einstellbar: „Max. Abweichung Bilanz ↔ Selbstzählung"
  (1–100 %, Standard 25 %; Spalte `prognosis_config.self_count_guard_percent`)
  und „Mindest-Abweichung" (0–5 kWh, Standard 0,2; Spalte
  `prognosis_config.self_count_guard_min_kwh`, 0 = allein die relative Schwelle
  entscheidet).

## [1.1.0] — 2026-07-05

### Hinzugefügt

- **Messen + Schalten: neue Unterseite „Schaltgruppen".** Die Seite klappt im
  Menü unter Messen + Schalten aus und ist in zwei unabhängig scrollbare
  Spalten geteilt: links die Schaltgruppen (Name, optionales **Remote-Topic**,
  Checkbox **„Gruppe schaltet als Einheit"**), rechts schmaler alle Geräte aus
  Messen + Schalten ohne Schaltgruppe; per **Drag & Drop** werden Geräte
  zugeordnet bzw. wieder gelöst. Eine Gruppe gilt als **eingeschaltet, sobald
  ein Gerät an ist**, und erst als aus, wenn alle Geräte aus sind; „als
  Einheit" zieht jede Ein-/Ausschaltflanke eines Mitglieds auf alle übrigen.
  Einschalten der Gruppe (Toggle, Remote-Topic oder State) schaltet **alle
  Geräte ein**, Ausschalten **alle aus** — je Gerät weiterhin durch die
  effektive Priorität gegatet. Das Remote-Topic wird bidirektional synchron
  gehalten (externe Wertänderung = Schaltwunsch, jede Änderung des abgeleiteten
  Gruppen-Istzustands wird unmittelbar zurückgespiegelt; ein beim Start
  gelieferter retained Wert ist nur Baseline und kein Schaltbefehl).
  Optional lässt sich eine Laufzeit in Minuten setzen: Mit dem Wechsel der
  Gruppe auf AN startet der Timer, bei vorzeitigem AUS wird er gelöscht und nach
  Ablauf werden alle Gruppenmitglieder gemeinsam ausgeschaltet.
  Die Schaltzustände stehen als beschreibbare States
  (`schaltgruppe://gruppen/<id>`) unter der neuen Kategorie **Schaltgruppen**
  in der States-Liste und damit automatisch im Wertekatalog und State-Picker
  zur Weiterverarbeitung bereit (neue Tabelle `mess_schalt_switch_groups`,
  neue Spalte `mess_schalt_actors.switch_group_id`;
  `messen-schalten/schaltgruppen.js` + `schaltgruppen-automation.js`,
  virtuelle States-Instanzen in `adapters/router.js`/`adapters/states.js`; Spalte
  `mess_schalt_switch_groups.timer_minutes`).
- **Messen + Schalten: Verrechnung je Gruppe steuerbar.** Im Gruppendialog legt
  die neue, standardmäßig aktivierte Checkbox **„Verbrauchssumme mit
  Gesamtverbrauch verrechnen“** fest, ob die Verbrauchssumme der Gruppe bei
  **„Sonstige Verbraucher“** vom Eigenverbrauch abgezogen wird. Bestehende Gruppen
  bleiben durch den aktivierten Datenbank-Default unverändert verrechnet.
- **Prognose: abgehärtete und transparente Verbrauchs-Datenbasis.** Der stündliche
  Lernwert stützt sich nicht mehr allein auf die (beim Akku-Lade-Übergang
  sägezahnanfällige) Bilanz:
  - **Optionaler echter Eigenverbrauchszähler** (3 Phasen) unter „Zähler-Rohdaten"
    auf der Stromverbrauch-Seite. Ist er gesetzt und liefert Werte, gilt sein
    Tageszuwachs plus verbraucherseitige PV als tatsächlicher Eigenverbrauch – ohne
    Bilanzierung. Neue Spalten `eigenverbrauch_zaehler_l1..3_topic`.
  - **Selbstzählung als Kontrollwert:** Die Eigenverbrauch-Leistung (am
    Wechselrichter-Ausgang gemessen, ≥ 0 und ohne Nulldurchgänge) wird stundenweise
    integriert (`prognosis/self-count.js`). Nach Abschluss einer Stunde ersetzt ein
    **Guard** die Bilanz durch die Selbstzählung, wenn beide zu stark voneinander
    abweichen (Schwelle relativ 25 % **und** absolut 0,2 kWh; ohne echten Zähler).
    Echte Verbrauchsspitzen (Kochen o. Ä.) bleiben erhalten – es wird **nicht
    geglättet**, nur bei belegbarer Divergenz ersetzt.
  - **Transparenz-Diagramm** auf der Prognose-Seite: festes 24-Stunden-Raster mit
    je zwei Balken (Selbstzählung vs. Bilanz/Messung), das sich über den Tag füllt
    (konstante Platzbreite); die aktuelle Stunde wächst bis zum Stundenende, eine
    Marke zeigt den in die Prognose übernommenen Wert. Neue Stundenspalten
    `primary_kwh`, `self_kwh`, `reconciled`.
- **Batterie: Remote-Topic für den Mindest-Ladezustand.** Zusätzlich zum
  bestehenden Ziel-/Steuer-Topic kann ein separates Remote-Topic konfiguriert
  werden — analog zum Schalt- + Remote-Topic der Messen-+-Schalten-Geräte. Es ist
  bidirektional mit der **Mindest-SoC-Einstellung** verknüpft: Speichern spiegelt
  den Wert an das Remote-Topic; ändert ein externes System den Wert dort, wird er
  als neue Einstellung übernommen ("mitgezogen"), gespeichert und zusätzlich an
  das Steuer-Topic weitergegeben. Ein `receivedAt`-Vergleich verhindert, dass ein
  noch nicht aktualisierter Cache-Wert eine gerade gespeicherte Änderung sofort
  wieder zurückdreht (`batterie/min-soc-sync.js`). Bestehende Datenbanken erhalten
  die neue Spalte `remote_topic` automatisch.
- **Mobile Ansicht: Grundkonstrukt + Prognose-Seite.** Beginn der vollwertigen
  Smartphone-Ansicht (Konzept und Arbeitsstand in [MOBILE.md](MOBILE.md)):
  - **Mobile Shell** (≤ 768px): kompakter einzeiliger Header (Zeit/Datum-Pills
    entfallen, Batterie/Level/Himmel bleiben sichtbar), Sidebar ersetzt durch
    eine **untere Tab-Bar** (Dashboard, Strom, Batterie, Prognose, Menü) und
    ein vollflächiges **Menü-Sheet** mit allen Seiten inkl. Modulen, Abmelden
    und Version.
  - **Mobile-Framework** in `styles.css` (Mobile-Layer am Dateiende): Dialoge
    als Bottom-Sheets, KPI-Kacheln im 2er-Raster, einspaltige Dialog-Raster,
    16px-Eingabefelder (kein iOS-Auto-Zoom), Touch-Ziele ≥ 44px, Utilities
    `only-mobile`/`only-desktop`.
  - **Prognose** als erste mobil gestaltete Seite: Statuskarte mit
    Kennzahlen-Zeilenliste, Verhaltensmodell-Steuerung gestapelt, Autark-Kachel
    über volle Breite, einspaltige Prognosetage mit Stundenprofil in voller
    Breite, umbruchfähige Verbrauchsmodell-Fakten.
  - **Header ohne horizontales Scrollen:** mobil sticky statt fixiert, darf
    bei Platzmangel in eine zweite Zeile umbrechen; kompaktere Status-Pills,
    das „Aussen"-Label entfällt, die Batterie zeigt nur das Icon mit
    Füllstand (ohne Prozentzahl).
  - **Alle übrigen Seiten mobil aufgearbeitet** (Details in MOBILE.md):
    Dashboard (2er-Widget-Raster, Info-Widgets volle Breite, Kachel-Aktionen
    auf Touch immer sichtbar, Drag-Griffe ausgeblendet), Stromverbrauch
    (Energie-Übersicht als Karten mit beschrifteten Zeitraum-Werten statt
    seitlich scrollender Tabelle), Photovoltaik/Wallbox (Anlagen-/Box-Karten
    gestapelt, PV-Prognosestreifen als 2er-Raster), Messen + Schalten
    (Gerätezeile zweizeilig: Name/Leistung/Schalter oben, Betriebsart/Zähler/
    Aktionen darunter), Adapter (Instanz-Zeilen zweispaltig), Adapter-States/
    HM-RPC/Tasmota (Register-Tabellen scrollen im eigenen Container), Output
    (gestapelte Zeilen, größere Touch-Buttons), Module (vollbreite
    Aktivieren-Buttons), Pool (Modus-Buttons als vollbreite Segmente),
    Grid-Control (umbruchfähige Protokollzeilen), Login sowie Wertekatalog/
    State-Picker (größere, umbruchfähige Touch-Zeilen).

### Geändert

- **HM-RPC-Adapter 1.1.2: vollständige XML-RPC-Logikschicht.** Der Callbackserver
  meldet und implementiert nun das von der Homematic-Spezifikation geforderte
  `listDevices(interface_id)` und liefert der CCU `ADDRESS`/`VERSION` des bekannten
  Bestands. Die Abmeldung verwendet korrekt dieselbe Callback-URL mit leerer
  `interface_id`. Damit kommen `event`/`system.multicall` wieder unmittelbar an;
  die ersten fünf Callbackmethoden nach einer Registrierung werden zur Diagnose
  protokolliert. Der zuvor vorübergehend eingebaute sekündliche HM-Sonderabruf im
  Hauptsystem wurde entfernt — Adapter und Kern bleiben gemäß `ADAPTER.md`
  entkoppelt. Der optionale, adaptereigene CCU-Cache-Hintergrundrefresh bleibt.
- **Adapter-Einstellungen werden atomar zusammengeführt.** Formularänderungen
  patchen nur ihre eigenen Schlüssel per SQLite-JSON statt das vollständige
  Settings-Objekt zu überschreiben. Parallel vom Adapter persistierte Metadaten
  wie die HM-RPC-Geräteliste bleiben auch beim Speichern und Instanzneustart
  sicher erhalten.

### Behoben

- **Schaltgruppen synchronisieren Status, Remote-Topic und virtuellen State
  bidirektional.** Direkte Geräteänderungen, Gruppen-/State-Schaltungen und echte
  externe Remote-Änderungen werden ereignisbasiert in beide Richtungen
  weitergereicht. Eigene MQTT-Echos lösen keine Rückkopplung aus; Boolean-States
  werden typgetreu publiziert. Kanonische Adapter-Eventschlüssel (insbesondere
  HM-RPC-Batches) starten den Gruppentick ebenfalls, sodass kein Seitenaufruf zum
  Aktualisieren nötig ist.
- **Live-Schalter folgen dem bestätigten Istzustand.** Auf „Messen + Schalten"
  und der Schaltgruppen-Seite aktualisieren sich nicht nur die Statuspunkte,
  sondern auch die Toggle-Schalter sofort. Der Browserfokus blockiert das
  Live-Update nach einem Klick nicht mehr.

## [1.0.15] — 2026-07-04

### Hinzugefügt

- **Wertekatalog: „Sonstige Verbraucher" unter Verbrauchssummen.** Neuer Eintrag
  mit der Leistung, die sich aus der Eigenverbrauchsleistung (lt. Stromverbrauch)
  abzüglich aller Gruppen-Verbrauchssummen ergibt. Der Wert wird bei 0 gekappt,
  damit Messungenauigkeiten keine negativen Werte erzeugen; ohne verfügbare
  Eigenverbrauchsleistung bleibt er leer.

## [1.0.14] — 2026-07-04

### Geändert

- **Wertekatalog zeigt mehrere Verzeichnisebenen (wie der Adapter-State-Picker).**
  Die Werteauswahl bei Outputs und Dashboard-Widgets gruppiert Kategorien der Form
  „A / B / C" jetzt als eingerückten, einklappbaren Verzeichnisbaum. Adapter-States
  erscheinen dadurch mit ihrer echten Hierarchie `Adapter: <Instanz> / <Gerät> /
  <Kanal>` statt flach unter der Instanz.
- **„Merken"-Funktion für die Werteauswahl.** Der Auf-/Zuklapp-Zustand jeder Ebene
  wird – wie beim Topic-Picker – in `localStorage` gemerkt und beim erneuten Öffnen
  des Dialogs wiederhergestellt (gemeinsam für Output- und Dashboard-Auswahl).

### Behoben

- **Wertekatalog-Suche: Zurücksetzen klappt den Baum wieder ein.** Beim Tippen
  klappt die Suche Treffer-Kategorien samt Unterkategorien auf (Suche greift jetzt
  auch über den Kategorie-Pfad); beim Leeren der Suchzeile wird der gemerkte
  Ein-/Ausklapp-Zustand wiederhergestellt, statt alles offen zu lassen — dieselbe
  Korrektur wie zuvor beim State-Picker.

## [1.0.13] — 2026-07-04

### Behoben

- **State-Picker: Suche zurücksetzen klappt den Baum wieder ein.** Beim Tippen
  klappt die Suche Treffer-Kategorien samt Unterkategorien auf; beim Leeren der
  Suchzeile wurde dieses Auto-Aufklappen bisher nicht zurückgenommen. Jetzt wird
  der persistierte Ein-/Ausklapp-Zustand wiederhergestellt: nur durch die Suche
  geöffnete Kategorien schließen wieder, vom Nutzer dauerhaft geöffnete bleiben
  offen.
- **HM-RPC: kein erneuter Steuerbefehl bei unverändertem Wert.** Ein Schreibvorgang
  mit dem bereits gesetzten Wert (z. B. `true` auf einen schon `true`-Zustand)
  löst keinen erneuten `setValue` an die CCU mehr aus und spart so Funk/Duty-Cycle.
  Ausgenommen sind `ACTION`-Parameter (Taster-/Trigger-Impulse), bei denen das
  wiederholte Schreiben die eigentliche Aktion ist.

### Geändert

- **Adapter tragen einen eigenen Copyrightvermerk.** Da die Adapter eigenständige
  Anwendungen sind, führt jedes Manifest (`adapter.json`) nun ein `copyright`-Feld,
  das auf der Adapter-Seite angezeigt wird – analog zum Vermerk im Menüfuß.
  Adapterversionen entsprechend erhöht (hm-rpc 1.1.1, modbus 1.1.1, tasmota 1.0.2,
  demo 1.0.1).

## [1.0.12] — 2026-07-04

### Behoben

- **Akkuladung blähte die gelernten Stundenwerte nicht mehr auf.** Die
  Batteriebereinigung des Eigenverbrauchs (`− Ladung + Entladung`) war korrekt
  signiert, wurde aber in den kumulierten Tageszähler eingebaut, aus dem das
  Lernmodell nur **positive** Stundendeltas bildet. Weil der Ladezähler bislang
  nur in einem **eigenen, asynchronen Job** fortgeschrieben wurde, sägte der
  bereinigte Wert minütlich hoch/runter; die Abwärtsspitzen wurden verworfen und
  die Ladung fraß sich als Phantomverbrauch in die PV-/Ladestunden (real
  ~14 kWh/Tag wurden als ~47 kWh gelernt, mit unmöglichen 10–12-kWh-Stunden
  mittags). Der Akku-Energiezähler wird jetzt **im selben Snapshot-Takt** wie die
  PV-/Netzzähler fortgeschrieben (`updateBatteryEnergy` in
  `buildStromverbrauchSnapshot`), sodass die bereinigte Bilanz pro Intervall
  konsistent ist und die Ladestunden nur noch den realen Hausverbrauch lernen.

### Geändert

- **Titelzeile: Akkuanzeige ≥ 50 % wieder grün** (statt blau), passend zur
  Batterieseite; darunter unverändert gelb (< 50 %) und rot (< 20 %).
- **Titelzeile: Betriebslevel zusätzlich als Zahl.** Neben den fünf Levelbalken
  steht das aktive Level als weiße Ziffer in einem farbig umrandeten Kreis
  (Randfarbe je Level, 1 rot → 5 grün); Balkenbreite unverändert.

## [1.0.11] — 2026-07-04

> HM-RPC-Adapter auf **1.1.0** angehoben.

### Hinzugefügt

- **HM-RPC hält Werte jetzt aktiv aktuell.** Der Adapter reagiert nicht mehr rein
  passiv auf CCU-Push-Events, sondern kann Werte gezielt aus dem **CCU-Cache**
  nachladen (`getParamset` auf das VALUES-Paramset — **kein Funk, kein
  Duty-Cycle**). Damit werden Änderungen in der CCU auch dann übernommen, wenn ein
  Push-Event ausbleibt, und die Frische-Zeitstempel bleiben aktuell (behebt das
  fälschliche „⚠"/veraltet bei trägen Zählern wie kWh). Drei Ebenen greifen
  ineinander: **On-Demand** (Live-Refresh der Messen-Schalten-Seite), ein
  optionaler, **gleichmäßig verteilter Hintergrund-Refresh** (neue Einstellung
  „Hintergrund-Refresh (s)", 0 = aus — arbeitet als serialisierter Round-Robin,
  ein Kanal nach dem anderen, nie als Burst) und ein **aktives Beobachtungsfenster
  nach Steuerbefehlen** (5 s lang werden nach einem Schaltbefehl alle Kanäle des
  Geräts engmaschig nachgefragt, damit das zugehörige Status-Topic zeitnah
  nachzieht).
- **Topic-Picker mit fester Breite und gemerktem Zustand.** Das Auswahl-Dropdown
  ist nicht mehr an die (oft schmale) Breite des Topic-Felds gekoppelt, sodass
  lange State-Namen nicht mehr abgeschnitten werden. Zusätzlich merkt sich der
  Picker pro Kategorie den **Ein-/Ausklappzustand** und seine **letzte
  Scrollposition**, sodass man beim Zuweisen mehrerer Topics den gesuchten Wert
  nicht jedes Mal neu suchen muss.
- **HM-RPC-Geräteseite: eingeklappt und persistent.** Die Geräte sind beim Laden
  standardmäßig eingeklappt und merken sich ihren Auf-/Zu-Zustand. Die Geräteliste
  bleibt über einen Adapterneustart erhalten und wird nicht mehr bei jedem Start
  komplett aus der CCU neu aufgebaut.

### Geändert

- **HM-RPC bündelt CCU-Geräteaktualisierungen.** `updateDevice`-Ereignisse der CCU
  lösen nicht mehr je Ereignis einen vollständigen Re-Sync aus, sondern werden mit
  Debounce und Single-Flight zu **einem** Re-Sync zusammengefasst. Das senkt die
  CPU-Last des Adapters bei Geräte-Bursts deutlich.

### Behoben

- **HM-RPC übernimmt die Einheiten der Werte.** Bei großen Anlagen konnten
  Push-Events schneller eintreffen, als die Parameterbeschreibungen (mit Einheit)
  geladen wurden; die betroffenen States blieben dann dauerhaft ohne Einheit. Der
  Adapter wertet einen bereits angelegten State jetzt nach, sobald die echte
  Beschreibung vorliegt, sodass die übermittelte Einheit an den Werten erscheint.

## [1.0.10] — 2026-07-04

### Hinzugefügt

- **Geräteseite für den HM-RPC-Adapter.** Jede HM-RPC-Instanz hat jetzt – wie
  Tasmota – eine eigene „Geräte"-Unterseite. Dort lässt sich jedem von der CCU
  erkannten Gerät ein frei wählbarer Klarname geben (z. B. „Wohnzimmerlampe"),
  mit dem es sich in homeESS identifiziert; er ersetzt die kryptische Geräte-ID
  in den State-Kategorien. Die technische Geräte-ID sowie der CCU-Name bleiben
  auf der Geräteseite weiterhin sichtbar. Der Adapter meldet die erkannten
  Geräte samt Kanälen als Metadaten, sodass die Seite auch bei kurzzeitig
  getrennter CCU nutzbar bleibt.

## [1.0.9] — 2026-07-04

### Behoben

- **Eigenverbrauchsenergie berücksichtigt den Hausakku korrekt.** Die zentrale
  Stromverbrauchsbilanz zieht geladene Batterieenergie von den Energiezählerwerten
  ab und rechnet entladene Energie wieder hinzu. Das gilt für Tages-, Wochen-,
  Jahres- und Vorjahreswerte. Dadurch fällt
  der Verbrauch bei nächtlicher Versorgung aus dem Akku nicht mehr auf null und
  die Prognose lernt auch für die Nachtstunden eine reale Verbrauchskurve.
- **Eigenverbrauchsleistung bleibt ein direkter Messwert.** Die Leistung wird
  unverändert aus den Eigenverbrauchs-Topics des Wechselrichters übernommen und
  nur um verbraucherseitig einspeisende PV-Anlagen ergänzt. Batteriefluss und
  Glättung werden hier bewusst nicht angewendet.
- **Keine doppelte Akkukorrektur in der Prognose.** Da bereits der zentrale
  Eigenverbrauch batteriebereinigt ist, übernimmt das Lernmodell diese Bilanz
  direkt und zieht Laden beziehungsweise Entladen nicht ein zweites Mal ab.

### Geändert

- **Batteriewirkungsgrade gehören zu den Batterieparametern.** Lade- und
  Entladewirkungsgrad wurden von der Prognoseseite auf die Batterieseite
  verschoben. Bestehende Werte werden bei der Datenbankmigration übernommen;
  die Prognosesimulation verwendet weiterhin beide Wirkungsgrade. Die
  Eigenverbrauchsenergie verwendet den gemessenen Batteriefluss ohne
  zusätzlichen Wirkungsgrad; die Eigenverbrauchsleistung bleibt davon unabhängig.

## [1.0.8] — 2026-07-03

### Behoben

- **Homematic-Duty-Cycle: keine `/get`-Stürme mehr an `hm-rpc.*`.** Bisher
  fragte der MQTT-Client bei jedem Connect/Reconnect sowie bei jedem
  Konfig-Speichern (alle Modul-Seiten) sämtliche konfigurierten States aktiv
  per `/get` an — inklusive aller Homematic-Topics (~88 Anfragen pro Burst
  bei 11 Funk-Aktoren), von denen jede eine echte Funkabfrage auslösen kann.
  Funk-Topics (`hm-rpc.*`) sind jetzt in allen Pfaden vom aktiven Polling
  ausgenommen (Verbindungsaufbau, State-Definitionen, Ad-hoc-Abos,
  Readback-Verifikation); ihre Werte kommen rein ereignisgetrieben über das
  Abo. Zusätzlich fragt das Aktualisieren der State-Definitionen nur noch
  neue bzw. umkonfigurierte Topics an statt bei jedem Speichern alle.
- **Homematic-Duty-Cycle: ein Funkbefehl pro Schaltvorgang statt vier.**
  Schreibvorgänge fächerten bisher auf Punkt- und Slash-Notation sowie
  `/set`-Subtopic und Haupt-Topic auf — bei `hm-rpc.*` landen alle vier
  Varianten auf derselben State-ID und lösten je einen eigenen Funkbefehl
  aus. Funk-Topics erhalten jetzt genau ein Publish (Haupt-Topic in
  Punktnotation als JSON mit `ack:false`). Betrifft die Schaltbefehle von
  Messen + Schalten und der Poolsteuerung; alle anderen Topics behalten die
  bisherige Auffächerung.
- **Passive Frischebewertung für Gerätewerte.** Status-, Leistungs- und
  Zählerwerte tragen ihren bereits vorhandenen MQTT-Empfangszeitpunkt bis in
  die Oberfläche. Nach fünf Minuten ohne passives Update werden sie sichtbar als
  alt markiert, ohne `/get` oder Funkabfrage. Meldet ein schaltbares Gerät
  bestätigt `AUS`, wird ein hängengebliebener Leistungswert als `0 W` behandelt;
  dadurch bleiben etwa alte Homematic-POWER-Werte ausgeschalteter Leuchten
  nicht mehr als laufender Verbrauch stehen.

## [1.0.7] — 2026-07-03

### Hinzugefügt

- **Messen + Schalten: optionales Remote-Topic.** Schaltbare Geräte können
  jetzt ein zusätzliches Remote-Topic erhalten. Änderungen am Remote-Topic
  schalten das Gerät; manuelle und physische Zustandsänderungen werden auf das
  Remote-Topic zurückgespiegelt. Verhindern Betriebslevel oder Lastabwurf das
  Einschalten, werden Schalt- und Remote-Topic gemeinsam auf `AUS` gesetzt.
  Bestehende Datenbanken erhalten die neue Spalte `remote_topic` automatisch.

### Geändert

- **Gerätedialog aufgeräumt.** Schalt- und Remote-Topic stehen als Paar,
  das Status-Topic in einer eigenen Zeile und Leistungs- sowie Zähler-Topic
  wieder nebeneinander.

### Behoben

- **Gerätestatus und Energiewerte aktualisieren sich schneller.** Neue
  Zählerwerte werden sofort statt erst im Minutentakt verarbeitet. Beim
  Live-Refresh werden ausschließlich lokale Adapterwerte aktiv und gedrosselt
  angefordert; externe MQTT-Topics bleiben rein ereignisgetrieben, damit etwa
  Homematic keine zusätzlichen Funkabfragen und Duty-Cycle-Last erhält. Der
  Tasmota-Adapter beantwortet lokale Reads mit einem gemeinsamen `STATUS`-Abruf
  für Schaltstatus und Energie.
- **Keine endlosen Schaltwiederholungen bei ausbleibender Bestätigung.** Meldet
  ein Status-Topic nach einem Schaltbefehl weiterhin den alten Zustand, sendet
  der 30-s-Regeltakt nicht mehr fortlaufend denselben Befehl. Ein identischer
  Befehl wird erst wieder freigegeben, nachdem der Ist-Zustand ihn bestätigt hat
  und später erneut abweicht. Das verhindert insbesondere unnötige
  Homematic-Funktelegramme und Duty-Cycle-Last.
- **Poolsteuerung wiederholt gegatete Pumpenbefehle nicht mehr.** Wollte ein
  Zeitfenster oder die Solarautomatik eine Pumpe einschalten, während das
  Betriebslevel dies verhinderte, verglich die Regelung bisher den tatsächlichen
  Zustand `AUS` fortlaufend mit dem ungegateten Wunsch `EIN`. Dadurch wurde alle
  30 Sekunden und bei Grid-Ereignissen erneut `AUS` publiziert. Verglichen wird
  jetzt mit dem tatsächlich erlaubten Zielzustand; ein blockiertes Einschalten
  erzeugt keinen wiederholten Ausschaltbefehl mehr.

## [1.0.6] — 2026-07-03

### Geändert

- **Grid-Control trennt jetzt Netzschwellen und Lastabwurf-Maximallast sauber
  je Phase.** Für `L1`–`L3` gibt es eigene Felder **„Maximallast Lastabwurf"**.
  Der phasenbezogene Lastabwurf arbeitet damit auf **80 % / 50 %** dieser
  Maximallast, während **„Netz ein über"** und **„Netz aus unter"** weiterhin
  ausschließlich die eigentliche Netzschaltung steuern.
- **Lastabwurf-Freigabe erst nach 60 Sekunden stabil unter 50 %.** Nicht nur
  zwischen zwei Freigabestufen, sondern bereits für die **erste**
  Wiedereinschaltung gilt jetzt dieselbe **60-s-Verzögerung**.

### Behoben

- **Messen + Schalten: Wiedereinschaltung nach Lastabwurf robuster.** Geräte
  mit **„Immer an"** senden nach einer Lastabwurf-Freigabe den Einschaltbefehl
  jetzt erneut, selbst wenn ein veraltetes `status_topic` noch `AN` meldet.
  Dadurch bleiben z. B. Waschmaschinen nach einem Lastabwurf nicht mehr
  fälschlich aus.

## [1.0.5] — 2026-07-03

### Geändert

- **Prognose trennt E-Auto und temperaturabhängige Lasten strikt vom
  Grundbedarf.** Wallbox-Zählerdelta und Hausverbrauch werden jetzt im selben
  Minutentakt erfasst; der exakte Ladeenergie-Delta hat Vorrang vor dem
  Leistungswert. E-Auto-Last wird nur bei angeschlossenem Fahrzeug mit bekanntem
  SoC und genau einmal gemäß Ladestrategie eingeplant, nicht aus historischen
  Ladezeiten. **Heizung / Klima** bleibt separat und verwendet 5-°C-Fenster auf
  Basis der energiegewichteten Stundentemperatur.

## [1.0.4] — 2026-07-03

### Geändert

- **Adapter-Seite: inaktive Adapter standardmäßig ausgeblendet.** Oben rechts
  gibt es jetzt einen Schalter **„Inaktive Adapter ausblenden"**, der per
  Default aktiv ist. Versteckt werden Adapterkarten, die aktuell **keine
  aktivierte Instanz** besitzen; über den Schalter lassen sie sich wieder
  einblenden. Die Sichtbarkeit zieht bei Aktivieren/Deaktivieren einer Instanz
  ohne Neuladen mit dem Live-Status nach.

- **Messen + Schalten komplett umstrukturiert.** Gruppen laufen jetzt als
  **einklappbare Abschnitte über die volle Seitenbreite** (wie die Kategorien
  der Output-Seite): Standard zugeklappt, der Auf/Zu-Zustand je Gruppe wird im
  Browser gemerkt. Gruppen haben **keine Drag-Fläche mehr** und sind fest
  **alphanumerisch nach Titel sortiert**. Geräte sind **einzeilige Zeilen über
  die volle Breite** (Status, Name, Betriebsart, Leistung, Zähler, Toggle),
  behalten ihre Drag-Fläche und bleiben frei anordbar bzw. zwischen Gruppen
  verschiebbar — Drop auf den Kopf einer zugeklappten Gruppe ordnet das Gerät
  ans Gruppenende zu. **Gruppenlose Geräte** stehen im Abschnitt „Ohne Gruppe"
  am Seitenende unter den Gruppen.

- **Messen + Schalten: interner Zählerstand statt Roh-Topic-Wert.** Der
  angezeigte Zählerstand eines Geräts ist jetzt ein interner Zähler, der wie
  beim Stromverbrauch nur die **Deltas** des Zähler-Topics fortschreibt. Bei
  **Geräte-Neuanlage** startet er bei 0, bei **Wechsel des Zähler-Topics oder
  der Einheit** wird nur die Baseline neu gesetzt — der aktuelle Rohwert des
  Topics geht nicht mehr als Sprung in den Zählerstand ein. Rückwärtssprünge
  des Rohwerts (Geräte-Reset) basieren ebenfalls nur neu, ohne den internen
  Stand zu verändern. Bestehende Geräte übernehmen beim ersten Snapshot
  einmalig ihren bisherigen Anzeigewert und laufen nahtlos weiter
  (neue Spalte `counter_total_kwh` in `mess_schalt_actor_state`).

### Behoben

- **Messen + Schalten: Validierungsfehler beim Gerät-Anlegen waren unsichtbar.**
  Schlug die Server-Validierung fehl (z. B. nur Status-Topic angegeben oder
  „Priorität der Gruppe verwenden" ohne Gruppenauswahl), öffnete sich der Dialog
  zwar erneut mit den eingegebenen Werten, die Fehlermeldung wurde aber sofort
  wieder gelöscht — „Speichern" sah aus, als täte es nichts. Die Meldung wird
  jetzt nach dem Öffnen des Dialogs gesetzt und bleibt sichtbar.
- Testschemata um die Lastabwurf-Spalten (`load_shed_enabled`,
  `load_shed_phase`) ergänzt, die seit 1.0.2/1.0.3 in den betroffenen
  Testtabellen fehlten (Aggregation, Funktionen, Wallbox-Prognose).

## [1.0.3] — 2026-07-03

### Geändert

- **Poolsteuerung und Wallbox nehmen jetzt ebenfalls am phasenbezogenen
  Lastabwurf teil.** Solarpumpe, Filterpumpe und jede Wallbox können nun einer
  **Lastabwurf-Phase** (`L1`, `L2`, `L3`, `Drehstrom`) zugeordnet werden und
  nutzen dieselbe **stufenweise Prioritätslogik** wie Messen + Schalten:
  niedrigste Priorität zuerst, **10 Sekunden** Stabilisierung vor der nächsten
  Stufe und Wiedereinschaltung in umgekehrter Reihenfolge mit **60 Sekunden**
  Abstand. Bei deaktiviertem Grid-Control bleiben die zugehörigen
  Formulareinstellungen ausgegraut.

## [1.0.2] — 2026-07-03

### Hinzugefügt

- **Messen + Schalten – Lastabwurf-Anzeige auf der Kachel.** Geräte zeigen bei
  aktivem Lastabwurf jetzt direkt **„Lastabwurf · Priorität N"** statt nur ihrer
  normalen Betriebsart.

### Geändert

- **Messen + Schalten – Lastabwurf jetzt stufenweise nach Priorität.** Pro
  Phase werden bei hoher Wechselrichterlast zuerst Geräte der **niedrigsten
  Priorität** abgeworfen, danach frühestens nach **10 Sekunden** Stabilisierung
  die nächste Stufe. Die Wiedereinschaltung erfolgt in umgekehrter Reihenfolge
  mit **60 Sekunden** Abstand je Stufe; nur Geräte mit **„Immer an"** werden
  danach automatisch wieder zugeschaltet.

## [1.0.1] — 2026-07-03

### Geändert

- **Prognose – Vortag als Vorlage für ungelernte Wochentage.** Wochentage ohne
  eigene Lerntage übernehmen jetzt ausschließlich die Lernkurve des jüngsten
  abgeschlossenen Tages (Kurvenform und Tagesziel); die Tageskalibrierung passt
  sie an den laufenden Verlauf an, und der abgeschlossene Tag wird wieder Vorlage
  für den nächsten. Die frühere Hochrechnung `heute ÷ erwarteter Tagesanteil`
  konnte in den frühen Morgenstunden explodieren (kleiner Tagesanteil aus noch
  ungelernter Profilform) und riss als Anker aller Wochentagsziele die gesamte
  Bedarfsprognose nach oben; sie greift nur noch im echten Kaltstart ab 30 %
  Tagesfortschritt.
- **Klimatisierungsmodell entfernt.** Der temperaturbasierte Mehrverbrauchs-
  Zuschlag samt `prognose.klima*`-Wertekatalog-Einträgen und `klima`-Tages-
  historie entfällt ersatzlos; Klimatisierung wird stattdessen über die neue
  Funktions-Statistik (Funktion „Heizung / Klima") gemessen und prognostiziert.

### Hinzugefügt

- **Messen + Schalten – Funktion je Gruppe und Gerät.** Neues Dropdown
  **Funktion** (Licht, Waschen, Warmwasser, Heizung / Klima, Kochen) an Gruppen
  und Geräten; Geräte ohne eigene Funktion erben die Funktion ihrer Gruppe. Je
  zugeordneter Funktion entstehen zwei Wertekatalog-Einträge (Kategorie
  **Funktionen**): aktuelle Leistung (`funktion.<key>.leistung`) und Verbrauch
  heute (`funktion.<key>.verbrauchHeute`).
- **Prognose – Stundenprofile je Funktion.** Die Leistung funktionszugeordneter
  Geräte wird minütlich zu Stundenenergien integriert
  (`mess_schalt_function_hourly`), aus dem gelernten Haus-Grundverbrauch
  herausgerechnet (analog Wallbox/Pool) und in der Simulation separat
  aufgeschlagen: Heizung / Klima nach Außentemperatur-Buckets in 5-°C-Schritten,
  die übrigen Funktionen nach Wochentag.
- **Prognoseseite – 24-h-Stundenprofil je Tag.** Die PV-/Bedarfs-Balken sind
  kürzer; rechts daneben zeigt ein Balkendiagramm den erwarteten Verbrauch der
  24 Stunden gemäß Tagesprofil. Bereits gelernte Stunden des laufenden Tages
  erscheinen in abweichender Farbe (Ist) mit Soll-Marke je Stunde, sodass die
  Abweichung zwischen tatsächlichem Verbrauch und Prognose direkt sichtbar ist
  (Details je Stunde im Tooltip).

## [1.0.0] — 2026-07-02

### Stable Release

- Erstes stabiles Release von **homeESS**.
- **Messen + Schalten:** Alle schaltbaren Geräte werden unabhängig von der
  Betriebsart durch Betriebslevel und effektive Priorität geschützt. „Immer an"
  steuert nur das automatische Wiedereinschalten nach erneuter Freigabe.

## [0.11.1] — 2026-07-02

### Geändert

- **Messen + Schalten – klare Betriebsart je Gerät.** Neue Checkbox **„Immer an"**:
  Ist sie gesetzt, schaltet das Gerät automatisch ein, sobald das Betriebslevel die
  Priorität zulässt (und darunter wieder aus, auch bei externem Einschalten); der
  Kachel-Schalter entfällt. Ohne „Immer an" bleibt der Kachel-Schalter manuell, wird
  aber ebenfalls durch die Priorität gegatet: Zwangs-Aus unterhalb der Freigabe und
  kein automatisches Wiedereinschalten danach. Je Kachel wird die Betriebsart angezeigt
  („Immer an · Priorität N", „manuell" bzw. „nur Messen").

## [0.11.0] — 2026-07-02

### Hinzugefügt

- **Neue Seite „Messen + Schalten"** (Hauptmenü direkt unter Batterie), aufgebaut
  wie das Dashboard: frei anlegbare **Gruppen** und **Geräte-Kacheln**, per
  Drag & Drop zwischen Gruppen bzw. ohne Gruppe anordbar. Je Gerät bis zu vier
  MQTT-Topics (**Schalten, Status, Leistung, Zähler**); mindestens Schalten,
  Leistung oder Zähler ist erforderlich. Ohne Status-Topic gilt das Schalt-Topic
  (bzw. die Leistung) als Ist-Stand. Ist nur ein Zähler gesetzt, wird die Leistung
  aus dem Zählerfortschritt abgeleitet und fällt nach über 10 Minuten ohne
  Fortschritt auf 0 W. Geräte mit Schalt-Topic haben einen **An/Aus-Toggle**
  (persistenter Wunschzustand), der stets über das **Betriebslevel** gegatet wird
  (Freigabe ab der Geräte- bzw. optional übernommenen Gruppenpriorität,
  Zwangsabschaltung bei Levelabfall; siehe LEVEL_HANDLING.md). Die Werte der
  gesetzten Topics stehen im Wertekatalog in der Kategorie **Geräte**, die
  Leistungssummen der Gruppen in der Kategorie **Verbrauchssummen**; jede Gruppe
  zeigt ihre Summe zusätzlich in der Titelzeile. Die **aktive (effektive) Priorität**
  wird je Gerätekachel und je Gruppe angezeigt. Das **Betriebslevel-Gate wirkt auf den
  Ist-Zustand**: ein Gerät, das läuft – auch extern oder am Gerät eingeschaltet –,
  wird bei zu niedrigem Level abgeschaltet. Bei ausreichendem Level bleibt eine
  externe Schaltung unangetastet (nicht-destruktiv, u. a. beim Anlegen mit Default
  „aus"); aktiv „An" wird nur bei ausdrücklichem Wunsch und Freigabe gesetzt. Der
  **Kachel-Toggle spiegelt den Ist-Zustand** (nicht mehr nur den Wunsch), passt also
  auch bei externem Schalten zum Gerät, und die Steuerung reagiert **entprellt auf
  MQTT-Änderungen**, sodass das Gate bei externem Ein-/Ausschalten prompt eingreift.

## [0.10.5] — 2026-07-02

### Behoben

- **Betriebslevel im Netzparallelbetrieb direkt mit der Prognoseampel gekoppelt:**
  Grün setzt Level 4, Gelb Level 3 und Rot Level 2. Level 1 bleibt dem tatsächlich
  unterschrittenen Mindest-SoC vorbehalten; Level 5 gilt weiterhin für den vollen
  Akku mit Überschuss. Damit bleibt das Level bei gelber Ampel weder auf 4 hängen
  noch fällt es dort vorzeitig auf 2.

## [0.10.4] — 2026-07-02

### Hinzugefügt

- **Pool-Energiemodell:** Bei aktivierter Poolsteuerung werden die Leistungen von
  Solar- und Filterpumpe robust aus realen Schaltflanken gelernt, ihre tatsächliche
  Energie persistent erfasst und aus dem gelernten Hausbedarf entfernt. Die
  Prognose plant Solarstunden aus der PV-Prognose sowie Filter-Zeitfenster,
  Follow-Solar und Akku-Override als eigene Last ein. Maximaltemperatur und
  Probeläufe werden bewusst nicht vorausgesagt, rückwirkend aber bereinigt.
- **Leichtgewichtige Laufzeitdiagnose:** `HOMEESS_PERF_DEBUG=1` protokolliert
  minütlich Laufzeiten, Aufruf-, Cache- und Coalescing-Zähler, SQLite-Aktivität
  sowie Event-Loop-Lag.
- Adapter können mehrere gleichzeitig gelesene Werte über
  **`host.publishStates()`** gesammelt melden; Frischezeitstempel bleiben je State
  erhalten, während reaktive Verbraucher nur ein Änderungsereignis erhalten.

### Geändert

- **Prognosebasis fachlich getrennt:** Der physische Eigenverbrauch wird aus
  Netzbezug und PV-Ertrag gebildet. Akku, Wallbox, Klimatisierung und Pool werden
  für das Haushaltsmodell herausgerechnet und anschließend jeweils passend zur
  aktuellen Situation separat simuliert.
- Noch ungelernte Wochentage verwenden nach ausreichendem Tagesfortschritt den
  bereinigten heutigen Verlauf, davor den jüngsten bereinigten Mittelwert und nur
  bei einer Neuinstallation ohne Lerndaten das bereinigte Jahresmittel.
- Der Wallbox-Vorausplan wird für jeden Aufrufer frisch aus einem unveränderlichen
  Basismodell und dem aktuellen Batterie- und Fahrzeugzustand erzeugt. Im
  Privatmodus wird der verbleibende Pflichtbedarf über den sichtbaren Horizont
  fortgeführt; flexible Ladung erhält nur echten Überschuss nach dem Hausakku.
- Im Netzparallelbetrieb gibt Level 4 Verbraucher frei, wenn der Bedarf bis zum
  nächsten Ladebeginn sicher aus dem Akku gedeckt ist. Die Prognoseampel steuert
  die Stufen direkt: Grün = Level 4, Gelb = Level 3 und Rot = Level 2; Level 1
  bleibt dem unterschrittenen Mindest-SoC vorbehalten.
- Grid-Control verdichtet relevante Wert-Bursts auf einen laufenden und höchstens
  einen folgenden Lauf; der unabhängige 2-Sekunden-Sicherheitstakt bleibt erhalten.
- Wertekatalog, Output-Auswertung, PV-Prognose und Verbrauchsmodell teilen kurz
  gültige beziehungsweise laufende Berechnungen. Periodische Jobs verhindern
  Selbstüberlappung; häufig gelesene Konfigurationen werden gezielt invalidiert.
- Der Modbus-Adapter liest zusammenhängende Register gleicher Unit-ID, Registerart
  und Pollrate blockweise, verhindert überlappende Polls und holt verpasste Ticks
  nicht nach. Konfigurierte Intervalle, Adressen und Schreibpfade bleiben gleich.

### Behoben

- Ein fehlerhafter oder überalterter Verbrauchssprung kann keinen Tageswert um
  Größenordnungen mehr aufblasen. Minutenintervalle werden plausibilisiert und
  Tages-/Stundenstände selbstheilend konsistent gehalten.
- Wallbox-Ladungen verschwinden nicht mehr abhängig von Cache-Reihenfolge aus der
  Prognose und werden umgekehrt nicht mehrfach als Statistik- und Live-Plan
  angesetzt.
- Akku-Ladung erhöht den gemessenen Eigenverbrauch weiterhin physikalisch,
  Akku-Entladung mindert ihn; beide Richtungen werden beim Lernen des reinen
  Hausbedarfs korrekt über die signierte Batterieleistung bereinigt.

## [0.10.3] — 2026-07-02

### Hinzugefügt

- **Statistische Jahreswerte im Wertekatalog** für PV-Ertrag, Netzbezug,
  Eigenverbrauch, E-Auto (alle Wallboxen zusammen) und Klimatisierung: je Kennzahl
  **gestern**, **Durchschnitt**, **Minimum + Datum**, **Maximum + Datum** sowie die
  **Jahres-** und **Vorjahressumme**. Grundlage ist die neue Tabelle
  `daily_metric_history`, die je Kennzahl beim Tageswechsel einen abgeschlossenen
  Tageswert festhält (400 Tage Aufbewahrung). Der Durchschnitt wird als
  **Jahressumme ÷ angebrochene Tage** gerechnet (konsistent mit den Summen, statt
  aus der erst kürzlich beginnenden Tageshistorie). Fehlen noch Werte, zeigt der
  Katalog **0** statt „—", das Min-/Max-Datum den **1. Januar** des laufenden Jahres.
- **Adapter-States erscheinen automatisch im Wertekatalog.** Jeder von einer
  Adapter-Instanz gemeldete State ist – zusätzlich zu den berechneten Werten – als
  Quelle für Outputs und Dashboard-Kacheln wählbar (Kategorie „Adapter: <Instanz>").
- **Output-Seite merkt sich den Auf-/Zu-Zustand der Kategorien** (localStorage);
  ohne gespeicherten Zustand werden alle Kategorien zugeklappt geladen.

### Geändert

- **Menü:** „Adapter" ist jetzt ein normaler Hauptnavigationspunkt; „States"
  klappt als Unterpunkt darunter auf.
- **„Wert abgleichen" auf der Photovoltaik- und Stromverbrauchseite.** Die beiden
  getrennten „Wert setzen"-Buttons (Woche/Jahr) sind einem einzelnen Dialog oben
  rechts gewichen, in dem sich die Kennzahl auswählen lässt: Woche-, Jahres- und
  **Vorjahressumme** sowie **Minimum/Maximum** (Wert + Datum, wird als Startwert in
  die Tageshistorie geschrieben).
- **Output-Prüfung entlastet den Broker.** Jeder Output bekommt einen zufälligen
  Prüfzeitpunkt innerhalb des 30-Sekunden-Fensters, statt dass alle gleichzeitig
  ein `/get` senden. Bereits bestätigte Werte werden nur erneut aktiv geprüft, wenn
  der bestätigte Ist-Wert älter als ein Prüffenster ist.
- Die Output-Seite lädt Werte bei MQTT-Bursts nur noch **gebündelt** (max. 1×/s)
  nach – das behebt die hohe Serverlast bei geöffneter Seite.

### Behoben

- **Zählertausch/Topic-Wechsel wird nicht mehr als Zählersprung gewertet.** Beim
  Ändern eines Stromzähler-Topics (z. B. Umstellung auf den Modbus-Adapter) wird der
  gemerkte Rohstand verworfen; der erste Wert des neuen Zählers gilt als Ist-Stand,
  statt die Differenz zum alten Zählerstand als riesigen Tageszuwachs zu buchen.

## [0.10.2] — 2026-07-02

### Hinzugefügt

- **Akku-Lade-/Entladeenergie-Tracking** (`batterie/energy.js`, Tabelle
  `battery_energy_state`, 60-s-Job). Erfasst per Leistungsintegration die
  Netto-Akkuladung nach Tag/Woche/Monat/Jahr + Vorjahr — Grundlage für die
  Bereinigung der Jahres-Prognosebasis (siehe unten).

### Geändert

- Modbus-/State-Editor-Adapter: Das Speichern der Instanz-Einstellungen löscht
  **nicht mehr die angelegten Register** – nicht im Settings-Schema enthaltene
  Werte (v. a. der State-Editor-Speicher) bleiben erhalten. Die States-Seite wurde
  übersichtlicher: angelegte States sind nach **Kategorie gruppiert und
  einklappbar**, Anlegen/Bearbeiten läuft über einen **Dialog**, und die **Presets**
  haben eine eigene Seite (neue Manifest-Option `categoryField`). Beim Laden eines
  Presets sind die Einträge nach **Kategorie gruppiert und eingeklappt**, per
  **Suchfeld** filterbar, standardmäßig **alles abgewählt**, und die Buttons
  „Übernehmen/Abbrechen" stehen oben.
- Wallbox-Steuerung robuster gemacht: Der erste MQTT-Status nach einem Neustart
  wird nur als Ausgangswert übernommen und nicht als manuelle Schaltänderung.
  Auf jeder Wallbox-Karte zeigt ein Umschalter den aktuellen Steuerzustand
  **Automatik / Aus / Vollladen** und erlaubt eine eindeutige manuelle Übersteuerung.
- Im Wallbox-Modus **Privat** ist Laden oberhalb des Mindest-Ladestands nur noch
  freigegeben, wenn die Tagesprognose Überschuss erwartet, den der Hausakku nicht
  mehr aufnehmen kann. Batterientladung wird live gegengerechnet, nahe Mindest-SoC
  bleibt die flexible Ladung aus und ein Soll-Leistungs-Topic drosselt passend.
  **Beruflich** berechnet den spätesten Start aus Restenergie und Ladeleistung für
  06:00 Uhr; **Immer voll** lässt das Ladegerät bei erlaubter Priorität aktiviert.
  Ohne Soll-Leistungs-Topic startet Überschussladen erst, wenn die feste
  Wallboxleistung vollständig gedeckt ist.
  Ein volles Fahrzeug wird bei ausbleibender Ladeleistung nicht mehr als
  hängender Ladestart behandelt; laufende Neustartzyklen enden mit der Vollmeldung.
- Die manuelle Wallbox-Steuerung kehrt definiert zur **Automatik** zurück:
  **Aus** am Folgetag erst bei PV-Leistung über Eigenverbrauch plus Wallboxleistung
  und ausreichender Hausakku-Reserve; **Vollladen** nach zuvor erkannter Ladung beim
  Abfall unter die Leerlaufschwelle oder beim Abziehen. Eigene Automatikbefehle
  werden über einen erwarteten Steuer-Topic-Readback bestätigt und niemals als
  Nutzerwunsch gewertet; das Status-Topic bleibt reiner Ist-Zustand.
  Nach einem Neustart wartet die flexible Ladung auf die erste vollständige Prognose.
- **Jahresbasis des Verbrauchs um die Akkuladung bereinigt.** Der Eigenverbrauch
  (PV + Netzbezug − Einspeisung) enthält physikalisch auch die Ladung des
  Hausakkus. Bislang floss sie ungefiltert in die Jahresbasis der
  Verbrauchsprognose ein und trieb den prognostizierten Tagesbedarf nach oben. Die
  Netto-Akkuladung wird jetzt – analog zur bereits abgezogenen Wallbox-Energie –
  aus der Jahresbasis herausgerechnet. Wirkt vorwärts, sobald Messwerte auflaufen.
- **Wallbox „Privat": Live-Überlauf übersteuert eine zu vorsichtige Prognose.**
  Ist der Hausakku bereits voll und speist die Anlage nachweislich ins Netz ein,
  darf die Tagesprognose das Laden nicht mehr verhindern (bisher blockierte eine zu
  niedrig ausgefallene Wetterprognose die Überschussladung trotz laufender
  Einspeisung). Die Prognose bleibt für den vorausschauenden Start zuständig,
  verliert aber ihr Vetorecht gegen die eingetretene Realität.

### Behoben

- **Prognose-Tagesverbrauch gegen Ausreißer abgesichert.** Konnte der
  Minuten-Sampler ein Intervall nicht als plausibel einstufen (z. B. veralteter
  Zeitstempel nach einem Neustart oder ein Sprung im Quellzähler), wurde der
  komplette Rohsprung ungebremst auf den Tageswert addiert – ein einzelner
  Ausreißer (real bis ~500 kWh statt ~34 kWh) blieb für den ganzen Tag stehen und
  verzerrte als „gelernter" Verbrauch die Prognose der Folgetage. Der Fallback ist
  jetzt auf 50 kWh je Ereignis gedeckelt.
- **Klimatisierungsmodell erzeugt kein Scheinsignal mehr.** Ohne einen einzigen
  nicht-heißen Vergleichstag verglich das Modell heiße Tage nur gegeneinander und
  markierte zwangsläufig einen davon als „signifikant erhöht" – ein vermeintlich
  gelernter Hitzetag mit Klimatisierung, obwohl keine Klimaanlage lief. Residuen
  werden jetzt erst bewertet, wenn ein echter nicht-heißer Referenztag als Baseline
  vorliegt.
- **Grid-Control-Protokoll: kein „nicht bestätigt"-Fehlalarm mehr.** Jede
  Schaltung wurde im selben 2-Sekunden-Tick als „vom Broker nicht bestätigt – wird
  wiederholt" (rot/kritisch) protokolliert, obwohl der Broker den Sollwert
  unmöglich so schnell zurückmelden kann. Der kritische Log-Eintrag erscheint jetzt
  – wie die zugehörige MQTT-Warnung – erst nach tatsächlich anhaltender Divergenz
  (≥ 20 s); der Live-Status auf der Seite bleibt unverändert momentan.

## [0.10.1] — 2026-07-01

### Hinzugefügt

- **Info-Kachel fürs Dashboard.** Der Dialog „Widget hinzufuegen" hat jetzt oben
  **Tabs**: „Wert" (die bisherige Wert-Kachel) und „Info-Kachel". Die Info-Kachel
  listet System-Informationen untereinander auf — homeESS-Version, Node.js,
  Plattform, Hostname, CPU/-Kerne, **CPU- und RAM-Auslastung als Fortschrittsbalken**,
  Prozess-Speicher sowie Betriebs-/System-Laufzeit. Pro Kachel lässt sich per
  Häkchen wählen, welche Felder erscheinen (standardmäßig alle). Die Werte
  aktualisieren sich live.

### Geändert

- **Dashboard aufgeräumt:** Der Infotext „Live-Werte als Kacheln…" und der
  Leerraum darunter entfallen; die Widgets stehen direkt unter der Überschrift.
- **Reaktionszeit der Bus-Konsumenten verkürzt:** Die Entprellung von Output-Engine
  und Prognose-Verhalten liegt jetzt bei **1000 ms** (vorher 1500 ms), damit
  zeitkritische Werte (z. B. Last) im Sekundentakt greifen.
- **README:** Hardware-Empfehlungen und eine Schritt-für-Schritt-Installation ab
  frischem Debian (curl/sudo bereitstellen, dann der Setup-Befehl) ergänzt.

### Behoben

- **Hohe CPU-Last bei geöffnetem Dashboard/States.** Beide Seiten luden bei
  **jedem** MQTT-SSE-Event ungebremst nach (`/dashboard/data` bzw.
  `/states/data.json`). MQTT-Werte kommen in Bursts (viele Topics gleichzeitig),
  und `/dashboard/data` ruft das teure `listInternalValues` auf – die offene Seite
  flutete so den Server (ein Core dauerhaft ausgelastet). Das Nachladen wird jetzt
  pro Burst zu **einem** Aufruf zusammengefasst (max. 1×/Sekunde), analog zum
  bereits entprellten Header.
- **Rückkopplung auf dem internen Broker-Pfad (Vorsorge).** Der Wert-Bus
  feuerte bei jedem `ingest` ein Änderungs-Event – auch wenn der Wert gleich blieb.
  Schreibt ein Konsument auf ein Adapter-Topic, echot der Adapter den Wert zurück
  (`write → Adapter-Echo → ingest → Event → write → …`) und die Schleife läuft mit
  Event-Loop-Geschwindigkeit (poll-unabhängig, CPU voll ausgelastet). Der Bus
  emittiert jetzt **nur bei tatsächlicher Wertänderung**; der Cache (inkl.
  `receivedAt`) wird weiter bei jedem `ingest` aktualisiert, damit die Readback-
  Verifikation frisch bleibt.
- **CPU-Auslastung der Info-Kachel korrekt gemessen:** statt Load-Average /
  Kernzahl (im Container stark überhöht) jetzt die Differenz der CPU-Zeiten aus
  `/proc/stat` – dieselbe Quelle wie Proxmox. Der Wert wird über ein festes
  **1-Sekunden-Fenster** gemittelt (Hintergrund-Sampler), statt als verrauschtes
  Rohdelta zwischen unregelmäßigen Abfragen.
- **Adapter-Werte kamen bei Konsumenten nicht an.** Trug man ein Adapter-Topic
  (`prefix://instanz/adresse`) in ein Konfigurationsfeld ein (z. B. Stromverbrauch
  L1), wurde beim Speichern über `normalizeMqttTopic` das `://` des Schemas zu `:/`
  kollabiert (Regel „doppelte Slashes zusammenfassen"). Damit galt das Topic nicht
  mehr als Adapter-Topic und wurde fälschlich über den MQTT-Broker statt über den
  Adapter-Router geroutet – es kam kein Wert an. `normalizeMqttTopic` ist jetzt
  schema-fest und gibt Schema-Topics kanonisch (mit intaktem `://`) zurück; normale
  Broker-Topics werden wie bisher bereinigt. Betrifft alle Speicherpfade
  (stromverbrauch, batterie, pool, grid-control).
- **Retained-Delivery beim Abonnieren** im Adapter-Router (`adapters/router.js`):
  Ein frisch registrierter Abonnent (`registerRoute`) erhält den zuletzt bekannten
  Wert des kanonischen Topics jetzt sofort aus dem Wert-Bus – wie ein MQTT-Broker
  eine retained message ausliefert –, ohne auf den nächsten Adapter-Tick oder eine
  optionale `read()`-Implementierung zu warten.

## [0.10.0] — 2026-06-30

### Hinzugefügt

- **Modbus-TCP-Adapter** (`adapter/modbus`): verbindet homeESS mit Modbus-TCP-
  Geräten. Pro Instanz wird ein Server konfiguriert (Host/Port/Timeout). Die
  **Unit-/Slave-ID gehört zum Register** (erste Adressebene
  `modbus://instanz/<unitId>/<adresse>`), sodass eine Instanz mehrere Units abfragt;
  die abzufragenden **Register werden als States** angelegt und periodisch
  gelesen, schreibbare Register nehmen Schreibvorgänge an. Dekodierung gemäß
  PRESET.md (Datentypen `bool`/`bit`/`int/uint16/32/64`/`float32/64`/`string`,
  Byte-/Word-Reihenfolge, Skalierung/Offset). Eigener, **abhängigkeitsfreier**
  Modbus-TCP-Client (reiner Node-Socket, FC 01/02/03/04/05/06/16).
- **Adapter-Seite** zeigt je Instanz zusätzlich den **Verbindungsstatus**
  (Aktiv/Inaktiv **und** Verbunden/Getrennt, live aktualisiert über
  `/adapter/status.json`); Adapter melden ihn per `host.setConnected(...)`. Die
  Instanzliste nutzt die **volle Seitenbreite** mit flachen, spaltigen Zeilen
  (Instanz · Adresse · Status · Verbindung · Aktionen) für mehr Übersicht.
- **Generischer, schema-getriebener State-Editor** im Adapter-Framework: Adapter
  können im Manifest einen `stateEditor` (Spalten + `presets`-Flag) deklarieren;
  homeESS rendert daraus eine Verwaltungs-Unterseite (Tabelle + Anlegen/Bearbeiten/
  Löschen). Kein adapterspezifischer Code im Core nötig.
- **Presets** als Vorlagen je Adapter (`<adapter>/presets/*.json`): Laden mit
  Auswahl, welche Einträge als **Live-States** in die Instanz übernommen werden;
  aktuelle States als Preset speichern; Preset vom PC hochladen. Presets sind von
  den Live-States getrennt (reine Vorlagen). Format-Regelwerk: `PRESET.md` im
  Adapterverzeichnis (siehe `adapter/modbus/PRESET.md`).

## [0.9.0] — 2026-06-30

### Hinzugefügt

- **Adapter-Schnittstelle**: homeESS kann nun über austauschbare Adapter mit
  Geräten verbunden werden, ohne den Quellcode zu ändern. Adapter liegen als
  Unterverzeichnisse in `/adapter/` (Manifest `adapter.json` + `index.js` mit
  `createAdapter(host)`), sind portabel und installationsübergreifend kompatibel.
  Das vollständige Regelwerk steht in **ADAPTER.md**; als lauffähige Vorlage dient
  der mitgelieferte **Demo-Adapter** (`/adapter/demo`).
- Neue **Adapter-Seite** (im Menü-Fußbereich über „Module"): gefundene Adapter
  verwalten, mehrere **benannte Instanzen** je Adapter anlegen, einzeln
  aktivieren/deaktivieren, umbenennen, löschen und über eine generische, aus dem
  Manifest erzeugte Einstellungsseite konfigurieren.
- Jede aktive Adapter-Instanz läuft als **eigener Kindprozess** (Isolation,
  automatischer Neustart mit Backoff bei Absturz).
- Der zentrale MQTT-Handler wirkt als **Router**: Topics mit Schema
  `prefix://instanz/adresse` werden an die zuständige Adapter-Instanz geleitet,
  Topics ohne Schema laufen unverändert über den MQTT-Broker (abwärtskompatibel).
- Neue **States-Seite** (im Menü unter „Prognose"): alle von Adaptern gemeldeten
  States als einklappbarer Baum (Instanz → Kategorie → State) mit Live-Werten.
- **State-Picker**: hinter **jedem** Topic-Feld der Anwendung öffnet ein Button
  einen Auswahldialog, der den gewählten Adapter-State (`prefix://instanz/adresse`)
  direkt übernimmt. Global im Layout eingehängt (dekoriert auch dynamisch
  hinzugefügte Felder automatisch).

## [0.8.2] — 2026-06-30

### Geändert

- Der Output **Nächster Wallbox-Ladebeginn in Sekunden** liefert ohne
  prognostizierten Ladebeginn `0` statt keinen Sollwert.

## [0.8.1] — 2026-06-30

### Geändert

- **Gemeinsamer Lade-Vorausplan** für Wallbox-Automatik und Systemprognose: aktiver
  Modus, Priorität, Fahrzeug-SoC, Akkugröße, Mindestladung und Arbeitstage bestimmen
  den konkreten Bedarf. Pflichtladungen werden fest als Last berücksichtigt; flexible
  Wallboxen teilen sich den verbleibenden PV-Überschuss priorisiert und können ihn nicht
  mehr parallel doppelt verplanen. Die gelernte Historie dient als Fallback für noch
  unbekannte zukünftige Ladevorgänge.

## [0.8.0] — 2026-06-30

### Hinzugefügt

- Optionales Modul **Wallbox** (`/wallbox`, aktivierbar unter `/module`) zur Verwaltung
  mehrerer PKW-Wallboxen — einzeln anlegbar wie die PV-Anlagen (`src/wallbox/boxes.js`,
  Tabellen `wallboxes`/`wallbox_counter_state`/`wallbox_summary_state`).
  - Je Box ein Pflicht-**Steuer-Topic** (an/aus) sowie optional **Status** (sonst dient
    das Steuer-Topic als Ist-Stand), **Leistung** (W/kW wählbar), fortlaufender
    **Zähler** (Wh/kWh wählbar), **Soll-Leistung**, **„Fahrzeug angesteckt"** (true/false)
    und **Fahrzeug-SoC** (%); dazu **Maximalleistung** und **Fahrzeug-Akkugröße**.
  - **Verbrauchszählung** je Box für Tag/Woche/Monat/Jahr inkl. Vorjahr mit Jahres-/
    Monatswechsel (`src/wallbox/aggregation.js`). Ohne Zähler-Topic wird der Verbrauch
    aus der Leistung integriert; fehlt das SoC-Topic, wird der Ladezustand aus der seit
    Einstecken geladenen Energie und der Akkugröße geschätzt.
  - **Drei Lademodi mit je eigener Priorität** (`src/wallbox/planner.js`):
    **Privat** lädt bis zum Mindest-Ladestand, darüber nur PV-Überschuss (verfügbarer
    Überschuss = Netzeinspeisung + Batterie-Ladeleistung, solange der Hausakku über dem
    Mindest-SoC liegt); **Beruflich** stellt das Auto an gewählten Wochentagen
    vorausschauend voll bereit (tagsüber Überschuss, abends Garantieladung) und fällt an
    freien Tagen auf die Privatregel zurück; **Immer voll** lädt durchgehend. Mit
    Soll-Leistungs-Topic wird gegen den Überschuss fein moduliert, sonst An/Aus an einer
    Schwelle. Optionaler **Modus-Sync** über ein eigenes Topic (bidirektional).
  - Jede Wallbox ist **Verbraucher am Betriebslevel-Handler** (Priorität des aktiven
    Modus): Einschalten nur nach Freigabe, Zwangsabschaltung bei Levelabfall
    (`src/wallbox/automation.js`, 30-s-Tick). Mindesthaltedauer gegen Flattern.
  - Eigene Wertekatalog-Kategorie **Wallbox** (Leistung, Fahrzeug-SoC, angesteckt,
    Lademodus, Verbrauch Tag/Woche/Monat/Jahr/Vorjahr je Box) für Outputs und Dashboard.
  - **Sonderfall-Behandlung** (`src/wallbox/planner.js` `decideWallboxAction`):
    - *Ladestart-Neustart*: hängt die Ist-Leistung trotz Ladebefehl nach einer je Box
      konfigurierbaren **Vorgabezeit** (`stall_timeout_seconds`, Default 120 s) noch unter
      der **Leerlaufschwelle** (`stall_power_w`, Default 200 W), wird einmal für eine
      Minute aus- und wieder eingeschaltet (gedeckelte Versuche). **Nur bei tatsächlich
      eingestecktem Auto** (`plugged === true`); ohne bestätigtes Anstecken kein Aus/Ein-Takten.
    - *Manuell EIN am Broker* → einmalige Volladung bis die zuvor vorhandene
      Ladeleistung unter die Leerlaufschwelle fällt oder das Fahrzeug abgezogen wird.
    - *Manuell AUS am Broker* → bleibt aus, bis am Folgetag PV-Leistung größer als
      Eigenverbrauch plus Wallbox-Maximalleistung ist und der Hausakku genügend
      Abstand zum Mindest-SoC hat; danach greift wieder der gewählte Plan.
    - *„Angesteckt"-Signal nicht als Sperre*: da es per Mobilfunk vom Fahrzeug kommt und
      veraltet sein kann, wird auch bei scheinbar nicht angestecktem Auto eingeschaltet,
      wenn der Plan laden möchte (ein echtes Fehlen fängt die Stall-Erkennung ab).
  - **Voraussichtlicher nächster Ladebeginn**: wird gerade nicht geladen, wird aus der
    stündlichen PV-/Verbrauchsprognose (Überschuss-Reihe) der nächste Ladebeginn
    geschätzt (`predictNextChargeStart`); berücksichtigt Überschuss-Schwelle, die
    Beruflich-Garantieladung sowie die Sperre nach manuellem Ausschalten. Im Wertekatalog
    je Box als **Restzeit in Sekunden** (`wallbox.<id>.naechsterLadebeginnSekunden`) und
    **Uhrzeit** (`wallbox.<id>.naechsterLadebeginn`); auf der Wallbox-Seite ausgewiesen.
  - **Getrenntes Prognose-Lernen je Wallbox**: Tages- und Stundenhistorien bilden
    erwartete Ladeenergie und typische Ladezeit je Wochentag. Wallboxleistung
    wird aus dem allgemeinen Hausverbrauch entfernt und in der Energieprognose
    je Box separat wieder eingeplant; Werte für heute/morgen stehen im Katalog.
## [0.7.2] — 2026-06-29

### Hinzugefügt

- Zentraler **Betriebslevel-Handler / Lastmanagement** (`src/operating-level/handler.js`):
  beobachtet dauerhaft das globale Betriebslevel. Verbraucher registrieren sich mit
  einer **Priorität** (= Betriebslevel, ab dem sie laufen dürfen, `erlaubt ⇔ Level ≥
  Priorität`) und re-registrieren sich bei Prioritätsänderung. Jedes Einschalten wird
  über `requestTurnOn`/`isAllowed` vom Handler **bestätigt**; sinkt das Level, werden
  nicht mehr erlaubte Verbraucher über ihren `onMustTurnOff`-Callback **sofort**
  abgeschaltet. `operating-state.js` meldet Levelwechsel über `onOperatingLevelChanged`.
- **Filter- und Solarpumpe** der Poolsteuerung als erste Verbraucher an das Lastmanagement
  angebunden (`pool.solar`, `pool.filter`): Registrierung sobald das Kommando-Topic im
  Automatik-Modus gesetzt ist (effektive Priorität inkl. Solarprobelauf der Filterpumpe).
  Automatik-Einschaltungen laufen über ein Level-Gate (kein Flackern); ein Levelabfall
  zwischen zwei Ticks schaltet die Pumpe sofort ab. Der **Hand-Modus (An/Aus) übersteuert
  das Betriebslevel bewusst** und bleibt ungegated.
- Entwickler-Leitfaden [LEVEL_HANDLING.md](LEVEL_HANDLING.md): allgemeingültige
  Schritt-für-Schritt-Anleitung zur Anbindung künftiger Verbraucher (Priorität,
  Modi An/Aus/Automatik, Registrierung, Gate, Sofort-Abschaltung).

## [0.7.1] — 2026-06-29

### Hinzugefügt

- Neue Kernseite **Prognose** direkt unter Batterie: grafische Energiebilanz für
  heute + 3 Tage mit Ampel, PV-/Verbrauchsbalken, erwartetem Netzbedarf,
  Überschuss und Batterie-SoC am Tagesende.
- Selbstlernendes Verbrauchsmodell aus Jahresmittel, exponentiell gewichtetem
  Tagesmittel und persönlichem Stundenprofil. Tagesverlauf, Mindest-SoC sowie
  konfigurierbare Lade-/Entladewirkungsgrade fließen in die Batteriesimulation
  ein. 38 Werte unter `prognose.*` ergänzen Output und Dashboard-Wertekatalog.
- Batteriekapazität von der Prognose- auf die Batterieseite verschoben und auf
  Ah umgestellt. Die Prognose rechnet mit der Nennspannung des Batterietyps in
  kWh um. Der Wertekatalog enthält zusätzlich unter
  `batterie.freieKapazitaet` die noch bis 100 % speicherbare Energie,
  `batterie.nutzbarBisMindestSoc` die bereits nutzbar gespeicherte Energie und
  `batterie.restzeitBisGrenze` die Restzeit bei momentaner Batterieleistung bis
  100 % beziehungsweise bis zum Mindest-SoC.
- Prognoseseite um „Heute autark“ und den Zähler autark beendeter Tage im
  laufenden Jahr ergänzt. Der Zähler kann mit Startwertabfrage bidirektional an
  ein optionales MQTT-Topic gekoppelt werden. Beim Jahreswechsel wird der
  vollständige Stand als „Autarke Tage Vorjahr“ übernommen; dafür steht ein
  zweites optionales Abgleich-Topic mit identischem Verhalten bereit.
- Prognose ermittelt nun den SoC beim ersten ab dem Folgetag sichtbaren
  Ladebeginn (`PV > Verbrauch` bei freier Akkukapazität) inklusive Tag und
  Uhrzeit. Bei Dunkelflaute wird über weitere Open-Meteo-Tage kumuliert; ein
  heutiger Ladebeginn beendet das Fenster nicht. Das erste erwartete Erreichen
  des Mindest-SoC wird ebenfalls mit Tag und Uhrzeit ausgewiesen. Diese Größen
  bestimmen vorrangig die Ampel und stehen im Wertekatalog.
- Verbrauchslernen auf sieben getrennte Wochentagskurven erweitert. Vor dem
  Sampling wird Batterieenergie signiert aus dem abgeleiteten Gesamtverbrauch
  entfernt (Laden abziehen, Entladen hinzurechnen), damit Akkuladung nicht mehr
  als Hausverbrauch in die Prognose eingeht. Beim Upgrade wird das bisherige,
  nicht rückwirkend korrigierbare Lernfenster einmalig sauber neu begonnen.
- Zwei aktivierbare Prognose-Verhaltensmodelle ergänzt: Netzparallelbetrieb
  arbeitet mit Netzreserve, Autarkbetrieb reagiert anhand der Mehrtagesprognose
  deutlich früher und kann dabei auch Level 1 einplanen. Die Prognose verwaltet
  exklusiv Level 1–5; Grid-Control schaltet nur noch den Notstromzustand. Level 1
  greift unter Mindest-SoC auch ohne aktives Modell. Level 5 setzt im
  Autarkbetrieb SoC > 98 % plus Überschuss voraus; im Netzparallelbetrieb gilt
  die obere Grid-Control-Schwelle beziehungsweise ohne das Modul 90 % als voll.
  Auswahl und Aktivierung befinden sich oben rechts auf der Prognoseseite.
- Prognose-Wertekatalog um die bisherigen externen Kennzahlen ergänzt:
  dynamischer Tagesdurchschnitt, 24-h-Hochrechnung der letzten Stunde,
  profilbasierter Verbrauch bis Sonnenaufgang, Gesamtbedarf inklusive
  Akkufüllung sowie verfügbare, fehlende und freie Energie. „Bedarf gedeckt“
  bewertet nun den Zeitraum bis zum nächsten prognostizierten Ladebeginn.
- Batterie-Wertekatalog um die Zustände Charge, Charged today, Discharging,
  Empty, Full, Good, HalfCharged, High, Overflow und Reserve sowie deren
  dynamische SoC-Schwellen ergänzt. „Charged today“ bleibt nach SoC > 98 % bis
  zum lokalen Tageswechsel gesetzt.
- Wertekatalog um `operating.notstrom` („Notstrombetrieb“) in der Kategorie
  **Betrieb** ergänzt. Der Ja/Nein-Wert spiegelt den Notstromzustand
  (`emergencyMode`) und steht damit für Outputs und Dashboard-Widgets bereit.

- Optionales Modul **Grid-Control** mit broker-konformer MQTT-Steuerung für
  Netz und Überschusseinspeisung. SoC und Spannung besitzen jeweils getrennte
  untere/obere Schaltfenster mit lokaler, begrenzter Hysterese; dazwischen ist
  der jeweilige Grid-Ausgang aus. Temperaturwarnungen, Warnungs-Publishing und
  die Katalogwerte „Grid by SoC“, „Grid by Voltage“, „Grid by Temperature“ und
  „Grid actual“ sind enthalten.
- Batterie-Konfiguration um Mindest-SoC-Topic, 5-%-Regler, Batterietyp,
  Zellanzahl sowie manuelle Spannungsgrenzen erweitert.
- Grid-Control um Netzfrequenz-Topic und konfigurierbare Erkennungszeit
  erweitert. Bleibt die Frequenz nach einer Netzanforderung bei 0, werden
  Warnung und persistenter Notstromzustand gesetzt; das Netz bleibt bis zur
  Rückkehr einer Frequenz dauerhaft angefordert. Globales Betriebslevel 1–5
  inklusive Balkenanzeige in der Titelzeile ergänzt. Alle Batterie- und
  Grid-Control-Topicfelder zeigen den aktuellen Brokerwert.
- Netzfrequenz und Wechselrichterlast auf **L1/L2/L3** erweitert: Eine
  ausgefallene Phase aktiviert Notstrom, verlassen wird er erst bei drei
  wiederhergestellten Phasen. Lastüberschreitung einer Phase setzt den neuen
  Katalogwert **Grid by Load**; Rückschaltung erfolgt erst unter allen drei
  phasenweisen Ausschaltschwellen. Die Statuskachel heißt jetzt „Warnung“.
- Persistenter globaler Katalogwert **Autark** (`operating.autark`): täglicher
  Reset auf `true`, sofern Grid-Control nicht wegen Mindest-SoC schaltet;
  eine Mindest-SoC-Netzschaltung verriegelt ihn bis zum nächsten Tag auf `false`.
- **Grid-Control-Protokoll** (`grid-control/log.js`, Tabelle `grid_control_log`,
  begrenzt auf 2000 Einträge): scrollbares Audit-Log unten auf der Seite.
  Protokolliert werden ausschließlich **Schwellen-Übertritte mit Aktionen**
  (gelb) und **kritische Zustände** (rot) — je **einzeilig** mit Zeitstempel und
  dem zugehörigen Werte-Schnappschuss. Paginiert (100/Seite, `/grid-control/log`),
  **Seite 1 live**, ab Seite 2 statisch.
- **Geschlossene Regelschleife** in Grid-Control: Schaltbefehle werden gegen die
  tatsächliche Broker-Rückmeldung verifiziert und bei Abweichung (verlorener
  Write, externe Änderung, Reconnect) selbstheilend wiederholt; bleibt die
  Bestätigung aus, wird gewarnt. Bestätigungs-Badges („bestätigt“/„nicht
  bestätigt!“) und eine Verbindungsanzeige je Befehls-Topic.
- PV-Anlagen: Button **„Kalibrierung löschen“** im Bearbeiten-Dialog (mit
  Sicherheitsabfrage) inkl. Route `POST /photovoltaik/plants/:id/clear-calibration`.
- **MQTT-Draht-Diagnose** über Umgebungsvariable `HOMEESS_MQTT_DEBUG=1`
  (protokolliert alle ein-/ausgehenden Nachrichten mit Topic, Wert und `ack`).

### Geändert

- Allgemeine Output-Engine auf eine geschlossene, verifizierte Regelschleife
  umgestellt: aktiver Broker-Readback alle 30 Sekunden, erneutes Schreiben bei
  fehlender oder abweichender Bestätigung, Retry-Begrenzung und sichtbarer Status
  je Output. Nicht rücklesbare Command-Topics werden nicht mehr als sichere
  Output-Ziele akzeptiert.
- Betriebslevel-Horizonte getrennt: Netzparallel bewertet nur bis zum nächsten
  Ladebeginn und setzt Level 1 ausschließlich bei tatsächlich unterschrittenem
  Mindest-SoC. Autarkbetrieb bleibt mehrtägig und darf Level 1 vorbeugend setzen,
  um Netzbezug möglichst vollständig zu vermeiden.
- Verhaltensmodell setzt den globalen Betriebslevel nun über eine eigenständige
  Regelung bei MQTT-Änderungen und spätestens alle 30 Sekunden; es hängt nicht
  mehr vom erfolgreichen Verbrauchssampling ab. Die unverbindliche
  Empfehlungszeile wurde entfernt und die Aktivierungsansicht zeigt sofort den
  tatsächlich gespeicherten Level.

- **PV-Selbstkalibrierung** wirkt jetzt in **beide Richtungen** (`FACTOR_MAX`
  1,15 → 1,5; `RATIO_MAX` 1,3 → 1,5). Nicht kalibrierte Randzeiten (morgens/abends)
  **erben rückwärts** den Faktor des letzten kalibrierten Buckets statt auf 1,0
  zurückzuspringen. Das Kalibrier-Gate nutzt nun den **anlagenspezifischen
  Sonnenreferenz-Cutoff** (morgens/abends) statt eines globalen 20-%-Werts, sodass
  z. B. eine Westanlage nur nachmittags und eine Ostanlage nur vormittags
  kalibriert wird.
- **MQTT-Schreiben** sendet Befehle an alle konkreten Topic-Kandidaten (Punkt-
  und Slash-Form), um Notations-Unsicherheiten der `topic2id`-Rückbildung
  abzudecken. Hinweis: Auf ein Wildcard kann nicht publiziert werden — das
  Slash-Wildcard hilft nur beim **Lesen**.
- Werte optionaler Module (Pool, Grid-Control) erscheinen im **Wertekatalog**
  und in den **MQTT-Abos** nur noch, wenn das jeweilige Modul aktiviert ist.
- **Wertekatalog** als zentrale, wiederverwendbare Routine
  (`views/value-catalog.js`) neu aufgebaut: statt eines langen Dropdowns eine
  kompakte, durchsuchbare Liste mit nach **Herkunft** geordneten, einklappbaren
  Kategorien (Photovoltaik, Stromverbrauch, Batterie, Prognose, Netzsteuerung,
  Pool, Betrieb) samt aktuellem Ist-Wert je Zeile. Die Auswahl landet in einem
  versteckten Feld, sodass sich das Bauteil unverändert in Formulare einfügt. Es
  ist jetzt direkt im **Output-Dialog** (unter dem Ziel-Topic) und im
  **Dashboard-Dialog „Widget hinzufügen“** (unter der Gruppenauswahl) eingebettet.
- **Output-Seite** zeigt angelegte Outputs ebenfalls als dichte, nach Kategorien
  gruppierte und einklappbare Liste. Feste Spaltenbreiten sorgen dafür, dass eine
  Statusänderung rechts den Ist-Wert nicht mehr verschiebt.
- Katalog- und Output-Liste verwenden schmale, tabellenartige Zeilen in einem
  Viewport mit Eigen-Scroll (sticky Kategorie-Köpfe), damit das Ein- und
  Ausklappen das übrige Layout nicht mehr verschiebt.

### Behoben

- Prognose-Verbrauchslernen gegen verspätete Resets externer Tageszähler
  abgesichert: Ein neuer lokaler Lerntag startet immer bei 0 kWh; der erste
  kumulierte Wert dient nur als Differenz-Basis. Dadurch kann der Vortagesstand
  nach Mitternacht nicht mehr als heutiger Verbrauch übernommen werden.

- Stromverbrauchs-Tageswechsel nutzt jetzt MQTT-Datum beziehungsweise die
  konfigurierte lokale Zeitzone statt der UTC-Serverzeit; damit erfolgt der
  Wechsel inklusive Sommerzeit um lokale 00:00 Uhr.

- Grid-Control schaltet das Netz an der **oberen SoC-Grenze** nur noch, wenn
  **Überschusseinspeisung aktiviert** ist (vorher unbedingt).
- **Readback-Verfälschung behoben:** eigene `ack:false`-Schreib-Echos auf dem
  Haupt-Topic werden nicht mehr als Broker-Stand gecacht — nur `ack:true` bzw.
  Rohwerte gelten als bestätigter Ist-Zustand. Behebt die falsche
  „bestätigt“-Anzeige, obwohl der Broker einen anderen Wert hielt.
- **Notstromerkennung:** überalterte Netzfrequenzen (nach Verbindungsabbruch)
  entriegeln den Notstrom nicht mehr — Frische-Prüfung der Cache-Werte.
- **Startup-Race behoben:** optionale Module werden vor dem Laden der
  State-Definitionen initialisiert, damit `isEnabled()` beim Start korrekt greift.

## [0.7.0] — 2026-06-28

### Hinzugefügt

- **PV-Prognose** (`photovoltaik/forecast.js`, `wetter/client.js`):
  Prognosestreifen unter den KPI-Kacheln mit erwartetem Tagesertrag (kWh) für
  **Heute + 3 Tage**. Quelle ist die stündliche Strahlungsprognose
  (GHI/DNI/DHI + Temperatur + Bewölkung) von **Open-Meteo** — kostenlos, kein
  API-Key, 30-min-In-Memory-Cache mit Stale-on-Error, Startup-Prime und
  30-min-Refresh in `app.js`. Standortbezug über die tatsächlich genutzten
  Open-Meteo-Gitterkoordinaten als Label im Streifen.
  - Die Prognose nutzt **dieselbe** Geometrie + Transposition + Skalierung wie der
    Live-Idealwert (gemeinsame Helfer `solarGeometryAt`, `transposePlaneIrradiance`,
    `idealPowerFromIrradiance` aus `aggregation.js`) — nur mit prognostizierter statt
    modellierter Clear-Sky-Strahlung. Read-only; clientseitig über
    `/photovoltaik/forecast` im 15-min-Takt aktualisiert.
  - **Heute-Karte aufgeteilt**: großer Tagesgesamtwert (Vorsatz „gesamt") plus
    **„bis jetzt"** (laut Prognose bis zum aktuellen Moment erwarteter Ertrag) und
    **„noch erwartet"** (Rest des Tages). Aufteilung anhand der lokalen Uhrzeit,
    laufende Stunde anteilig; Open-Meteo-Strahlung als Mittel der vorangehenden
    Stunde berücksichtigt.

- **Selbstkalibrierung** (`photovoltaik/calibration.js`, je Anlage per Checkbox
  **„Automatische Kalibrierung"**): ein **pro Tageszeit-Bucket (15 min, 0..95)**
  hinterlegter Kalibrierfaktor (`pv_calibration_buckets`, Default 1,0). Je
  abgeschlossenem 15-min-Fenster wird der **gemessene Leistungs-Durchschnitt** der
  vergangenen 15 Minuten gegen die von **Open-Meteo gelieferte Strahlung desselben
  Fensters** (`minutely_15`, in erwartete Leistung umgerechnet) verglichen und der
  Bucket sanft per EMA (α≈0,05) auf `gemessen/erwartet` nachgezogen. Da die
  Wetter-Strahlung die tatsächliche Bewölkung bereits enthält, isoliert das
  Verhältnis anlagenspezifische, tageszeit-abhängige Effekte (v. a.
  **Verschattung**) — ein Klarhimmel-Gate ist dafür nicht mehr nötig.
  - Gates: **hoher Sonnenstand** (erwartete Leistung ≥ 20 % Peak), **kein voller
    Akku** (`batterie.soc` < 95 %, Abregelungsschutz), Verhältnis plausibel (0,4–1,3).
  - **Startwert-Übernahme**: ein neuer Bucket übernimmt den Faktor des vorangehenden
    Buckets als Startwert (statt 1,0); der frisch berechnete Faktor wird zudem auf den
    neuen (aktuellen) Bucket übernommen — es sei denn, dort liegt bereits ein Wert
    (z. B. aus dem Vorjahr).
  - Der wirksame Faktor multipliziert den Idealwert (`idealEffektiv = idealBasis ×
    factor`), sobald der Bucket einen Wert besitzt — wirkt auf Live-Ideal,
    Sonnenintensität **und** Prognose. Der aktuelle Faktor wird zur Diagnose in der
    Anlagenzeile angezeigt. Mess-Akkumulation und Fensterauswertung im 60-s-Job
    (`app.js`).
  - **Bucket-Reset**: Wird eine Anlage **gelöscht** oder ihre **Ausrichtung bzw.
    Gesamtleistung** geändert, werden ihre Buckets verworfen (passen nicht mehr zur
    Geometrie/Skalierung) und neu gelernt.

- **Wert-Katalog** (`output/internal-values.js`) um **Prognosewerte** erweitert
  (für Outputs und Dashboard-Widgets):
  - Erwarteter Tagesertrag **heute / morgen / in 2 Tagen / in 3 Tagen**.
  - **Heute bisher** (`pv.forecast.today.elapsed`) und **heute noch erwartet**
    (`pv.forecast.today.remaining`).
  - Die Kalibrierfaktoren sind bewusst **nicht** im Katalog (reine Diagnose).

### Geändert

- **Sonnenreferenz-Cutoff jetzt größenrelativ** statt absoluter 50-W-Schwelle
  (`photovoltaik/aggregation.js`, `sun-intensity.js`, `plants.js`): Eine Anlage zählt
  nur noch dann als Sonnenreferenz (für Sonnenintensität **und** ☀️/☁️-Erkennung),
  wenn ihr Klarhimmel-Idealwert mindestens einen konfigurierbaren **Anteil ihrer
  kWp-Spitzenleistung** erreicht — die Sonne also brauchbar auf ihre Modulebene
  scheint. Behebt, dass eine **große, off-axis stehende Anlage** (z. B. Südanlage
  morgens bei Sonne im Osten) trotz Bewölkung aus Diffuslicht weit mehr als ihren
  winzigen Idealwert lieferte und so das Ist/Ideal-Verhältnis verfälschte
  (scheinbare Sonne trotz Wolken). Der absolute 50-W-Boden entfällt; der relative
  Cutoff skaliert automatisch für kleine **und** große Anlagen. Neue Helfer
  `sunCutoffWatt` / `isSunReference`; off-axis-Anlagen fallen aus Zähler **und**
  Nenner der Sonnenintensität.
  - **Pro Anlage konfigurierbar**, getrennt für **morgens / abends** (vor bzw. nach
    Sonnenhöchststand, `decimalHours < 12`), neue Spalten `sun_cutoff_morning` /
    `sun_cutoff_evening` in `pv_plants` (Default **10 %**, Migration vorhanden), zwei
    neue Formularfelder im PV-Anlagen-Dialog.

- **PV-Aggregation refaktoriert** (`photovoltaik/aggregation.js`): Clear-Sky-Geometrie
  und Plane-of-Array-Transposition in wiederverwendbare Helfer ausgelagert
  (`solarGeometryAt`, `transposePlaneIrradiance`, `idealPowerFromIrradiance`), die
  Live-Pfad **und** Prognose teilen — verhaltensneutral (numerisch identisch zum
  bisherigen Live-Ergebnis).

### Geändert

- **Poolsteuerung — Probelauf sonnenabhängig** (`pool/automation.js`): Der
  Probebetrieb der Solarpumpe startet jetzt nur noch bei direkter
  Sonneneinstrahlung. Der Sonnenzustand (`hasSun`) wird einmalig pro Tick
  ermittelt und in beiden Pfaden (Temp-Modus + normaler Betrieb) genutzt:
  - Eine bereits **laufende Probe** wird bei einsetzender Beschattung zu Ende
    geführt (volle konfigurierte Einschaltdauer) — erst danach schaltet die
    Pumpe ab.
  - Der **Pausenzähler** (`tempCycleStart`) wird nur zurückgesetzt, wenn eine
    Probe regulär abgeschlossen wurde. Bei Beschattung ohne laufende Probe läuft
    er still weiter. Kehrt die Sonne zurück und ist die Pausenzeit abgelaufen,
    startet sofort eine neue Probe.

### Behoben

- **Fresh-DB-Crash** `pool_config has no column named solar_pump_status_topic`:
  `CREATE TABLE pool_config` deklariert jetzt alle Spalten vollständig (mit Defaults),
  statt sie nur per Migration nachzurüsten — beseitigt das Seed/Migration-Race auf
  einer frischen Datenbank. Migration bleibt als No-op-Upgrade für Bestands-DBs.

### Datenmodell

- `pv_plants` um **`auto_calibrate`** erweitert (Migration; Default 0).
- Neue Tabelle **`pv_calibration_buckets`** (`plant_id`, `bucket 0..95`, `factor`,
  `sample_count`, `updated_at`, `window_minutes`; FK → `pv_plants` ON DELETE CASCADE).
  Bei der Umstellung von 10- auf 15-min-Buckets werden Bestandsdaten einmalig
  verworfen (Migration `migratePvCalibrationBuckets`, Marker-Spalte `window_minutes`).

---

## [0.6.0] — 2026-06-27

### Hinzugefügt

- **Batterie-Seite** (`/batterie`) vollständig implementiert:
  - MQTT-Topics für SoC, Leistung, Spannung, Temperatur konfigurierbar.
  - KPI-Kacheln nur wenn jeweiliges Topic konfiguriert.
  - SoC-Balken mit Farbwechsel (grün ≥ 50 %, dunkelgelb 20–49 %, rot < 20 %).
  - Leistungsanzeige mit Richtungsindikator (Laden · X W / Entladen · X W / Bereit).
  - Live-Updates via SSE-Event `homeess:mqtt` + 30-s-Fallback-Poll.
  - `src/batterie/config.js`: load/save, `buildBatterieStateDefinitions`,
    `readBatterieData`. Battery-Topics gehen in die State-Definitionen ein
    (Standard-Subscription, kein Ad-hoc-System).
  - `batterie_config`-Tabelle in SQLite.

- **Batterie-Ladeanzeige in der Titelzeile**: Icon in Batterieform rechts im
  Header, erscheint automatisch sobald ein SoC-Wert im Cache vorliegt.
  Füllstand, Farbwechsel und Prozentzahl werden über `/live/header` + SSE
  live aktualisiert. Feste Zeichenbreite verhindert Layout-Shift bei
  Stellenänderung.

- **Optionale Module** (`src/modules/index.js`): generische Registry + In-Memory-
  Enabled-State; neue Seite `/module` zum Aktivieren/Deaktivieren.
  Aktivierte Module erscheinen automatisch in der Sidebar-Navigation.

- **Poolsteuerung** (`/pool`, optionales Modul):
  - **Zwei Pumpen**: Solarpumpe + Filterpumpe, je mit Status- und
    Steuerungs-Topic, Priorität 1–5 (Solar: Standard 2, Filter: Standard 4).
  - KPI-Kacheln nur wenn Topic konfiguriert (Wassertemperatur, Pumpen, pH, Chlor).
  - **Drei Modus-Buttons pro Pumpe** (An / Aus / Automatik), aktiver Button
    farblich hervorgehoben; Modus bleibt bis zur nächsten Änderung, Automatik
    nach Server-Neustart.
  - **Solarsteuerung**: sonnenbasiert (Himmelszustand), 2-Minuten-Mindesthaltedauer,
    optionale Maximaltemperatur mit konfigurierbarer Probezyklus-Einschaltdauer
    (s) und Pause (min).
  - **Filtersteuerung**: bis zu 3 Zeitfenster, Follow-Solar-Option,
    Akku-Override (zusätzliches Einschalten ab konfigurierbarem SoC-Schwellwert —
    liest `batterie.soc` aus dem zentralen Cache, kein eigenes Topic).
  - **„Für Probelauf die Filterpumpe verwenden"**: Checkbox nur aktiv wenn
    Filter-Status- und Steuerungs-Topic konfiguriert; bei aktiviertem Haken
    übernimmt die Filterpumpe die Probeläufe, Solarpumpe wird beim Eintritt in
    den Temp-Modus sofort abgeschaltet und beim Austritt die Filterpumpe.
  - **MQTT Ad-hoc-Subscriptions** für Pool-Topics (außerhalb der normalen
    State-Definitionen, mit vollem `mqttReadCandidates`/`mqttSubscribeCandidates`-
    und `/get`-Mechanismus gemäß MQTT.md).
  - **Prioritätshandler** `getEffectivePriority(which, cfg)` in
    `src/pool/automation.js`: gibt während eines Filter-Probelaufs die
    Solarpumpen-Priorität für die Filterpumpe zurück — Vorarbeit für das
    spätere Last-Management.
  - Neue DB-Tabellen: `modules`, `pool_config`.

- **Wert-Katalog** (`output/internal-values.js`) erweitert:
  - Batterie-Werte: SoC (%), Leistung (W), Spannung (V), Temperatur (°C) —
    je nach konfigurierten Topics.
  - Pool-Werte: Wassertemperatur, Solarumpen-Status, Filterpumpen-Status,
    pH-Wert, Chlor — nur wenn Pool-Modul aktiv und Topic konfiguriert.
  - Alle neuen Werte stehen Outputs und Dashboard-Widgets zur Verfügung.

### Geändert

- **Batterie-Seite** von Stub auf vollständige Implementierung mit Config-Formular
  und Live-Daten aktualisiert.
- **Pool-Akku-Override**: kein eigenes SoC-Topic mehr — liest den Wert über
  `batterie.soc` aus dem zentralen MQTT-Cache. Checkbox ausgegraut wenn kein
  Batterie-SoC-Topic konfiguriert ist.
- **`/live/header`** gibt jetzt zusätzlich `batterySoc` zurück.
- **`loadAllStateDefinitions`** integriert Batterie-State-Definitionen.
- **Batterie-Farben** vereinheitlicht: dunkelgelb `#d4a500` für 20–49 %
  (statt Orange) — identisch in Header-Icon und Batterie-Seite.

---

## [0.5.0] — 2026-06-27

### Hinzugefügt
- **Einstellungen — Standort & Zeit**: Felder **Längengrad** und **Zeitzone**
  (Auswahlliste) sowie Checkbox **„automatische Zeitumstellung"** (Sommer-/
  Winterzeit). Dienen ausschließlich der Präzisierung des Clear-Sky-Modells und
  haben keinen Einfluss auf übermittelte Uhrzeit/Datum.
- **Einstellungen — Karten-Layout**: Seite in Karten gegliedert (Passwort,
  Standort & Zeit, MQTT-Verbindung, MQTT-Topics, Aktionen/Protokoll).
- **PV-Anlagen — Konverter/Regler** (`photovoltaik/converters.js`): Auswahl des
  Gerätetyps (MPPT-/PWM-Solarladeregler, String-/Hybrid-/Mikro-/Zentral-/
  Insel­wechselrichter, DC-Direktmessung, Sonstiges) mit hinterlegten
  **typischen, temperaturabhängigen Geräte-Wirkungsgraden**. Geht zusätzlich
  zum Anlagen-Wirkungsgrad in den Idealwert ein.
- **Zelltypische Vorgabe-Wirkungsgrade**: Bei Auswahl des Zelltyps wird ein
  typischer Wert ins Wirkungsgrad-Feld vorbelegt (nur Startwert, frei
  feinkalibrierbar — **keine direkte** Modellnutzung).

### Geändert
- **Clear-Sky-Modell — wahre Ortssonnenzeit** (`photovoltaik/aggregation.js`):
  Die per MQTT empfangene lokale Wanduhrzeit wird in die echte Sonnenzeit am
  Standort umgerechnet — über **Längengrad-Versatz zum Zeitzonen-Bezugsmeridian**,
  **UTC-Versatz der Zeitzone inkl. Sommerzeit** und **Zeitgleichung**. Vorher
  wurde die Wanduhrzeit direkt als Sonnenzeit verwendet (Sonnenhöchststand stur
  bei 12:00, in Mitteleuropa im Sommer > 1 h daneben). Greift nur, wenn
  Längengrad und Zeitzone gesetzt sind; sonst unverändertes Altverhalten.
- **PV-Idealleistung** berücksichtigt zusätzlich den **Konverter-Wirkungsgrad**
  (temperaturabhängig, Geräte auf Außentemperaturniveau, Referenz 25 °C):
  `kWp × Einstrahlung/1000 × Wirkungsgrad × Zell-Temperaturfaktor × Konverter-Wirkungsgrad`.
- `mqtt_config` um **`longitude`, `timezone`, `dst_enabled`** erweitert (Migration).
- `pv_plants` um **`converter_type`** erweitert (Migration; Default `Direkt`).

## [0.4.0] — 2026-06-26

### Hinzugefügt
- **Output-Seite** (`/output`): beliebige berechnete Werte an Ziel-Topics des Brokers
  zurückgeben. Publish-Engine (`output/engine.js`) wertet den Wert-Katalog debounced
  bei MQTT-Änderungen + alle 60 s aus und schreibt je Output nur bei Wertänderung.
  Kompakte, alphabetisch sortierte Zeilenliste.
- **MQTT-Publish** (`client.publish`) gemäß MQTT.md: normale States `/set` (Rohwert)
  **und** Haupt-Topic (`{val, ack:false}`), Command-Topics (`_SET`/`.SET`/`/SET`)
  nur Rohwert.
- **Wert-Katalog** (`output/internal-values.js`): nur **berechnete** Werte
  (Leistungen, Erträge, Eigenverbrauch/Netzbezug/Summen, Zählersummen, direkte
  Sonne, Sonnenintensität, Schatten-Grenzleistung) — keine Roh-Inputs; alphabetisch.
- **Clear-Sky-Idealwert** je PV-Anlage (aktuelle Leistung groß, Idealwert klein).
- **Direkte-Sonne-Erkennung** je Anlage (☀️/☁️, zelltyp-spezifische Schwelle)
  und **Himmelssymbol in der Titelzeile** (☀️/☁️/🌙 nach Sonnenstand, via
  `/live/header`).
- **Sonnenintensität** in % (gedeckelt): aktuell + 10-Minuten-/Tages-/Vortagsmittel
  (`photovoltaik/sun-intensity.js`, Tabelle `sun_intensity_samples`). Das
  10-Minuten-Mittel läuft über alle Samples; Tages-/Vortagsmittel nur über
  Samples mit mindestens einer Anlage oberhalb des Idealwert-Cutoffs.
- **PV-Leistung Schatten**: Grenzleistung Schatten→direkte Sonne (Summe + je Anlage).
- **Dashboard-Widgets**: frei konfigurierbare Live-Kacheln aus dem Wert-Katalog,
  hinzufügen/bearbeiten/löschen, Live-Update.
- **Dashboard-Gruppen** mit Titel und **Breite (voll/halb/viertel)**; nicht-volle
  Gruppen liegen nebeneinander. **Drag & Drop** für Widgets und Gruppen
  (flicker-frei: Einfügemarke beim Ziehen, Verschiebung beim Loslassen).
- **SSE-Live-Layer** (`/live/events`, `/live/header`).
- Tabellen: `outputs`, `dashboard_groups`, `dashboard_widgets`,
  `sun_intensity_samples`, `stromverbrauch_counter_state`.

### Geändert
- **PV-Idealleistung**: Formel auf
  `kWp × Einstrahlung/1000 × Wirkungsgrad × Temperaturfaktor` umgestellt — der
  hinterlegte **Wirkungsgrad wirkt jetzt als Kalibrierfaktor** (vorher kürzte er
  sich heraus). Temperaturkorrektur zelltyp-spezifisch, bezogen auf 20 °C
  Außentemperatur.
- **Sonnenintensität** wird nur über Anlagen gebildet, die Ist- **und** Idealwert
  liefern (fehlende MQTT-Werte verfälschen den Mittelwert nicht mehr).
- `sun_intensity_samples` markiert Samples mit `day_average_eligible`, damit
  Tages-/Vortagsmittel Dämmerungszeiten unterhalb des Idealwert-Cutoffs
  auslassen, während das 10-Minuten-Mittel weiterhin 24 Stunden berechnet wird.
- **Read-only Wert-Provider** (`readPhotovoltaikValues`, `readStromverbrauchValues`)
  eingeführt, damit häufige Auswertung keine DB-Writes/Races auslöst.
- `mqtt_config` um Standort/Umgebungs-Topics erweitert (Breitengrad, Außentemp.,
  Uhrzeit, Datum) für Clear-Sky und Header.

## [0.3.0] — 2026-06-26

### Geändert
- **Stromverbrauch** speichert jetzt MQTT-Topics fuer **Eigenverbrauch L1-L3**,
  **Netzbezug L1-L3** und **Verbrauch heute** direkt auf der Seite.
- **Diese Woche** und **Dieses Jahr** werden automatisch aus dem Tageswert
  fortgeschrieben; beide KPI-Karten haben einen **"Wert setzen"**-Dialog fuer
  den Abgleich zum Tagesstart.
- **Stromverbrauch** fuehrt jetzt statt `Dieser Monat` den Wert `Dieses Jahr`
  mit kleinem `Vorjahr` darunter; am Jahreswechsel wird der Endstand als
  Vorjahr uebernommen und der Jahreszaehler auf `0` gesetzt.
- **Photovoltaik** verwaltet jetzt mehrere Anlagen mit Name, kWp, Wirkungsgrad,
  Ausrichtung, Neigung, Zelltyp, MQTT-Topics und Kennzeichen fuer die
  Verbraucherseite; verbraucherseitige PV-Leistung wird in den Eigenverbrauch
  auf der Strom-Seite eingerechnet.
- **PV-Ertrag Woche/Jahr** wird jetzt global oben gefuehrt statt pro Anlage
  vervielfacht. `Ertrag Gesamt` wurde in `Ertrag Jahr` umbenannt; am
  Jahreswechsel wird der Endstand als `Vorjahr` gespeichert und die Zaehlung
  startet wieder bei `0`.

### Hinzugefügt
- **Seite Stromverbrauch** (`/stromverbrauch`): KPI-Kacheln für Aktuell, Heute,
  Diese Woche, Dieses Jahr. Bereit für MQTT-Datenanbindung.
- **Seite Photovoltaik** (`/photovoltaik`): KPI-Kacheln für aktuelle Leistung,
  Ertrag heute/Woche/Gesamt.
- **Seite Batterie** (`/batterie`): KPI-Kacheln für SoC, Leistung, Spannung,
  Temperatur sowie animierter SoC-Fortschrittsbalken.
- Alle drei Seiten in der **Sidebar-Navigation** (NAV-Registry in `layout.js`).
- **CSS-Klassen** für KPI-Kacheln (`.kpi-card`, `.kpi-row`, farbige Varianten
  `--pv` und `--bat`), Info-Karte (`.info-card`) und SoC-Balken (`.soc-bar-*`).
- **systemd-Service** `home-ess.service` unter
  `/etc/systemd/system/home-ess.service` — enabled, startet automatisch beim
  Systemboot, Restart bei Fehler.

## [0.2.0] — 2026-06-26

### Geändert (Umstrukturierung)
- **Monolithisches `server.js` (294 Z.) in modulare Struktur unter `src/`
  aufgeteilt.** Eine Datei pro Funktion; Trennung in `auth/`, `mqtt/`,
  `routes/`, `views/` plus Infrastruktur (`config.js`, `db.js`, `app.js`).
  `server.js` ist nur noch schlanker Einstiegspunkt.
- Alle Seiten werden weiterhin **dynamisch** gerendert; Rendering in eigene
  View-Module (`src/views/`) ausgelagert, gemeinsame App-Hülle mit
  Navigations-Registry (`layout.js`).

### Hinzugefügt
- **„Passwort merken"**-Checkbox im Login. Aktiviert → persistentes 30-Tage-
  Cookie, sonst Session-Cookie.
- **Echte Sessions** (`src/auth/session.js`): DB-gestützt (Tabelle `sessions`),
  überleben Neustarts, mehrere Clients möglich. Ersetzt das frühere
  prozessweite `isLoggedIn`-Flag.
- **Passwort-Hashing** via Node `crypto.scrypt` (`src/auth/password.js`).
  Automatische Migration bestehender Klartext-Passwörter beim Start.
- **MQTT-Schicht** (`src/mqtt/`): Topic-Helfer aus [MQTT.md](MQTT.md) als reine
  Funktionen (`topics.js`), Config-Persistenz (`config.js`), Verbindungs-Manager
  mit Reconnect-Handling, Wert-Cache und Verbindungstest (`client.js`).
- **HTML-Escaping** für dynamische Werte (`src/views/components.js`).
- Env-Overrides `PORT` und `HOME_ESS_DB`.
- Projektdokumente: `README.md`, `PROJECT_CONTEXT.md`, `CHANGELOG.md`.
- `npm start` / `npm run dev` Scripts.

### Entfernt
- Tote Platzhalter `src/server.js`, `src/mqttClient.js`, `config/settings.json`.
- Ungenutzte statische `public/index.html` (Login wird dynamisch gerendert).

### Sicherheit
- Passwörter nicht mehr im Klartext in der DB.
- Session-Cookies `HttpOnly` + `SameSite=Lax`.

## [0.1.0] — vor Umstrukturierung (Commit `13a40e4`)
- Erste lauffähige Basis: monolithischer Express-Server mit Login
  (prozessweites Flag, Klartext-Passwort), leerem Dashboard und
  Einstellungsseite (Passwort, MQTT-Config + Test).
