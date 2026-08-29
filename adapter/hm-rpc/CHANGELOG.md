# Changelog – HM-RPC-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

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
