# homeESS v1.6.3 – Englische Oberfläche, ruhige Klimageräte, mobile Navigation

**v1.6.3** ist ein Wartungsrelease mit einem großen Schwerpunkt: Die Oberfläche
ist jetzt **durchgängig zweisprachig**. Bisher fehlte auf zahlreichen Seiten die
englische Übersetzung teilweise oder ganz — *Heizung & Klima*, *Wetter* und
*Grid-Control* blieben zu über 90 % deutsch. Der Übersetzungskatalog wächst von
508 auf **2249 Schlüssel** und deckt alle Seiten, alle Meldungen und alle
Systemwert-Beschriftungen ab.

Dazu kommt eine Korrektur, die vor allem Besitzer von Splitklimaanlagen merken:
Die **Heizungssteuerung wiederholt Schaltbefehle nicht mehr**. Bisher bekam ein
Gerät bei jeder Neubewertung der PV-Prognose denselben An-/Aus-Befehl erneut,
obwohl es längst im gewünschten Zustand stand.

## Behoben

### Die Oberfläche ist durchgängig zweisprachig

Die Bestandsansichten werden nicht über `t()` geführt, sondern über
`i18n.localizeText()`: Es ersetzt im fertig gerenderten HTML jeden deutschen
Ausgangstext aus `languages/de.json` durch seine Übersetzung. Fehlt ein Text im
Katalog, bleibt er **in jeder Sprache deutsch** — genau das war die Ursache. Die
beiden Kataloge waren zwar deckungsgleich, deckten aber nur einen Bruchteil der
Oberfläche ab; für Heizung, Wetter, Grid-Control und Heimkino gab es überhaupt
keine Einträge.

Nachgezogen wurde alles, was ein Benutzer lesen kann:

- **Alle server-gerenderten Seiten** — Überschriften, Feldbeschriftungen,
  Hilfetexte, Tabellenköpfe, Schaltflächen, Auswahllisten und Tooltips.
- **Melde- und Fehlertexte** aus Routen und Fachlogik. Sie erreichen den Browser
  über `i18n.localizePayload()`, das die Felder `error`, `message`, `title`,
  `detail` und `text` übersetzt.
- **Die Wetterlagen** (*Leichter Regen*, *Gewitter mit schwerem Hagel* …), die
  auf der Wetterseite und im Dashboard-Widget erscheinen.
- **Die Beschriftungen der Systemwerte**, die auf der States-Seite, im
  State-Picker und im Wertekatalog stehen.
- **Die Statustexte der Regelung** — *Umwälzpumpe läuft nach*, *Privat:
  Live-Überschuss*, *Netz zugeschaltet* und ihresgleichen.

Reine **Logtexte bleiben bewusst deutsch**: Sie gehen an Logger und Konsole, nie
an den Browser, und der Betreiber liest sein Protokoll ohnehin auf Deutsch.

Der aufwendigste Teil waren Texte, die erst **beim Rendern** entstehen und
deshalb in keiner Quelltextsuche auftauchen:

- Eine Beschriftung, die mit einem Messwert **in einem Textknoten
  zusammenfällt** — `Kessel ${zustand}`, `Außen ${temp} · Vorlauf ${temp}`.
- Ein Satz, den ein **eingebetteter Wert zerschneidet** — etwa der Hinweis auf
  den Klima-State eines Raums, in dessen Mitte das Topic steht.
- **Browserskripte**, die eine Zustandsmarke nach jeder Live-Aktualisierung
  wieder deutsch zusammensetzen. Die Seite kam übersetzt an und wurde Sekunden
  später teilweise wieder deutsch.

Solche Stellen laufen jetzt über `i18n.t()` mit Platzhaltern (`Laufender
Abrechnungszeitraum seit {date} ({days} Tage)`) oder setzen die Beschriftung in
ein eigenes Element, damit der Katalog sie als vollständigen Textknoten trifft.

### Die Heizungssteuerung wiederholt Schaltbefehle nicht mehr

Jeder Raum merkt sich je Gerät — Heizen und Kühlen getrennt — den **zuletzt
gesendeten Schaltzustand**. Eine Aktionsfolge läuft nur noch bei Abweichung
davon.

Zuvor gab es einen zweiten, ungeprüften Weg zum Gerät: Der Betriebslevel-Handler
ruft bei **jedem** Levelwechsel alle nicht mehr erlaubten Verbraucher zum
Abschalten auf — auch die, die längst aus waren. Da die PV-Prognose alle 30
Sekunden und bei jeder SoC-Änderung neu bewertet und dabei das Betriebslevel
setzt, bekam ein gesperrtes Klimagerät die „aus"-Folge immer wieder abgespult.
Pendelte das Level an einer Schwelle, kam der „ein"-Befehl abwechselnd dazu.

Für Splitklimaanlagen mit IR-Ansteuerung war das besonders unangenehm: Jeder
Befehl ist dort eine sichtbare und hörbare Aktion am Gerät.

Wiederholen darf einen Steuerbefehl jetzt allein die **zyklische
Plausibilitätsprüfung** einer Schleife, wenn ihre Bedingung nicht erfüllt ist —
also genau der Mechanismus, der dafür gedacht ist. Ein Neustart löst für sich
genommen keinen Schaltbefehl aus, und ein Neuladen der Konfiguration ebenso
wenig.

## Geändert

### Mobile Navigation und Energieseite

Die untere Tab-Leiste führt jetzt **Dashboard · Energie · Prognose · Messen ·
Wetter**. Die eigenen Tabs für *Stromverbrauch* und *Photovoltaik* entfallen,
weil die Energieseite seit v1.6.2 der Einstieg in beide ist.

Neu ist, dass ein Tab auch auf den **Unterseiten** markiert bleibt: *Energie*
auf Stromverbrauch, Photovoltaik, Batterie und Grid-Control, *Messen* auf den
Unterseiten von *Messen + Schalten*. Man sieht damit jederzeit, in welchem
Bereich man sich befindet.

Die **Übersichtstabelle der Energieseite** bricht auf dem Telefon in Karten um,
statt die ganze Seite in die Breite zu ziehen.

### Adapterschnittstelle: `hostVersion`

`host.getInstanceIdentity()` liefert zusätzlich zu `instanceId` und
`fingerprint` das Feld **`hostVersion`** mit der laufenden homeESS-Version. Ein
Adapter erkennt daran ein Update über die interne Updatefunktion und kann es von
einem gewöhnlichen Neustart unterscheiden — etwa um eine sonst nur tägliche
Onlineprüfung sofort nachzuholen. Der **private Instanzschlüssel** bleibt wie
bisher außen vor.

## Adapter

### hDP 1.2.13

- **Der Online-Firmwarekatalog wird wirklich nur einmal am Tag gefragt.** Bisher
  fragte jeder Adapterstart erneut — ein Dienstneustart, eine geänderte
  Einstellung und jeder Auto-Restart nach einem Absturz lösten also zusätzliche
  Abrufe aus. Jetzt gilt ein Tagesplan: Der erste Abruf nach der Neuinstallation
  legt die Uhrzeit fest, zu der von da an geprüft wird; die Instanzen verteilen
  sich damit von allein über den Tag. Der Plan liegt als
  `catalog-schedule.json` im Datenverzeichnis der Instanz und übersteht
  Neustarts.
- **Ausnahme nach einem Update:** Ändert sich die homeESS-Version, prüft der
  Adapter beim Start sofort — dafür liest er das neue Feld `hostVersion`.
- Die Firmwarekachel nennt die tägliche Uhrzeit und den nächsten Termin.

### hm-rpc 1.1.6

- **Eine kurz beschäftigte CCU gilt nicht mehr als abgerissene Verbindung.** Der
  Schnittstellenprozess der CCU arbeitet Aufrufe seriell ab: Während er einen
  Funkbefehl an ein stummes Gerät bis zu dessen Timeout abarbeitet, beantwortet
  er gar nichts — auch nicht den Prüf-Ping. Bisher genügte diese **eine**
  Zeitüberschreitung, um die Verbindung als getrennt zu melden; danach wurden
  Steuerbefehle aller Geräte abgewiesen. Genau das ließ Lichter sporadisch nicht
  schalten. Der Prüflauf trennt jetzt erst nach mehreren Transportfehlern in
  Folge.
- **Ein Schaltbefehl scheitert nicht mehr am Verbindungsmerker.** Ein kurzer
  Erreichbarkeitstest entscheidet: Antwortet die Schnittstelle, geht der Befehl
  raus und die Verbindung wird nebenbei wiederhergestellt.
- **Nach einem Verbindungsverlust wird sofort neu verbunden**, statt bis zum
  nächsten Prüfintervall zu warten.
- **Verbindungswechsel stehen jetzt im Protokoll** — ein sporadisches „getrennt"
  ließ sich bisher nicht nachvollziehen.
- **Weniger gleichzeitige Last auf der CCU:** Die Nachbeobachtung fragt die
  Kanäle nacheinander ab, und der Hintergrund-Refresh pausiert, solange ein
  eigener Steuerbefehl die Schnittstelle blockiert.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.6.3**. Adapterstände: hDP **1.2.13**
  (neu), hm-rpc **1.1.6** (neu), Zigbee **1.3.4**, InfluxDB **1.0.3**, Modbus
  **1.1.2**, MQTT-Broker **1.0.2**, Tasmota **1.0.2**, Renault **1.0.0**,
  Shelly **1.0.0**.
- **Keine Datenbankänderung.** Dieses Release bringt keine Migration mit.
- **Keine Konfigurationsänderung.** Bestehende Räume, Bedingungen, Widgets und
  Adapterinstanzen laufen unverändert weiter.
- **Sprachumstellung:** Die Systemsprache steht wie bisher unter *Einstellungen
  → Allgemein → Sprache* und gilt systemweit. Wer auf Deutsch arbeitet, merkt
  von der Übersetzungsarbeit nichts — die deutschen Texte sind unverändert.
- **Eigene Sprachdateien:** Wer eine hochgeladene Sprachdatei nutzt, sollte sie
  gegen den gewachsenen Katalog aktualisieren. Fehlende Schlüssel fallen wie
  bisher auf Deutsch oder Englisch zurück, je nach eingestelltem Standort — es
  geht also nichts verloren.
- **Klimageräte:** Nach dem Update sendet homeESS erst wieder einen
  Schaltbefehl, wenn sich der gewünschte Zustand tatsächlich ändert. Steht ein
  Gerät beim Start bereits im gewünschten Zustand, bleibt es unangetastet.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten,
  damit die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
