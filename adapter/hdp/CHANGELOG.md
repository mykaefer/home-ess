# Changelog – hDP-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.2.12] — 2026-08-24

### Hinzugefügt

- **Online-Firmwarekatalog.** homeESS bezieht die aktuellen hDP-Firmwarestände
  jetzt über die öffentliche Schnittstelle
  `https://www.homeess.de/wp-json/hdp-firmware/v1/firmware`. Geprüft wird beim
  ersten Aktivieren der Instanz und danach täglich; führt der Katalog in einem
  Kanal eine höhere Version, wird sie geholt, gegen die dort deklarierte
  Dateigröße und SHA-256 geprüft und der Kanal atomar ersetzt. Die neue
  Einstellung `firmwareCatalogUrl` gibt die Quelle vor, ein leerer Wert schaltet
  den Abruf ab. Downloads sind auf HTTPS beim Kataloghost beschränkt; die Geräte
  greifen nie selbst auf den Katalog zu und erhalten ihr Image weiterhin über den
  authentifizierten hDP-OTA-Pfad.
- **Knopf „Jetzt auf neue Firmware-Versionen prüfen“.** Die Firmwarekachel prüft
  auf Wunsch sofort, meldet je Kanal geholt/aktuell/Fehler und nennt den
  Zeitpunkt der letzten Prüfung. Die Kanalkarten zeigen zusätzlich die Herkunft
  des Stands und die Release Notes aus dem Katalog.

### Geändert

- **Mit der Installation kommt keine Firmware mehr mit.** Das mitgelieferte
  `bundled-firmware/`-Verzeichnis und dessen Übernahme beim ersten Start
  entfallen; der Firmwarespeicher startet leer und wird aus dem Online-Katalog
  oder von Hand befüllt. Das spart eine mit jedem Adapterupdate veraltende Kopie
  im Installationspaket.
- **Katalogschema 1 und 2.** Die Schnittstelle wurde am 24.08.2026 auf
  `schema_version: 2` gehoben und führt seither je Eintrag `signature`,
  `signature_algorithm`, `signature_key_id` und `signed_at` sowie einen
  `signing`-Block. Beide Schemata werden gelesen. Trägt ein Artefakt eine
  Signatur, wird sie gegen den hinterlegten `firmwarePublicKey` geprüft; ein
  defektes oder halbes Signaturfeld verwirft den Eintrag, damit das Weglassen
  eines Feldes die Prüfung nicht umgeht. Der vom Katalog selbst genannte
  öffentliche Schlüssel wird nie zum Vertrauensanker — er käme aus derselben
  Quelle wie das Artefakt. Meldet der Katalog eine unbekannte Schemaversion,
  nennt die Fehlermeldung sie jetzt beim Namen.
- **Ein Release darf sein Konfigurationsschema offen lassen.** Der Katalog nennt
  keines. Ist es `null`, entfällt die Vorprüfung des Adapters und der OTA-Header
  spiegelt das Schema des Geräts — das Gerät prüft die Metadaten beim Empfang
  selbst und lehnt einen unpassenden Stand mit
  `OTA_CONFIG_SCHEMA_INCOMPATIBLE` ab.

### Behoben

- **Ein Gerät ohne bestimmbares Konfigurationsschema wird nicht mehr als
  Schema 0 behandelt.** `null` und Leerstrings liefen durch `Number()` still auf
  0 und ließen damit jedes Update passieren; sie gelten jetzt korrekt als nicht
  bestimmbar.

## [1.2.11] — 2026-08-22

### Behoben

- **Gelernte IR-Codes stehen jedem Blaster zur Verfügung.** Die Bibliothek der
  aufgezeichneten Codes gehört der Adapterinstanz, wurde auf der Geräteseite
  aber nur für das aufzeichnende Gerät und nur bei einem Receiver im
  Record-Modus angezeigt. Ein Gerät mit reinem IR-Blaster sah dadurch keinen
  einzigen Code. Jede IR-Geräteseite mit aktivem Blaster listet jetzt alle
  gelernten Codes und kann sie senden; bei fremder Herkunft steht das
  aufzeichnende Gerät unter dem Namen. Umbenennen und Löschen wirken auf das
  aufzeichnende Gerät, und der Live-Refresh der Seite reagiert auf Aufnahmen
  aller Geräte.

## [1.2.10] — 2026-08-22

### Geändert

- **Die Verwaltungsseite folgt dem Farbthema des Benutzers.** homeESS bietet je
  Benutzer ein helles oder dunkles Farbthema an. Die Festfarben dieses Adapters
  laufen dafür jetzt über die Design-Tokens von homeESS (Flächen, Linien, Text
  und Zustandsfarben), sodass die Seite im dunklen Thema mitzieht, statt weiße
  Kästen mit dunkler Schrift stehen zu lassen. Im hellen Thema bleibt die
  Darstellung unverändert — die Tokens tragen dort dieselben Werte.

- **Geräteverwaltung und Geräteseite im dunklen Thema lesbar.** Betroffen waren
  vor allem die Geräteliste, die Kennzahlen je Gerät und die Abschnittstitel:
  Sie standen dunkel auf dunklem Grund. Die Hinweiszeile eines Geräts
  (`.hdp-device-alert`) nimmt jetzt die Schriftfarbe der Hinweisfamilie, aus
  der ihr Grund ohnehin schon stammt; im hellen Thema wechselt ihr Braun dabei
  von `#9a3412` auf `#854d0e` und ist damit dasselbe wie bei allen übrigen
  Hinweisen.

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
