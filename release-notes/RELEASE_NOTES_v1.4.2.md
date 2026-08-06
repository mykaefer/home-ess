# homeESS v1.4.2 – Bedingungen rechnen, verweisen und verzweigen

**v1.4.2** baut das Bedingungssystem aus [v1.4.0](RELEASE_NOTES_v1.4.0.md) an
den Stellen aus, an denen es bisher zu starr war: Werte dürfen jetzt aus einem
anderen Topic stammen, Aktionen rechnen statt nur zu setzen, die Wenn-Prüfung
ist abschaltbar, und ein Sonst-Zweig fängt den nicht erfüllten Fall ab.
Bestehende Automationen laufen unverändert weiter.

## Hinzugefügt

### Vergleichs- und Zielwerte dürfen auf ein Topic verweisen

Das Wertfeld einer Wenn-Prüfung und die Werte einer Dann- oder Sonst-Aktion
nehmen weiterhin feste Zahlen und Texte auf. Beginnt die Eingabe dagegen mit
einem gültigen Präfix (`prefix://instanz/adresse`, z. B. `hdp://…`), wird zur
Laufzeit der Wert dieses Ziel-States verwendet. Hinter jedem dieser Felder sitzt
ein State-Picker, darüber steht der Hinweis auf beide Eingabearten.

So lässt sich etwa eine Temperatur gegen einen anderswo gepflegten Sollwert
prüfen, ohne die Schwelle in der Automation zu duplizieren.

### Numerische Prüfung bei mathematischer Verwendung

Bei den Vergleichen größer/kleiner und bei jeder Rechenfunktion muss ein fest
eingetragener Wert numerisch sein. Andernfalls erscheint unter dem Feld in Rot

> Wert muss bei mathematischen Operatoren numerisch sein

und Anlegen bzw. Speichern bleibt gesperrt. Für Topic-Verweise gilt dieselbe
Anforderung — geprüft mit dem tatsächlichen Wert des States, sobald die
Automation läuft. Boolesche Zustände zählen dabei als numerisch, gleich ob sie
als `true`/`false` oder als Ein/Aus geführt werden.

### Rechenfunktionen in Dann- und Sonst-Aktionen

Statt nur einen festen Wert zu schreiben, verrechnen Aktionen jetzt zwei Werte:

- Addieren, Subtrahieren, Multiplizieren, Dividieren
- Rest der Division
- kleineren bzw. größeren Wert nehmen

Das Ergebnis lässt sich optional auf bis zu sechs Nachkommastellen runden. Beide
Operanden können fest eingetragen sein oder aus einem Topic stammen — damit
schreibt eine Automation beispielsweise den um einen Grundverbrauch erhöhten
Messwert eines anderen States.

### Sonst-Zweig als vierter Bereich

Trifft die Wenn-Prüfung nicht zu, läuft der Sonst-Zweig. Er ist je Bedingung
einmal möglich, im Anlegen-Dialog per Haken zuschaltbar und bleibt bis dahin
ausgeblendet, damit der Dialog übersichtlich bleibt. Liefert ein beteiligter
State noch gar keinen Wert, bleibt die Auswertung wie bisher folgenlos — dann
läuft weder der Dann- noch der Sonst-Zweig.

## Geändert

### Die Wenn-Prüfung ist optional

Ein Haken im Anlegen- und im Bearbeiten-Dialog schaltet die Prüfung ab; die
Dann-Aktionen laufen dann bei jedem Trigger bedingungslos. Der ausgeschaltete
Bereich bleibt ausgeblendet.

Prüfung und Wenn-Elemente bleiben dabei gekoppelt: Das letzte Wenn zu entfernen
schaltet die Prüfung ab, ein neu angelegtes Wenn schaltet sie wieder ein.
Unverzichtbar bleiben nur Trigger und Dann.

## Hinweise zum Update

Die Datenbank wird beim Start automatisch nachgezogen: Bestehende Automationen
behalten ihre Wenn-Prüfung, ihre Trigger, Wenns und Danns bleiben unverändert
erhalten. Ein Zurückrollen auf v1.4.1 ist möglich, solange keine Sonst-Zweige
angelegt wurden.
