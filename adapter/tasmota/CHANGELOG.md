# Changelog – Tasmota-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Frühere Änderungen bis 1.0.2 sind im
homeESS-CHANGELOG verzeichnet. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.0.3] — 2026-09-14

### Behoben

- **Schaltbefehle gehen nach einem Geräte-Neustart nicht mehr verloren.** Nach
  einem Stromausfall verbinden sich die Steckdosen neu, die alte TCP-Verbindung
  blieb im Adapter aber halb offen stehen. Befehle wurden über die älteste
  Verbindung eines Geräts gesendet und verschwanden dort ohne Fehlermeldung.
  Der Adapter verhält sich jetzt wie ein MQTT-Broker nach Spezifikation:
  - Verbindet sich eine bereits verbundene Client-ID erneut, wird die alte
    Verbindung getrennt.
  - Kommt innerhalb des 1,5-fachen Keep-Alive-Intervalls kein Paket, wird die
    Verbindung getrennt; zusätzlich ist TCP-Keepalive aktiv.
  - Befehle und Statusabfragen nutzen die jüngste Verbindung eines Geräts.
  - Ein verworfener Schaltbefehl (Gerät nicht verbunden) wird protokolliert.
