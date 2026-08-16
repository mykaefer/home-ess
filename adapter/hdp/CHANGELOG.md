# Changelog – hDP-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.2.6] — 2026-08-16

### Hinzugefügt

- **IR-Transceiver-Unterstützung.** Receiver, Blaster und kombinierte Geräte
  lassen sich mit geprüfter GPIO- und Trägerkonfiguration betreiben. Empfangene
  Codes können an States durchgereicht oder dauerhaft aufgezeichnet, benannt,
  umbenannt, gelöscht und über Oberfläche oder Blaster-State gesendet werden.
  Die Geräteverwaltung bietet dafür eine responsive Aufnahme- und Codebibliothek.

### Geändert

- **Einheitliche State-Bezeichner.** Veröffentlichte hDP-Adressen, Namen und
  Kategorien verwenden ausschließlich Unterstriche als Worttrenner; globale
  IR-Aufzeichnungen liegen unter `ir_recordings/<name>`.

### Behoben

- **Automatischer Wiederanlauf nach einem verpassten Binding-Abgleich.** Ein
  unverändertes mDNS-Lebenszeichen startet den Abgleich erneut, wenn einem aktiv
  gekoppelten Gerät weiterhin die Laufzeitverbindung fehlt.
- **Impulsabstand des Richtungsindikators wirkte allein nicht.** Die Timeline
  wurde ausschließlich über den Hash ihres Programms wiedererkannt, der
  Impulsabstand steckt aber allein in der Schleifendauer und nicht im Programm.
  Eine Änderung nur am Impulsabstand ergab deshalb dieselbe Timeline-ID und
  wurde vom Ausgang als bereits aktiv abgetan — der neue Wert erreichte das
  Gerät erst, wenn zusätzlich die Durchlaufzeit geändert wurde und damit das
  Programm selbst. Die Schleifendauer geht jetzt in Timeline-ID und
  Gleichheitsprüfung ein.
