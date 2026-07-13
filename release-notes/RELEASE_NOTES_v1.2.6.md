# homeESS v1.2.6 – Wallbox-Automatik bleibt Automatik & korrekte PV-Ertragszählung

**v1.2.6** behebt eine Rückkopplung im Wallbox-Modul: Wenn homeESS die Ladung
automatisch freigibt und das Steuerung-Sync-Topic diese aktive Ladung meldet,
wechselt die Steuerung nicht mehr fälschlich auf **Vollladen**. Erlaubtes
Überschussladen, z. B. im Beruflich-Modus oberhalb des Mindest-Ladestands, bleibt
weiterhin Automatikbetrieb. Außerdem werden die **PV-Ertrags-Topics** jetzt korrekt
als kumulative Rohzähler ausgewertet (nur Zuwächse zählen), inklusive einer
Einheiten-Einstellung (Wh/kWh) je Anlage. Und die **Verbrauchsprognose** rechnet
die **Pool-Solarpumpe** nicht mehr auf einen unrealistischen Ganztagsbetrieb hoch —
Laufzeit aus dem Clear-Sky-Sonnenstand, Leistung aus einer neuen konfigurierbaren
Nennleistung je Pumpe.

---

## Behoben

### Wallbox: Automatik-Schaltungen am Steuerung-Sync-Topic bleiben Automatik

Das **Steuerung-Sync-Topic** wird weiterhin zur Anzeige verwendet, ob eine
Ladung aktiv ist. Diese Signalisierung darf aber nicht selbst zur
Bedienaufforderung werden.

Bisher konnte ein von homeESS ausgelöster Automatik-Start so aussehen wie ein
manuelles Einschalten am entfernten Topic: Die Steuerung wechselte dadurch auf
**Vollladen** und hebelte die Automatik aus.

Jetzt zählt ein Sync-Wertwechsel nur noch als Nutzerbefehl, wenn er dem aktuellen
Automatikplan widerspricht:

- Automatik will laden und `sync=on` kommt zurück: bleibt **Automatik**.
- Automatik will ausschalten und `sync=off` kommt zurück: bleibt **Automatik**.
- Beruflich darf oberhalb des Mindest-Ladestands per Überschuss laden: bleibt
  **Automatik**.
- Nach einem eigenen Automatik-Schaltbefehl meldet dasselbe Topic kurz darauf
  `off`, weil kein Fahrzeug angesteckt ist und keine aktive Ladung entsteht:
  bleibt **Automatik**, keine manuelle Aus-Sperre.
- Live-Überschuss ist gedeckt, der vorausschauende Ladeplan sieht aber gerade
  keinen flexiblen Überschuss: die Wallbox bleibt **an**. Echter Überschuss geht
  vor Ladeplan.
- Nutzer schaltet das entfernte Topic gegen den Automatikzustand: weiterhin
  **Vollladen** bzw. **Aus**.

Wichtig bei der Einrichtung: Wird dieselbe physische Wallbox zusätzlich unter
**Messen + Schalten** zur Leistungserfassung angelegt, dort nur Mess- oder
Zähler-Topics verwenden. Das Wallbox-Steuerung-Sync-Topic und das Wallbox-
Steuer-Topic dürfen nicht gleichzeitig als Schalt-/Remote-Topic in
**Messen + Schalten** stehen, sonst kann diese zweite Gerätesteuerung wieder
Aus-Befehle auf die Wallbox-Automatik schreiben.

### Photovoltaik: Ertrags-Topics werden als Rohzähler ausgewertet

Der Wert des PV-Ertrags-Topics wurde bisher **direkt als „Ertrag heute"**
übernommen — das setzt einen Tageszähler voraus, der um Mitternacht auf 0
zurückspringt. Bei einem **kumulativen Zählerstand** (Gesamtertrag über die
Lebensdauer) war das falsch: Der gesamte Zählerstand erschien als heutiger Ertrag,
besonders auffällig nach dem Neu-Auswählen des Topics.

Jetzt wird das Ertrags-Topic **wie jedes andere Zählertopic** behandelt:

- Der Rohwert gilt als **kumulativer Zähler**; intern werden nur seine **Zuwächse**
  (in kWh) fortgeschrieben. „Ertrag heute/Woche/Jahr" ergibt sich aus dem
  Fortschritt seit dem jeweiligen Periodenstart.
- Ein **Rückwärtssprung** (Geräte-Reset) oder ein **Topic-/Einheitenwechsel**
  basiert nur neu — der neue Rohwert wird zur Baseline, ohne als Sprung in den
  Ertrag einzugehen. Ein Topic-Wechsel verändert den Zählerstand also nicht mehr.

> **Symptom vorher:** Nach dem Umstellen des Ertrags-Topics stand plötzlich der
> gesamte Zählerstand als „Ertrag heute".

### Prognose: Pool-Solarpumpe verdoppelte den erwarteten Verbrauch

Die Verbrauchsprognose addiert neben der Hausgrundlast auch Wallbox, Heizung/Klima
und den Pool. Beim Pool wurde die **Solarpumpe** bisher so projiziert:

- **Laufzeit:** jede Prognosestunde mit PV-Ertrag (`pvKwh > 0,02`) – im Sommer also
  praktisch der gesamte Tag (~16 h).
- **Leistung:** der **gelernte** Wert aus dem Toggle-Delta-Sampling. Dieser fängt
  beim gleichzeitigen Schalten anderer Lasten leicht Nebenverbräuche mit ein und
  war real überzeichnet (im Beispielsystem 1342 W statt einer plausiblen
  Absorberpumpen-Leistung).

Ergebnis: rund **21–22 kWh reine Pool-Solarlast pro Tag** – mehr, als der Pool im
gesamten bisherigen Jahr verbraucht hatte. In der Tagesbilanz erschien dadurch für
Folgetage etwa das Doppelte des tatsächlichen Bedarfs (z. B. „morgen 50 statt
28 kWh"), was der gelernten Hauslernkurve widersprach.

Jetzt gilt:

- Die **Solarpumpen-Laufzeit** ergibt sich aus dem **geometrischen Clear-Sky-Modell**:
  die Absorberpumpe läuft, wenn die Sonne (unabhängig von Bewölkung) über **5°**
  steht — sonnenstandsgesteuert statt an den wolkenabhängigen PV-Ertrag gekoppelt.
- Die **Leistung** stammt aus der neuen, pro Pumpe konfigurierbaren **Nennleistung**
  (siehe unten). Ohne Eintrag bleibt der gelernte Messwert die Grundlage.
- Die **Filterpumpe** ist unverändert: Laufzeit aus den eingestellten Zeitfenstern
  (bzw. Kopplung an die Solarpumpe / Akku-Override).

> **Symptom vorher:** „Die Prognose behauptet, wir bräuchten morgen doppelt so viel
> Strom wie heute“ — verursacht durch die aufgeblähte Pool-Solarlast.

## Hinzugefügt

### Photovoltaik: Einheit des Ertrags-Zählers je Anlage (Wh/kWh)

Im Anlagen-Dialog gibt es neben dem Ertrags-Topic ein Auswahlfeld **Einheit des
Ertrags-Zählers** (Wh oder kWh). Intern wird immer in kWh gezählt; ein Wh-Topic
wird durch 1000 geteilt. Vorgabe ist kWh.

### Pool: Nennleistung je Pumpe (Solar/Filter)

Im Pool-Setup gibt es bei Solar- und Filterpumpe je ein Feld **Nennleistung (W)**.
Ist ein Wert gesetzt, verwendet die **Prognose** ihn direkt; ohne Eintrag greift
weiterhin der aus dem Betrieb gelernte Leistungswert. Die laufende Messung/
Energiezählung des Pools bleibt davon unberührt.

---

## Hinweise

- **Wallbox-Korrektur ohne Migration.** Reine Logik-Korrektur ohne Schema-Änderung.
- **Automatische PV-Migration.** Beim ersten Start werden je Anlage die
  Ertragszähler-Spalten angelegt (`pv_aggregation`: `last_counter_raw`,
  `counter_total_kwh`, `day_key`, `day_start_kwh`) und die Spalte
  `pv_plants.today_yield_unit` ergänzt (Default kWh). **Einmalig** wird dabei ein
  fälschlich als Ertrag erfasster Zählerstand entfernt (`last_today_value = 0`);
  Woche/Jahr-Summen bleiben unberührt. Diese Bereinigung läuft nur bei dieser einen
  Migration, nicht bei jedem Neustart.
- **Einheit prüfen.** Nach dem Update je PV-Anlage die Ertrags-Einheit (Wh/kWh)
  kontrollieren; die tägliche Zählung startet ab dann sauber bei 0.
- **Pool-Migration.** Beim ersten Start werden die Spalten
  `pool_config.solar_pump_rated_power_w` und `pool_config.filter_pump_rated_power_w`
  angelegt (Default leer → gelernter Wert). Empfehlung: im Pool-Setup die reale
  Nennleistung von Solar- und Filterpumpe eintragen, damit die Prognose die
  Größenordnung trifft.
