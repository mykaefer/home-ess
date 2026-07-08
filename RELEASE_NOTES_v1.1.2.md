# homeESS v1.1.2 – Wallbox: Mindest-Ladestand Beruflich, Lade-Timing & mobile Navigation

**v1.1.2** verfeinert den Beruflich-Modus der Wallbox: Arbeitstage benötigen
nicht mehr zwingend ein volles Fahrzeug, Unterschreitungen am Arbeitstag werden
sofort nachgeladen, und vor einem freien Folgetag endet die Beruflich-Regel zu
einer einstellbaren Uhrzeit. Zusätzlich wird die mobile Navigation umgebaut
(Menü über das Titellogo, Photovoltaik als fünfter Direktzugriff in der
Tab-Bar), die PC-Titelzeile zeigt die aktuellen Leistungswerte (PV, Netz,
Verbrauch, Akku), und mobil steht der SoC als Zahl im Batteriesymbol.

## Neu

### Mindest-Ladestand Beruflich

Analog zum Mindest-Ladestand Privat gibt es je Wallbox jetzt einen
**Mindest-Ladestand Beruflich** (Default 100 % = bisheriges Verhalten „voll
bereitstellen"). Die Garantieladung vor einem Arbeitstag zielt nur noch auf
diesen Wert; der rechtzeitige Ladestart vor 06:00 Uhr wird unverändert aus
Restenergie und Ladeleistung berechnet. Oberhalb des Mindest-Ladestands wird
das Fahrzeug — genau wie im Privat-Modus — ausschließlich mit nicht
speicherbarem PV-Überschuss weitergeladen.

## Geändert

### Lade-Timing im Beruflich-Modus

- **Sofortladung am Arbeitstag:** Fällt der Ladestand AN einem Arbeitstag unter
  den Mindest-Ladestand Beruflich, wird die Ladung sofort aktiviert — nicht
  erst mit dem vorbereitenden Plan für den nächsten Tag am Abend.
- **Feierabend vor freiem Tag:** Folgt auf einen Arbeitstag ein freier Tag,
  gilt ab einer einstellbaren Uhrzeit (**„Privatregel ab (Uhr) vor freiem
  Folgetag"**, Default 18 Uhr) nur noch die Privatregel — wie an
  Nicht-Arbeitstagen.
- Der gemeinsame Vorausplan für Prognose und Automatik plant entsprechend:
  Pflicht ist nur die Energie bis zum Mindest-Ladestand Beruflich (am
  Arbeitstag sofort, sonst bevorzugt aus Überschuss und ab der Garantiezeit des
  Vorabends erzwungen), der Rest bis Voll ausschließlich aus PV-Überschuss.

### Mobile Navigation: Menü über das Titellogo

- Der **Menü-Tab in der unteren Leiste entfällt**. Das homeESS-Titellogo im
  Header übernimmt am Smartphone die Funktion der Menüschaltfläche und öffnet
  das vollflächige Menü-Sheet; am Desktop bleibt das Logo funktionslos.
- Das Logo im Menü-Sheet hat jetzt dieselbe Größe wie im Titel.
- Die untere Tab-Bar zeigt fünf Direktzugriffe: Dashboard, Strom,
  **PV (Photovoltaik, neu auf Position 3)**, Batterie (Position 4) und
  Prognose (Position 5).

### Kopfzeile: aktuelle Leistungswerte (PC) & SoC im Akkusymbol (mobil)

- Die Titelzeile der PC-Ansicht zeigt vier Momentanwerte in einer gemeinsamen
  Pill: **☀️ PV**, **⚡ Netzbezug** (negativ = Einspeisung), **🏠
  Eigenverbrauch** (inkl. verbraucherseitiger PV) und **🔋 Akkuladung**
  (negativ = Entladung) — Piktogramme statt Beschriftung, transparente Pill
  mit Umrandung, Werte in aufgehellten Header-Varianten der einheitlichen
  Leistungsfarben. Aktualisierung live wie die übrigen Kopfzeilenwerte.
- In der mobilen Ansicht steht der prozentuale SoC jetzt klein, weiß und
  mittig **im** Batteriesymbol statt daneben.

## Migration

Bestehende Datenbanken erhalten die neuen Spalten automatisch
(`min_charge_business_percent` Default 100, `business_end_hour` Default 18);
ohne Anpassung der Einstellungen bleibt das Verhalten wie in v1.1.1 — lediglich
die Sofortladung bei Unterschreitung am Arbeitstag und das Feierabend-Fenster
vor freien Tagen kommen hinzu.
