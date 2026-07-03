# Changelog

Alle nennenswerten Änderungen an homeESS. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

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
- Prognose-Wertekatalog um die bisherigen ioBroker-Kennzahlen ergänzt:
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

- Optionales Modul **Grid-Control** mit ioBroker-konformer MQTT-Steuerung für
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
  umgestellt: aktiver ioBroker-Readback alle 30 Sekunden, erneutes Schreiben bei
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
  „bestätigt“-Anzeige, obwohl ioBroker einen anderen Wert hielt.
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
- **Output-Seite** (`/output`): beliebige berechnete Werte an ioBroker-Ziel-Topics
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
