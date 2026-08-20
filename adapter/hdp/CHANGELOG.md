# Changelog – hDP-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.2.9] — 2026-08-17

### Behoben

- **Nicht erreichbare Geräte werden nicht mehr als säumige WebSocket-Partner
  gemeldet.** Die Bibliothek `ws` fasst TCP-Aufbau und HTTP-Upgrade unter einem
  gemeinsamen Timeout zusammen; bislang wurde daraus in jedem Fall die Meldung
  „Das Gerät hat den WebSocket-Upgrade nicht innerhalb von 3000 ms beantwortet.“
  Bei einem Gerät, das gar nicht mehr im Netz ist, ist das eine Aussage, die es
  so nicht treffen kann — die Fehlersuche begann dadurch bei der Firmware statt
  beim Gerät. Kam die TCP-Verbindung nachweislich nicht zustande, meldet der
  Adapter jetzt „nicht erreichbar (keine TCP-Verbindung innerhalb von 3000 ms)“
  samt Zieladresse.

## [1.2.8] — 2026-08-16

### Geändert

- **Mitgelieferte Stable-Firmware auf 0.7.4 angehoben.** Der Stand 0.7.3 konnte
  `GET /api/v1/manifest` bei knappem Heap abgeschnitten ausliefern — mit einer
  `Content-Length`, die zur gekappten Länge passte, sodass die Antwort erst beim
  Parsen als „Ungültige JSON-Antwort (HTTP 200)“ auffiel und der Manifestabgleich
  nach jedem Verbindungsaufbau scheiterte. 0.7.4 liefert das Manifest wieder
  vollständig aus. Ein bereits vorhandener, lokal gepflegter Stable-Kanal wird
  wie bisher nicht überschrieben; die Anhebung wirkt für Neuinstallationen und
  für Bootstraps, die weiterhin von homeESS verwaltet werden.

## [1.2.7] — 2026-08-16

### Hinzugefügt

- **Stable-Firmware wird mit dem Adapter ausgeliefert.** Der geprüfte Stand
  0.7.3 für ESP8266/D1 Mini liegt im Adapterpaket und initialisiert beim ersten
  Start automatisch den lokalen Stable-Kanal. Spätere Paketstände aktualisieren
  nur einen weiterhin von homeESS verwalteten Bootstrap; ein manuell gepflegter
  Stable-Kanal wird nicht überschrieben.
- **Signierte HTTPS-Releasequelle.** Eine konfigurierte Basis-URL wird beim
  Start und danach alle sechs Stunden nach Stable-, Beta- und Development-
  Releases abgefragt. Remote-Artefakte gelangen erst nach Größen-, SHA-256- und
  zwingender Ed25519-Prüfung atomar in den lokalen Store. Die hDP-Geräte selbst
  benötigen weiterhin keinen Internetzugriff.

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
