# InfluxDB-Adapter

Schreibt die Werte ausgewählter States als Historie in eine **InfluxDB 1.x** —
die Grundlage für Auswertungen in Grafana oder in künftigen homeESS-Dashboards.
Das Regelwerk für Adapter steht in [ADAPTER.md](../../ADAPTER.md).

## States auswählen

Die Auswahl passiert nicht im Adapter, sondern dort, wo die States stehen: Auf
der **States-Seite** trägt jede Wertzeile rechts eine Stiftschaltfläche. Sie
öffnet den Eigenschaften-Dialog mit einer Tableiste — „Allgemein" für
Nachkommastellen und Einheit, danach **je aktiver InfluxDB-Instanz ein eigener
Tab**. Mehrere Instanzen bedeuten also mehrere Datenbanken, jede mit eigener
Auswahl und eigenen Einstellungen.

Je State und Datenbank sind einstellbar:

| Einstellung | Bedeutung | Standard |
|---|---|---|
| Werte speichern | Schaltet die Historie für diesen State ein | aus |
| DB-Alias | Name der Messreihe; leer = aus dem Topic abgeleitet | Topic |
| Speichern | Bei Wertänderung oder in festen Abständen | Bei Wertänderung |
| Abstand | Nur bei festen Abständen; schreibt den zuletzt bekannten Wert | 60 s |
| Entprellzeit | Mindestabstand zwischen zwei Schreibvorgängen | 5 s |
| Keepalive | Aufbewahrungsdauer in der Datenbank | 730 Tage (2 Jahre) |

Die Entprellung verwirft nichts: Der erste Wert geht sofort, ein während der
Sperrzeit eintreffender Wert wird nach deren Ablauf mit seinem letzten Stand
geschrieben.

Jede Aufbewahrungsdauer bildet der Adapter auf eine eigene Retention Policy ab
(`homeess_730d`, `homeess_30d`, …), die er bei Bedarf anlegt. So kann jeder
State seine eigene Keepalive-Zeit haben, ohne dass es eine zweite Datenbank
braucht. `0` bedeutet unbegrenzte Aufbewahrung.

## Ersteinrichtung einer lokalen Datenbank

Die Verwaltungsseite („Datenbank") bietet eine **Ersteinrichtung** an — aber nur
dann, wenn dabei nichts überschrieben werden kann:

- Der Server in den Einstellungen ist ein lokaler (`127.0.0.1`, `localhost`),
- auf diesem System ist noch **keine** InfluxDB installiert,
- und es besteht noch **keine** Verbindung zu einer Datenbank.

Trifft eines davon nicht zu, bleibt die Schaltfläche ausgeblendet und die Seite
erklärt, warum.

Die Einrichtung installiert InfluxDB, legt Datenbank, Benutzer und
Aufbewahrungsregel mit dem **in den Instanzeinstellungen hinterlegten Kennwort**
an und schaltet die Anmeldung verbindlich ein.

### Die Installation selbst

Zum Adapter gehört das Skript **`install-influxdb.sh`**. Es installiert das
Paket, startet den Dienst, legt Datenbank, Benutzer und Aufbewahrungsregel an
und schaltet die Anmeldung ein. Es ist mehrfach ausführbar und überschreibt
nichts Vorhandenes.

homeESS läuft im Regelfall als unprivilegierter Dienst (`NoNewPrivileges`,
`ProtectSystem=strict`) und kann weder Pakete installieren noch `/etc`
beschreiben. Die Verwaltungsseite nennt deshalb den fertigen Befehl für die
Root-Konsole:

```bash
bash /opt/home-ess/adapter/influxdb/install-influxdb.sh \
  --database homeess --user homeess --port 8086 --retention 730
```

Der Befehl gehört in eine **Root-Konsole**; ein `sudo` ist dort weder nötig noch
auf jedem Minimalsystem vorhanden.

Das Kennwort steht **nicht** in der Befehlszeile: Das Skript fragt es verdeckt
ab (oder liest `INFLUX_SETUP_PASSWORD`), damit es weder in der Shell-History
noch in der Prozessliste landet. Es muss mit dem Kennwort in den
Instanzeinstellungen übereinstimmen. Danach genügt „Verbindung prüfen".

Läuft der Adapterprozess ausnahmsweise mit Rootrechten, bietet die Seite
zusätzlich eine Schaltfläche an, die genau dasselbe Skript startet und den
Fortschritt anzeigt.

## Vorhandene Datenbank einbinden

Statt der Ersteinrichtung lassen sich Server, Port, Datenbank und Zugangsdaten
einfach in den Instanzeinstellungen eintragen — auch für eine InfluxDB auf einem
anderen Rechner. Fehlt die Datenbank dort, legt der Adapter sie an (abschaltbar).
Mit mehreren Instanzen lassen sich mehrere Datenbanken parallel bespielen.

## Mehrere Instanzen in derselben Datenbank

Jeder Messpunkt trägt das Tag `instance=<Instanzname>`. In InfluxDB gehört ein
Tag zum Serienschlüssel — zwei Instanzen schreiben also selbst dann in getrennte
Serien, wenn sie dieselbe Datenbank und denselben Alias verwenden:

```
wz.temp,instance=erste  value=21.5 1786531200000
wz.temp,instance=zweite value=21.5 1786531200000
```

In Grafana lässt sich damit gezielt filtern (`WHERE instance = 'erste'`) oder
vergleichen (`GROUP BY instance`). Wer mehrere Instanzen bewusst in **dieselbe**
Serie schreiben lassen will — etwa zwei Server, die sich gegenseitig absichern —
schaltet **Instanznamen als Tag mitschreiben** in den Instanzeinstellungen ab.

Der Instanzname ist damit das Trennmerkmal innerhalb einer Datenbank; die
Messreihennamen bleiben unverändert und kollisionsfrei. Aufbewahrungsregeln
gelten dagegen datenbankweit: Zwei Instanzen mit demselben Keepalive teilen sich
dieselbe Retention Policy, was semantisch identisch und daher unkritisch ist.

Wird der Instanzname später geändert, entsteht eine neue Serie — die bisherigen
Daten bleiben unter dem alten Tag erhalten.

## Betrieb

Messpunkte werden gesammelt und im eingestellten Sammelfenster gemeinsam
geschrieben. Ist die Datenbank nicht erreichbar, bleiben sie in einer begrenzten
Warteschlange und gehen nach der Wiederverbindung raus; läuft die Warteschlange
über, werden die ältesten Punkte verworfen und gezählt. Der Adapter meldet
Verbindung, Anzahl verfolgter States, geschriebene, wartende und verworfene
Messpunkte als eigene States unter der Kategorie „InfluxDB".

Gespeichert wird immer der **Rohwert**. Nachkommastellen und Einheit aus dem Tab
„Allgemein" betreffen ausschließlich die Anzeige in homeESS, nicht die Historie.

## Voraussetzungen

- homeESS ab 1.4.5 (`host.listStateOptions()` und `stateOptions` im Manifest).
- Für die Ersteinrichtung Debian/Ubuntu mit `apt` und `systemd`; ein bereits
  vorhandener InfluxDB-Server lässt sich unabhängig davon einbinden.
- InfluxDB 1.x. In Debian 13 ist das Paket `influxdb` (1.6.x) enthalten; für
  InfluxDB 2.x/3.x ist dieser Adapter nicht gedacht.
- Keine externen JavaScript-Abhängigkeiten.
