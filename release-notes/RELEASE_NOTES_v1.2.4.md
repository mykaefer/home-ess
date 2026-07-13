# homeESS v1.2.4 – Robuste Verbrauchserfassung, Mobile-Überarbeitung & Heizung/Klima nach Tageszeit

**v1.2.4** härtet die **Verbrauchserfassung der Prognose** ab (die Selbstzählung
läuft jetzt unabhängig von den Netzzählern, dazu eine echte Fehlererkennung mit
Ausgrauen und Logdatei), überarbeitet den gesamten Bereich **Messen + Schalten**
für die **Handy-Ansicht** (inkl. vertikalem Energiefluss-Diagramm und Schaltgruppen
ohne Drag & Drop) und verfeinert das Lernmodell **Heizung / Klima** zusätzlich nach
**Tagesstunde**. Enthalten ist außerdem die saubere Trennung der Wallbox-An/Aus-Kanäle.

---

## Behoben

### Prognose: Verbrauchserfassung fällt nicht mehr mit den Netzzählern aus

Die verbraucherseitige **Selbstzählung** (unabhängige Absicherung der Bilanz) lief im
Erfassungs-Job hinter einem Early-Return, der einen echten **Netzzähler**-Wert
verlangt. Fehlten die Netzzähler kurzzeitig (Verbindungsabbruch, Inselbetrieb), wurde
die eigentlich **grid-unabhängige** Selbstzählung fälschlich mit übersprungen — Bilanz
**und** Selbstzählung brachen dann gemeinsam ein, und der Absicherungs-Guard konnte
nichts ersetzen (beide waren ~0, keine Abweichung).

> **Symptom:** einzelne Stunden mit **nahezu 0 kWh** trotz laufender Verbraucher.

Neu wird die Selbstzählung **unabhängig** von den Netzzählern integriert, sobald
verbraucherseitige Leistung vorliegt. Nur die zähler-/bilanzbasierte Erfassung braucht
weiterhin einen echten Zählerwert (damit eine Start-Null den kumulierten Tageszähler
nicht neu basiert).

### Wallbox: An/Aus-Kanäle sauber getrennt – keine Rückkopplung durch die Automatik

Ein einziges Steuer-Topic diente zugleich als Aktor **und** als Rückmelde-/Bedienkanal,
sodass eigene Schalt-Readbacks bzw. der Gerätezustand nach einem Reconnect als
Nutzerschaltung fehlgedeutet wurden (Automatik sprang auf Vollladen bzw. Aus). Jetzt ist
das **Steuer-Topic ein reiner Aktor**; ein optionales **Steuerung-Sync-Topic** übernimmt
den bidirektionalen An/Aus-Schalter und wertet nur eine **extern ausgelöste** Änderung
als Bedienbefehl. Ein **Re-Baseline-Fenster (45 s)** nach jedem MQTT-(Wieder-)Verbindungs­
aufbau sorgt dafür, dass Neustart/Reconnect/Topic-Refresh nie als Schaltung gelten. Das
**Modus-Sync-Topic** hält ausschließlich den Ladeplan synchron (1 = Privat, 2 = Beruflich,
3 = Immer voll), schaltet aber nicht ein/aus.

> **Einrichtung:** In der Wallbox-Konfiguration das neue **Steuerung-Sync-Topic (an/aus)**
> eintragen. Ohne dieses Topic läuft die Ladung rein nach Automatik/Oberfläche.

### Messen + Schalten: kleinere Korrekturen

- **Zählerstand nicht mehr fälschlich „veraltet".** Der angezeigte Zählerstand ist ein
  interner, aus dem Zählerfortschritt gebildeter Wert – er ist immer bekannt und kann
  nicht veralten. Eine fehlende Verbindung zeigt sich stattdessen am neuen **Offline-Signal**
  (siehe unten).
- **Aktionen auf Touch erreichbar.** Bearbeiten/Entfernen (✎/🗑) an Geräten und Gruppen
  waren per Hover ausgeblendet und am Handy unbenutzbar; auf Touch-Geräten sind sie jetzt
  dauerhaft sichtbar. Zudem behoben: seitlich überlaufende „Sonstige Verbraucher"-Zeile
  und umbrechende Toolbar.
- **Heizung/Klima-Diagramm** sitzt wieder sauber auf einer Nulllinie.

---

## Geändert

### Heizung / Klima: mittlere Leistung je 1-°C-Fenster UND Tagesstunde

- Die Außentemperaturfenster wurden von **5 °C auf 1 °C** verfeinert; gelernt und geplant
  wird die **mittlere Leistung (W)** je Fenster statt der Energie (bis zu 30 Messtage, der
  Modellwert ist deren Mittel). Ein Fenster wird nur an Tagen belegt, an denen die
  Temperatur real auftrat → die Sommer- überschreibt die Winterkurve nicht.
- **Neu zusätzlich nach Tagesstunde:** Jedes Temperaturfenster hält für **jede der 24
  Tagesstunden** eine eigene mittlere Leistung vor, weil der Heiz-/Kühlbedarf je Tageszeit
  variiert (Kühlen v. a. abends, Heizen morgens stärker als abends). Die Prognose plant
  stundengenau; noch ungelernte Stunden fallen auf das Fenstermittel zurück.
- Das Temperatur-Balkendiagramm zeigt weiterhin das **Mittel über alle 24 Stunden**; ein
  **Klick auf einen Balken** öffnet die **24-Stunden-Kurve** dieses Fensters.

---

## Hinzugefügt

### Prognose: Fehlererkennung der Verbrauchserfassung

Kann eine Stunde nicht sauber erfasst werden (Verbindungsabbruch, fehlende Daten,
Prozess-Downtime), wird sie erkannt und als **unvollständig** markiert:

- Der Lernwert wird auf den **Vortageswert** gesetzt → es wird **keine falsche Kurve**
  mehr gelernt (die erfassten Rohwerte bleiben zur Nachschau erhalten).
- Die Stunde erscheint in der **„Datenbasis"-Ansicht ausgegraut** (schraffiert), damit
  erkennbar ist, dass hier nichts gemessen werden konnte.
- Störungen landen zusätzlich in der **Logdatei** `data/prognosis-sampling.log`.

### Prognose: gestapelter Heiz-/Kühlbedarf im Stundenprofil

Im 24-h-Stundenprofil der Tagesprognosen sitzt der erwartete Heizungs-/Klimabedarf je
Stunde als **gestapelter Balken über der Grundlast** (rein additive Anzeige – die
Grundlastberechnung bleibt unberührt).

### Mobile-Überarbeitung von „Messen + Schalten"

- **Energiefluss-Diagramm vertikal (≤ 760 px).** Statt des breiten horizontalen Flusses
  ein **schmaler Stamm mit eingerückten Zweigen**, einheitlich von oben nach unten:
  Einzel-PV-Anlagen → PV gesamt → Netz → Batterie **über** dem Eigenverbrauch, darunter
  die Verbrauchergruppen (eingerückt verschachtelt). Die Fluss-Linien laufen in eigenen
  senkrechten Kanälen **nebeneinander** (nie durch einen Knoten) und bündeln sich am
  Eigenverbrauch; die Einrückung wächst **dynamisch** mit der Gruppenzahl. Kein
  horizontales Scrollen mehr; der Desktop behält das horizontale Layout.
- **Schaltgruppen ohne Drag & Drop.** Jede Gruppe hat einen **„+ Gerät hinzufügen"**-Dialog
  (Auswahl der freien Geräte) und ein **„×"** je Zeile zum Lösen – klickbasiert und damit
  am Handy nutzbar (Drag & Drop bleibt auf dem Desktop).
- **Dediziertes „nicht verbunden"-Signal.** Schweigt die periodische Telemetrie eines
  Geräts (Leistung/Zähler) länger als 30 min, wird es sichtbar als **offline** markiert
  (roter Statuspunkt-Ring + „offline"-Kennzeichnung). Bewusst nur aus Telemetrie – ein
  lange ausgeschaltetes Gerät ist nicht offline.
- **Warnung bei unplausiblem Zähler (Wh/kWh-Gegenprobe).** Für Geräte mit Leistungs- UND
  Zähler-Topic wird zusätzlich die aus der Live-Leistung integrierte Tagesenergie geführt.
  Weicht der Zähler heute stark davon ab (typisch bei vertauschter Einheit **Wh statt kWh**,
  ein 1000×-Fehler, der Gruppensummen still auf ~0 zieht), erscheint an der Zählerzelle ein
  rotes **⚠** mit Hinweis. Die Zählung selbst bleibt unverändert.

---

## Hinweise

- **Automatische Migration.** Neue Tabellen/Spalten werden beim Start angelegt
  (`prognosis_sampling_state`, `prognosis_hourly_consumption.incomplete`,
  `mess_schalt_temperature_power.hour`, `mess_schalt_actor_state.power_energy_*`). Keine
  manuelle Aktion nötig. Das Heiz-/Klimamodell verfeinert sich beim Weiterlernen; die
  Wh/kWh-Warnung greift, sobald genügend Leistungs-Energie integriert wurde.
- **Neustart empfohlen.** Das gelernte Verbrauchsmodell wird im laufenden Dienst
  zwischengespeichert. Nach einem Neustart wird es aus den (ggf. korrigierten) Daten neu
  aufgebaut – erst dann sind die Prognosen für heute/Folgetage vollständig aktuell.
- **Logdatei.** Störungen der Verbrauchserfassung stehen künftig in
  `data/prognosis-sampling.log`.
