# homeESS v1.1.1 – Wartungsrelease

**v1.1.1** ist ein Wartungsrelease mit drei Korrekturen an Wallbox, Grid-Control
und der Prognose-Datenbasis sowie neuen, einstellbaren Guard-Schwellen in den
Modellparametern der Prognose.

## Behoben

### Wallbox: „nicht angesteckt" blockiert die Ladefreigabe nicht mehr

Manche Fahrzeuge erkennen den Stecker erst, nachdem die Wallbox die Ladung
freigegeben hat (Henne-Ei-Problem). Das „angesteckt"-Signal dient jetzt
ausschließlich der Ladeüberwachung: angesteckt + Ladung aktiv + SoC unter Voll
⇒ Leistung muss fließen, sonst greift die bestehende Aus-/Ein-Neustart-Schleife.
Ist laut Plan oder Anforderung eine Ladung erforderlich, wird immer
eingeschaltet — unabhängig vom „angesteckt"-Status. Konkret verwarf der
gemeinsame Vorausplan bei „nicht angesteckt" den kompletten Ladebedarf
(Überschussladung blieb dauerhaft aus), und die einmalige Volladung nach
manuellem Einschalten wurde sofort wieder abgebrochen.

### Grid-Control: kein Aus-/Ein-Takten des Netz-Schützes nach einem Neustart

Nach einem Neustart konnte ein eingeschaltetes Netz kurz aus- und sofort wieder
eingeschaltet werden (unnötige Schützbelastung). Jetzt gilt: erst Ist-Werte
abfragen, dann steuern.

- Kein Aus-Befehl, solange die Broker-Rückmeldung des Ziel-Schützes unbekannt
  ist (Ein-Befehle bleiben erlaubt — sicherheitsgerichtet).
- Meldet der Broker das Netz beim Start als EIN, gelten die SoC-/
  Spannungs-Hysteresefenster als „ausgelöst": Messwerte im Hystereseband halten
  das Netz wie vor dem Neustart.
- Unvollständige Messwerte (SoC, Spannung, Temperaturwarnung, Lasten L1–L3)
  schalten ein laut Broker eingeschaltetes Netz nie aus; fehlende Messwerte
  halten zudem den letzten Fensterzustand — auch bei Sensor-/Adapterausfall im
  laufenden Betrieb.
- Die Ausschaltverzögerung der Wechselrichterlast wird in jedem Fall auch über
  Neustarts eingehalten.

### Prognose: Bilanz-Datenbasis tagsüber massiv überhöht

Der kumulierte bilanzbasierte Eigenverbrauch pendelt beim Akku-Laden minütlich
auf und ab (PV-, Netz- und Akkuzähler schreiten nicht exakt synchron fort). Die
Stundenlernung übernahm bisher nur positive Deltas und wirkte dadurch wie ein
Gleichrichter: Das Pendeln wurde als Schein-Verbrauch in die PV-/Ladestunden
gepumpt (real belegt: Bilanz-Stunden bis über 2,5× der Selbstzählung, rund
+4 kWh/Tag). Kleine negative Deltas werden jetzt gegengerechnet; die Bilanz
folgt wieder dem tatsächlichen Verbrauch. Große Rücksprünge gelten unverändert
als verspäteter Zähler-Reset.

## Neu

### Guard-Schwellen Bilanz ↔ Selbstzählung als Modellparameter

Die Schwellen, ab denen eine abgeschlossene Bilanz-Stunde durch die
Selbstzählung ersetzt wird, sind jetzt auf der Prognoseseite einstellbar:

- **Max. Abweichung Bilanz ↔ Selbstzählung (%)** — relative Schwelle,
  1–100 %, Standard 25 %.
- **Mindest-Abweichung (kWh)** — absolute Schwelle, 0–5 kWh, Standard 0,2;
  0 bedeutet: allein die relative Schwelle entscheidet.

Der Guard ersetzt nur, wenn beide Schwellen überschritten sind; mit echtem
Eigenverbrauchszähler greift er weiterhin nicht.

## Hinweise zum Update

- Die Datenbank wird beim ersten Start automatisch migriert (zwei neue Spalten
  in `prognosis_config`); bestehende Lerndaten bleiben erhalten.
- Kein Konfigurationsaufwand nötig — die neuen Modellparameter starten mit den
  bisherigen Standardwerten (25 % / 0,2 kWh).
