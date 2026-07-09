# homeESS v1.2.0 – Mehrschichtige Verbrauchsgruppen, Zählergruppen & Energiefluss

**v1.2.0** baut „Messen + Schalten" mehrschichtig um: Verbrauchsgruppen lassen
sich wie Verzeichnisse ineinander schieben, eine neue **Zählergruppe** fixiert
den Zweig-Gesamtverbrauch aus eigenen Zählern und wirkt als Sperrschicht, und
die neue Unterseite **Energiefluss** zeigt den gesamten Fluss von PV, Netz und
Batterie über den Eigenverbrauch bis in die (verschachtelten) Gruppen als
vollständig animiertes Diagramm. Zusätzlich zählt homeESS pro Gruppe den
Verbrauch von Tag, Jahr und Vorjahr und stellt ihn im Wertekatalog bereit.
Nebenbei wird der Steuerungs-Schalter der Wallbox neustart-resistent.

## Neu

### Mehrschichtige Verbrauchsgruppen

- Gruppen haben eine **Drag-Fläche** am Kopf und lassen sich beliebig tief
  ineinander schieben (Ziehen auf eine andere Gruppe → Untergruppe; auf freie
  Fläche → oberste Ebene). Zyklen und Selbst-Verschachtelung werden abgewiesen.
- Untergruppen stehen **eingerückt** im Body und klappen mit der Elterngruppe
  zu – wie Verzeichnisse.
- Der Titel einer Gruppe mit Untergruppen zeigt verkürzt **„Ebene/Gesamt W"**:
  links die Leistung der eigenen Ebene, rechts die Gesamtleistung inklusive
  aller Untergruppen. Gruppen ohne Untergruppen zeigen wie bisher eine Zahl.
- **Prioritäten werden nicht vererbt.** Jede Gruppe behält ihre eigene
  Priorität; Geräte mit „Priorität der Gruppe verwenden" beziehen sie weiterhin
  von ihrer **direkten** Gruppe, nicht von einer übergeordneten.
- Der globale Restposten **„Sonstige Verbraucher"** zählt Untergruppen nicht
  doppelt (nur oberste, verrechnete Zweige tragen bei).

### Zählergruppe (Sperrschicht)

- Neue Gruppenoption **„Zählergruppe"**: Die eigenen Geräte der Gruppe gelten
  als Zähler des ganzen Zweigs. Der **Gesamtverbrauch ist damit fix** aus diesen
  Zählern (nicht additiv), die Ebene entfällt im Titel.
- Stattdessen erscheint als Fußzeile ein rechnerisches Fuß-Gerät **„Sonstige
  Verbraucher dieser Gruppe"** = Zählerleistung − Gesamtleistung der
  verrechneten Untergruppen (bei 0 gekappt).
- Ist der Haken **„mit Gesamtverbrauch verrechnen"** bei der Zählergruppe
  gesetzt, wirkt sie als **Sperrschicht**: Sie trägt den vollen Zweigwert zum
  Hausverbrauch bei, und die Untergruppen werden global nicht mehr zusätzlich
  verrechnet – unabhängig von deren Haken.
- Der Haken einer Untergruppe ist dann nicht wirkungslos, sondern steuert, ob
  ihr Verbrauch gegen die nächsthöhere Zählergruppe verrechnet – also aus deren
  „Sonstige Verbraucher" herausgerechnet – wird oder darin enthalten bleibt.

### Unterseite „Energiefluss"

- Vollständig **animiertes SVG-Flussdiagramm** unter Messen + Schalten
  (`/messen-schalten/energiefluss`).
- **Eingangsseitig** bündeln sich die einzelnen PV-Anlagen zu einem Gesamtzweig;
  dazu der **Netzbezug** (bei Einspeisung negativ) und die **Batterie** als
  neutrale Stabstelle (Laden/Entladen).
- **Zentraler Knoten** ist der Eigenverbrauch, über den alles läuft.
- **Ausgangsseitig** verzweigt der Fluss auf die (verschachtelten) Gruppen und
  weiter in die Untergruppen; zusätzlich gibt es einen **„Sonstige
  Verbraucher"-Ast** – global neben den obersten Gruppen und hinter jeder
  Zählergruppe –, sodass das Bild in sich geschlossen ist. Einzelne Geräte
  werden bewusst nicht gezeigt.
- **Strichbreite** und **Fließgeschwindigkeit** folgen der Leistung, die
  **Richtung** dem Vorzeichen (Bezug/Einspeisung, Laden/Entladen). Das Diagramm
  aktualisiert sich live, ohne die Animation neu zu starten.
- **Farben** aus den Systemfarben (PV, Netz, Batterie, Eigenverbrauch = lila).
  Je Gruppe lässt sich über einen **Stift-Button** eine eigene Farbe wählen
  (Mini-Colorpicker mit Palette + freiem Farbfeld); die Pfade zu den Gruppen
  erscheinen in Gruppenfarbe, die von PV/Netz/Batterie in deren Farbe.
- Durch **Priorität oder Lastabwurf** gerade abgeschaltete Gruppen werden
  **ausgegraut**.
- Jeder Gruppen-Knoten sowie PV, Netz und Eigenverbrauch weisen zusätzlich zur
  Leistung den **Verbrauch heute und dieses Jahr** aus.

### Verbrauchssummen je Gruppe: Tag / Jahr / Vorjahr

- Aus dem internen Gerätezähler wird pro Gruppe sauber der Verbrauch des
  laufenden **Tages** und **Jahres** sowie der abgeschlossene **Vorjahres**-
  verbrauch gebildet und im Wertekatalog (Kategorie *Verbrauchssummen*)
  bereitgestellt: `verbrauchssumme.<id>.verbrauchHeute`, `.verbrauchJahr`,
  `.verbrauchVorjahr` (der Vorjahreswert nur im Katalog).
- Die Aggregation ist **baum-konsistent** zur Leistung: eine Zählergruppe zählt
  nur ihre eigenen Zähler (die den ganzen Zweig messen), sonst additiv eigene
  Geräte + Untergruppen.

## Behoben

### Wallbox: Steuerungs-Schalter neustart-resistent

Die manuelle Übersteuerung je Wallbox (Automatik / dauerhaft Aus / einmalig
Vollladen) lag bisher nur im Arbeitsspeicher und fiel nach einem Neustart
zurück auf „Automatik". Sie wird jetzt persistiert und beim ersten
Automatik-Tick nach dem Start wiederhergestellt.

## Migration

Bestehende Datenbanken erhalten alle neuen Spalten automatisch:

- `mess_schalt_groups`: `parent_id` (NULL = oberste Ebene), `meter_group`
  (Default 0 = normale, additive Gruppe), `color` (leer = Standardfarbe).
- `wallboxes`: `control_mode` (Default `auto`).
- `mess_schalt_actor_state`: Tages-/Jahres-Baselines für die
  Gruppen-Verbrauchssummen.

Ohne weitere Anpassung bleibt das Verhalten wie in v1.1.3 (flache Gruppen, keine
Zählergruppen, additive Verrechnung). Der **Vorjahres-Gruppenverbrauch** entsteht
erst mit dem ersten Jahreswechsel nach dem Update, da vorher keine
Jahres-Baseline vorliegt.
