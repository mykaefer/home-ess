# homeESS v1.4.3 – Sensoren und Fingerabdruckleser über hDP

**v1.4.3** erweitert das hDP-Protokoll um zwei Gerätetypen. Neben Prozentanzeige,
ARGB-Ausgang und Binary-I/O binden hDP-Geräte jetzt auch lokale Messfühler und
R503-kompatible Fingerabdruckmodule ein — ohne MQTT und ohne Pfadkonfiguration,
wie gewohnt direkt über die Geräteverwaltung. Bestehende Geräte laufen
unverändert weiter.

Weil sich dabei die Endpunkte des hDP-Adapterprotokolls erweitert haben, steigt
der Adapter ausnahmsweise gemeinsam mit der Anwendung: von 1.1.3 auf **1.2.0**.

## Hinzugefügt

### Gerätetyp `sensors`

Ein Gerät im Laufzeitprofil `sensor-reading-v1` liest bis zu acht lokale
Messfühler:

- DHT11 und DHT22 — Temperatur, Luftfeuchtigkeit
- DS18B20 — Temperatur
- BME280 — Temperatur, Luftfeuchtigkeit, Luftdruck
- SHT30 und SHT31 — Temperatur, Luftfeuchtigkeit
- BH1750 — Beleuchtungsstärke
- INA219 — Bus- und Shuntspannung, Strom, Leistung
- HX711 — Rohwert einer Wägezelle
- VL53L0X — Entfernung
- Analogeingang A0 — Rohwert

Alle I²C-Fühler teilen sich ein gemeinsames SDA/SCL-Paar, das gegen die GPIOs
der übrigen Sensoren und der Binary-I/O abgegrenzt wird. Jeder Fühler hat sein
eigenes Messintervall. GPIOs, die kein Sensor belegt, bleiben als Binary-I/O
nutzbar.

Die Messwerte kommen als ganze Zahlen in Basiseinheiten vom Gerät —
Millicelsius, Millipercent, Pascal, Millilux, Mikrovolt, Mikroampere,
Mikrowatt, Millimeter. Die Umrechnung in die angezeigte Einheit übernimmt der
Adapter, sodass das Gerät keine Fließkommazahlen übertragen muss.

### Gerätetyp `fingerprint_reader`

Ein Gerät im Laufzeitprofil `fingerprint-event-v1` bindet ein R503-kompatibles
Fingerabdruckmodul über einen 3,3-V-TTL-UART ein. Es beherrscht Anlernen,
Erkennen, Löschen einzelner Vorlagen und einen LED-Ring mit fünf frei
konfigurierbaren Szenen (`idle`, `scanning`, `success`, `failure`,
`enrolling`).

Eine erkannte Vorlage wirkt wie ein einzelner Tasterdruck: Sie kann einen State
umschalten, einen festen Wert schreiben oder einen Zähler fortschreiben.

Die Vorlagen selbst liegen ausschließlich im Modul und verlassen es nie.
homeESS speichert dazu nur Name, Ziel-State und Aktion — ein Zurückrechnen auf
den Fingerabdruck ist aus diesen Daten nicht möglich.

Empfohlen wird die UART-Belegung RX GPIO 13 / TX GPIO 15: Nur dort verwendet
die Firmware den nativen, umgelegten UART des ESP8266 mit Hardwarepuffer. Jedes
andere Pinpaar landet auf einem software-getakteten UART, der unter WLAN-Last
Pakete verliert.

### Messwerte auf States verknüpfen

Die Sensorgeräteseite führt je Sensor und Messgröße ein State-Feld. Bei jeder
Messung schreibt der Adapter den fertig umgerechneten Wert dorthin.

Welche Messgrößen zur Auswahl stehen, ergibt sich aus dem Sensortyp und nicht
aus der zuletzt eingetroffenen Messung — die Verknüpfung lässt sich also
anlegen, bevor der erste Wert da ist. Ohne Verknüpfung bleibt ein Messwert wie
bisher im Zustandskatalog des Adapters sichtbar und über den State-Picker
erreichbar.

### Neue Protokollnachrichten und Endpunkte

Zum Gerät gehen `sensor.status.get` sowie `fingerprint.status.get`,
`fingerprint.enroll.begin`, `fingerprint.enroll.cancel` und
`fingerprint.template.delete`. Alle tragen die Konfigurationsrevision und
werden bei Abweichung abgelehnt, damit ein Befehl nicht auf eine inzwischen
geänderte Hardwarekonfiguration trifft.

Vom Gerät kommen `sensor.sample` und `sensor.status` sowie
`fingerprint.status`, `fingerprint.match` samt Konfidenz,
`fingerprint.unknown`, `fingerprint.enroll.status` mit den Stufen des
Anlernvorgangs, `fingerprint.template.deleted` und
`fingerprint.command.accepted`.

Die Geräteverwaltung bietet dazu `POST …/fingerprints/enroll`,
`POST …/fingerprints/cancel` und `POST …/fingerprints/delete/<id>`.

### Konfigurationsschema 5

Die Hardwarekonfiguration trägt jetzt die Sensorliste, die UART- und
Wakeup-Belegung des Fingerabdrucklesers sowie dessen LED-Szenen. Ein Gerät
lehnt den Wechsel auf einen Releasekanal ab, dessen Firmware ein älteres Schema
führt — eine bereits gespeicherte Konfiguration ließe sich sonst nicht mehr
lesen.

## Geändert

### Gerätestatus und Update-Automatik überall gleich

Verbindung, WLAN-Signal, hDP-Version, IP-Adresse, Laufzeit, Resetgrund, freier
Speicher, Konfigurationsrevision und Firmwarestand stehen jetzt auf jeder
Geräteseite in derselben Statuskachel — auch bei Sensoren und
Fingerabdrucklesern, wo sie bisher fehlten. Gerätetypspezifische Angaben stehen
darunter statt an ihrer Stelle.

Ebenso führen alle Geräteseiten denselben Abschnitt für Updatepolitik,
Releasekanal, Wiederholungsversuche und Wartungsfenster.

## Behoben

### Die Geräteseite für Sensoren war nicht aufrufbar

Sie trug die Auto-Aktualisierung des Fingerabdruck-Anlernens, deren
Zustandsprüfung dort nicht existiert; der Aufruf endete mit
`status is not defined`. Die Auto-Aktualisierung sitzt jetzt auf der
Fingerabdruckseite, für die sie gedacht ist — dort hatte sie zuvor gefehlt,
sodass der Anlernfortschritt nie nachgeladen wurde.

### Der Releasekanal sprang beim Speichern zurück

Die Updateeinstellungen wurden bei jedem Speichern vollständig aus dem Formular
neu gebildet. Geräteseiten ohne Updateabschnitt schickten keine entsprechenden
Felder mit, worauf die Vorgabewerte griffen: Der Kanal fiel auf „Stabil“
zurück, dazu Updatepolitik, Wiederholungsversuche, Wartungsfenster und das
Nachholen nach Wiederkehr. Anschließend prüfte der Adapter gegen ein Release
mit älterem Konfigurationsschema und meldete „Kein Update verfügbar“.

Fehlende Felder gelten jetzt als „keine Aussage“ und lassen den gespeicherten
Wert unverändert.

### Verwaiste Vorlagenzuordnungen ließen sich nicht entfernen

Die Vorlagenliste vereinigt die Belegung des Moduls mit den in homeESS
gespeicherten Zuordnungen. Fehlte die Vorlage im Modul, blieb die Zuordnung
sichtbar, ihr Löschknopf lief aber ins Leere. Meldet das Gerät die Vorlage als
nicht belegt, wird die verwaiste Zuordnung jetzt aufgeräumt.

## Hinweise zum Update

Die neuen Gerätetypen setzen eine Gerätefirmware mit **Konfigurationsschema 5**
voraus. Ältere Firmware meldet sie nicht als unterstützt; solche Geräte
erscheinen unverändert mit ihrem bisherigen Typ und lassen sich weiter
verwenden. Die passenden Firmwareartefakte werden wie gewohnt über die
Geräteverwaltung hinterlegt und von dort installiert.

Vorhandene Geräte, Bindungen und Automationen bleiben unberührt; an der
Datenbank ändert sich nichts. Ein Zurückrollen auf v1.4.2 ist möglich, solange
kein Gerät als `sensors` oder `fingerprint_reader` konfiguriert wurde — deren
Zuordnungen kennt die Vorversion nicht.

Der hDP-Adapter steigt in diesem Zug auf 1.2.0. Er wird sonst unabhängig
gepflegt; hier folgt die Nebenversion den erweiterten Protokollendpunkten.
