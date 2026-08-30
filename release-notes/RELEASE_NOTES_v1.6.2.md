# homeESS v1.6.2 – Aufgeräumtes Menü, Energie-Übersicht, Schleifen und bedienbare States

**v1.6.2** räumt das Hauptmenü auf: aus elf Punkten werden sieben. Die neue Seite
**Energie** bündelt die Eckdaten von Photovoltaik, Stromverbrauch, Batterie und
Prognose und ist zugleich der Einstieg in diese Seiten, die jetzt als
Unterpunkte darunter hängen. Zweite große Neuerung: Der **Dann-** und
**Sonst-Zweig** der Bedingungen ist eine vollwertige **Aktionsfolge** mit Pausen
und Schleifen — inklusive zyklischer Plausibilitätsprüfung, und auf Wunsch als
eigenständige Automation ganz ohne Trigger.

Dazu kommt die **Handbedienung**: Klimaanlagen in *Heizung & Klima* lassen sich
je Raum auf **An / Aus / Automatik** stellen — über einen Umschalter in der
Raumübersicht oder über die neuen Klima-States —, und auf der **States-Seite**
ist jeder beschreibbare State unmittelbar bedienbar, ohne Umweg über eine
Bedingung oder das Dashboard.

## Hinzugefügt

### Neue Seite „Energie"

**Energie** steht an zweiter Stelle des Hauptmenüs, direkt hinter dem Dashboard.
Sie zeigt je Fachbereich eine Karte, deren Titel und Schaltfläche „Zur Seite" auf
die zugehörige Detailseite springen:

- **Photovoltaik** — aktuelle Leistung, Ertrag heute, diese Woche und dieses
  Jahr mit Vorjahresvergleich.
- **Stromverbrauch** — Eigenverbrauch und Netzbezug, jeweils aktuell, heute,
  diese Woche und dieses Jahr.
- **Batterie** — Ladezustand mit Mindest-SoC, Leistung, nutzbare Energie und
  Kapazität, Spannung und Temperatur, dazu der SoC-Balken.
- **Grid-Control** — die fünf Schaltzustände, sofern das Modul aktiv ist.
- **Prognose** — die Ampelbewertung als Chip (*Gut versorgt · Knapp kalkuliert ·
  Mindeststand in Sicht*), PV- und Verbrauchsrest des Tages, Netzbedarf sowie
  SoC am Tagesende mit Autarkie-Angabe.

Die Werte aktualisieren sich wie auf den Fachseiten über `/energie/data` — bei
jedem MQTT-Ereignis und zusätzlich im Minutentakt. Die Übersicht **liest
ausschließlich**: sie schreibt keine Summen fort und stößt keinen Netzabruf an
(die Prognose kommt wie auf der Prognoseseite nur aus dem Cache). Abschnitte,
deren Seite für den angemeldeten Benutzer nicht freigeschaltet ist, entfallen.

### Schleifen und Pausen in den Bedingungen

Der **Dann-** und der **Sonst-Zweig** sind jetzt vollwertige Aktionsfolgen mit
denselben Bausteinen wie die Aktionsfolgen von *Heizung & Klima* und *Heimkino*:

- **Wert zuweisen** wie bisher — fester Wert oder Topic-Verweis, Rechenfunktion,
  Rundung.
- **Pause** in Sekunden.
- **Schleife** mit einstellbarer Zahl an Durchläufen, beliebig verschachtelbar
  und für jede Aktionsart offen.

Jede Schleife kann **zyklisch prüfen**, ob der gewünschte Zustand tatsächlich
erreicht wurde. Trifft die Prüfung im eingestellten Abstand nicht zu, wird
**ausschließlich diese Schleife** noch einmal abgespult — nicht der übrige
Zweig. Das ist die Plausibilitätsprüfung für Fälle wie „der Rollladen meldet
wirklich 100 %". Bei einer getriggerten Bedingung wird dabei nur der Zweig
geprüft, der zuletzt gelaufen ist; sonst würden Dann und Sonst einander
dauerhaft überschreiben.

Weil eine Folge **von oben nach unten** läuft, zählt jetzt die Reihenfolge:
Aktionen tragen eine Dragfläche und lassen sich frei verschieben — auch in eine
Schleife hinein und wieder heraus. Trigger und Wenns bleiben wie bisher
unsortiert, ihre Reihenfolge hat für die Auswertung keine Bedeutung.

Solange eine Folge läuft (Pausen, Schleifen), löst dieselbe Bedingung nicht
erneut aus; der laufende Durchgang wird zu Ende geführt.

### Schleife als eigenständige Automation

Neben „Bedingung hinzufügen" steht jetzt **„Schleife hinzufügen"** — je
Verzeichnis über die Schaltfläche `+S`. Eine so angelegte Automation hat **weder
Trigger noch Wenn noch Sonst**, sondern nur die Schleife. Ihre zyklische Prüfung
ist dort **Pflicht** und zugleich die Ausführungsbedingung: solange die Prüfung
nicht zutrifft, läuft die Schleife im eingestellten Abstand erneut. Anders als
bei einer getriggerten Bedingung beginnt diese Prüfung schon **ab dem Start von
homeESS** — sie wartet auf keinen vorherigen Lauf. In der Liste trägt eine solche
Automation das Kennzeichen **„Zyklisch"**.

Die tragende Prüfung lässt sich nicht abschalten und die Schleife nicht löschen,
solange sie die einzige Auslösequelle ist. Kommt ein Trigger dazu, wird daraus
wieder eine gewöhnliche Bedingung; umgekehrt darf der letzte Trigger entfernt
werden, sobald eine sich selbst auslösende Schleife vorhanden ist.

### Klimaanlagen von Hand übersteuern

Ist in einem Raum von *Heizung & Klima* eine **Klimaanlage zum Kühlen**
eingerichtet (eine „Kühlen ein"-Aktionsfolge), lässt sich ihr Zustand jetzt von
Hand vorgeben:

- In der **Raumübersicht** trägt jeder solche Raum einen Umschalter
  **An / Aus / Automatik** — dieselben Schaltflächen wie die Pumpenmodi der
  Poolsteuerung, mit der aktuellen Betriebsart markiert. Er schaltet ohne
  Seitenneuaufbau und gilt als **Bedienen**, steht also auch der Rolle
  *bedienen* offen.
- Unter *System* gibt es die neue Wertegruppe **Klima** mit einem Unterordner je
  Raum und darin zwei States: die beschreibbare **Betriebsart**
  (`system://homeess/klima.<Raum>.betriebsart`, `0` = Aus, `1` = An,
  `2` = Automatik; auch „aus"/„an"/„auto" werden angenommen) und den nur
  lesenden Wert **Aktiv** (`…klima.<Raum>.aktiv`), der meldet, ob die Anlage
  gerade läuft. Beide sind überall verwendbar: Bedingungen, Dashboard,
  Wertekatalog.

**An** und **Aus** setzen die automatischen Aktionsschleifen des Kühlgerätes
aus: die Anlage reagiert dann weder auf einen offenen Fenster-/Türkontakt noch
auf die Raumtemperatur, sondern bleibt in ihrem geschalteten Zustand stehen.

Zurück in die **Automatik** geht sie auf zwei Wegen:

- Sobald der Raum die eingestellte **Soll-Temperatur erreicht**. Gemeint ist der
  Übergang dorthin — war der Sollwert beim Umschalten bereits erreicht, hebt das
  die Handschaltung nicht sofort wieder auf.
- Zur optionalen **Rückkehr-Uhrzeit** des Raums (Raumseite, Abschnitt
  *Klimaanlage*; leer = keine). Maßgeblich ist die erste Fälligkeit **nach** dem
  Umschalten: wer um 23:00 Uhr auf „An" stellt, dessen Rückkehr um 22:00 Uhr
  kommt am folgenden Tag. Der Zeitpunkt der Handschaltung liegt in der
  Datenbank — ein Neustart holt eine verpasste Rückkehr nach, statt sie zu
  verlieren.

Vorrang behält das **Betriebslevel**: Deckt das aktuelle Level die Priorität des
Kühlgerätes nicht ab, bleibt die Anlage auch bei „An" aus und läuft wieder an,
sobald das Level sie freigibt. Heizen, Wärmeanforderung an die Zentralheizung
und der Heizkörperlüfter bleiben von der Übersteuerung unberührt; die
eingestellte Betriebsart überlebt einen Neustart.

### Beschreibbare States direkt auf der States-Seite bedienen

Jede Zeile eines beschreibbaren States bekommt in der Übersicht ihr passendes
Bedienelement:

- **Ein/Aus** für Schaltzustände — der geschriebene Wert richtet sich nach der
  Darstellung des Ziel-States (`true`/`false` gegenüber `1`/`0`).
- eine **Auswahl** für Werte mit fester Bedeutung, etwa die Betriebsart einer
  Klimaanlage (Aus/An/Automatik).
- ein **Feld mit „Setzen"** für Zahlen und Texte; Zahlenfelder übernehmen
  Grenzen und Schrittweite der Quelle, die Eingabetaste setzt ebenfalls.

Welches Element erscheint, meldet die Quelle mit: Module liefern es zu ihren
Schreibzielen (Soll-Temperatur, Schornsteinfeger-Modus, Klima-Betriebsart),
Custom States leiten es aus ihrem Datentyp ab, und für Adapter-States — die nur
melden, *dass* sie beschreibbar sind — wird es aus dem zuletzt gesehenen Wert
abgeleitet. Geschrieben wird über denselben Weg wie aus einer Aktionsfolge
(Systemwert-Schreibziele, Custom States, Adapter oder Broker); angenommen werden
ausschließlich States, die ihre Quelle als beschreibbar meldet. Das Setzen zählt
als **Bedienen** — Leser bekommen die Bedienelemente gar nicht erst
ausgeliefert. Die Elemente ziehen mit den Live-Werten nach; eine begonnene
Eingabe bleibt dabei unangetastet.

### Eigene Beschriftung für Wert-Widgets

Im Widget-Dialog des Dashboards steht unter dem State das optionale Feld
**Bezeichnung**. Bleibt es leer, trägt die Kachel wie bisher den Namen des
States; ist es gefüllt, zeigt sie diesen Text und nennt im Tooltip zusätzlich
den State, aus dem der Wert stammt. Gespeichert wird die Beschriftung wie beim
Schalter-Widget in der Widget-Konfiguration — Bestands-Widgets bleiben
unverändert.

### Breiterer Topic-Picker

Der systemweit genutzte Topic-Picker öffnet **bis zur doppelten Breite**
(920 statt fester 460 px), sofern der Bildschirm den Platz hergibt; auf schmalen
Geräten bleibt es wie bisher bei der verfügbaren Breite. Lange State-Namen und
ihre Werte stehen dadurch nebeneinander, ohne abgeschnitten zu werden.

## Geändert

### Hauptmenü von elf auf sieben Punkte

```
Dashboard
Energie             → Stromverbrauch · Photovoltaik · Batterie · Prognose
                      (Grid-Control, wenn das Modul aktiv ist)
Messen + Schalten   → Energiefluss · Schaltgruppen
Bedingungen
Adapter
States              → Custom States · Output
Wetter
```

- *Stromverbrauch*, *Photovoltaik*, *Batterie* und *Prognose* sind Unterpunkte
  von **Energie**. Bei aktivem Modul steht **Grid-Control** ebenfalls dort — vor
  der Prognose, weil es zum Ist-Zustand gehört und die Prognose den Ausblick
  abschließt.
- **Output** ist eine Unterseite von **States** geworden: es schreibt berechnete
  Werte an Ziel-States zurück und gehört damit in denselben Bereich.
- **Bedingungen** steht zwischen *Messen + Schalten* und *Adapter* — die Seite
  wertet die dort gepflegten Geräte aus und rückt damit vor die technischen
  Seiten.
- **„Wetterprognose" heißt jetzt „Wetter"** — im Menü, in der Seitenliste der
  Benutzerrechte sowie als Überschrift und Browser-Titel der Seite.
- **Mobile Tab-Leiste:** *Energie* ersetzt den Direktzugriff auf *Batterie*
  (Dashboard · Energie · Strom · PV · Prognose). Die Batterieseite bleibt über
  Energie und das Menü-Sheet erreichbar; die Tab-Leiste ist bewusst ein
  Direktzugriff und bildet die Menühierarchie nicht nach.

### Weitere Änderungen

- **Der Topic-Picker klappt in die Richtung mit mehr Platz auf.** Liegt das
  Topic-Feld in der unteren Hälfte des Viewports — ist es also näher am unteren
  als am oberen Rand —, öffnet die Auswahl nach oben, sonst nach unten. Bisher
  klappte sie erst dann nach oben, wenn unterhalb weniger als 240 px übrig
  waren; die nutzbare Höhe richtet sich jetzt ebenfalls nach der größeren Seite.
- **Der Sonst-Zweig darf mehrere Aktionen enthalten.** Bisher war er auf genau
  ein Element begrenzt; als Aktionsfolge nimmt er nun — wie das Dann — beliebig
  viele Aktionen auf. Die Bindung an eine aktive Wenn-Prüfung bleibt bestehen.
- **Seitenrechte:** „Energie" ist eine eigene Seite im Rechtemodell und wird je
  Benutzer freigeschaltet. Ist sie gesperrt, rücken die freigeschalteten
  Unterseiten wie bisher als eigene Hauptpunkte ins Menü — es geht also nichts
  verloren. Die Seitenliste folgt jetzt derselben Reihenfolge wie das Menü.
- **Output-Seite:** Die irreführende Beschreibung über das Rücklesen im
  30-Sekunden-Takt ist aus dem Seitenkopf entfernt.
- **Keine Fremdsoftware mehr namentlich genannt:** Wo bisher ein bestimmtes
  Broker-Produkt beim Namen genannt wurde, ist jetzt durchgängig allgemein vom
  **MQTT-Broker** die Rede — in der Oberfläche, in den Adapterbeschreibungen, in
  den Quelltextkommentaren und in der gesamten Dokumentation.
- **Weniger doppelter Code:** Die Aktionsarten *Wert · Pause · Schleife* sind
  nur noch an einer Stelle definiert (`src/conditions/repository.js`); die
  Aktionsfolgen der Module beziehen Validierung, Grenzen und Beschreibungstexte
  von dort. Ebenso liegt der Ampeltext der Prognose jetzt in
  `src/prognosis/status.js` und wird von Prognoseseite und Energie-Übersicht
  gemeinsam genutzt.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.6.2**. Adapterstände unverändert:
  hDP **1.2.12**, Zigbee **1.3.4**, InfluxDB **1.0.3**, hm-rpc **1.1.5**,
  Modbus **1.1.2**, MQTT-Broker **1.0.2**, Tasmota **1.0.2**, Renault **1.0.0**,
  Shelly **1.0.0**.
- **Datenbankänderung:** Die Elementtabelle der Bedingungen bekommt die Spalte
  `parent_id` für die Verschachtelung der Schleifen. Die Migration läuft beim
  ersten Start von selbst; bestehende Trigger, Wenns und Danns bleiben
  unverändert auf der obersten Ebene. Ein manueller Eingriff ist nicht nötig.
- **Zweite Datenbankänderung:** Die Raumtabelle von *Heizung & Klima* bekommt
  die Spalten `climate_mode`, `climate_mode_since` und `climate_reset_time` für
  die Handbedienung der Klimaanlage. Auch diese Migration läuft beim ersten
  Start von selbst; bestehende Räume starten in der **Automatik** und ohne
  Rückkehr-Uhrzeit, verhalten sich also genau wie zuvor.
- **Benutzer mit eingeschränkter Seitenauswahl** sehen die neue Seite „Energie"
  erst, wenn sie in der Benutzerverwaltung freigeschaltet wird. Bis dahin
  bleiben ihre bisherigen Seiten unverändert erreichbar — sie erscheinen als
  eigene Hauptpunkte im Menü.
- Bestehende Bedingungen laufen unverändert weiter: Ohne Pausen und Schleifen
  verhält sich eine Folge genau wie zuvor.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten,
  damit die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
