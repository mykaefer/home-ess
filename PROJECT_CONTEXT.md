# PROJECT_CONTEXT — homeESS

> **Zweck dieser Datei:** Einstieg für neue Agent-Sitzungen ohne erneute
> Vollanalyse. Hält Architektur, Konventionen und offene Punkte fest.
> Bei strukturellen Änderungen mitpflegen. Siehe auch [README.md](README.md)
> (Bedienung) und [CHANGELOG.md](CHANGELOG.md) (Verlauf).

## Was ist homeESS?

Basis für ein **Energy Storage System (ESS)**. Der Server abonniert
MQTT-Topics (Quelle: ioBroker-Broker), hält die eingehenden Werte in einem
Cache und soll daraus ableiten, **wie Lasten geschaltet werden** (Regel-Engine,
deren Betriebslevel prognosegeführt werden; ein zentraler **Betriebslevel-Handler**
(`operating-level/handler.js`) setzt registrierte Verbraucher nach Priorität durch —
erste Verbraucher sind Filter- und Solarpumpe der Poolsteuerung). Bedienoberfläche
ist ein Web-Dashboard mit vorgeschaltetem Login.

**Aktueller Funktionsstand:**
- Login (Passwort) mit **„Passwort merken"**-Checkbox.
- **Dashboard** mit frei konfigurierbaren **Widgets** und **Gruppen** (Titel +
  Breite voll/halb/viertel). Zwei Widget-Typen (Add-Dialog mit Tabs, Spalte
  `dashboard_widgets.type`): **`value`** (Live-Kachel eines Werts aus dem
  Wert-Katalog `output/internal-values.js`) und **`info`** (System-Infos aus
  `dashboard/system-info.js` — Versionen, CPU/RAM als Fortschrittsbalken u. a.;
  gewählte Felder als JSON in `dashboard_widgets.config`, Default = alle). Widgets
  und Gruppen per **Drag & Drop** anordbar, Widgets in Gruppen verschiebbar,
  Widgets/Gruppen bearbeit- und löschbar. Live-Refresh über `GET /dashboard/data`
  (Werte + `system`-Block).
- **Stromverbrauch**: MQTT-Topic-Felder für Eigenverbrauch L1–L3, Netzbezug
  L1–L3 und Zählerstände; oben Eigenverbrauch/Netzbezug als Phasensummen,
  Woche/Jahr aus Tageswert plus Tagesstart-Abgleich über den Dialog
  **„Wert abgleichen"** (Woche/Jahr/Vorjahr sowie Minimum/Maximum je Kennzahl mit
  Datum); Jahreswechsel → Vorjahr. Ein **Zähler-Topic-Wechsel verwirft den
  gemerkten Rohstand** (`resetCountersForChangedTopics`), damit der erste Wert eines
  neuen/getauschten Zählers als Ist-Stand gilt und kein Sprung gezählt wird.
- **Photovoltaik**: verwaltet mehrere PV-Anlagen (Stammdaten, Zelltyp,
  **Konverter-/Reglertyp**, MQTT-Topics). Je Anlage **aktuelle Leistung groß,
  Clear-Sky-Idealwert klein**.
  Ideal = `kWp × Einstrahlung/1000 × Wirkungsgrad × Zell-Temperaturfaktor ×
  Konverter-Wirkungsgrad`; der **Wirkungsgrad wirkt als Kalibrierfaktor**, die
  Zell-Temperaturkorrektur ist zelltyp-spezifisch bezogen auf 20 °C, der
  **Konverter-Wirkungsgrad** (MPPT-Regler, Wechselrichter, …) ist typ- und
  temperaturabhängig (Geräte auf Außentemperaturniveau, Referenz 25 °C,
  `converters.js`). Der **Sonnenstand** nutzt die echte Ortssonnenzeit: die per
  MQTT gelieferte Wanduhrzeit wird über **Längengrad, Zeitzonen-UTC-Versatz
  (inkl. Sommerzeit) und Zeitgleichung** umgerechnet (`aggregation.js`,
  `buildSolarContext`); ohne Längengrad/Zeitzone gilt die unkorrigierte Ortszeit.
  **Direkte-Sonne-Erkennung** je Anlage über `Ist/Ideal ≥ zelltyp-Schwelle`
  (☀️/☁️) und globales **Himmelssymbol in der Titelzeile** (☀️/☁️/🌙 je
  Sonnenstand, via `/live/header`). Bewertet wird nur, solange die Anlage als
  **Sonnenreferenz** taugt (siehe Sonnenintensität). Ertrag heute/Woche/Jahr inkl.
  Vorjahr.
  **PV-Prognose** (`photovoltaik/forecast.js`): Prognosestreifen unter den
  KPI-Kacheln mit erwartetem Tagesertrag (kWh) für Heute + 3 Tage. Quelle ist die
  stündliche Strahlungsprognose von **Open-Meteo** (`wetter/client.js`, kostenlos,
  kein API-Key, 30-min-In-Memory-Cache, Startup-Prime + 30-min-Refresh in
  `app.js`). Die Prognose nutzt **dieselbe** Transposition + Skalierung wie der
  Live-Idealwert (gemeinsame Helfer `solarGeometryAt`, `transposePlaneIrradiance`,
  `idealPowerFromIrradiance` in `aggregation.js`) — nur mit prognostizierter statt
  modellierter Clear-Sky-Strahlung, daher konsistent mit dem Live-Modell. Read-only;
  clientseitig über `/photovoltaik/forecast` aktualisiert (15-min-Takt). Die
  **Heute-Karte** zeigt zusätzlich den **bis jetzt** erwarteten und den **noch
  erwarteten** Ertrag (Aufteilung des Tagesgesamtwerts an der lokalen Uhrzeit,
  laufende Stunde anteilig).
  **Selbstkalibrierung** (`photovoltaik/calibration.js`, je Anlage per Checkbox
  `auto_calibrate`): ein **pro Tageszeit-Bucket (15 min, 0..95)** hinterlegter
  Kalibrierfaktor (`pv_calibration_buckets`). Je abgeschlossenem 15-min-Fenster wird
  der **gemessene Leistungs-Durchschnitt** der letzten 15 Minuten gegen die von
  **Open-Meteo gelieferte Strahlung desselben Fensters** (`minutely_15`, in
  erwartete Leistung umgerechnet) verglichen und der Bucket sanft per EMA (α≈0,05)
  auf `gemessen/erwartet` nachgezogen (Faktor wirkt in **beide Richtungen**,
  geklammert 0,2–1,5). Weil die Wetter-Strahlung die Bewölkung bereits enthält,
  fällt das frühere Klarhimmel-Gate weg; verbleibende Gates: kein voller Akku
  (`batterie.soc`, Abregelung), Verhältnis plausibel (0,4–1,5) und ein
  **anlagenspezifischer Sonnenstand-Cutoff** — kalibriert wird nur, wenn die
  erwartete Leistung den morgens/abends konfigurierten Sonnenreferenz-Cutoff
  (`sun_cutoff_morning/_evening`, Default 10 % der kWp-Spitze) überschreitet. So
  kalibriert eine Westanlage nur nachmittags, eine Ostanlage nur vormittags. Der
  Messdurchschnitt wird über die 60-s-Ticks im Speicher akkumuliert. Ein **neuer
  Bucket** übernimmt den Faktor des vorangehenden Buckets als Startwert (statt 1,0);
  der frisch berechnete Faktor wird zudem auf den neuen (aktuellen) Bucket
  übernommen, sofern dort noch kein Wert (z. B. aus dem Vorjahr) liegt. Hat ein
  Bucket keinen eigenen Wert (Randzeiten außerhalb des Kalibrierfensters), liefert
  `effectiveFactor` den Faktor des **rückwärts nächstgelegenen** kalibrierten
  Buckets — die Mittagskalibrierung trägt so sanft in Morgen-/Abendstunden, ohne
  Sprung auf 1,0. Sobald ein Faktor wirkt, multipliziert er den Idealwert
  (`idealEffektiv = idealBasis × factor`) — auf Live-Ideal, Sonnenintensität **und**
  Prognose, bildet u. a. Verschattung ab. Der aktuelle Faktor wird zur Diagnose in
  der Anlagenzeile angezeigt; **„Kalibrierung löschen“** (Bearbeiten-Dialog, mit
  Sicherheitsabfrage) verwirft alle Buckets einer Anlage. Tick im 60-s-Job
  (`app.js`). **Bucket-Reset** beim Löschen einer Anlage sowie bei Änderung von
  Ausrichtung oder Gesamtleistung (`plants.js`).
- **Sonnenintensität** (`photovoltaik/sun-intensity.js`): Ist/Ideal in %,
  gedeckelt auf 100 %, nur über Anlagen gebildet, die aktuell als **Sonnenreferenz**
  taugen — d. h. ihr Klarhimmel-Idealwert erreicht mindestens den anlagenweise
  konfigurierten **größenrelativen Cutoff** (`isSunReference`/`sunCutoffWatt` in
  `aggregation.js`: `idealBasis ≥ kWp × 1000 × Cutoff%`, Cutoff getrennt für
  morgens/abends, Default 10 %). So fließen off-axis-Anlagen (z. B. die große
  Südanlage morgens) nicht ein und ziehen das Verhältnis nicht künstlich hoch.
  Momentanwert plus 10-Minuten-/Tages-/Vortagsmittel aus periodischen Samples
  (`sun_intensity_samples`, Sampling im 60-s-Intervall in `app.js`).
- **Batterie** (`/batterie`): voll implementiert. MQTT-Topics für SoC (%),
  Leistung (W, positiv = laden), Spannung (V), Temperatur (°C) konfigurierbar;
  KPI-Kacheln nur wenn Topic gesetzt; SoC-Balken farbcodiert (grün/dunkelgelb/rot).
  Live-Updates via SSE. State-Definitionen integriert (kein Ad-hoc-System).
  **Titelzeile:** Batterie-Ladeanzeige als Icon mit Füllstand + Prozentzahl,
  erscheint automatisch sobald `batterie.soc`-Wert im Cache vorhanden ist.
  Zusätzlich: Mindest-SoC-Ziel-Topic mit 5-%-Regler und Batterieparameter
  (Typ, Zellzahl, Kapazität in Ah, untere/obere Gesamtspannung). Die Prognose
  leitet daraus über die zelltypspezifische Nennspannung die Energie in kWh ab.
  Der Wertekatalog stellt außerdem die abgeleiteten Batteriezustände Charge,
  Charged today, Discharging, Empty, Full, Good, HalfCharged, High, Overflow und
  Reserve bereit. Schwellen beziehen sich auf den dynamischen Mindest-SoC:
  Reserve endet bei 30 %, Good beginnt bei 25 % und HalfCharged bei 50 % des
  nutzbaren Bereichs bis 100 %; High gilt über 90 %, Full über 98 %. Charged
  today wird persistent bis zum lokalen Tageswechsel gehalten.
- **Messen + Schalten** (`/messen-schalten`, Kernseite, Menü unter Batterie):
  Dashboard-artige Seite mit frei anlegbaren **Gruppen** und **Geräte-Kacheln**
  (Aktoren), per Drag & Drop zwischen Gruppen bzw. ohne Gruppe anordbar (gemeinsame
  Widget-Klassen/Logik wie das Dashboard). Je Gerät bis zu vier MQTT-Topics:
  **Schalten, Status, Leistung, Zähler** — mindestens Schalten, Leistung oder Zähler
  ist Pflicht (`messen-schalten/actors.js`, Validierung). Ohne Status-Topic gilt das
  Schalt-Topic (sonst die Leistung) als Ist-Stand. Ist nur ein Zähler gesetzt, wird
  die **Leistung aus dem Zählerfortschritt** abgeleitet (`Δkwh/Δt`,
  `messen-schalten/aggregation.js`, 60-s-Job `messSchaltAggregation`) und fällt nach
  über 10 min ohne Fortschritt auf 0 W. Zwei **Betriebsarten** je Gerät mit
  Schalt-Topic (Checkbox `always_on`):
  - **„Immer an"**: `messen-schalten/automation.js` registriert das Gerät am zentralen
    Betriebslevel-Handler mit seiner **effektiven Priorität** (eigene oder – per
    Checkbox – die der zugeordneten Gruppe; siehe [LEVEL_HANDLING.md](LEVEL_HANDLING.md))
    und schaltet es **automatisch EIN, sobald das Level die Priorität erreicht** – und
    hält es an (auch bei externem Ausschalten wieder ein). Unter der Priorität wird es
    (auch extern eingeschaltet, `readActualOn`) **abgeschaltet**. Der Kachel-Toggle ist
    hier **ausgeblendet**.
  - **Manuell** (ohne „Immer an"): Unterhalb der effektiven Priorität greift ebenfalls
    Zwangs-Aus und manuelles Einschalten wird abgewiesen. Nach erneuter Freigabe bleibt
    das Gerät aus, bis es über den Kachel-Toggle wieder eingeschaltet wird.
  Die Steuerschleife reagiert zusätzlich zum 30-s-Tick **entprellt auf MQTT-Änderungen**
  der `messschalt:`-Topics (`onValuesChanged`/`isRelevantEvent`), sodass Geräte bei
  externem Schalten prompt nachgeregelt werden. Je Kachel wird die
  **Betriebsart** angezeigt: „Immer an · Priorität N", „manuell" oder „nur Messen";
  Gruppen zeigen ihre Priorität in der Titelzeile. Die Werte der gesetzten Topics stehen im
  Wertekatalog in Kategorie **Geräte** (`geraet.<id>.schalten/status/leistung/zaehler`),
  die Leistungssummen der Gruppen in Kategorie **Verbrauchssummen**
  (`verbrauchssumme.<id>.leistung`); jede Gruppe zeigt ihre Summe zusätzlich in der
  Titelzeile. Live-Refresh über `GET /messen-schalten/data`. Gruppen **und** Geräte
  besitzen zusätzlich ein Dropdown **Funktion** (Licht, Waschen, Warmwasser,
  Heizung / Klima, Kochen; Geräte ohne eigene Funktion erben die der Gruppe,
  `messen-schalten/functions.js`). Je zugeordneter Funktion entstehen zwei
  Wertekatalog-Einträge in Kategorie **Funktionen** (`funktion.<key>.leistung`,
  `funktion.<key>.verbrauchHeute`); die minütlich integrierten Stundenenergien
  (`mess_schalt_function_hourly`) liefern der Prognose Stundenprofile je Funktion
  und werden aus dem gelernten Haus-Grundverbrauch herausgerechnet.
- **Systemprognose** (`/prognose`, `prognosis/forecast.js`): simuliert heute +
  drei Folgetage stündlich aus PV-Wetterprognose, Verbrauch und Batterie. Die
  nutzbare Batterie endet am Mindest-SoC; Lade- und Entladewirkungsgrad werden
  getrennt gerechnet. Ungelernte Wochentage übernehmen **ausschließlich die
  Lernkurve des jüngsten abgeschlossenen Tages (Vortag)** als Vorlage — Kurvenform
  und Tagesziel (`previousDayKey`/`previousDayKwh`, `selectUnlearnedDailyTarget`);
  danach folgen gleitender Mittelwert und Jahresmittel, eine Hochrechnung des
  laufenden Tages greift nur noch im echten Kaltstart ab 30 % Tagesanteil (die
  frühere `heute/Tagesanteil`-Erstwahl explodierte morgens bei ungelernter
  Profilform). Diese Basis enthält weder Wallbox, Netto-Akkuladung, Pool noch die
  funktionszugeordneten Messen-+-Schalten-Lasten. Das BDEW-Standardprofil dient
  nur noch als Kaltstart ohne einen einzigen abgeschlossenen Tag; der heutige
  Verlauf kalibriert die Restprognose begrenzt nach. 60-s-Sampling persistiert
  Tagesstände in `prognosis_daily_consumption` und Zählerdifferenzen stündlich in
  `prognosis_hourly_consumption`. Je Prognosetag zeigt die Seite ein
  24-h-Stundenprofil-Balkendiagramm (Soll = Tagesziel × Wochentagskurve); bereits
  gelernte Stunden von heute erscheinen als Ist-Balken in abweichender Farbe mit
  Soll-Marke je Stunde (`model.todayByHour`). Die Ergebnisse sind als `prognose.*` im
  Wertekatalog verfügbar. Zusätzlich zeigt die Seite den persistenten
  `operating.autark`-Tagesstatus. Beim lokalen Tageswechsel wird ein
  Jahreszähler nur dann erhöht, wenn der Tag weiterhin autark endete; ein
  optionales MQTT-Topic synchronisiert diesen Zähler bidirektional und bietet
  beim Einrichten die Übernahme des externen Startwerts an. Beim Jahreswechsel
  wird nach Wertung des 31. Dezember der vollständige Stand samt Jahreskennung
  in „Autarke Tage Vorjahr“ verschoben und der aktuelle Stand zurückgesetzt.
  Der Vorjahresstand hat ein separates optionales MQTT-Abgleich-Topic nach
  demselben Muster.
  Beim Beginn eines neuen lokalen Lerntags wird der erste kumulierte
  Verbrauchswert nur als Delta-Basis gespeichert; `consumption_kwh` startet bei
  0. Damit kann ein extern erst nach Mitternacht zurückspringender Tageszähler
  den Vortageswert nicht in den neuen Lerntag übertragen.
  Die Batteriesimulation sucht ab dem Folgetag den ersten Zeitslot mit
  `PV > Verbrauch` und freier Akkukapazität. Bleibt der Folgetag ohne Ladebeginn,
  wird über alle weiteren sichtbaren Open-Meteo-Tage kumuliert. Heutiger
  Überschuss fließt in den Akkustand ein, beendet das Nachtfenster aber nicht.
  SoC, Tagesoffset und Uhrzeit dieses Ladebeginns sowie das erste erwartete
  Erreichen des Mindest-SoC stehen im Wertekatalog. Die Ampel bewertet primär
  Netzbedarf beziehungsweise Mindest-SoC bis zum Ladebeginn; Tagesend-SoC ist
  nachgeordnet.
  Der Katalog bildet außerdem die früheren ioBroker-Prognosegrößen ab:
  dynamischer Tagesdurchschnitt, 24-h-Hochrechnung aus der letzten Stunde,
  Verbrauch bis zum nächsten Sonnenaufgang aus Stundenprofil beziehungsweise
  letzter Stunde, Gesamtbedarf inklusive Akkufüllung, verfügbare, fehlende und
  freie Energie. Der Sonnenaufgang folgt der Standortgeometrie; ohne Koordinaten
  dient 06:00 Uhr als definierter Ersatz.
  Verbrauchssampling speichert neben dem physischen Eigenverbrauch aus
  **Netzbezug + PV-Ertrag** den um Batterieenergie, Wallbox und Pool bereinigten
  Hausverbrauch: `DeltaVerbrauch − BatterieLeistung × Zeit`, wobei
  positive Batterieleistung Laden und negative Entladen bedeutet. Lässt sich ein
  Intervall nicht als plausibel einstufen (z. B. veralteter Zeitstempel nach
  einem Neustart oder ein Sprung im Quellzähler), wird das Intervall verworfen;
  auch plausible Minutensamples sind auf 2 kWh begrenzt. Damit kann kein einzelner
  Ausreißer als Tagesverbrauch stehen bleiben und die Prognose der Folgetage
  verzerren. Die
  Jahresbasis (`annualAverage`) zieht zusätzlich zur Wallbox-Energie die per
  Leistungsintegration erfasste **Netto-Akkuladung** ab (`battery_energy_state`,
  Tag/Woche/Monat/Jahr + Vorjahr, `batterie/energy.js`, 60-s-Job): Der
  Eigenverbrauch (PV + Netzbezug) enthält die Hausakku-Ladung
  physikalisch mit, ohne Bereinigung verschiebt sie den prognostizierten
  Tagesbedarf nach oben; ebenso werden die per `mess_schalt_function_hourly`
  erfassten Funktionslasten je Jahr abgezogen. Aus den bereinigten Stundenwerten
  entstehen sieben getrennte, weich gelernte Wochentagsprofile samt
  wochentagsabhängigem Tagesniveau; bei wenig Daten wird zur Vortageskurve
  zurückgeblendet. Die **Funktions-Statistik** (`messen-schalten/functions.js`)
  ersetzt das frühere Klimatisierungsmodell: Geräte/Gruppen mit Funktion (Licht,
  Waschen, Warmwasser, Heizung / Klima, Kochen) werden minütlich zu
  Stundenenergien integriert (plausible Intervalle ≤ 5 min, analog Lernmodell)
  und in der Simulation je Stunde aufgeschlagen — Heizung / Klima nach
  Außentemperatur-Buckets in 5-°C-Schritten (nächstgelegener gelernter Bucket,
  Prognosetemperatur aus Open-Meteo), die übrigen Funktionen nach Wochentag.
  Persistente Verhaltensmodelle (`prognosis_config.behavior_model/_active`):
  `grid_parallel` bewertet ausschließlich Reserve und Netzbedarf bis zum nächsten
  Ladebeginn; spätere Tage sind wegen des verfügbaren Netzes irrelevant und
  Level 1 ist bis zur tatsächlichen Mindest-SoC-Unterschreitung gesperrt.
  `off_grid` bewertet dagegen Mindest-SoC und Energiebilanz aller sichtbaren Tage
  und kann vorausschauend auch Level 1 setzen. `prognosis/behavior.js` läuft als
  eigenständige, serialisierte Regelung bei MQTT-Änderungen, spätestens alle
  30 Sekunden sowie unmittelbar beim Aktivieren und besitzt exklusiv
  alle Level 1–5. Unter Mindest-SoC setzt es Level 1 auch bei deaktiviertem
  Verhaltensmodell. Im Autarkbetrieb erfordert Level 5 SoC > 98 % plus Überschuss;
  Im Netzparallelbetrieb bedeutet Level 4 sichere Deckung bis zum nächsten
  Ladebeginn. Die Prognoseampel ist direkt zugeordnet: Grün = Level 4, Gelb =
  Level 3, Rot = Level 2; Level 1 greift erst unter Mindest-SoC. Dort gilt die
  obere Grid-Control-SoC-Schwelle als voll, bei
  deaktiviertem Grid-Control ersatzweise 90 %. Grid-Control verwaltet nur noch
  das Ein- und Ausschalten des persistenten Notstromzustands.
- **Grid-Control** (`/grid-control`, optional): Netz- und Einspeisungssteuerung
  über getrennte untere/obere SoC- und Spannungs-Schaltfenster mit lokaler
  Hysterese sowie Wechselrichter-Temperaturwarnung. Die **obere SoC-Grenze**
  schaltet das Netz nur zu, wenn **Überschusseinspeisung aktiviert** ist.
  Veröffentlicht Warnungen und stellt fünf Grid-Zustände im Wert-Katalog bereit.
  Netzfrequenz 0 nach konfigurierbarer Wartezeit auf einer beliebigen Phase
  verriegelt einen persistenten Notstromzustand; erst L1/L2/L3 jeweils > 0
  entriegeln ihn. Überalterte Frequenzwerte (Frische-Prüfung) entriegeln **nicht**.
  Dreiphasige Lastschaltung auf Basis der bestehenden Eigenverbrauchsleistung
  L1–L3 mit separaten Ein-/Ausschaltschwellen und `grid.byLoad`. Globaler Zustand in `operating-state.js`
  (`operatingLevel` 1–5, `emergencyMode` Boolean), visualisiert im Header.
  Dort liegt auch der persistente Tages-Latch `autark`; im Wert-Katalog als
  `operating.autark`. Eine untere SoC-Netzschaltung setzt ihn bis Tagesende false.
  - **Geschlossene Regelschleife** (`grid-control/automation.js`): jeder Tick (2 s
    + bei MQTT-Änderung) gleicht den Soll-Wert gegen die **tatsächliche
    Broker-Rückmeldung** der Befehls-Topics ab und schreibt bei Abweichung erneut
    (selbstheilend nach verlorenem Write/Reconnect); bleibt die Bestätigung > 20 s
    aus, wird gewarnt. Bestätigt gilt nur, wenn verbunden **und** der Broker den
    Soll-Wert (`ack:true`/Rohwert) zurückmeldet. Status je Befehl im UI als Badge.
  - **Protokoll** (`grid-control/log.js`, Tabelle `grid_control_log`, max. 2000):
    nur **Schwellen-Übertritte mit Aktionen** (gelb) und **kritische Zustände**
    (rot), einzeilig mit Zeitstempel + Werte-Schnappschuss; paginiert
    (100/Seite, `/grid-control/log`), Seite 1 live, ab Seite 2 statisch. Reine
    Wertänderungen werden bewusst **nicht** protokolliert. Das kritische
    „nicht bestätigt“ erscheint erst nach **tatsächlich anhaltender** Divergenz
    (≥ 20 s, dieselbe Bedingung wie die MQTT-Warnung) — nicht schon im Schalt-Tick,
    in dem der Broker den Soll-Wert unmöglich zurückmelden kann; der Live-Status-
    Badge im UI bleibt davon unberührt momentan.
- **Output** (`/output`): beliebige berechnete Werte (Wert-Katalog) an
  ioBroker-**Ziel-Topics** zurückgeben. Die **Engine** (`output/engine.js`)
  arbeitet als geschlossene Regelschleife: Ziel-States werden abonniert und in
  einem 30-s-Fenster aktiv per `/get` gelesen — jedoch **je Output zu einem
  zufälligen Zeitpunkt** innerhalb des Fensters (`verifyTick`, Slot-Verteilung),
  damit nicht alle gleichzeitig den Broker treffen. Nur eine frische Broker-
  Rückmeldung gilt als Bestätigung; ein bereits bestätigter Wert wird erst wieder
  aktiv geprüft, wenn sein Ist-Wert älter als ein Prüffenster ist
  (`readbackNeedsVerification`). Bei fehlendem oder abweichendem Istwert wird
  rate-limitiert erneut publiziert; `ack:false`-Schreib-Echos zählen nicht. Die
  Seite zeigt je Output den Bestätigungsstatus. Command-Topics sind ausgeschlossen,
  weil sie keinen verifizierbaren Istwert bereitstellen. Angelegte Outputs
  erscheinen als dichte, nach Kategorie gruppierte und einklappbare Liste mit festen
  Spaltenbreiten (Statuswechsel verschiebt den Ist-Wert nicht); der Auf-/Zu-Zustand
  je Kategorie wird pro Browser (localStorage) gemerkt, das Nachladen bei
  MQTT-Bursts gebündelt (max. 1×/s). Die Wertauswahl im Dialog nutzt den zentralen
  Wertekatalog (`views/value-catalog.js`).
- **Optionale Module** (`src/modules/index.js`): generische Registry +
  In-Memory-Enabled-State; Seite `/module` zum Aktivieren/Deaktivieren.
  Aktivierte Module erscheinen automatisch in der Sidebar. Aktuell:
  - **Poolsteuerung** (`/pool`): Solarpumpe + Filterpumpe mit je Status-/
    Steuerungs-Topic, Priorität 1–5. KPI-Kacheln (Temperatur, Pumpen, pH, Chlor)
    nur wenn konfiguriert. **Drei Modus-Buttons** (An/Aus/Automatik) je Pumpe,
    aktiver Button hervorgehoben.
    - *Solarautomatik*: sonnenbasiert, 2-Min-Mindesthaltedauer, Maximaltemperatur
      mit konfigurierbarer Probezyklus-Einschaltdauer (s) und Pause (min).
      Option „Filterpumpe für Probelauf verwenden" (wenn Filterpumpe konfiguriert).
      **Probeläufe nur bei Sonneneinstrahlung** (`hasSun`): Neue Proben starten nur
      wenn Sonne scheint. Eine bereits laufende Probe wird bei Beschattung vollständig
      zu Ende geführt. Der Pausenzähler (`tempCycleStart`) läuft bei Beschattung still
      weiter (kein Reset); kehrt die Sonne zurück und ist die Pausenzeit abgelaufen,
      startet sofort eine neue Probe.
    - *Filterautomatik*: bis zu 3 Zeitfenster, Follow-Solar, Akku-Override
      (liest `batterie.soc` aus dem zentralen Cache — kein eigenes Topic).
    - **Pool-Energiemodell** (`pool/energy-model.js`): lernt Solar-/Filterpumpenleistung
      robust aus realen Schaltflanken (Median), integriert tatsächliche Laufzeiten
      persistent und entfernt sie beim 60-s-Sampling aus dem Grund-Hausverbrauch.
      Die Prognose setzt die Solarpumpe aus den erwarteten PV-Stunden und die
      Filterpumpe aus Zeitfenstern/Follow-Solar beziehungsweise simuliertem
      Akku-Override als eigene Last an. Temperaturabschaltung und Probeläufe
      werden prospektiv nicht angenommen, rückwirkend aber vollständig abgezogen.
    - Polling `/pool/status` alle 5 s (Pool-Topics außerhalb der normalen
      State-Definitionen, via Ad-hoc-Subscription-System in `client.js`).
    - `getEffectivePriority(which, cfg)` liefert während Filter-Probeläufen die
      Solarpumpen-Priorität. Beide Pumpen sind als Verbraucher am zentralen
      **Betriebslevel-Handler** registriert (siehe „Betriebslevel / Lastmanagement"
      und [LEVEL_HANDLING.md](LEVEL_HANDLING.md)): Einschalten nur nach Freigabe,
      Zwangsabschaltung bei Levelabfall — im Automatik-Modus, nicht bei Hand An/Aus.
  - **Wallbox** (`/wallbox`): verwaltet mehrere PKW-Wallboxen, einzeln anlegbar wie die
    PV-Anlagen (`wallbox/boxes.js`, Tabellen `wallboxes`/`wallbox_counter_state`/
    `wallbox_summary_state`). Je Box ein Pflicht-**Steuer-Topic** sowie optional Status
    (sonst Steuer-Topic als Ist-Stand), Leistung (W/kW), fortlaufender Zähler (Wh/kWh),
    Soll-Leistung, „Fahrzeug angesteckt" (true/false), Fahrzeug-SoC (%) und ein
    bidirektionales **Modus-Sync-Topic**; dazu Maximalleistung und Fahrzeug-Akkugröße.
    - *Verbrauch* je Box Tag/Woche/Monat/Jahr + Vorjahr (`wallbox/aggregation.js`,
      `buildWallboxSnapshot` im 60-s-Job, Vorbild `stromverbrauch/aggregation.js`); ohne
      Zähler-Topic aus der Leistung integriert. **SoC-Schätzung** aus der seit Einstecken
      geladenen Energie ÷ Akkugröße, wenn kein SoC-Topic gesetzt ist.
    - *Prognose-Lernen*: `wallbox_daily_consumption` und
      `wallbox_hourly_consumption` führen je Box getrennte Wochentags- und
      Stundenprofile. Die aktuelle Wallboxleistung wird vor dem Lernen aus dem
      Hausverbrauch entfernt; `prognosis/wallbox-model.js` fügt den erwarteten
      Ladebedarf je Box in der Batteriesimulation separat wieder hinzu. Der gemeinsame
      Vorausplan wertet aktiven Modus, Verbraucherpriorität, Live-/geschätzten Fahrzeug-SoC,
      Akkugröße, Mindestladung und Arbeitstage aus. Pflichtladungen (Mindest-SoC,
      Beruflich-Garantie, Immer voll) sind feste Lasten; flexible Ladungen werden
      nacheinander auf den verbleibenden PV-Überschuss verteilt. Die gelernte Historie
      bleibt Fallback für noch unbekannte künftige Ladevorgänge.
    - *Drei Lademodi mit je eigener Priorität* (`wallbox/planner.js`): **Privat** lädt bis
      zum Mindest-Ladestand, darüber nur den prognostizierten Überschuss, der nach
      Hausverbrauch und Hausakku nicht mehr speicherbar ist. Hausakku-Entladung wird
      live gegengerechnet, nahe dessen Mindest-SoC bleibt die flexible Ladung aus.
      Ein **live nachgewiesener Überlauf** (Hausakku-SoC ≥ 95 % **und** laufende
      Netzeinspeisung über der Einschaltschwelle) übersteuert dabei eine zu
      vorsichtige Tagesprognose — die eingetretene Realität hat Vorrang, die
      Prognose bleibt nur für den vorausschauenden Start zuständig.
      **Beruflich** berechnet den spätesten Start aus Fahrzeug-Restenergie und
      Ladeleistung für 06:00 Uhr an gewählten Arbeitstagen; freie Tage → Privatregel.
      **Immer voll** lässt das Ladegerät aktiviert. Mit Soll-Leistungs-Topic
      Feinmodulation, sonst An/Aus an einer Schwelle.
    - Steuerschleife `wallbox/automation.js` (30-s-Tick + serielle Kette, Init aus
      `routes/wallbox.js`). Jede Box ist **Verbraucher am Betriebslevel-Handler** mit der
      Priorität des aktiven Modus (Einschalten nur nach Freigabe, Zwangsabschaltung,
      Mindesthaltedauer). Die vorausschauende Bewertung nutzt die System-Prognose
      (`computePrognosis`); die Mehrtagessicht wirkt zusätzlich über das prognosegeführte
      Betriebslevel auf die Modus-Priorität.
    - *Sonderfälle* in `decideWallboxAction` (planner.js, testbar): **Ladestart-Neustart**
      (hängt die Ist-Leistung trotz Befehl nach `stall_timeout_seconds` unter
      `stall_power_w`, 1 Minute aus/ein, gedeckelte Versuche — **nur bei `plugged === true`**,
      damit ohne eingestecktes Auto kein Aus/Ein-Takten entsteht); **manuell EIN am Broker** →
      einmalige Volladung bis Leistungsabfall unter Leerlaufschwelle oder Abziehen;
      **manuell AUS am Broker** → aus bis Folgetag mit PV größer als Eigenverbrauch plus
      Wallboxleistung und ausreichender Hausakku-Reserve; das **„angesteckt"-Signal
      sperrt nicht** (Mobilfunk-Signal, möglich falsch-negativ — bei Ladewunsch wird trotzdem
      eingeschaltet). Manuelle Schaltungen werden ausschließlich über das Steuer-Topic
      erkannt. Erwartete Readbacks eigener Automatikbefehle werden konsumiert und nicht
      als Nutzerwunsch gewertet; das Status-Topic ist reiner Ist-Zustand.
    - *Nächster Ladebeginn*: wird gerade nicht geladen, übernimmt die Automatik den
      Ladebeginn aus dem gemeinsamen Mehr-Wallbox-Vorausplan. `predictNextChargeStart`
      bleibt Fallback und behandelt insbesondere die manuelle Sperre. Die Steuerschleife legt
      den absoluten Zeitpunkt je Box ab (`getNextCharge`); der Wertekatalog rechnet daraus
      zur Lesezeit die **Restzeit in Sekunden** (`wallbox.<id>.naechsterLadebeginnSekunden`)
      sowie die **Uhrzeit** (`wallbox.<id>.naechsterLadebeginn`); die Wallbox-Seite zeigt es an.
- **Wert-Katalog** (`output/internal-values.js`): berechnete und gemessene Werte
  für Outputs und Dashboard-Widgets. Enthält PV, Stromverbrauch, Sonnenintensität,
  **PV-Prognose** (erwarteter Tagesertrag heute/morgen/+2/+3 sowie heute bisher /
  heute noch erwartet), **Systemprognose** (`prognose.*`) **sowie Batterie-Werte** (SoC, Leistung, Spannung,
  Temperatur) und **Pool-Werte** (Wassertemperatur, Pumpen-Status, pH, Chlor — nur
  wenn Modul aktiv) sowie **Betrieb** (`operating.*`, u. a. Autark und
  `operating.notstrom` = Notstrombetrieb). Die Kalibrierfaktoren sind bewusst
  **nicht** im Katalog (reine Diagnose). Zusätzlich **statistische Jahreswerte** je
  Kennzahl (PV, Netzbezug, Eigenverbrauch, E-Auto gesamt): gestern,
  Minimum/Maximum inkl. Datum, Jahres-/Vorjahressumme aus `history/daily-metrics.js`
  (Tabelle `daily_metric_history`, je Metrik ein abgeschlossener Tageswert pro Tag);
  der **Durchschnitt** wird als Jahressumme ÷ angebrochene Tage gerechnet. Fehlt ein
  Wert, zeigt der Katalog `0` (Datum: 1. Januar). Außerdem erscheinen automatisch
  **alle Adapter-States** (`buildStatesTree`, Kategorie „Adapter: <Instanz>", id =
  Scheme-Topic). Alle Einträge haben `id`, `label`,
  `value`, `display` und `category` (Herkunft, abgeleitet aus dem id-Präfix; siehe
  `categoryForId`/`VALUE_CATEGORIES`). Die Darstellung übernimmt die zentrale,
  wiederverwendbare Routine `views/value-catalog.js` (durchsuchbare, einklappbare
  Liste mit Ist-Werten) — eingebettet in Output- und Dashboard-Dialoge.
- Einstellungen (Karten-Layout): Passwort ändern, **Standort & Zeit**
  (Breiten-/Längengrad, Zeitzone, automatische Zeitumstellung — Eingangsgrößen
  fürs Clear-Sky-Modell), MQTT-Broker konfigurieren + Verbindung testen.
- MQTT-Verbindungs-Manager (Connect/Reconnect/Cache **+ publish**); abonnierte
  Topics ergeben sich aus den konfigurierten States (`mqtt/state-definitions.js`)
  plus Ad-hoc-Abonnements für Pool-Topics.
- **Live-Updates** per SSE (`/live/events`); Header-Werte + Himmelssymbol +
  Batterie-SoC über `/live/header`.
- **systemd-Service** `home-ess` — startet automatisch beim Systemstart.

## Leitprinzipien (vom Auftraggeber vorgegeben)

1. **Keine statischen Seiten.** Jede Seite wird serverseitig dynamisch
   gerendert (Template-Funktionen in `src/views/`). `public/` enthält nur
   statische Assets (CSS).
2. **Eine Datei pro Funktion.** Jede neue Funktion/Feature kommt in eine eigene
   kleine `.js`-Datei, um Dateien überschaubar zu halten und den Ausbau zu
   vereinfachen.
3. **Modulgrenzen:** Rendering (`views/`), HTTP-Routen (`routes/`, `auth/`),
   Fachlogik (`mqtt/`, `auth/`, Module-Unterverzeichnisse), Infrastruktur
   (`db.js`, `config.js`, `app.js`).

## Verzeichnisstruktur

```
server.js                 Einstiegspunkt: App bauen + listen
src/
  config.js               Zentrale Konstanten (Port, Cookie, DB-Pfad, Timeouts)
  db.js                   SQLite öffnen, Schema, Seed, Migrationen
  app.js                  Express-App zusammenbauen + periodische Jobs
  operating-state.js      Globaler Zustand (operatingLevel 1–5, emergencyMode,
                          Tages-Latch autark), persistent in `operating_state`;
                          `onOperatingLevelChanged`-Abo bei Levelwechsel
  operating-level/
    handler.js            Betriebslevel-Handler / Lastmanagement: register/
                          unregister, requestTurnOn/isAllowed, onMustTurnOff bei
                          Levelabfall (siehe LEVEL_HANDLING.md)
  modules/
    index.js              Modul-Registry + In-Memory-Enabled-State
  auth/
    password.js           scrypt-Hashing
    session.js            DB-gestützte Cookie-Sessions + requireAuth
    routes.js             /, POST /login, /logout
  mqtt/
    topics.js             ioBroker-Topic-Helfer (reine Funktionen, aus MQTT.md)
    config.js             MQTT-Config + Umgebungs-Snapshot (Temp/Zeit/Datum)
    client.js             Verbindungs-Manager + publish + testConnection
                          + Ad-hoc-Subscription-API (subscribeAdHoc)
    state-definitions.js  Sammelt alle abonnierten Topics (mqtt/strom/pv/batterie)
  stromverbrauch/
    config.js             Topics laden/speichern + buildStateDefinitions
    aggregation.js        Aggregation (schreibend) + readStromverbrauchValues
  photovoltaik/
    plants.js             CRUD + MQTT-State-Definitionen + Zelltyp-Vorgabewerte
    converters.js         Konverter-/Reglertypen + temperaturabh. Wirkungsgrad
    aggregation.js        Clear-Sky/Ideal, direkte Sonne, Himmelszustand,
                          readPhotovoltaikValues (read-only); gemeinsame Helfer
                          solarGeometryAt/transposePlaneIrradiance/
                          idealPowerFromIrradiance (von Live + Prognose genutzt)
    forecast.js           PV-Prognose: Open-Meteo-Strahlung → Tageserträge (kWh)
    calibration.js        Selbstkalibrierung: 15-min-Kalibrierfaktor je Anlage/Bucket
                          (gemessen vs. Open-Meteo-Strahlung, EMA, Gates SoC/Sonne)
    sun-intensity.js      Momentane Intensität + Sampling + Mittelwerte
  wetter/
    client.js             Open-Meteo-Abruf (GHI/DNI/DHI/Temp, stündlich +
                          minutely_15) + In-Memory-Cache
  batterie/
    config.js             Topics laden/speichern, buildBatterieStateDefinitions,
                          readBatterieData
  pool/
    config.js             Topics laden/speichern, rowToConfig, subscribePoolTopics,
                          readPoolValue
    automation.js         Pump-Automation (solar/filter), Modus-Buttons,
                          getEffectivePriority, getPumpMode/setPumpMode;
                          Registrierung + Level-Gate beim Betriebslevel-Handler
  grid-control/
    config.js             Topics/Schwellen laden/speichern, State-Definitionen,
                          readGridControlBrokerValues
    automation.js         Schaltlogik + geschlossene Regelschleife (Verifikation
                          gegen Broker-Readback), Notstrom, Audit-Logging
    log.js                Audit-Log (`grid_control_log`): append/read, Pagination
  wallbox/
    boxes.js              CRUD + Validierung + buildWallboxStateDefinitions (Vorbild plants.js)
    aggregation.js        Zähler/Summen Tag/Woche/Monat/Jahr+Vorjahr, Power-Integration,
                          SoC-Schätzung, readWallboxValues (read-only), buildWallboxSnapshot
    planner.js            Lademodus-Logik (Privat/Beruflich/Immer voll) — reine Funktion
    automation.js         Steuerschleife: Tick, Level-Handler-Registrierung, Modus-Sync,
                          Überschussberechnung, Schalten via mqttClient.publish
  messen-schalten/
    groups.js             Gruppen-CRUD (Titel/Priorität/Position) + reorder
    actors.js             Geräte-CRUD + Validierung (min. 1 Topic), effectivePriority,
                          buildMessSchaltStateDefinitions, cacheKey, setDesiredOn
    aggregation.js        Live-Werte je Gerät, Leistung aus Zählerfortschritt
                          (buildActorSnapshot, 60-s-Job), Gruppen-Verbrauchssummen
    automation.js         Steuerschleife: Level-Handler-Gate je Gerät mit Schalt-Topic
  output/
    internal-values.js    Katalog (PV, Strom, Batterie, Pool, Wallbox, Sonne)
    outputs.js            Output-CRUD
    engine.js             Publish-Engine (diff, debounced)
  dashboard/
    groups.js             Gruppen-CRUD
    widgets.js            Widget-CRUD (Typen value/info, config-JSON)
    system-info.js        Info-Kachel: Feld-Katalog + Live-System-Werte
  routes/
    dashboard.js          GET /dashboard + Widget/Gruppen-CRUD + /layout + /data
    stromverbrauch.js     GET /stromverbrauch + Topic/Abgleich-POSTs + /data
    photovoltaik.js       GET /photovoltaik + CRUD + /data + /forecast
    batterie.js           GET /batterie + POST /batterie/topics + GET /batterie/data
    output.js             GET /output + Output-CRUD + /data
    settings.js           GET /settings, POST password/mqtt/mqtt-test
    live.js               SSE /live/events + /live/header
    modules.js            GET /module + POST /module/:key/enable|disable
    pool.js               GET /pool + POST /pool/config + GET /pool/status
                          + POST /pool/pump/:which/:mode
    grid-control.js       GET /grid-control + POST /grid-control/config
                          + GET /grid-control/status + GET /grid-control/log
    wallbox.js            GET /wallbox + Box-CRUD + POST /wallbox/box/:id/mode/:mode
                          + GET /wallbox/data
    messen-schalten.js    GET /messen-schalten + Gruppen-/Geräte-CRUD + /layout
                          + POST /messen-schalten/actor/:id/switch/:state + /data
  views/
    components.js         escapeHtml, statusText
    value-catalog.js      Zentrale Wertekatalog-Routine (Liste + Client-Script)
    layout.js             App-Hülle + Nav + Header-Live-Script (inkl. Batterie-Icon)
    login.js              Login-Seite
    dashboard.js          Dashboard: Widgets/Gruppen, Drag&Drop, Dialoge
    stromverbrauch.js     Stromverbrauch — KPI-Kacheln + Config
    photovoltaik.js       Photovoltaik — Anlagenliste
    batterie.js           Batterie — KPI-Kacheln + SoC-Balken + Config
    output.js             Output — kategorisierte, einklappbare Zeilenliste
    settings.js           Einstellungen
    modules.js            Modul-Verwaltung
    pool.js               Pool — KPI-Kacheln + Pumpen-Buttons + Config
    grid-control.js       Grid-Control — Zustände, Config, Bestätigungs-Badges,
                          Protokoll-Panel (live Seite 1, paginiert)
    wallbox.js            Wallbox — Boxenliste (KPI je Box), Modus-Buttons, Config-Dialog
    messen-schalten.js    Messen + Schalten — Gruppen/Geräte-Kacheln, Drag&Drop, Dialoge
public/styles.css         Einziges statisches Asset
data/app.db               SQLite (gitignored)
MQTT.md                   Referenz: ioBroker-MQTT-Regeln
```

## Datenmodell (SQLite)

- `users(id, password)` — Passwort als scrypt-Hash.
- `mqtt_config(id=1, host, port, username, password, latitude, longitude, timezone,
  dst_enabled, outdoor_temperature_topic, clock_time_topic, clock_date_topic)`
- `sessions(id, expires_at)`
- `stromverbrauch_config(id=1, eigenverbrauch_l1-3_topic, netzbezug_l1-3_topic,
  netzbezug_zaehler_l1-3_topic, einspeisung_zaehler_l1-3_topic)`
- `stromverbrauch_aggregation(id=1, week/year_import/export_offset, previous_year_*, ...)`
- `stromverbrauch_counter_state(counter_key, last_raw_value, day_total, last_day_key)`
- `pv_plants(id, name, kw_peak, efficiency, orientation, tilt, is_consumer_side,
  cell_type, converter_type, power_topic, today_yield_topic, auto_calibrate,
  sun_cutoff_morning, sun_cutoff_evening)` — die beiden Cutoff-Spalten (Prozent,
  Default 10) steuern den größenrelativen Sonnenreferenz-Cutoff morgens/abends.
- `pv_aggregation(plant_id, ...)` / `pv_summary_aggregation(id=1, ...)`
- `pv_calibration_buckets(plant_id, bucket 0..95, factor, sample_count, updated_at,
  window_minutes)` — je Anlage und 15-Min-Tageszeit-Bucket ein langsam nachgeführter
  Kalibrierfaktor (`window_minutes` dokumentiert die Fensterbreite und dient als
  Migrations-Marker; Altbestand wird einmalig verworfen).
- `sun_intensity_samples(id, recorded_at, day_key, intensity, day_average_eligible)`
- `outputs(id, source_id, target_topic)`
- `dashboard_groups(id, title, width, position)`
- `dashboard_widgets(id, source_id, group_id, position)`
- `batterie_config(id=1, soc/power/voltage/temperatur/min_soc_topic, min_soc,
  capacity_ah, battery_type, cell_count, lower_voltage, upper_voltage)`
- `battery_daily_state(id=1, day_key, charged_today)`
- `prognosis_config(id=1, charge/discharge_efficiency, history_days,
  behavior_model, behavior_active)`
- `prognosis_daily_consumption(day_key, consumption_kwh, raw_consumption_kwh,
  max_temperature, completed, updated_at)`
- `prognosis_hourly_consumption(day_key, hour, consumption_kwh)`
- `modules(key TEXT PRIMARY KEY, enabled INTEGER)` — aktivierte optionale Module.
- `pool_config(id=1, temperature_topic, solar_pump_status_topic,
  solar_pump_command_topic, solar_pump_priority, solar_pump_max_temp,
  solar_pump_temp_on_seconds, solar_pump_temp_pause_minutes,
  solar_pump_temp_use_filter, filter_pump_status_topic,
  filter_pump_command_topic, filter_pump_priority, filter_pump_follow_solar,
  filter_time_1_start/end, filter_time_2_start/end, filter_time_3_start/end,
  filter_battery_enabled, filter_battery_soc, ph_topic, chlor_topic)`
- `grid_control_config(id=1, grid/feed_in_command_topic, temperature_warning_*,
  warning_text/active_topic, soc/voltage/temperature/load_enabled, feed_in_allowed,
  soc_lower/upper_offset, soc/voltage_hysteresis, grid_frequency_l1-3_topic,
  grid_detection_seconds, load_on/off_l1-3)`
- `operating_state(id=1, operating_level 1–5, emergency_mode, autark,
  autark_day_key, autark_days_count/year/counted_day_key/topic,
  autark_days_previous_year_count/year/topic)`
- `grid_control_log(id, ts, category 'info'|'action'|'critical', message,
  values_text)` — Audit-Log, automatisch auf 2000 Einträge beschnitten.
- `wallboxes(id, name, max_power_w, battery_capacity_kwh, command_topic,
  status_topic, power_topic, power_unit 'W'|'kW', counter_topic, counter_unit 'Wh'|'kWh',
  setpoint_topic, plugged_topic, soc_topic, mode_sync_topic, mode 1|2|3,
  priority_private/business/full 1–5, min_charge_percent, business_days CSV Mo..So,
  stall_timeout_seconds, stall_power_w)` — je Wallbox eine Zeile (optionales Modul);
  die beiden Stall-Spalten steuern den Ladestart-Neustart.
- `wallbox_counter_state(wallbox_id, last_raw_value, day_total, last_day_key,
  plugged_energy_start, last_power_ts)` — Zähler-/Power-Integrationsstand + SoC-Schätzbasis.
- `wallbox_summary_state(wallbox_id, week/month/year_offset, previous_year_total,
  last_rollover_date, week/month/year_key)` — historische Summen inkl. Monat + Jahreswechsel.
- `wallbox_daily_consumption(wallbox_id, day_key, consumption_kwh, completed, updated_at)`
- `wallbox_hourly_consumption(wallbox_id, day_key, hour, consumption_kwh)` —
  getrennte Lernhistorie für Wochentagsbedarf und Ladezeit je Box.
- `mess_schalt_groups(id, title, priority 1–5, position, function_key)` —
  Messen-+-Schalten-Gruppen; Priorität wird von Geräten mit `use_group_priority`
  übernommen, `function_key` von Geräten ohne eigene Funktion geerbt.
- `mess_schalt_actors(id, name, group_id, position, switch_topic, status_topic,
  power_topic, power_unit 'W'|'kW', counter_topic, counter_unit 'Wh'|'kWh',
  priority 1–5, use_group_priority, always_on, desired_on, function_key)` — je
  Gerät eine Zeile; `always_on` = automatisch übers Betriebslevel (sonst manueller
  Toggle, direkt am Schalt-Topic). `desired_on` ist ungenutzter Altbestand.
- `mess_schalt_actor_state(actor_id, last_counter_raw, last_progress_ts,
  derived_power_w)` — Ableitungszustand für „Leistung aus Zählerfortschritt"
  (0 W nach über 10 min ohne Fortschritt).
- `mess_schalt_function_hourly(function_key, day_key, hour, consumption_kwh,
  temperature)` + `mess_schalt_function_state(id=1, last_sample_ts)` — je Funktion
  und Stunde integrierte Energie samt maximaler Außentemperatur der Stunde;
  Grundlage der Funktions-Stundenprofile der Prognose (Heizung / Klima nach
  5-°C-Temperatur-Buckets, übrige Funktionen nach Wochentag). 400 Tage Aufbewahrung.
- `battery_energy_state(id=1, day_charge/discharge_kwh, week/month/year_charge/
  discharge_offset, previous_year_charge/discharge_total, last_power_ts,
  last_rollover_date, week/month/year_key)` — per Leistungsintegration erfasste
  Netto-Akkuladung nach Tag/Woche/Monat/Jahr + Vorjahr.
- `daily_metric_history(metric, day_key, value, updated_at)` — je Kennzahl
  (`pv`, `strom.netzbezug`, `strom.eigenverbrauch`) ein abgeschlossener
  Tageswert pro Tag; Grundlage für die statistischen Jahreswerte (gestern,
  Minimum/Maximum inkl. Datum) im Wert-Katalog. 400 Tage Aufbewahrung.

> **Wert-Katalog** (`output/internal-values.js`): Outputs **und** Dashboard-Widgets
> beziehen ihre Werte aus demselben Katalog. Enthält PV (Leistungen, Erträge,
> Sonne), Stromverbrauch (Leistungen, Energien je Zeitraum, Zählersummen),
> Sonnenintensität, **PV-Prognose** (Tagesertrag heute/morgen/+2/+3 sowie heute
> bisher / noch erwartet), **Systemprognose** (38 Werte), **Batterie** (Messwerte,
> Energie/Restzeit und abgeleitete Zustände), **Betriebszustand**, **Grid-Control**,
> **Geräte** und **Verbrauchssummen** (Messen + Schalten) sowie **Pool** und
> **Wallbox** (wenn das jeweilige Modul aktiv ist). Jeder Eintrag
> hat `id`, `label`, `value`, `display`.

## MQTT Ad-hoc-Subscriptions (Pool und Output-Readback)

Pool-Topics liegen außerhalb der normalen State-Definitionen (Pool ist optional,
Topics ändern sich per Config). `client.subscribeAdHoc(configuredTopic, cacheKey)`
registriert alle `mqttReadCandidates` als Routen und abonniert alle
`mqttSubscribeCandidates` (inkl. Wildcard für Slash-States). `/get`-Anfragen
werden beim Subscribe und beim Reconnect gesendet. Cache-Keys: `pool:<topic>`.
Abgerufen über `readPoolValue(cache, topic)`. Die Output-Regelschleife verwendet
pro Ziel-State einen gemeinsamen `output.readback:<topic>`-Cache-Key und fordert
den Istwert zusätzlich alle 30 Sekunden aktiv an.

## Adapter-Schnittstelle (Geräte-Anbindung)

Austauschbare Adapter verbinden homeESS mit Geräten, **ohne** Eingriff in den
Quellcode. Vollständiges Regelwerk in [ADAPTER.md](ADAPTER.md); Vorlage:
`/adapter/demo`.

- **Verzeichnis** `config.ADAPTER_DIR` (Default `<repo>/adapter`, override
  `HOME_ESS_ADAPTER_DIR`). Je Adapter ein Unterordner mit `adapter.json`
  (Manifest: `id`, `prefix`, `settings`-Schema, `main`) + Einstiegsdatei.
  `src/adapters/registry.js` scannt und validiert.
- **Gemeinsamer Wert-Bus** `src/state-bus.js`: hält den zentralen `valueCache` +
  EventEmitter. Sowohl `mqtt/client.js` (Broker) als auch Adapter schreiben hier
  hinein; `mqttClient.getCache()/onValuesChanged()` sind Fassaden darauf — alle
  bestehenden Konsumenten (Output-Engine, `/live`, Dashboard) bleiben unverändert.
  `ingest` aktualisiert den Cache (inkl. `receivedAt`) immer, **emittiert das
  `values`-Event aber nur bei tatsächlicher Wertänderung** — das verhindert
  write→Echo-Rückkopplungen auf Adapter-Topics und hält die Event-Last niedrig.
  Reaktive Konsumenten (Output-Engine, Prognose-Verhalten) entprellen mit 1000 ms;
  browser-seitig fassen Dashboard/States/Output das Nachladen pro Event-Burst
  zusammen (max. 1×/s).
- **Router** `src/adapters/router.js` + Schema-Helfer `parseSchemeTopic`/
  `buildSchemeTopic` in `mqtt/topics.js`. Topics `prefix://instanz/adresse` werden
  vom Client an den Router delegiert (in `publish`, `subscribeAdHoc`,
  `requestAdHocValue`, `buildTopicRoutes`); Topics ohne Schema laufen unverändert
  über den Broker (abwärtskompatibel). Der Router wirkt wie ein **kleiner interner
  Broker**: `registerRoute` liefert dem neuen Abonnenten sofort den zuletzt
  bekannten Wert (retained delivery aus dem Bus, unabhängig von `read()`),
  `ingestFromInstance` verteilt jede Wertänderung automatisch an alle Abonnenten.
  **Wichtig:** `normalizeMqttTopic` ist schema-fest — es darf das `://` von
  Schema-Topics nicht kollabieren (sonst würden sie als Broker-Topic fehlgeroutet
  und lieferten keinen Wert). Config-Speicherpfade normalisieren gefahrlos.
- **Instanzen** (`adapter_instances`, CRUD in `src/adapters/instances.js`): pro
  Adapter mehrere benannte Instanzen mit eigenen JSON-Settings; Name = Autorität
  im Topic.
- **Isolation**: `src/adapters/host.js` (Supervisor) forkt je aktiver Instanz
  `src/adapters/runtime.js` als Kindprozess (Auto-Restart mit Backoff). Der
  Runtime-Shim lädt die Adapter-`main` und bildet die `host`-API transparent auf
  IPC ab — Adapter-Autoren kennen kein IPC. `forkImpl` ist für Tests injizierbar
  (`host._setForkImpl`). Init in `app.js` vor `loadAllStateDefinitions`.
- **State-Editor (generisch, schema-getrieben)**: Adapter können im Manifest einen
  `stateEditor` deklarieren (Spalten + `presets`-Flag, parse in `registry.js`).
  homeESS rendert daraus die Verwaltungs-Unterseite `/adapter/instance/:id/states`
  (`src/views/adapter-states.js`, Routen in `src/routes/adapters.js`); Zeilen-
  Normalisierung/Validierung in `src/adapters/state-editor.js`. Die Zeilen liegen
  in `instance.settings[storageKey]` und sind die **Live-States**. **Presets**
  (`src/adapters/presets.js`, Verzeichnis `<adapter>/presets/*.json`) sind reine
  Vorlagen: Laden mit Auswahl, „als Preset speichern", Upload (Browser liest die
  Datei und POSTet JSON). Kein adapterspezifischer Code im Core.
- **Modbus-Adapter** (`adapter/modbus`): nutzt den State-Editor (Spalte =
  Register) + Presets (Format in `adapter/modbus/PRESET.md`). Eigener,
  abhängigkeitsfreier Modbus-TCP-Client (`modbus-tcp.js`, Unit-ID **pro Request**)
  + reine Dekodierung/Kodierung (`decode.js`, byte-/word-order/scale gemäß
  PRESET.md). Die **Unit-ID ist Teil jedes Registers** (zusammengesetzter
  Editor-Schlüssel `keyFields:[unitId,address]`) und bildet die erste Adressebene
  `modbus://instanz/<unitId>/<adresse>` — eine Instanz bedient so mehrere Units.
- **States-Seite** (`/states`, Menü unter Prognose): `src/adapters/states.js`
  aggregiert gemeldete States (persistiert in `adapter_states`) + Live-Werte aus
  dem Bus zum Baum. **Adapter-Seite** (`/adapter`, Fußbereich über Module):
  Verwaltung + generische Settings aus dem Manifest-Schema.
- **State-Picker** `src/views/state-picker.js` (analog `value-catalog.js`): Button
  hinter Topic-Feldern öffnet den State-Baum (`/states/catalog.json`) und
  übernimmt `prefix://instanz/adresse`. Als **Popover** (Popover-API,
  `showPopover()`) umgesetzt, das wie ein Dropdown am Feld andockt (je nach Platz
  nach unten/oben) und im **Top-Layer** über `<dialog>`-Elementen liegt.
  **Global** über `renderLayout` eingehängt:
  `statePickerAutoAttach()` dekoriert per DOMContentLoaded **jedes** Eingabefeld,
  dessen `name` „topic" enthält, und beobachtet via MutationObserver nachträglich
  eingefügte Felder (dynamische Anlagen-/Wallbox-Zeilen). Einzelne Seiten müssen
  nichts tun; ein Feld kann sich per `data-no-state-picker` ausnehmen.

## Betriebslevel / Lastmanagement

Zentraler **Betriebslevel-Handler** in `src/operating-level/handler.js`. Vollständige
Anleitung zum Anbinden neuer Verbraucher: [LEVEL_HANDLING.md](LEVEL_HANDLING.md).

- **Priorität (1–5) = Freigabe-Level:** `erlaubt ⇔ aktuelles Betriebslevel ≥ Priorität`
  (Priorität 4 ⇒ erlaubt bei Level 4/5, gesperrt bei 1–3).
- **API:** `register(id, priority, { onMustTurnOff })` (Re-Registrierung überschreibt die
  Priorität), `unregister(id)`, `requestTurnOn(id)` (Einschalt-Freigabe), `isAllowed(priority)`,
  `currentOperatingLevel()`. Der Handler abonniert `operatingState.onOperatingLevelChanged`
  und ruft bei Levelabfall `onMustTurnOff()` jedes nicht mehr erlaubten Verbrauchers auf.
- **Drei Modi pro Verbraucher** (`an`/`aus`/`automatik`): nur **`automatik`** läuft über das
  Gate (registriert, Einschalten nur nach Freigabe, Zwangsabschaltung). **`an`/`aus`**
  übersteuern das Level bewusst und sind **nicht** registriert.
- **Verbraucher:** Filter- und Solarpumpe (`pool.solar`, `pool.filter`) sowie je
  Wallbox `wallbox.<id>` (Priorität des aktiven Lademodus) in
  `pool/automation.js`. `getEffectivePriority(which, cfg)` liefert während eines
  Filter-Probelaufs die Solarpumpen-Priorität für die Filterpumpe.
- Init in `app.js` (`operatingLevelHandler.init()`) nach geladenem Betriebszustand, vor
  `prognosisBehavior.init`. Neue Verbraucher registrieren sich aus ihrer eigenen
  Steuerschleife heraus, sobald sie aktiv sind.

## Wichtige Entscheidungen / Eigenheiten

- **Sessions statt Flag:** Cookie-Name `ess_sid`. „Merken" → 30-Tage-Cookie;
  sonst Session-Cookie (serverseitig 12 h gültig).
- **Passwörter gehasht** (Node `crypto.scrypt`). Default beim ersten Start: `admin`.
- **MQTT/ioBroker-Regeln** in [MQTT.md](MQTT.md) und in `mqtt/topics.js` umgesetzt.
- **ack-Unterscheidung beim Readback:** Eingehende Nachrichten mit `ack:false`
  sind Schreibwünsche/Kommandos (u. a. das Echo eigener Schreibvorgänge auf dem
  Haupt-Topic) und werden **nicht** als Broker-Stand gecacht. Nur `ack:true` bzw.
  Rohwerte gelten als bestätigter Ist-Zustand (`unwrapMqttMessage` in `topics.js`,
  Filter in `client.js`). Grundlage der Schalt-Verifikation in Grid-Control.
- **Slash-Schreib-Limitierung:** State-IDs mit eingebettetem Slash (Modbus/Victron,
  z. B. `…3500_/ManualStart`) lassen sich per MQTT nur **lesen** (Wildcard-Abo),
  nicht zuverlässig **schreiben** (der Broker bildet `/`→`.` falsch zurück). Lösung:
  für Schalt-Ziel-Topics **slash-freie** Namen verwenden. Siehe [MQTT.md](MQTT.md).
- **Batterie = zentrales Element**: `batterie.soc` ist der einzige SoC-Wert
  der gesamten Plattform. Der Pool-Akku-Override liest diesen State direkt aus
  dem Cache — kein eigenes Topic. Das Batterie-SoC-Icon in der Titelzeile ist
  permanent sichtbar (sobald konfiguriert).
- **DB-Pfad** via Env `HOME_ESS_DB`, Port via `PORT`.

## Nächste sinnvolle Schritte (Roadmap)

1. **Last-Management / Regel-Engine (Basis umgesetzt):** zentraler
   Betriebslevel-Handler (`operating-level/handler.js`) schaltet registrierte Verbraucher
   nach Priorität gegen das prognosegeführte Betriebslevel — erste Verbraucher: Filter-/
   Solarpumpe. Offen: weitere Verbraucher anbinden (Leitfaden: [LEVEL_HANDLING.md](LEVEL_HANDLING.md)).
2. **Watchdog/Reconnect-Härtung** gemäß MQTT.md (stille Subscriptions erkennen).
3. **Session-Cleanup:** abgelaufene `sessions`-Zeilen periodisch löschen.
4. **Drag&Drop für Touch** (aktuell native HTML5-DnD, nur Maus/Desktop).
5. **Sample-Pflege:** `sun_intensity_samples` werden beim Sampling zwar gekürzt
   (2 Tage) — bei langem Stillstand des Samplers ggf. separater Cleanup.
6. **Selbstkalibrierung (umgesetzt):** 15-min-Kalibrierfaktor je Anlage/Bucket aus
   gemessenem Schnitt vs. Open-Meteo-Strahlung (`calibration.js`,
   `pv_calibration_buckets`). Mögliche Verfeinerungen: Solar-Zeit- statt
   Wanduhr-Buckets (saisonstabilere Verschattung), UI-Kurve der Faktoren über den
   Tag, Persistenz des laufenden 15-min-Messfensters über Neustarts hinweg.

## Konventionen für read-only Wert-Provider

- Die Snapshot-Builder `buildStromverbrauchSnapshot` / `buildPhotovoltaikSnapshot`
  **schreiben** in die DB. Sie laufen nur in den 60-s-Intervallen in `app.js`.
- Für häufige Auswertung: **schreibfreie** Provider `readStromverbrauchValues` /
  `readPhotovoltaikValues` / `readBatterieData`. Neue „Live"-Verbraucher **immer**
  diese read-only Varianten nutzen.

## Laufzeit- und CPU-Verhalten

- Adapter können zusammen gelesene Werte per `host.publishStates()` als Batch
  melden. Der State-Bus aktualisiert dabei alle Frischezeitstempel, erzeugt aber
  nur ein gemeinsames Änderungsereignis. Der Modbus-Adapter gruppiert dafür
  zusammenhängende Register gleicher Unit, Registerart und Pollrate.
- Grid-Control verdichtet relevante Wert-Bursts auf höchstens einen laufenden und
  einen folgenden Tick; fachfremde Events werden ignoriert. Der 2-s-Sicherheitstakt
  bleibt davon unabhängig bestehen.
- Output-Readbacks besitzen einen günstigen Bestätigungspfad ohne erneuten Aufbau
  des gesamten Wertekatalogs. Wertekatalog, PV-Prognose und Verbrauchsmodell teilen
  parallele bzw. kurz gültige Berechnungen.
- Das gecachte Verbrauchsmodell enthält keinen mutierten Wallbox-Ladeplan. Jeder
  Aufrufer materialisiert daraus einen frischen Plan mit aktuellem Hausakku-SoC,
  Kapazität, Wirkungsgraden und der gewählten Wallbox-Strategie.
- Periodische Jobs laufen über `job-scheduler.js` ohne Selbstüberlappung.
- `HOMEESS_PERF_DEBUG=1` aktiviert einen minütlichen `[perf]`-Datensatz mit
  Laufzeiten, Aufruf-/Cache-/Coalescing-Zählern, SQLite-Profil und Event-Loop-Lag.

## Service-Verwaltung (systemd)

```bash
systemctl status home-ess      # Status
systemctl restart home-ess     # Neustart nach Code-Änderungen
systemctl stop home-ess        # Stoppen
journalctl -u home-ess -f      # Live-Log
```

Unit-Datei: `/etc/systemd/system/home-ess.service`
WorkingDirectory: `/opt/home-ess`, User: `root`, Restart: `on-failure`.

## Lokaler Start / Test

```bash
npm install
npm start                 # Port 3000, Login mit "admin"
npm run dev               # mit --watch
HOME_ESS_DB=/tmp/t.db PORT=3001 npm start   # Wegwerf-DB für Tests
```
