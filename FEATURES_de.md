# homeESS-Funktionen

[Click here for the English version.](FEATURES.md)

homeESS verbindet Energiemessung, Prognosen und Laststeuerung in einem lokalen,
selbst betriebenen System. Die Seiten werden serverseitig gerendert und besitzen
eigenständige Desktop- und Mobilansichten.

## Oberfläche und Zugriffssteuerung

- Responsive Desktop- und Mobiloberflächen mit touchtauglicher Navigation,
  Dialogen und Dashboards.
- Anmeldung mit dauerhaften Sitzungen, Nutzerauswahl und den Rollen Lesen,
  Bedienen und Schreiben. Administratoren behalten uneingeschränkten Zugriff.
- Mehrere Dashboard-Tabs mit konfigurierbaren Wert-, Schalter- und
  Informationswidgets. Gruppen und Widgets lassen sich per Drag-and-drop
  anordnen.
- Systemweite Sprachwahl mit deutschen und englischen Katalogen. Adapter können
  eigene Sprachdateien mitbringen.
- Farbthema je Benutzer: hell, dunkel oder nur das Dashboard dunkel. Eingefärbt
  wird allein die Arbeitsfläche der Seiten — Titelleiste und Seitenmenü behalten
  in jedem Thema ihre Farben.

## Energiemessung

- Energie-Übersicht als Einstieg in die Energieseiten: Eckdaten von
  Photovoltaik, Stromverbrauch, Batterie, Prognose und – falls aktiv –
  Grid-Control auf einer Seite, jeweils mit Sprung auf die zugehörige
  Unterseite.
- Stromverbrauchsseite für Eigenverbrauch, Netzbezug, Einspeisung sowie Tages-,
  Wochen- und Jahreswerte.
- Sichere Rohzählerbehandlung über Differenzen ohne Sprünge nach Zähler- oder
  MQTT-Topic-Wechseln.
- Verwaltung mehrerer Photovoltaikanlagen mit Liveleistung, Erträgen,
  Konverter- und Zellmetadaten sowie Clear-Sky-Referenzleistung.
- Sonnenstandsberechnung mit wahrer Ortssonnenzeit, konfigurierbaren
  Referenzschwellen und direkter Sonnenlichterkennung.
- Open-Meteo-PV-Prognose für heute und die folgenden sechs Tage einschließlich
  anlagenspezifischer Selbstkalibrierung in 15-Minuten-Fenstern.
- Batterieseite für Ladezustand, Leistung, Spannung, Temperatur,
  Wirkungsgrade, Kapazität und konfigurierbaren Mindest-Ladezustand.
- Bidirektionale Synchronisierung ausgewählter Einstellungen und Liveanzeigen
  für Batterie, Leistungen, Temperatur, Zeit und Betriebszustand im Kopfbereich.

## Prognose und Betriebsstrategie

- Viertägige Energiebilanz aus PV-Erzeugung, gelerntem Verbrauch,
  Batteriegrenzen, konfigurierbaren Reserven und geplanten Lasten.
- Gelernte Grundlast, Wochentagsprofile, temperaturabhängiger Heiz- oder
  Kühlbedarf und getrennte Wallbox-Verbrauchsmodelle.
- Ein zentraler Betriebslevel-Handler gibt registrierte Verbraucher anhand
  ihrer Priorität frei.
- Notstrom- und Autarkiezustände, Hysteresen und persistente Zustände verhindern
  unsicheres Schalten nach Neustarts oder bei unvollständigen Messwerten.

## Wetterprognose

- Eigene Seite mit der aktuellen Wetterlage und den kommenden drei Tagen in
  voller Tiefe: Temperaturen, Niederschlag, Wind, UV-Index, Sonnenintensität,
  Bewölkung, Luftdruck, Luftfeuchte und Sonnenzeiten — nach Themen gegliedert
  (am Schreibtisch je Thema eine Spalte, am Telefon Kacheln), jede Größe mit
  Piktogramm und je Detailtag mit Stundenverlauf.
- Verlaufsdiagramm über den gesamten Zeitraum: Temperatur und Sonnenintensität
  als Linien, Niederschlag als Balken dahinter.
- Der erwartete PV-Tagesertrag aus der PV-Prognose steht im Titel jedes
  ausführlichen Tages und in jeder Zeile der weiteren Tage.
- Eigene Telefonansicht: kompakte Abstände, schmale Diagrammform und
  Stundenverlauf in 3-Stunden-Schritten — nichts muss seitlich gescrollt werden.
- Die weiteren Tage folgen als Kurzübersicht mit dem Wichtigsten je Zeile.
- **Wetter-Widget fürs Dashboard**: zeigt wahlweise die aktuelle Lage oder einen
  einzelnen Prognosetag; welche Werte darin stehen, wird je Kachel angehakt. Die
  Kachel ordnet sich nach der Breite ihrer Gruppe an — einspaltig in einer
  Viertel-Gruppe, mehrspaltig in einer vollen.
- Alle Werte stehen als States in der Systemgruppe **Wetter** bereit und lassen
  sich in Bedingungen, Automationen, Output und Dashboard-Widgets verwenden.

## Messen und Schalten von Verbrauchern

- Frei konfigurierbare Mess- oder Schaltgeräte mit MQTT-Topics für Befehl,
  Remote-Synchronisierung, Status, Leistung und Energiezähler.
- Verschachtelte Gruppen, Gruppenprioritäten, aus Nennleistungen abgeleitete
  virtuelle Leistung und interne Energiezähler.
- Optionaler phasenspezifischer Lastabwurf über Grid-Control mit gestuftem
  Abschalten und verzögerter Wiederfreigabe.
- Animiertes Energieflussdiagramm für PV, Netz, Batterie, Eigenverbrauch und
  verschachtelte Verbrauchergruppen einschließlich öffentlicher Nur-Lese-Exporte.
- Schaltgruppen mit Drag-and-drop-Zuordnung, gemeinsamem Schalten,
  Remote-Topics und optionalen Timern.
- Dashboard-Kachel „Diagramm": bis zu vier Messreihen aus der Datenbank als
  Zeitreihe, Zeitraum 6 Stunden bis 30 Tage, mit frei wählbarer Farbe und
  Legendenbezeichnung je Linie, aktuellem Wert und Fadenkreuz zum Ablesen.
- Zentrale Datenbankanbindung für Diagramme und Auswertungen: eine InfluxDB 1.x
  wird in den Einstellungen eingetragen oder per Knopf aus dem InfluxDB-Adapter
  übernommen; auch eine externe Datenbank lässt sich einbinden.
- Systemweite Warnung: Fehler, die ein Eingreifen erfordern, erscheinen als
  rotes Warnband auf jeder Seite und stehen als States „Warnungstext" und
  „Warnung aktiv" unter System / Betrieb bereit, bis sie quittiert werden.

## Optionale Steuerungsmodule

- Grid-Control schaltet Netz- und Wechselrichterpfade mit verifizierter
  Rückmeldung, konfigurierbaren Schwellen, Hysteresen und Audit-Protokoll.
  Gemeldet wird nur ein über Minuten und trotz Wiederholungen bestehender
  Dauerfehler — sporadische Aussetzer bleiben ohne Warnung.
- Poolsteuerung verwaltet Solar- und Filterpumpen anhand von Zeitplänen,
  Temperaturen, Sonnenbedingungen, Prioritäten und gelerntem Energiebedarf.
- Wallboxsteuerung unterstützt mehrere Ladegeräte, die Modi Privat, Beruflich
  und Immer voll, Fahrzeug-Ladezustand, Prognosen, Prioritäten und Zählung.
- Heimkino verwaltet beliebig viele frei benannte Räume. Jeder Raum bekommt
  einen beschreibbaren Kinomodus-State unter „System / Heimkino" und steht als
  Schaltziel „Kinomodus Raum …" für Dashboard-Widgets bereit. Ein Raum öffnet
  sich als eigene Seite mit getrennten Aktionsfolgen für An und Aus:
  Wertzuweisungen wie bei den Bedingungen, Pausen und beliebig verschachtelbare
  Schleifen mit frei verschiebbaren Aktionen. Eine Schleife kann zusätzlich in
  festem Abstand prüfen, ob der gewünschte Zustand tatsächlich erreicht wurde,
  und sich andernfalls allein wiederholen. Ein optionales Sync-Topic hält den
  Kinomodus bidirektional mit einem externen Topic synchron; nach einem Neustart
  ist dessen Zustand maßgeblich und wird ohne Aktionsfolge übernommen.
- Heizung & Klima verwaltet beliebig viele Räume mit eigener Soll-Temperatur,
  Offsets für Heizen und Kühlen sowie eigener Schalthysterese. Je Raum sind
  beliebig viele Temperaturquellen zuordenbar — bei mehreren zählt ihr
  Durchschnitt; ein Thermostat hält die Soll-Temperatur bidirektional synchron.
  Eine optionale Mindesttemperatur verhindert, dass eine Nachtabsenkung am
  Thermostat die Klimaanlage weckt: unterhalb dieser Grenze wird nie gekühlt.
  Offene Fenster- und Türkontakte schalten Heizen und Kühlen ab, sofort oder
  nach einer einstellbaren Verzögerung. Heiz- und Kühlgerät werden mit denselben
  Aktionsfolgen wie beim Heimkino geschaltet — Wertzuweisungen, Pausen und
  Schleifen mit zyklischer Prüfung, je Gerät eine Folge für „ein" und eine für
  „aus" —, sodass sich auch eine Splitklimaanlage mit Betriebsart,
  Solltemperatur und Einschaltbefehl bedienen lässt. Die Geräte sowie die
  Freigabe der Zentralheizung sind optional; ohne sie erfasst der Raum nur seine
  Temperatur und stellt alle Werte als Systemwerte bereit — unter *System* im
  Ordner *Räume* mit einem Unterordner je Raum, benannt nach dem Raum
  (`system://homeess/raeume.Wohnzimmer.temperatur`) statt durchnummeriert. Ob
  Ist im Raum eine **Klimaanlage zum Kühlen** eingerichtet, lässt sich ihr
  Zustand von Hand übersteuern: unter *System* im Ordner *Klima* liegt je Raum
  eine beschreibbare **Betriebsart** (0 = Aus, 1 = An, 2 = Automatik,
  `system://homeess/klima.Wohnzimmer.betriebsart`) und daneben der nur lesende
  Wert **Aktiv**, der meldet, ob die Anlage gerade läuft. „Aus" und „An" setzen
  die automatischen Aktionsschleifen aus — die Anlage reagiert dann weder auf
  einen offenen Fenster-/Türkontakt noch auf die Raumtemperatur, sondern bleibt
  in ihrem geschalteten Zustand stehen. Zurück auf Automatik springt sie, wenn
  der Raum die eingestellte Soll-Temperatur erreicht — und, sofern je Raum eine
  **Uhrzeit** hinterlegt ist, spätestens zu dieser Zeit (die erste Fälligkeit
  nach dem Umschalten zählt; ein Neustart holt sie nach). Vorrang behält das
  Betriebslevel: deckt es die Priorität des Kühlgerätes nicht ab, bleibt die
  Anlage auch bei „An" aus. Bedient wird die Betriebsart wahlweise über den
  State oder direkt in der **Raumübersicht**, wo Räume mit Klimaanlage einen
  Umschalter *An / Aus / Automatik* tragen. Ob
  ein Raum seine Wärme vom lokalen Gerät oder von der Zentralheizung bekommt,
  entscheidet die **Außentemperatur** (systemweit oder eigene Quelle) gegen eine
  je Raum einstellbare Grenztemperatur. Je Raum lässt sich zusätzlich ein
  Heizkörperlüfter hinterlegen, der läuft, solange der Raum Wärme von der
  Zentralheizung anfordert. Beide lokalen Geräte hängen am Betriebslevel: je
  Gerät ist eine Priorität einstellbar, und für das Heizgerät lässt sich
  aktivieren, dass bei nicht ausreichender Priorität direkt die Zentralheizung
  heizt — dann entfällt für diesen Raum solange die Außentemperaturgrenze. Die
  Zentralheizung läuft über Modbus/State oder einen Schaltaktor mit zwingender
  Vor- und Rücklaufüberwachung und kennt drei getrennte Zustände: Kessel
  (Schaltzustand), Brenner (feuert er?) und Pumpe. Der Kessel schaltet erst ab,
  wenn keine Anforderung mehr besteht und der Brenner als aus erkannt ist —
  erkannt entweder an der Rückmeldung der Steuerung oder am Verlauf der
  Vorlauftemperatur. Eine optionale Umwälzpumpe am zweiten Schaltaktor läuft
  immer zuerst an, bevor der Kessel starten darf, und nach ihm die eingestellte
  Nachlaufzeit weiter. Für die Heizkosten zählt allein, was der Brenner
  tatsächlich feuert — laut seiner Rückmeldung, ersatzweise anhand der
  steigenden Vorlauftemperatur — verrechnet mit Verbrauch je Betriebsstunde und
  Preis je Einheit. Ein Zählwerk summiert Verbrauch und Kosten über einen
  Abrechnungszeitraum bis zur nächsten Zählerablesung, weist den Monatsabschlag
  aus und übernimmt beim Abschließen auf Wunsch den abgelesenen Zählerstand —
  optional auch zum Kalibrieren der Schätzung. Der Schornsteinfeger-Modus stellt
  alle Räume auf 28 °C, hält die dezentralen Geräte aus und lässt die
  Zentralheizung durchlaufen.
- Optionale Module lassen sich in den Einstellungen aktivieren, ohne parallele
  Server- oder Authentifizierungsstrukturen anzulegen.

## Adapter, States, Automationen und Output

- Isolierte Adapterinstanzen binden Modbus, Tasmota, Shelly, Homematic RPC, hDP
  und weitere portable Integrationen an.
- Jedes hDP-ARGB-Gerät kann einen eigenen Dimmschalter verwenden: Entspricht
  der gewählte State dem hinterlegten Vergleichswert, reduziert homeESS die
  berechnete Ausgabehelligkeit vor der Übertragung um den eingestellten Anteil.
- **Wert-Kacheln des Dashboards** tragen wahlweise eine eigene Beschriftung
  statt des State-Namens; der Tooltip nennt dann zusätzlich die Herkunft des
  Wertes.
- Der systemweite **Topic-Picker** öffnet bis zur doppelten Breite, wenn der
  Bildschirm den Platz hergibt — lange State-Namen bleiben so vollständig
  lesbar. Aufgeklappt wird immer in die Richtung mit mehr Platz: Felder in der
  unteren Hälfte des Bildschirms öffnen die Auswahl nach oben.
- Die Seite **States** zeigt Systemwerte, Custom States und Adapter-States in
  einem gemeinsamen Baum — und **beschreibbare States lassen sich dort direkt
  bedienen**: Ein/Aus-Schaltflächen für Schaltzustände, eine Auswahl für Werte
  mit fester Bedeutung (etwa die Betriebsart einer Klimaanlage) und ein Feld mit
  „Setzen" für Zahlen und Texte. Welches Element erscheint, sagt die Quelle
  selbst (Module und Custom States kennen ihren Datentyp); für Adapter-States
  wird es aus dem zuletzt gesehenen Wert abgeleitet. Geschrieben wird über
  denselben Weg wie aus einer Aktionsfolge, und nur States, die ihre Quelle als
  beschreibbar meldet, sind überhaupt ein Ziel. Die Bedienung setzt die Rolle
  *bedienen* voraus; Leser sehen die Werte ohne Bedienelemente.
- Custom States verwenden dasselbe vollbreite Gruppenraster wie Messen +
  Schalten. Eigene Drag-Flächen sortieren oder verschieben Verzeichnisse und
  States; alle Verzeichnis- und State-Eigenschaften bleiben nach dem Anlegen
  bearbeitbar.
- Persistente Bedingungen kombinieren beliebig viele Trigger, Prüfungen und
  geordnete Aktionen. Sie reagieren auf Intervalle, Wochenzeitpläne,
  Wertänderungen oder exakte State-Ereignisse, vergleichen typisierte Werte und
  schreiben Aktionen über die zentrale State-Grenze. Die Wenn-Prüfung ist
  abschaltbar, ein Sonst-Zweig fängt den nicht erfüllten Fall ab, und
  Vergleichs- wie Zielwerte nehmen wahlweise einen festen Wert oder ein Topic
  auf. Aktionen rechnen mit beiden Werten (Grundrechenarten, Rest, kleinerer
  oder größerer Wert) und runden auf Wunsch. Die responsive Verwaltung
  verwendet dasselbe ausklappbare Gruppenraster wie Messen + Schalten und
  Custom States, inklusive verschachtelbarer Verzeichnisse, in die sich
  Bedingungen per Drag&Drop einsortieren lassen.
- Dann- und Sonst-Zweig sind Aktionsfolgen: Wertzuweisung, Pause und beliebig
  verschachtelbare Schleifen mit einstellbarer Zahl an Durchläufen. Eine
  Schleife prüft auf Wunsch zyklisch, ob der gewünschte Zustand erreicht wurde,
  und wird bei Abweichung als Einzige erneut abgespult. Die Aktionen laufen von
  oben nach unten und lassen sich per Drag&Drop sortieren – auch in eine
  Schleife hinein.
- Eine Schleife lässt sich auch ohne Bedingung anlegen: dann ist ihre
  Plausibilitätsprüfung Pflicht und zugleich die Ausführungsbedingung – die
  Schleife läuft, solange der geprüfte Zustand nicht erreicht ist.
- Administratoren können geprüfte ZIP-Pakete hochladen. Archivstruktur, Pfade,
  Prüfsummen, Limits, Manifestwerte und JavaScript-Syntax werden geprüft, bevor
  ein Adapter `/adapter/` erreicht.
- Adapter lassen sich erst löschen, nachdem alle Instanzen entfernt, eine
  ausdrückliche Warnung bestätigt und die exakte Adapter-ID eingegeben wurde.
- Hochgeladene Adapter und bewusste Löschungen bleiben bei Installer- und
  internen Updates erhalten. Nur das ausdrückliche Installer-Flag `--all`
  stellt alle offiziellen Adapter wieder her.
- Ein zentraler hierarchischer State-Katalog verbindet System-, MQTT-, Custom-
  und Adapterwerte und wird von Dashboards, Outputs und State-Pickern gemeinsam
  verwendet.
- Schreibbare States und berechnete Werte lassen sich an konfigurierte Ziele
  zurückpublizieren.

## Fernzugriff und Updates

- Der optionale gekoppelte Fernzugriff folgt dem Pfad Browser → homeESS →
  essrelay. Relay-Token und private Ed25519-Schlüssel bleiben serverseitig.
- Der Origin-WebSocket-Tunnel wird nur für provisionierte Identitäten aktiviert
  und ist vom normalen lokalen Betrieb unabhängig.
- Integrierte Releaseprüfungen unterstützen manuelle und geplante Updates mit
  Wartungsfenster, Fortschrittsanzeige, Healthcheck und automatischem Rollback.
- Dauerhafte Daten liegen außerhalb des austauschbaren
  Anwendungsverzeichnisses; der systemd-Dienst läuft bei Standardinstallationen
  mit eingeschränkter Dateisystemsicht.
