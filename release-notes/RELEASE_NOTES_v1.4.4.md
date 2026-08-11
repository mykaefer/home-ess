# homeESS v1.4.4 – States-Seite aktualisiert sich selbst, Katalog ist geordnet

**v1.4.4** betrifft die zentrale States-Seite und die Adapter-Schnittstelle. Die
Seite zeigt neue und entfernte States jetzt von selbst, der gesamte Katalog ist
durchgängig alphanumerisch sortiert, und Adapter können den State-Bestand von
homeESS erstmals vollständig lesen. An Automationen, Dashboards, Output und
Datenbank ändert sich nichts.

## Hinzugefügt

### Der States-Baum lädt sich selbst nach

Die States-Seite holte bisher im 15-Sekunden-Takt ausschließlich die **Werte**
der bereits gerenderten Zeilen. Ihre Struktur stammte aus dem Seitenaufbau: Ein
State, der erst danach entstand, blieb unsichtbar, bis die Seite manuell neu
geladen wurde — und ebenso blieb ein entfernter State als Karteileiche stehen.

Weicht die gelieferte Wertemenge von den dargestellten Zeilen ab, lädt die Seite
den Baum jetzt selbst über den neuen Endpunkt `/states/tree.json` nach und
ersetzt ihn an Ort und Stelle. Der Auf- und Zuklappzustand aller Gruppen bleibt
dabei erhalten. Das kostet nur bei tatsächlichen Strukturänderungen zusätzliche
Übertragung; im Normalfall bleibt es beim bisherigen schlanken Wertabgleich.

Sichtbar wird das überall dort, wo States zur Laufzeit entstehen oder vergehen:
bei Adaptern, die ihren Katalog dynamisch melden, ebenso wie bei Automatiken,
die States wieder aufräumen.

### Einklappbare Prefix-Gruppen

Jede Gruppe der States-Seite — `hdp://…`, `modbus://…`, `custom://` und die
übrigen — lässt sich jetzt wie ihre Kategorien auf- und zuklappen. Der Kopf
zeigt die Anzahl der States der Gruppe, und der Zustand wird pro Gruppe
gemerkt, auch über das automatische Nachladen des Baums hinweg.

Voreingestellt sind die Gruppen zugeklappt. Installationen mit mehreren tausend
States beginnen damit bei einer kompakten Übersicht statt bei einer sehr langen
Seite.

### Host-API `host.listStates()`

Adapter konnten bislang einzelne Datenquellen abonnieren (`subscribeState`) und
beschreiben (`writeState`), aber nicht erfahren, welche States es überhaupt
gibt. `host.listStates()` liefert nun den quellenübergreifenden Katalog als
flache Liste: berechnete Systemwerte, Custom States und alle Adapter-Instanzen,
jeweils mit `topic`, `name`, `category`, `unit`, `value`, `writable` und
`sourceType`.

Berechnete Systemwerte tragen dabei ihr kanonisches `system://`-Topic, sodass
jeder Eintrag unmittelbar adressierbar ist. Die Werte selbst kommen weiterhin
ereignisgetrieben über `subscribeState()` — der Katalog bleibt reine Metadaten.

Gedacht ist die Methode für Adapter, die States nach außen weiterreichen oder
spiegeln. [ADAPTER.md](../ADAPTER.md) beschreibt dafür verbindliche Regeln: Der
eigene Prefix bleibt ausgespart, damit ein Adapter sich nicht selbst spiegelt;
die hinterlegten Schreibrechte gelten unverändert; im weitergereichten Baum
entstehen keine neuen States; und abonniert wird bedarfsgetrieben und
mengenbegrenzt, statt tausende States ungefragt zu binden.

Bestehende Adapter sind davon unberührt.

## Geändert

### Alphanumerische Sortierung im gesamten States-Katalog

States, Kategorien, Katalogeinträge und die Prefix-Gruppen selbst werden jetzt
einheitlich aufsteigend sortiert. Zahlenanteile zählen dabei als Zahl, sodass
`Kanal2` vor `Kanal10` steht; Groß- und Kleinschreibung spielt keine Rolle.

Die Reihenfolge der Prefix-Gruppen ergab sich zuvor daraus, in welcher
Reihenfolge die Instanzen angelegt worden waren. Sie folgt nun dem Namen; der
System-Block behält wie im Wertekatalog seinen festen Platz an der Spitze.

Im lazy geladenen Katalog wurde bisher in SQLite sortiert und seitenweise
nachgeladen. SQLite kennt keine alphanumerische Kollation, wodurch die
Reihenfolge an Seitengrenzen springen konnte. Die States einer Ebene werden
jetzt vollständig geladen, sortiert und erst danach ausgegeben.

### Nachdokumentierte Host-API

`host.writeState()` und `host.getDataDirectory()` gab es bereits, sie fehlten
aber im Regelwerk. Beide stehen jetzt in [ADAPTER.md](../ADAPTER.md).

## Hinweise zum Update

Ein reines Anwendungsupdate ohne Migrationen: Es ändert sich nichts an der
Datenbank, an Adapterinstanzen oder an gespeicherten Konfigurationen. Nach dem
Neustart empfiehlt sich ein einmaliges Neuladen der geöffneten States-Seite,
damit das neue Skript aktiv wird.

Ein Zurückrollen auf v1.4.3 ist jederzeit möglich. Adapter, die
`host.listStates()` verwenden, finden die Methode danach allerdings nicht mehr
vor und sollten diesen Fall selbst abfangen — der übrige Adapterbetrieb bleibt
davon unberührt.
