# homeESS v1.4.5 – States bekommen Eigenschaften, Adapter bekommen States

**v1.4.5** öffnet die States-Seite für Einstellungen: Jeder Wert lässt sich jetzt
in einem eigenen Dialog formatieren — und, was schwerer wiegt, gezielt einem
Adapter zuweisen. Diese Zuweisung ist die Grundlage für die Historisierung in
einer InfluxDB und damit für Auswertungen in Grafana; sie bleibt aber bewusst
allgemein, sodass künftige Adapter — etwa ein Display-Dashboard — denselben Weg
nutzen können.

Der zugehörige **InfluxDB-Adapter** wird eigenständig versioniert und hat seinen
eigenen Änderungsverlauf unter `adapter/influxdb/`.

## Hinzugefügt

### Eigenschaften-Dialog für jeden State

Auf der States-Seite trägt jede Wertzeile rechts eine kleine
Stiftschaltfläche. Sie öffnet einen Dialog mit Tableiste.

Der Tab **Allgemein** gilt für jeden State, unabhängig von seiner Quelle:

- **Nachkommastellen** samt Rundungsart — kaufmännisch, abrunden, aufrunden oder
  abschneiden. Ohne Angabe bleibt der Wert so, wie ihn die Quelle liefert.
- **Einheit**, die in der Anzeige an den Wert gehängt wird und eine Einheit der
  Quelle überschreibt.

Beides betrifft ausschließlich die **Darstellung** — auf der States-Seite, im
Wertekatalog und im State-Picker. Der Rohwert im Wertebus bleibt unangetastet,
und ebenso das, was Automationen, Output oder eine Historie verarbeiten.

### Adaptertabs im selben Dialog

Hinter „Allgemein" kann **jede aktive Adapterinstanz einen eigenen Tab
anhängen**. Hängt kein Adapter etwas an, bleibt es allein bei „Allgemein".

Der Adapter liefert dafür nur ein Formularschema — entweder statisch über das
neue Manifestfeld `stateOptions` oder zur Laufzeit über
`host.setStateOptionsSchema(schema)`, etwa wenn die Auswahlmöglichkeiten erst im
Betrieb feststehen. Das zuletzt gemeldete Schema merkt sich homeESS, sodass der
Tab auch bei gestoppter Instanz erscheint. homeESS rendert das Formular, prüft
die Eingaben gegen das Schema und speichert die Werte je Instanz und State.

Damit muss ein Adapter, der einzelne fremde States verarbeitet, keine eigene
Auswahloberfläche mehr mitbringen: Die Zuordnung passiert dort, wo der State
steht. Mehrere Instanzen desselben Adapters bedeuten mehrere Tabs — und damit
etwa mehrere Datenbanken, jede mit eigener Auswahl.

Zwei Regeln sind fest eingebaut: Eine Instanz erscheint **nicht** als Tab für
ihre eigenen States (ein Adapter kann sich nicht selbst als Quelle eintragen),
und Änderungen wirken **ohne Neustart** der Instanz.

### Host-API `host.setStateOptionsSchema()` und `host.listStateOptions()`

Der Adapter meldet sein Tab-Schema mit `setStateOptionsSchema(schema)` an
(`null` entfernt den Tab), liest die gepflegten Werte als `[{ topic, options }]`
und wird über
die optionale Methode `stateOptionsChanged()` sofort über jede Änderung
informiert. Ein regelmäßiger Abgleich ist damit nicht mehr nötig, bleibt aber
als Sicherheitsnetz möglich. Das vollständige Regelwerk steht in
[ADAPTER.md](../ADAPTER.md).

## Behoben

### Adapter-Verwaltungsseiten meldeten „Keine Berechtigung."

Das interne Zugriffsobjekt führte kein `canRead`, obwohl `GET /me/access` und
das Adapter-Regelwerk es als Vertrag beschreiben. Die Brücke zwischen
Verwaltungsseite und Adapterprozess reichte deshalb für jeden Benutzer
`canRead: false` durch — auch für Administratoren. Adapter, die darauf prüfen,
verweigerten folgerichtig die Anzeige.

Jeder angemeldete Benutzer hat jetzt Leserecht; Bedienen und Schreiben bleiben
unverändert an die Rolle gebunden. Und eine nicht aktive Instanz meldet nicht
mehr pauschal „Adapterverwaltung ist nicht verfügbar", sondern nennt den Grund
und den nächsten Schritt.

## Hinweise zum Update

Die Datenbank erhält drei neue Tabellen (`state_properties`,
`state_adapter_options`, `adapter_state_schemas`); vorhandene Daten bleiben
unberührt. Ohne gepflegte
Eigenschaften verhält sich die Anzeige exakt wie bisher.

Ein Zurückrollen auf v1.4.4 ist möglich: Die neuen Tabellen stören dort nicht,
gepflegte Eigenschaften und Adapterzuordnungen bleiben erhalten, sind aber ohne
Wirkung, und der Eigenschaften-Dialog verschwindet wieder.

Am Installer und an den systemd-Units ändert sich nichts.
