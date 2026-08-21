# Changelog – InfluxDB-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.0.1] — 2026-08-21

### Hinzugefügt

- **Knopf „Als Standard-Datenbank für homeESS übernehmen".** Auf der
  Einstellungsseite einer Instanz kopiert er Protokoll, Server, Port,
  Datenbank und Zugangsdaten in die zentrale Datenbankanbindung von homeESS
  (Einstellungen → Allgemein → Datenbank) und schaltet sie ein. Diagramme und
  Auswertungen lesen danach aus dieser Datenbank. Die Übernahme ist eine
  einmalige Kopie der **gespeicherten** Instanz-Einstellungen; spätere
  Änderungen wirken erst nach erneuter Übernahme. Umgesetzt über das neue
  Manifest-Feld `systemDatabase`, das homeESS für beliebige Datenbank-Adapter
  auswertet.

## [1.0.0] — 2026-08-11

### Hinzugefügt

- **Historie ausgewählter States in einer InfluxDB 1.x.** Der Adapter abonniert
  die im Eigenschaften-Dialog eines States ausgewählten Werte und schreibt sie
  im Line Protocol über die HTTP-Schnittstelle. Zahlen bleiben Zahlen, Booleans
  werden `true`/`false`, alles andere wird als Textfeld abgelegt.
- **Eigener Tab im Eigenschaften-Dialog eines States.** Das Manifest liefert
  das Startschema, zur Laufzeit meldet der Adapter es über
  `host.setStateOptionsSchema()` erneut — dann mit dem Datenbanknamen in der
  Überschrift und den in der Datenbank tatsächlich vorhandenen
  Aufbewahrungsregeln zur Auswahl. Einstellbar sind DB-Alias (Messreihe),
  Speichern bei Wertänderung oder in festen Abständen, Entprellzeit
  (Standard 5 Sekunden) und Keepalive (Standard 730 Tage).
- **Trennung mehrerer Instanzen über das Tag `instance`.** Jeder Messpunkt
  trägt den Instanznamen als Tag; da ein Tag zum Serienschlüssel gehört,
  schreiben zwei Instanzen auch in derselben Datenbank und mit demselben Alias
  in getrennte Serien. Abschaltbar, wenn mehrere Instanzen bewusst dieselbe
  Serie füllen sollen.
- **Aufbewahrung über Retention Policies.** Je Keepalive-Dauer legt der Adapter
  bei Bedarf eine eigene Policy an (`homeess_730d`, `homeess_30d`, …) und
  schreibt gezielt hinein. `0` Tage bedeutet unbegrenzte Aufbewahrung.
- **Mitgeliefertes Installationsskript `install-influxdb.sh`.** Es installiert
  das Paket, startet den Dienst, legt Datenbank, Benutzer und
  Aufbewahrungsregel an und schaltet die Anmeldung ein. Mehrfach ausführbar,
  überschreibt nichts Vorhandenes. Das Kennwort wird verdeckt abgefragt oder
  aus `INFLUX_SETUP_PASSWORD` gelesen — es steht nie in der Befehlszeile.
- **Ersteinrichtung über die Verwaltungsseite.** Sie wird nur angeboten, wenn
  ein lokaler Server eingetragen ist, noch keine InfluxDB installiert ist und
  keine Verbindung besteht — sonst bleibt sie zum Schutz vorhandener Daten
  ausgeblendet. homeESS läuft unprivilegiert, deshalb nennt die Seite den
  fertigen Befehl für die Root-Konsole; danach genügt „Verbindung prüfen".
  Läuft der Adapter ausnahmsweise mit Rootrechten, startet er dasselbe Skript
  auf Knopfdruck selbst und zeigt den Fortschritt an.
- **Einbinden bestehender Installationen**, auch auf einem anderen Server. Eine
  fehlende Datenbank wird auf Wunsch angelegt. Mehrere Instanzen bespielen
  mehrere Datenbanken parallel.
- **Pufferung bei Ausfall.** Messpunkte warten in einer begrenzten
  Warteschlange und gehen nach der Wiederverbindung raus; überzählige werden
  verworfen und gezählt.
- **Diagnose-States** unter der Kategorie „InfluxDB": Verbindung, historisierte
  States, geschriebene, wartende und verworfene Messpunkte.
- **Sprachdateien** für Deutsch und Englisch.

### Voraussetzungen

- homeESS ab 1.4.5 (`stateOptions` im Manifest und `host.listStateOptions()`).
  Es sind keine Änderungen an homeESS oder seinem Installer nötig.
- InfluxDB 1.x; InfluxDB 2.x/3.x wird nicht unterstützt.
