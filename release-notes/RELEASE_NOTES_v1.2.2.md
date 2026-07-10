# homeESS v1.2.2 – Zuverlässige Poolsteuerung & träge Temperaturfenster

**v1.2.2** ist ein Wartungs-Release mit zwei Fehlerbehebungen und einer
Verbesserung am Lernverhalten der Prognose. Im Mittelpunkt steht die
**Poolsteuerung**: Solar- und Filterpumpe schalten jetzt zuverlässig, weil die
Automatik sich am tatsächlichen Pumpenstatus orientiert statt an ihrem internen
Soll-Glauben. Außerdem erscheint das Bedarfsdiagramm Heizung/Klima korrekt, und
die gelernten Außentemperatur-Fenster werden träge nachgezogen statt hart
überschrieben.

## Behoben

### Poolsteuerung: Pumpen schalten zuverlässig

- Die Automatik vertraute bisher nur ihrem **internen Soll-Glauben**
  (`solar.output` / `filter.output`) und unterdrückte über `if (output !== target)`
  jeden erneuten Schaltbefehl. Wich der echte Pumpenzustand davon ab – etwa durch
  einen verlorenen Schaltbefehl, externes Schalten an der CCU oder einen
  CCU-Neustart – blieb die Pumpe dauerhaft im falschen Zustand. Über „Messen +
  Schalten" ließ sich dasselbe Gerät korrekt schalten, aus der Poolsteuerung nicht.
- Beide Pumpen gleichen ihre Entscheidung jetzt gegen das tatsächliche
  **Status-Topic** ab und senden bei Abweichung nach – gedrosselt über die
  bestehende **2-Minuten-Haltesperre** (kein Funk-Spam). Ein **Moduswechsel
  (An/Aus)** hebt die Drossel sofort auf, damit die Handbedienung unmittelbar wirkt.
  Ohne Status-Topic gilt weiterhin der interne Soll-Zustand.

### Poolsteuerung: veralteter Lastabwurf sperrt nicht mehr aus

- Der Grid-Control-Lastabwurf wird für die Schaltentscheidung nur noch
  berücksichtigt, **solange er wirklich aktiv ist** (`loadShedActive`). Ein alter
  Cutoff aus einer beendeten Grid-Control-Phase konnte die Pumpe zuvor dauerhaft
  aussperren (die Steuerung sendete dann „aus" statt „an"). Das Verhalten ist jetzt
  **konsistent zu Messen+Schalten und Wallbox**.
- Hand-„An"/„Aus" übersteuert das Betriebslevel wie in
  [LEVEL_HANDLING.md](../LEVEL_HANDLING.md) vorgesehen.

### Prognose: Bedarfsdiagramm Heizung/Klima

- Der Platzhalter behauptete fälschlich, es brauche gemessenen *Verbrauch*. Eine
  gemessene **0,0 kWh** ist eine gültige Beobachtung eines Temperaturfensters. Das
  Diagramm erscheint jetzt, sobald Messwerte in ein Fenster einfließen oder eine
  Außentemperatur vorliegt; der Platzhalter bleibt nur, wenn weder Temperatur noch
  Messdaten vorliegen.

## Geändert

### Prognose: Temperaturfenster ziehen träge nach

- Die gelernten **Außentemperatur-Buckets** für Heizung/Klima werden je
  Fenster/Stunde als **gleitender Mittelwert (EWMA)** über die Messreihe
  nachgezogen, statt bei jeder neuen Messung hart überschrieben zu werden – analog
  zum recency-gewichteten Wochentag-Grundverbrauch. Bewusst über die **Messreihe**
  des Fensters statt über den Kalender, damit ein nur im Winter belegtes Fenster
  über den Sommer nicht „vergisst".

## Hinweise

- Datenbank-Migrationen sind nicht erforderlich.
- Ab diesem Release liegen alle Release-Notes im Verzeichnis
  [`release-notes/`](.) statt im Projekt-Stammverzeichnis.
