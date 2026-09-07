# Changelog – HM-RPC-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.1.6] — 2026-08-30

### Behoben

- **Eine kurz beschäftigte CCU gilt nicht mehr als abgerissene Verbindung.** Der
  Schnittstellenprozess der CCU arbeitet Aufrufe faktisch seriell ab: Während er
  einen Funkbefehl an ein stummes Gerät bis zu dessen Geräte-Timeout abarbeitet,
  beantwortet er gar nichts — auch nicht den trivialen Schnittstellen-Ping des
  Prüflaufs. Bisher genügte diese **eine** Zeitüberschreitung, um die Verbindung
  als getrennt zu melden; bis zum nächsten Prüfintervall wurden danach die
  Steuerbefehle aller Geräte mit „verworfen: CCU nicht verbunden" abgewiesen.
  Genau das ließ Lichter sporadisch nicht schalten und die Schnittstelle
  zwischendurch auf „getrennt" springen. Der Prüflauf trennt jetzt erst nach
  mehreren Transportfehlern in Folge — derselbe Maßstab, den der Lesepfad schon
  anlegt — und zählt einen Fehlschlag gar nicht, solange ein eigener
  Steuerbefehl die CCU nachweislich blockiert.

- **Ein Schaltbefehl scheitert nicht mehr am Verbindungsmerker.** Der Merker
  beschreibt die Event-Registrierung, nicht die Erreichbarkeit — ein `setValue`
  nimmt die CCU auch ohne sie an. Stand er (etwa nach einer Zeitüberschreitung)
  falsch, ging der Klick des Nutzers ersatzlos verloren. Jetzt entscheidet ein
  kurzer Erreichbarkeitstest: Antwortet die Schnittstelle, geht der Befehl raus
  und die Verbindung wird nebenbei wiederhergestellt. Nur eine wirklich
  unerreichbare CCU führt noch zum Verwerfen — mit entsprechender Meldung.

- **Nach einem Verbindungsverlust wird sofort neu verbunden**, statt bis zum
  nächsten Prüfintervall (voreingestellt 30 s) zu warten. So bleibt das Fenster
  kurz, in dem Schaltbefehle den Umweg über den Erreichbarkeitstest nehmen.

- **Verbindungswechsel stehen jetzt im Protokoll.** Aufbau und Verlust der
  CCU-Verbindung wurden bisher nur an die Oberfläche gemeldet und waren im Log
  nirgends sichtbar — ein sporadisches „getrennt" ließ sich dadurch nicht
  nachvollziehen.

### Geändert

- **Weniger gleichzeitige Last auf der CCU.** Die aktive Nachbeobachtung nach
  einem Steuerbefehl fragt die Kanäle eines Geräts nacheinander ab statt alle
  gleichzeitig, und der Hintergrund-Refresh pausiert, solange ein eigener
  Steuerbefehl die Schnittstelle blockiert. Ein Bündel paralleler Lesungen wurde
  von der CCU ohnehin seriell abgearbeitet und trieb nur die hinteren Aufrufe in
  ihr Zeitlimit.

## [1.1.5] — 2026-08-28

### Behoben

- **Ein einzelnes stummes Gerät legt nicht mehr die ganze CCU-Anbindung lahm.**
  Quittierte die CCU einen Steuerbefehl mit einem Fehler (typisch
  „Generic error (UNREACH)" bei einem funktechnisch nicht erreichbaren Gerät),
  hat der Adapter das als Verbindungsabbruch gewertet und die Schnittstelle als
  getrennt gemeldet. Bis zum nächsten Reconnect wurden dann die Steuerbefehle
  **aller** Homematic-Geräte mit „verworfen: CCU nicht verbunden" abgewiesen —
  die Geräte ließen sich sporadisch nicht mehr schalten, obwohl ihr Zustand
  weiter korrekt angezeigt wurde. Ein CCU-Fehler mit XML-RPC-Fehlercode gilt
  jetzt als Geräteproblem und lässt die Verbindung unangetastet; bei einem
  Transportfehler (Abbruch, Zeitüberschreitung) entscheidet ein lokaler
  Schnittstellen-Ping, ob wirklich die Verbindung tot ist. Dieselbe
  Unterscheidung trifft der Lesepfad schon länger.

- **Steuerbefehle bekommen ein eigenes, längeres Zeitlimit (30 s).** Ein
  Funkbefehl wird von der CCU erst nach ihrem eigenen Geräte-Timeout quittiert;
  mit dem Zeitlimit für lokale Aufrufe (10 s) galt ein noch laufender Befehl an
  ein träges Gerät regelmäßig als Fehler.

- **Ein unbestätigter Steuerbefehl lässt sich wiederholen.** Der geschriebene
  Wert wird optimistisch gemerkt, damit ein unveränderter Wert keinen erneuten
  Funkbefehl auslöst. Blieb das bestätigende Readback-Event aus (Befehl kam beim
  Gerät nie an), war das Gerät in diese Schaltrichtung dauerhaft und stumm
  blockiert: Jeder weitere Klick lief in den Wertvergleich. Ein nur optimistisch
  gemerkter Wert sperrt die Wiederholung jetzt nur noch 30 Sekunden lang; ein
  per Event bestätigter Wert weiterhin dauerhaft.
