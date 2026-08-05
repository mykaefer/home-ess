# homeESS v1.4.0 – Automationen, Custom States und Mehrsprachigkeit

**v1.4.0** ist der nächste öffentliche Release nach **v1.3.41** und fasst die
Arbeit der gesamten 1.3-Entwicklungsphase zusammen. Die Schwerpunkte: homeESS
kann jetzt eigenständig automatisieren, eigene persistente Werte führen, sich
selbst aktualisieren und spricht Deutsch wie Englisch.

Die vollständige Liste aller Änderungen steht in [CHANGELOG.md](../CHANGELOG.md).

---

## Neu

### Bedingungen: Automationen ohne zusätzliche Software

Die neue Hauptseite **Bedingungen** verwaltet Automationen im gewohnten
Gruppenraster. Jede Bedingung besteht aus mindestens einem Trigger, einer
Wenn-Prüfung und einer Dann-Aktion; weitere Elemente kommen über die Plus-Zeile
dazu.

Als Trigger stehen Intervalle, feste Wochenzeitpunkte, Wertänderungen und exakte
State-Ereignisse bereit. Geprüft wird mit typisierten Vergleichen, geschrieben
über die zentrale State-Grenze — MQTT-, Adapter-, System- und Custom-States
verhalten sich dabei gleich. Zeittrigger verwenden ausschließlich die zentrale
homeESS-Uhr.

Bedingungen liegen in frei verschachtelbaren Verzeichnissen und lassen sich per
Drag & Drop einsortieren. Eine Laufzeitsperre je Bedingung, die
Bus-Änderungserkennung und eine harte Ausführungsgrenze pro Minute verhindern
Rückkopplungs- und Automationsschleifen; berechnete `system://`-States bleiben
schreibgeschützt.

### Custom States

Unter **States → Custom States** lassen sich beliebig tief verschachtelte
Verzeichnisse und persistente Werte anlegen — für Counter, Betriebszustände und
Zwischenberechnungen. Boolean, Integer, Floating Point, Text und JSON werden beim
Schreiben typgeprüft; Fließkommawerte unterstützen Einheit, Nachkommastellen und
wählbares Rundungsverhalten. Die Werte erscheinen als les- und schreibbare
`custom://`-Topics in der States-Liste und in allen State-Pickern.

### Systemweite Mehrsprachigkeit

Die allgemeinen Einstellungen enthalten eine Sprachkarte mit den installierten
Sprachen, sicherem JSON-Upload und Übernehmen-Aktion. Deutsch und Englisch sind
mitgeliefert, hochgeladene Kataloge bleiben updatefest im Datenverzeichnis.
Adapter können eigene Sprachdateien mitbringen; alle mitgelieferten Adapter
enthalten deutsche und englische Kataloge.

### Sicheres Self-Update

homeESS prüft im konfigurierten Intervall das neueste stabile GitHub-Release und
zeigt Administratoren eine Updateolive. Nach ausdrücklicher Bestätigung übernimmt
ein eng begrenzter, root-geführter systemd-One-shot-Helper: Er validiert das
Release erneut, bereitet es vollständig vor, schaltet erst dann um und prüft den
Neustart — bei einem Fehler wird automatisch zurückgerollt. Die Updatekarte in
den Einstellungen steuert Prüfintervall und ein optionales tägliches
Wartungsfenster für automatische Installationen.

### Zentrale States-Quelle und State-Picker

Berechnete Systemwerte und Adapter-States kommen aus einem gemeinsamen
States-Repository. Dashboard, Output und die bisherigen Wertekatalog-APIs greifen
auf dieselbe Quelle zu; gespeicherte Wert-IDs bleiben kompatibel. Der Topic-Picker
zeigt denselben Baum und blendet in reinen Schreibzielen alles aus, was nicht
schreibbar ist.

### Zentraler, ausfallsicherer Timehandler

Die Systemuhr ist die primäre Zeitquelle und wird gemäß konfigurierter Zeitzone
und Sommer-/Winterzeit ausgewertet. Ein konfiguriertes MQTT-Zeittopic liefert
einen gleitenden mittleren Versatz, der auch bei MQTT-Ausfall wirksam bleibt.
Interne Uhrzeit und Datum stehen als `system://homeess/operating.time` und
`…/operating.date` bereit.

### Adapterverwaltung

Administratoren können geprüfte ZIP-Pakete hochladen — Archivstruktur, Pfade,
Prüfsummen, Limits, Manifestwerte und JavaScript-Syntax werden geprüft, bevor ein
Adapter das produktive Verzeichnis erreicht. Instanzlose Adapter lassen sich nach
ausdrücklicher Bestätigung wieder entfernen, ohne dass Curl- oder interne Updates
sie zurückholen. Adapter können außerdem definierte Unterverzeichnisse als
`publicFiles` erklären, die homeESS nur lesend und ohne Anmeldung ausliefert.

### hDP-Adapter

Der hDP-Adapter hat die größte Einzelentwicklung dieses Releases hinter sich:

- zentraler Firmwarespeicher je Release-Kanal statt Upload je Gerät,
  Ein-Klick-Update und echter automatischer Rollout mit Wartungsfenster
- neuer Gerätetyp **ARGB-Ausgang** mit LED-genauen Einschaltkriterien, dazu
  Binary-I/O auf allen übrigen GPIOs
- optionaler Dimmschalter für Prozentanzeigen und ARGB-Ausgänge
- USB-Flashtool `hdp-flash` für Erstinbetriebnahme und OTA-verweigernde Geräte
- Geräteverwaltungen erscheinen mit ihrem Instanznamen direkt im Hauptmenü
- Geräteverwaltung, Firmwarebereich und Hardwaredialog sind auf schmalen
  Anzeigen vollständig bedienbar

## Geändert

- `README.md` ist die kompakte englische Einstiegsseite, `README_de.md` die
  deutsche Fassung; der ausführliche Funktionsumfang steht in `FEATURES.md` und
  `FEATURES_de.md`.
- Der Installer übernimmt bei leerem Ziel einen im Checkout liegenden
  `data/`-Bestand nach `/var/lib/home-ess` und hält alle veränderlichen Daten
  außerhalb des Git-Checkouts.
- Das Hauptmenü scrollt unabhängig vom festen Fußblock, sodass Einstellungen,
  Abmelden und Version auch bei geringer Bildschirmhöhe erreichbar bleiben.

## Hinweise zum Update

- Bestehende Datenbanken werden beim ersten Start automatisch migriert; neue
  Tabellen für Bedingungen, Custom States und Verzeichnisse entstehen dabei
  selbsttätig. Bestehende Automationen liegen anschließend im Wurzelverzeichnis.
- Die neue Seite **Bedingungen** ist wie jede Hauptseite je Zugang über die
  Benutzerverwaltung freischaltbar.
- Der ARGB-Ausgang setzt hDP-Firmware 0.5.0 voraus, sein Binary-I/O 0.5.1.
