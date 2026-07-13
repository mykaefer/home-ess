# homeESS v1.2.5 – Grid-Control-Feinschliff & Schaltgruppen-Mobilfixes

**v1.2.5** ist ein Pflege-Release: Die **Grid-Control** meldet keine
Wechselrichterlast-Warnung mehr, wenn das Netz ohnehin schon zugeschaltet ist,
verriegelt die Netzschaltung aber weiterhin sauber über die Last. Dazu zwei
**Mobil-Korrekturen der Schaltgruppen** (abgekürzte Gerätenamen, seitlicher
Überlauf) und ein auf **100 % festgenagelter Zoomfaktor** auf allen Seiten.

---

## Behoben

### Grid-Control: keine Wechselrichterlast-Warnung, wenn das Netz schon geschaltet ist

War das Netz bereits aus einem anderen Grund zugeschaltet (SoC, Spannung,
Temperatur oder Notstrom), meldete die Steuerung trotzdem **„Wechselrichterlast
zu hoch"**. Bei zugeschaltetem Netz existiert aber **keine
Wechselrichter-Obergrenze** mehr: Last oberhalb der Schwelle kompensiert das
öffentliche Netz automatisch — sie ist damit **keine Warnung**.

Die kritische Meldung erscheint jetzt nur noch, wenn die **Last der alleinige
Schaltgrund** ist (das Netz also gerade **wegen** der Last zuschaltet). Ist das
Netz bereits aus einem anderen Grund an, bleibt die Meldung aus.

> **Wichtig:** Die **Grid-by-Load-Verriegelung** bleibt unverändert aktiv. Sie
> rastet auch bei bereits zugeschaltetem Netz ein und **hält das Netz
> zugeschaltet** — selbst wenn der ursprüngliche Grund (z. B. niedriger SoC)
> wegfällt —, bis **alle** Grid-by-Gründe aus sind, d. h. bis die überlastete
> Phase wieder unter ihre **untere Schaltschwelle** fällt.

### Schaltgruppen (Handy): Gerätenamen wurden auf einen Buchstaben abgekürzt

Die Schaltgruppen-Zeilen verwenden dieselbe Statuspunkt-Klasse
(`.ms-status-dot`) wie die Geräte in **Messen + Schalten**. Deren mobile
Raster-Regel `grid-area: dot` war **nicht eingegrenzt** und griff dadurch auch in
den Schaltgruppen-Zeilen. Da diese kein `dot`-Rasterfeld definieren, verschob
sich das gesamte Zeilenraster und der Name wurde in die **12px schmale
Statusspalte** gequetscht — sichtbar als **ein Buchstabe + „…"** trotz reichlich
Platz. Die Regel ist jetzt auf `.ms-row` eingegrenzt; die Gerätenamen erhalten
wieder die volle Breite.

### Schaltgruppen (Handy): Seite skalierte über die Bildschirmbreite hinaus

Der Gruppenkopf trägt Titel, Zähler, bis zu drei Badges (Einheit/Remote/Timer),
den Schalter und zwei Aktionsknöpfe. Auf schmalen Geräten brach diese Zeile nicht
um und zog die ganze Seite **breiter als den Viewport** — ein horizontaler
Überlauf, der die untere Tab-Bar teilweise aus dem sichtbaren Bereich schob. Der
Kopf bricht jetzt um (`flex-wrap`), analog zum bereits umbrechenden
Messen-+-Schalten-Kopf; die Seite bleibt exakt viewport-breit.

---

## Geändert

### Zoomfaktor auf 100 % festgenagelt

Das Viewport-Meta lässt jetzt **keinen Zoom mehr zu** — weder rein noch raus
(`initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no`). Alle
Seiten bleiben damit auf allen Geräten in der vorgesehenen 1:1-Darstellung; das
versehentliche Verrutschen des Layouts durch Pinch-/Doppeltipp-Zoom entfällt.

> **Hinweis:** iOS-Safari kann `user-scalable=no` aus Barrierefreiheitsgründen
> ignorieren, respektiert aber `maximum-scale=1` — der 100 %-Faktor wird dort
> weiterhin gehalten.

---

## Hinweise

- **Keine Migration nötig.** Reines Verhaltens-/Darstellungs-Release ohne
  Schema-Änderungen.
