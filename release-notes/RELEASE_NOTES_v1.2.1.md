# homeESS v1.2.1 – Nennleistungs-Zählung, Energiefluss-Exporte & Temperatur-Prognose

**v1.2.1** ergänzt „Messen + Schalten" um eine **virtuelle Zählung aus der
Nennleistung** für Geräte ohne eigenen Zähler, macht das **Energiefluss-Diagramm
teilbar**: benannte, öffentlich abrufbare Live-Ansichten (hell/dunkel), die den
kompletten Baum auf jede Viewport-Größe skalieren. Die Prognose zeigt den
Heizungs-/Klimabedarf jetzt als **Balkendiagramm über feste
Außentemperatur-Fenster** und plant ihn stundengenau ein. Dazu zwei Fehlerbehebungen
(Wallbox-Steuerung nach Neustart, ausgeblendeter virtueller Zähler) und ein
Cooldown gegen endloses Schalten bei „Gruppe schaltet als Einheit".

## Neu

### Virtuelle Zählung aus Nennleistung

- Geräte ohne Leistungs- und ohne Zähler-Topic können eine **Nennleistung**
  bekommen (Feld direkt unter dem Zähler-Topic, Einheit **W/kW**).
- Ist kein Leistungs- und kein Zähler-Topic gesetzt, werden Leistung und Energie
  daraus **virtuell** ermittelt: Leistung = Nennleistung, wenn das Gerät an ist,
  sonst 0; die Energie wird über die Einschaltdauer in denselben **internen
  Zähler** (mit Tages-/Jahres-Baseline) integriert wie bei echten Zählern.
- Ist ein Leistungs- oder Zähler-Topic vorhanden, hat es weiterhin Vorrang. Fehlt
  auch die Nennleistung, gibt es wie bisher keine Messung.
- Der fortlaufende Zählerstand bleibt beim Umstellen von einem Zähler-Topic auf
  die Nennleistung **erhalten** und wird nahtlos weitergeführt.

### Energiefluss-Exporte

- Unter dem Diagramm lassen sich **Exporte** anlegen, bearbeiten und löschen
  (bekanntes Listen-/Dialog-Schema).
- Jeder Export hat einen **Namen**, ein **Theme** – *hell* (wie auf der Seite)
  oder *dunkel* (schwarzer Hintergrund, helle Schrift) – und eine aus dem Namen
  abgeleitete **Export-URL** (`/energiefluss/export/<slug>`).
- Die Export-URL ist **live abrufbar** und zeigt **nur das Diagramm** – ohne
  Navigation, Titel oder Erklärungen.
- Der komplette Baum wird **dynamisch auf die Viewport-Größe skaliert**. Wird der
  Platz zu klein, fallen **zuerst die Zählersummen** (heute/dieses Jahr) weg,
  bevor die Schrift weiter verkleinert wird.
- **Legende** unten links, **Wasserzeichen** unten rechts am Viewport-Rand.
- Die Zeichen-Logik ist jetzt in `public/energiefluss-diagram.js` **gemeinsam**
  für die interaktive Seite und die Exporte.

### Energiefluss: „Sonstige" mit Verbrauchszählern

- Der „Sonstige Verbraucher"-Ast (global und hinter jeder Zählergruppe) weist
  jetzt ebenfalls **Verbrauch heute und dieses Jahr** aus – baum-konsistent zur
  Leistung.
- Der Knotentitel ist auf **„Sonstige"** gekürzt.

### Prognose: Heizung / Klima nach Außentemperatur

- Unter der **Datenbasis** stellt ein neues **Balkendiagramm** den gemessenen
  Energiebedarf der Funktionsgruppe **Heizung / Klima** über feste
  **Außentemperatur-Fenster** dar: unterer Sammelbereich **< -20 °C**, oberer
  **> 50 °C**, dazwischen exakte **5-°C-Bereiche**.
- Genau diese Fenster werden in der Prognose ermittelt (Basis: der tatsächlich
  gemessene Verbrauch der Gruppe) und **je Stunde** nach der prognostizierten
  Außentemperatur eingeplant – nicht im Temperatur-Tagesdurchschnitt.

## Geändert

### Schaltgruppen „als Einheit": Cooldown gegen Blip-Rückkopplung

- Manche Zigbee-Aktoren melden nach dem Einschalten kurz **„aus" und sofort
  wieder „an"**. Bislang wertete die Gruppe das als echte Schaltflanke, schaltete
  die übrigen Geräte nach – und der so ausgelöste Blip startete das Spiel erneut:
  ein endloses Ein-/Ausschalten der ganzen Gruppe.
- Nach jeder Gruppenschaltung gilt jetzt ein **15-Sekunden-Fenster**, in dem die
  von den Geräten **selbst gemeldeten** Flanken nicht weitergereicht werden. Erst
  am Fensterende wird abgeglichen; weicht ein Gerät dann noch ab, gilt der
  **abweichende** Zustand (der zuletzt betätigte Schalter) als neuer Soll-Zustand
  der Gruppe – unabhängig von der Mehrheit.

## Behoben

- **Wallbox: Steuerung kehrt nach autonomer Freigabe zur Automatik zurück.** Gab
  die Automatik ein manuelles „Aus" selbst frei (PV-Deckung am Folgetag) oder
  schloss eine Volladung ab, wurde das nur im Laufzeitzustand vermerkt, nicht in
  der Datenbank. Ein Prozess-Neustart stellte daraufhin die längst verworfene
  Übersteuerung wieder her – die Steuerung blieb sichtbar auf „Aus", obwohl schon
  geladen wurde. Autonome Wechsel der Steuerung werden nun sofort **persistiert**.
- **Messen + Schalten: virtueller Zähler wurde nicht angezeigt.** Beim Umstellen
  auf die Nennleistungs-Zählung verschwand der Energiezähler eines Geräts
  vollständig (nicht einmal „0 kWh"), weil die Anzeige an ein Zähler-Topic
  gebunden war. Der interne Zähler wird jetzt auch ohne Zähler-Topic angezeigt.

## Datenmodell

- `mess_schalt_actors`: neue Spalten **`rated_power`** (REAL) und
  **`rated_power_unit`** (`'W'`/`'kW'`) für die Nennleistung.
- neue Tabelle **`energiefluss_exports`** (`id, name, slug, theme`).
- Bestehende Datenbanken werden beim Start automatisch migriert.

## Hinweis zu den Exporten

Die Export-URL ist bewusst **ohne Login** abrufbar (für Wand-Displays u. Ä.). Wer
den Slug kennt, sieht die Energiefluss-Werte und Gruppennamen; der Slug wird aus
dem Namen gebildet und ist damit erratbar. Wähle Export-Namen entsprechend.
