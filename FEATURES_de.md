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

- Stromverbrauchsseite für Eigenverbrauch, Netzbezug, Einspeisung sowie Tages-,
  Wochen- und Jahreswerte.
- Sichere Rohzählerbehandlung über Differenzen ohne Sprünge nach Zähler- oder
  MQTT-Topic-Wechseln.
- Verwaltung mehrerer Photovoltaikanlagen mit Liveleistung, Erträgen,
  Konverter- und Zellmetadaten sowie Clear-Sky-Referenzleistung.
- Sonnenstandsberechnung mit wahrer Ortssonnenzeit, konfigurierbaren
  Referenzschwellen und direkter Sonnenlichterkennung.
- Open-Meteo-PV-Prognose für heute und die folgenden drei Tage einschließlich
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
- Optionale Module lassen sich in den Einstellungen aktivieren, ohne parallele
  Server- oder Authentifizierungsstrukturen anzulegen.

## Adapter, States, Automationen und Output

- Isolierte Adapterinstanzen binden Modbus, Tasmota, Shelly, Homematic RPC, hDP
  und weitere portable Integrationen an.
- Jedes hDP-ARGB-Gerät kann einen eigenen Dimmschalter verwenden: Entspricht
  der gewählte State dem hinterlegten Vergleichswert, reduziert homeESS die
  berechnete Ausgabehelligkeit vor der Übertragung um den eingestellten Anteil.
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
