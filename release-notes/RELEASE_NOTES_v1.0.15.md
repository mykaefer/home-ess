# homeESS v1.0.15 – Initial Release

Mit **v1.0.15** erscheint die erste offizielle Version von homeESS. homeESS
verbindet Energiemessung, Hausakku, Photovoltaik und steuerbare Verbraucher in
einer zentralen, MQTT-basierten Oberfläche. Messwerte werden nicht nur
visualisiert, sondern auch für Prognosen und die automatische, prioritätsbasierte
Laststeuerung verwendet.

## Highlights

- Frei konfigurierbares Dashboard mit Wert- und System-Widgets
- Auswertung von Stromverbrauch, Netzbezug, Einspeisung und Eigenverbrauch
- Verwaltung mehrerer PV-Anlagen inklusive Ertragsprognose, Clear-Sky-Modell und
  automatischer Kalibrierung
- Batterieüberwachung mit Ladezustand, Leistung, Temperatur und
  batteriebereinigter Energiebilanz
- Prognosegeführte Betriebslevel zur prioritätsabhängigen Steuerung von
  Verbrauchern
- Messen und Schalten von Geräten über MQTT – inklusive Gruppen, Prioritäten,
  Automatik und phasenbezogenem Lastabwurf
- Optionale Module für Grid-Control, Poolsteuerung und mehrere Wallboxen
- Zentraler Wertekatalog für berechnete Werte und Adapter-States; darin auch
  **„Sonstige Verbraucher“** als Differenz zwischen Eigenverbrauch und bekannten
  Verbrauchergruppen

## Schnittstellen und Adapter

- MQTT-Anbindung, insbesondere für die Zusammenarbeit mit ioBroker
- Integrierte Adapter für **Homematic CCU (HM-RPC)**, **Modbus TCP** und
  **Tasmota**
- Flexible Zuordnung von Topics und Adapter-States über hierarchische,
  durchsuchbare Auswahlfelder
- Konfigurierbare Outputs zum Veröffentlichen interner Werte auf externe Topics

## Bedienung und Betrieb

- Weboberfläche mit Login und optional dauerhaftem Anmelden
- Live-Aktualisierung zentraler Mess- und Statuswerte
- Persistente Konfiguration und Historien in SQLite
- Installationsskript für die Einrichtung als Dienst

## Hinweis

Dies ist das **erste Release** von homeESS. Trotz der Versionsnummer v1.0.15
existieren daher keine früheren öffentlich veröffentlichten Versionen und keine
Upgrade-Hinweise.
