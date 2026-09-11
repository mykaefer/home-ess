# homeESS v1.6.4 – Temperaturdiagramm, Boost je Raum, schneller CCU-Start

**v1.6.4** dreht sich um *Heizung & Klima*. Die Seite bekommt ein
**Temperaturdiagramm**, das alle Räume nebeneinander zeigt und den Sollwert
direkt am Balken verstellbar macht. Dazu kommt **Boost je Raum**: ein Schalter,
der die Soll-Temperatur vorübergehend aushebelt und mit maximaler Leistung heizt
— bedienbar aus homeESS heraus und über ein eigenes Topic.

Unter der Oberfläche steht ein Fund aus der Betriebsdiagnose: Der
**HM-RPC-Geräteabgleich** nach einem Neustart dauerte zuletzt 87 Sekunden. Der
Abgleich selbst braucht davon 0,8 Sekunden — der Rest waren Funkbefehle an
Thermostate, die die CCU gar nicht mehr erreicht. Das ist behoben.

Außerdem korrigiert dieses Release einen Fehler, der zwei Seiten praktisch
unbedienbar machte: In den *Einstellungen* ließen sich die Register nicht mehr
umschalten, und die Registerseite der *Adapter* reagierte überhaupt nicht.

## Hinzugefügt

### Temperaturverteilung der Räume als Balkendiagramm

Über der Räume-Kachel von *Heizung & Klima* steht jetzt je Raum ein Balken. Seine
Höhe ist die Ist-Temperatur, seine Farbe der Regelzustand:

| Farbe | Bedeutung |
|---|---|
| grün | Temperatur wird gehalten |
| rot | Raum heizt — lokales Heizgerät **oder** Wärmeanforderung an die Zentralheizung |
| blau | Raum kühlt |
| grau | gesperrt, etwa bei offenem Fenster-/Türkontakt oder wenn das Betriebslevel das Gerät sperrt |

Der waagerechte Strich im Balken markiert die Soll-Temperatur und ist zugleich
das Bedienelement dafür: Ziehen mit Maus, Finger oder Pfeiltasten verstellt ihn
in Schritten von 0,5 °C. Geschrieben wird über dieselbe Route wie das Formular
der Raumzeile — die Berechtigung „schreiben" bleibt Voraussetzung.

Die Griffleiste unter jedem Namen ordnet die Räume um, damit benachbarte Räume
auch im Diagramm nebeneinander liegen. Die Reihenfolge steht in
`heizung_rooms.position` und betrifft ausschließlich das Diagramm; die Raumliste
darunter bleibt alphabetisch.

Das Diagramm passt sich dem Platz an: Die Spaltenbreite ergibt sich aus der
Anzahl der Räume und der verfügbaren Breite. Wird es eng — etwa auf dem Telefon
—, schrumpfen die Spalten bis zu ihrer Mindestbreite; danach lässt sich der
Balkenbereich waagerecht schieben, während die Skala daneben stehen bleibt. In
sehr schmalen Spalten entfällt die Zahl über dem Balken, weil sie sonst über der
Nachbarspalte stünde; die Ist-Temperatur steht weiterhin in der Raumzeile.
Die Skala wird aus den vorhandenen Werten abgeleitet und auf 5-°C-Schritte
gerundet, damit sie nicht bei jedem Messwert springt.

### Boost je Raum

Unter *Heizung & Klima → Raum → Regelung* lässt sich ein optionales Boost-Topic
hinterlegen. Es bleibt bidirektional mit dem beschreibbaren Raum-State `boost`
synchron — ein Schalter in einer anderen Anwendung und der Schalter in homeESS
zeigen also immer denselben Zustand.

Solange Boost aktiv ist, entfallen Soll-Temperatur und Kühlentscheidung: Der Raum
fordert die für den aktuellen Außentemperaturbereich zuständige Heizquelle mit
maximaler Leistung an. In der Raumzeile steht dazu der Hinweis *„Boost aktiv —
Soll-Temperatur wird ignoriert und mit maximaler Leistung geheizt."*

## Geändert

### Vierter Platz der mobilen Tab-Leiste gehört jetzt Heizung & Klima

Statt *Messen* führt der vierte Tab (Symbol 🌡️) direkt auf *Heizung & Klima* und
bleibt auch auf deren Unterseiten markiert. Beschriftet ist er kurz mit
„Heizung", damit fünf Tabs nebeneinander passen. Der Tab erscheint nur bei
aktivem Modul; ist es aus, steht dort weiterhin *Messen*. *Messen + Schalten*
bleibt in beiden Fällen über das Menü-Sheet erreichbar.

### Heizkosten stehen bei der Zentralheizung

Das „Heizkosten-Zählwerk" ist keine eigene Kachel mehr, sondern der Abschnitt
*Kosten* in der Kachel der Zentralheizung — dort, wo es inhaltlich hingehört.
Bisher stand es ganz unten hinter der Raumliste. Kennzahlen und Bedienung
(Startwert, Zeitraum abschließen) bleiben unverändert; ist die Zentralheizung
nicht eingerichtet, entfällt der Abschnitt wie zuvor die Kachel.

## Behoben

### Einstellungen und Adapter-Register waren ohne Funktion

Beide Seiten lieferten ein Browserskript aus, das gar nicht erst geparst wurde:
In `remote-access.js` und `adapter-states.js` stand in einem Template-Literal ein
`'\n\n'`, das schon beim Rendern zum echten Zeilenumbruch wurde und damit das
Stringliteral zerriss, das eigentlich im Browser stehen sollte. Weil dadurch das
gesamte Skript der Seite ausfiel, war keine einzige ihrer Funktionen mehr
erreichbar — bei den Einstellungen unter anderem die Tab-Umschaltung, denn die
Fernzugriffs-Kachel liefert ihr Skript in denselben Block.

Beide Stellen sind entkommen. Zusätzlich wird jede gerenderte Seite jetzt darauf
geprüft, dass ihre eingebetteten Skripte syntaktisch gültig sind — derselbe
Fehler fällt künftig im Test auf, nicht erst im Browser.

### HM-RPC: Geräteabgleich dauert wieder Sekunden statt Minuten

Nach einem Neustart brauchte der Adapter zuletzt 87 Sekunden, bis alle Werte da
waren. Die Messung an einer Anlage mit 706 Kanälen zeigt, wo die Zeit blieb:

| Messung | Wert |
|---|---|
| Alle 613 `getParamset` an der CCU zusammen | 0,8 s (Median 1 ms je Kanal) |
| Adapter-Kaltstart gegen eine Nachbildung derselben Anlage | 0,6 s |
| Realer Kaltstart | 87 s |

Die Differenz waren vier Funkbefehle an Thermostate, die die CCU als nicht
erreichbar führt. Jeder davon wird erst nach dem Geräte-Timeout der CCU — rund
20 Sekunden — mit einem Fehler quittiert und hielt währenddessen die gemeinsame
Warteschlange an. Ausgelöst wurden sie vom Regelzyklus, der beim Start alle
Sollwerte durchsetzt: Weil der Adapter die Istwerte noch nicht gelesen hatte,
ging jeder Befehl blind hinaus.

Drei Änderungen beheben das, ohne die Serialisierung aufzugeben — der
Schnittstellenprozess der CCU arbeitet Aufrufe weiterhin faktisch seriell ab, und
parallele Aufrufe würden genau die Zeitüberschreitungen zurückbringen, die
v1.6.3 beseitigt hat:

- Der **erste Abgleich nach dem Start** läuft als ein einziger Auftrag mit
  Vorrang vor Schreibbefehlen. Sonst rutscht ein Schaltbefehl zwischen zwei
  Kanälen durch und sendet blind, bevor die Istwerte da sind.
- Vor dem **ersten Schreiben auf einen noch nie gelesenen Kanal** werden dessen
  Istwerte geholt. Diese Cache-Lesung kostet Millisekunden und lässt den
  vorhandenen Vergleich greifen: Ein Sollwert, den das Gerät bereits hat, geht
  gar nicht erst über Funk — das schont auch im Normalbetrieb den Duty Cycle.
- Ein Gerät, das sich über seinen Wartungskanal als **nicht erreichbar** meldet
  (`UNREACH`), bekommt keinen Funkbefehl. Der Auftrag wird vorgemerkt und
  gesendet, sobald sich das Gerät zurückmeldet.

Im Nachbau derselben Anlage samt fünf nicht erreichbarer Thermostate ist der
Abgleich nach **0,6 s** fertig, und von zwölf Sollwert-Befehlen gehen nur die
drei tatsächlich abweichenden über Funk.

Dieselbe Blockade trat auch im laufenden Betrieb bei jedem Regelzyklus auf und
war die Ursache wiederkehrender Meldungen „Verbindung zur CCU verloren".

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.6.4**. Adapterstände: hm-rpc **1.1.8**
  (neu), hDP **1.2.13**, Zigbee **1.3.4**, InfluxDB **1.0.3**, Modbus **1.1.2**,
  MQTT-Broker **1.0.2**, Tasmota **1.0.2**, Renault **1.0.0**, Shelly **1.0.0**.
- **Datenbankänderung:** `heizung_rooms` bekommt die Spalten `boost_active` und
  `boost_topic`. Die Migration läuft beim ersten Start automatisch; bestehende
  Räume starten ohne Boost und ohne Boost-Topic.
- **Keine Konfigurationsänderung.** Bestehende Räume, Bedingungen, Widgets und
  Adapterinstanzen laufen unverändert weiter.
- **Nicht erreichbare Thermostate:** Meldet die CCU ein Gerät als `UNREACH`,
  sendet homeESS keinen Funkbefehl mehr dorthin, sondern merkt den Sollwert vor
  und schickt ihn bei Rückkehr des Geräts. Im Protokoll steht dazu je Adresse
  einmal „vorgemerkt". Wer solche Meldungen sieht, sollte das betreffende Gerät
  prüfen — homeESS regelt diesen Raum nicht.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten, damit
  die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
