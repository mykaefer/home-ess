# Changelog

Alle nennenswerten Änderungen an homeESS. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

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
