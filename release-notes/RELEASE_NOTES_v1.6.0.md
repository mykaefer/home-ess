# homeESS v1.6.0 – Heizung & Klima

**v1.6.0** bringt mit **Heizung & Klima** ein neues optionales Modul. Es
verwaltet beliebig viele frei benannte Räume mit je eigener Soll-Temperatur,
eigenen Schaltschwellen und eigener Hysterese, schaltet lokale Heiz- und
Kühlgeräte über Aktionsfolgen und steuert darüber hinaus eine Zentralheizung
samt Brennererkennung, Laufzeitprotokoll und Heizkostenabrechnung.

Der Sprung auf die zweite Stelle ist die Ausnahme von der sonst üblichen
Patch-Zählung: mit dem Modul kommen sieben neue Tabellen, ein zweiter
Verbraucher der Aktionsfolgen und die erste beschreibbare Sorte von
Systemwerten hinzu.

## Hinzugefügt

### Modul „Heizung & Klima"

Zu aktivieren unter **Einstellungen → Module**. Danach steht die Seite
**Heizung & Klima** im Menü; jeder Raum bekommt — wie beim Heimkino — eine
eigene Seite statt eines Dialogs, die Zentralheizung ebenso.

**Temperaturerfassung.** Je Raum lassen sich beliebig viele Temperaturquellen
zuordnen (hDP-Sensoren, Thermostat-Istwerte, beliebige States). Bei mehr als
einer Quelle zählt ihr **Durchschnitt**; unplausible Werte fallen heraus, damit
ein ausgefallener Sensor die Regelung nicht verzieht.

**Schaltschwellen und Hysterese.** Heizen schaltet bei Unterschreiten von *Soll
minus Heiz-Offset* ein, Kühlen bei Überschreiten von *Soll plus Kühl-Offset*
(Vorgabe 0 °C bzw. 5 °C). Die je Raum einstellbare Schalthysterese liegt
zwischen Ein- und Ausschaltpunkt und verhindert Takten.

**Mindesttemperatur zum Kühlen.** Je Raum lässt sich eine absolute Untergrenze
festlegen, unterhalb derer nie gekühlt wird. Damit weckt eine Nachtabsenkung am
Wandthermostat die Klimaanlage nicht: steht die Grenze auf 28 °C, springt sie
frühestens dort an, auch wenn die Soll-Temperatur nachts auf 18 °C fällt. Leer
= keine Untergrenze.

**Thermostat-Kopplung.** Ein beliebiger schreibbarer State — etwa ein Homematic
IP Wandthermostat — hält die Soll-Temperatur bidirektional synchron. Nach einem
Neustart ist der retained Wert des Thermostats die Ausgangsbasis.

**Fenster- und Türkontakte.** Beliebig viele Kontakte je Raum, wahlweise
invertiert. Ist einer offen, werden Heizen und Kühlen abgeschaltet — sofort
oder nach einer einstellbaren Verzögerung, damit kurzes Lüften die Anlage nicht
abschaltet. Das Schließen wirkt immer sofort.

### Geräte über Aktionsfolgen

Heiz- und Kühlgerät werden mit denselben **Aktionsfolgen wie beim Heimkino**
geschaltet: Wertzuweisungen, Pausen und beliebig verschachtelbare Schleifen mit
frei verschiebbaren Aktionen. Eine Schleife kann zusätzlich in festem Abstand
prüfen, ob der gewünschte Zustand tatsächlich erreicht wurde, und sich
andernfalls allein wiederholen.

Ein einzelnes An-/Aus-Topic reicht für echte Geräte nicht — eine
Splitklimaanlage will Betriebsart, Solltemperatur und Einschaltbefehl in
bestimmter Reihenfolge, und ein IR-Befehl kommt nicht immer an. Je Gerät gibt
es eine Folge **ein** und eine **aus** (vier je Raum); bei jedem Wechsel läuft
die passende einmal ab. Ein Raum hat ein Gerät genau dann, wenn seine
„ein"-Folge Aktionen enthält — ohne Folgen erfasst er nur seine Temperatur.

### Priorität nach Betriebslevel

Heiz- und Kühlgerät bekommen je eine Priorität (1–5) im Sinne des
Lastmanagements: sie ist das Betriebslevel, **ab dem** das Gerät laufen darf.
Deckt das aktuelle Level die Priorität nicht ab, bleibt das Gerät aus und wird
bei einem Levelabfall **sofort** abgeschaltet — die „aus"-Folge läuft
unmittelbar, nicht erst im nächsten Takt. Der Wärme- bzw. Kühlbedarf des Raums
bleibt davon unberührt; gesperrt ist nur, wer ihn deckt.

Für das Heizgerät lässt sich zusätzlich aktivieren, dass bei nicht
ausreichender Priorität **direkt die Zentralheizung** heizt. Solange das
Betriebslevel die Priorität nicht abdeckt, entfällt für diesen Raum die
eingestellte Außentemperaturgrenze — die Zentralheizung tritt an die Stelle des
gesperrten lokalen Gerätes. Sobald das Level die Priorität wieder abdeckt, gilt
die Grenze unverändert weiter.

### Zentralheizung

Eingerichtet unter **Heizung & Klima → Zentralheizung**, wahlweise über
**Modbus/State** (die Anlage regelt selbst) oder über einen **Schaltaktor**.
Als Außentemperatur dient die systemweite aus *Einstellungen → MQTT*; für die
Heizung lässt sie sich hier eigens überschreiben. Eine der beiden muss
vorliegen — sonst könnte kein Raum die Zentralheizung je anfordern. Beim
Schaltaktor sind Vor- und Rücklauftemperatur zwingend zu überwachen, und
optional hängt hier auch die Umwälzpumpe an einem zweiten Schaltaktor.

Je Raum wird die Zentralheizung per Häkchen freigegeben. Ob der Raum überhaupt
Wärme braucht, entscheidet seine eigene Temperatur gegen die Soll-Temperatur —
**wer sie liefert**, entscheidet allein die **Außentemperatur**: Liegt sie
unter der je Raum festgelegten Grenztemperatur, versorgt die Zentralheizung den
Raum anstelle des lokalen Gerätes, mit derselben Hysterese; darüber heizt das
lokale Gerät. Eingestellte Werte werden nie automatisch verbogen: steht die
Grenze auf 4 °C Außentemperatur und die Soll-Temperatur auf 21 °C, so heizt
dazwischen allein ein lokales Gerät — ist keines hinterlegt, wird dort bewusst
nicht geheizt.

**Drei getrennte Zustände.** *Kessel* ist der Schaltzustand der Anlage,
*Brenner* sagt, ob er tatsächlich feuert, *Pumpe* zeigt die Umwälzpumpe.

- Der **Kessel** wird eingeschaltet, sobald ein Raum Wärme anfordert. Er darf
  erst abschalten, wenn keine Anforderung mehr besteht **und** der Brenner als
  aus erkannt ist — damit wird er nie mitten in einer Brennphase getrennt.
- Der **Brenner** wird aus der Rückmeldung der Steuerung gelesen. Fehlt diese
  (optionaler State: Flammensignal, „Brenner an"-Kontakt, Register), erkennt
  homeESS ihn an der Vorlauftemperatur: mehrere Messwerte hintereinander nach
  oben bedeuten „an" — eine einzelne Schwankung ausdrücklich nicht; die
  anschließende Halte-Phase zählt weiter als Brennerlauf; erst mehrere
  Messwerte in Folge nach unten beenden die Brennphase. Was als
  Messwertänderung zählt und was Rauschen ist, bestimmt die einstellbare
  Mindest-Änderung je Messwert.
- Die **Pumpe** läuft immer vor dem Kessel an und nach seinem Abschalten die
  eingestellte Nachlaufzeit weiter.

**Heizkörperlüfter je Raum.** In der Zentralheizungs-Karte des Raums lässt sich
ein Schalt-State hinterlegen, der eingeschaltet wird, solange dieser Raum Wärme
von der Zentralheizung anfordert. Ein Lüfter ist ein einfacher Verbraucher —
hier genügt deshalb ein Topic statt einer Aktionsfolge. Er hängt bewusst
**nicht** am Betriebslevel: er läuft gerade dann, wenn das lokale Heizgerät
gesperrt ist und die Zentralheizung einspringt.

### Brennerlaufzeiten, Heizkosten und Zählwerk

Grundlage ist genau diese Brennererkennung — gezählt wird allein, was der
Brenner **tatsächlich feuert**, nicht die Einschaltzeit des Kessels. Ein Kessel
taktet und moduliert; die reine Freigabezeit würde die Kosten zu hoch
ausweisen. Welche Quelle gerade gilt (Rückmeldung oder Vorlauf), steht über der
Auswertung. Jede Brennphase ist ein eigener Eintrag und wird im laufenden
Betrieb fortgeschrieben, sodass ein Stromausfall höchstens den letzten Takt
kostet. Aus Verbrauch je Betriebsstunde, Einheit und Preis je Einheit ergeben
sich Verbrauch und Kosten für heute, 30 Tage, das laufende Jahr und gesamt.

Das **Heizkosten-Zählwerk** unten auf der Übersichtsseite summiert Verbrauch
und Kosten über einen **Abrechnungszeitraum** hinweg — bis der Betreiber ihn
abschließt, in aller Regel zur jährlichen Zählerablesung. Ausgewiesen werden
Verbrauch, Kosten und der Monatsabschlag (Kosten ÷ 12) sowie der zuletzt
abgeschlossene Zeitraum.

- Ein **Startwert** deckt ab, was seit der letzten Ablesung schon verbraucht
  wurde, bevor homeESS mitgezählt hat.
- **Zeitraum abschließen** fragt sicherheitshalber nach: der laufende Zeitraum
  wandert ins Archiv, der neue beginnt bei 0. Dabei lässt sich der tatsächlich
  abgelesene Zählerstand eintragen; er geht dann in die Kosten des
  abgeschlossenen Zeitraums ein.
- Per Häkchen kalibriert dieser Zählerstand zusätzlich den geschätzten
  Verbrauch je Betriebsstunde. Ausdrücklich optional, denn das ergibt nur Sinn,
  wenn keine weiteren Verbraucher am selben Zähler hängen. Ein völlig
  unplausibler Faktor wird abgelehnt statt übernommen.

### Schornsteinfeger-Modus

Stellt alle Räume auf 28 °C, damit die Heizungen aufdrehen, hält die
dezentralen Geräte aus, damit sie nicht mitlaufen, und lässt die Zentralheizung
durchlaufen. Die eingestellten Soll-Temperaturen bleiben unverändert: beim
Beenden bekommen gekoppelte Thermostate ihren alten Sollwert zurückgeschrieben,
und damit fallen auch die Wärmeanforderungen der Räume wieder weg. Ein
verspätet zurückgemeldeter Thermostat-Wert gilt kurz nach einem eigenen
Schreiben als Echo und **nicht** als Verstellung von Hand — sonst bliebe der
Nachhall der 28 °C als neue Soll-Temperatur stehen.

### Räume und Zentralheizung als Systemwerte

Weil Heizung & Klima ein **Modul und kein Adapter** ist, sind seine Werte
**Systemwerte**: sie liegen unter *System* im Ordner **Räume** mit einem
Unterordner je Raum, **benannt nach dem Raum** statt durchnummeriert
(`system://homeess/raeume.Wohnzimmer.temperatur`), und stehen damit auf der
States-Seite, im State-Picker und im Wertekatalog zur Verfügung. Je Raum sind
das Temperatur, Soll-Temperatur, Heizen, Kühlen, Wärmeanforderung und
Fensterzustand; die Zentralheizung hat daneben den Ordner
**Zentralheizung**.

Die Soll-Temperatur jedes Raums und der Schornsteinfeger-Modus sind
**beschreibbar** — die erste Ausnahme von der Regel, dass berechnete
Systemwerte reine Lesequellen sind. Ein Modul meldet dafür ausdrücklich ein
Schreibziel an; alle übrigen Systemwerte bleiben unverändert schreibgeschützt.

Weil der Name in der id steht, ändert ein Umbenennen die States des Raums; zwei
Räume dürfen deshalb nicht auf dieselbe id fallen („Bad 1" und „Bad_1" wären
dieselbe) — das wird beim Speichern gemeldet.

## Geändert

### Aktionsfolgen sind jetzt geteilte Bausteine

Datenschicht, Ausführung und Oberfläche der Aktionsfolgen liegen unter
`src/automation/` bzw. `src/views/action-sequences.js` und werden vom Heimkino
**und** von Heizung & Klima verwendet. Am Heimkino ändert sich dadurch nichts —
Räume, Folgen und Verhalten bleiben, wie sie waren.

### Übersicht aktualisiert sich vollständig

Hinweise je Raum, die Notiz der Zentralheizung, die Marke des
Schornsteinfeger-Modus und die Soll-Temperatur werden im 5-Sekunden-Takt
nachgeführt — bisher blieben sie bis zum nächsten Seitenaufbau stehen. Ein
Soll-Feld, in dem gerade getippt wird, bleibt dabei unangetastet.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.6.0**. Die mitgelieferten Adapter
  werden eigenständig versioniert: hDP **1.2.11**, Zigbee **1.3.4**, InfluxDB
  **1.0.3**, hm-rpc **1.1.4**, Modbus **1.1.2**, MQTT-Broker **1.0.2**,
  Tasmota **1.0.2**, Renault **1.0.0**, Shelly **1.0.0** — Einzelheiten stehen
  in deren CHANGELOG.
- Beim ersten Start legt homeESS die Tabellen `heizung_rooms`,
  `heizung_room_sensors`, `heizung_room_contacts`, `heizung_central`,
  `heizung_burner_runs`, `heizung_billing` und `heizung_actions` an. Das läuft
  automatisch; ein manueller Eingriff ist nicht nötig.
- Das Modul ist nach dem Update **nicht** aktiv. Ohne Aktivierung unter
  „Einstellungen → Module" ändert sich an einer bestehenden Anlage nichts: es
  entstehen keine States, es läuft kein Takt, es wird nichts geschaltet.
- **Reihenfolge beim Einrichten:** zuerst die Räume anlegen (Name und
  Soll-Temperatur genügen), dann je Raum die Temperaturquellen, dann die
  Geräte-Aktionsfolgen. Die Zentralheizung braucht zwingend eine
  Außentemperatur — systemweit unter „Einstellungen → MQTT" oder eigens auf
  ihrer Seite; ohne sie lässt sie sich nicht speichern.
- Ein Raum ohne Aktionsfolgen und ohne Zentralheizungs-Freigabe schaltet
  nichts, sondern erfasst nur seine Temperatur. Das ist ein zulässiger und
  sinnvoller Zwischenstand beim Einrichten.
- **Namen mit Bedacht wählen:** die State-ids eines Raums enthalten seinen
  Namen. Ein späteres Umbenennen ändert die ids — Dashboard-Kacheln,
  Bedingungen und Automatiken, die auf die alten ids zeigen, müssen dann
  nachgezogen werden.
- Die Soll-Temperatur und der Schornsteinfeger-Modus sind beschreibbare
  Systemwerte und stehen im State-Picker als Schreibziel zur Verfügung. Alle
  übrigen berechneten Systemwerte bleiben wie bisher reine Lesequellen.
- Bestehende Heimkino-Räume und ihre Aktionsfolgen sind von der
  Zusammenlegung nicht betroffen; eine Anpassung ist nicht nötig.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten,
  damit die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
