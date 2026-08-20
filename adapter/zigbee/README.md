# Zigbee-Adapter für homeESS

Macht homeESS zur **eigenständigen Zigbee-Zentrale**. Die vollständige
Netzwerkverwaltung läuft in diesem Adapter; der Coordinator ist reine
Funkhardware.

Für den Betrieb wird **nichts weiter benötigt** — kein Zigbee2MQTT, kein
Home Assistant, kein ioBroker, kein deCONZ-Server, kein MQTT-Gateway und kein
Cloud-Dienst.

```text
Zigbee-Geräte
      │
      ▼
Zigbee Coordinator
      │  Serial oder TCP
      ▼
homeESS Zigbee Adapter
      │
      ▼
homeESS
```

## Unterstützte Hardware

Freigegeben ist **Texas Instruments Z-Stack**: CC2652, CC2652P, CC2652P7,
CC1352 sowie der Sonoff Zigbee 3.0 USB Dongle Plus (ZBDongle-P).

Silicon Labs Ember und Dresden Elektronik deCONZ sind in der Treiberstruktur
vorgesehen. Sie sind bewusst noch nicht freigegeben: Ohne einen hardwarenahen,
rein lesenden Zugriff auf die Netzwerkparameter ließe sich nicht sicherstellen,
dass ein bestehendes Netz beim Start nicht überschrieben wird.

## Anbindung

Coordinator-Typ und Anbindung sind getrennt. Derselbe Coordinator lässt sich
lokal oder über das Netz betreiben.

### Seriell (lokal)

Möglichst den gleichbleibenden Pfad verwenden:

```text
/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_...
```

`/dev/ttyUSB0` kann sich nach einem Neustart auf andere Hardware beziehen; der
Adapter weist darauf hin, verweigert die Arbeit aber nicht.

Die vorhandenen Anschlüsse zeigt:

```bash
ls -l /dev/serial/by-id/
```

### TCP (Zigbee-Bridge im Netz)

Die Bridge reicht den seriellen Datenstrom **binärtransparent** weiter und
führt selbst keinerlei Zigbee-Logik aus:

```text
TI Z-Stack USB Coordinator ── Serial ── Zigbee Bridge ── TCP ── homeESS Zigbee Adapter
```

In den Instanz-Einstellungen werden Adresse und Port der Bridge eingetragen.

## Bestehendes Zigbee-Netz übernehmen

Das ist der Regelfall und der wichtigste Punkt dieses Adapters.

**Der Adapter erzeugt niemals beiläufig ein neues Zigbee-Netz.** Auch dann
nicht, wenn homeESS noch keinerlei gespeicherte Daten hat — das ist der normale
Zustand beim ersten Start oder nach einem Umzug der Installation.

Ablauf beim Start:

1. Anbindung auflösen (seriell oder TCP).
2. Coordinator **rein lesend** abfragen: Firmware, IEEE-Adresse, ob ein Netz
   konfiguriert ist, und die tatsächlichen Netzwerkparameter.
3. Plan fassen: bestehendes Netz übernehmen oder — nur bestätigt — neu erstellen.
4. Netzwerkdaten persistieren.
5. Coordinator in Betrieb nehmen.

Schritt 2 ist nicht optional. Ohne ihn entscheidet die Zigbee-Bibliothek anhand
beliebiger Vorgabewerte, ob sie das vorhandene Netz weiterführt oder neu
kommissioniert — und ein neu kommissioniertes Netz bedeutet, dass **jedes Gerät
neu angelernt werden müsste**.

### Geräte übernehmen

Netzwerkschlüssel und PAN-ID zu übernehmen genügt, damit die Geräte weiterfunken
— sie sind der Zigbee-Bibliothek dann aber noch unbekannt, weil diese ihre
Gerätedaten in einer eigenen Datenbank führt. Auf der Unterseite
**Zigbee-Netzwerk** legt die Schaltfläche *Geräte übernehmen* sie aus dem
Coordinator-Backup an und interviewt sie. Ein erneutes Anlernen ist dafür nicht
nötig.

Batteriebetriebene Geräte antworten erst, wenn sie aufwachen. Sie erscheinen
zunächst mit dem Interviewstatus „ausstehend“ und vervollständigen sich später
von selbst; ein Tastendruck am Gerät beschleunigt das.

### Von Zigbee2MQTT wechseln

Beide Dateien lassen sich auf der Unterseite **Zigbee-Netzwerk** einspielen:

| Datei | Inhalt |
|---|---|
| `coordinator_backup.json` | Netzwerkparameter, Schlüssel, Coordinator-Kinder |
| `database.db` | Modelle, Endpunkte und Interviewstand der Geräte |

Vorhandene Dateien werden vor dem Überschreiben gesichert. Die Gerätedatenbank
lässt sich nur bei getrenntem Coordinator einspielen.

### Neues Netz erstellen

Ein Neuaufbau verlangt **zweierlei**: die Einstellung „Neues Netzwerk erstellen“
*und* eine getrennte Bestätigung durch einen Administrator auf der Unterseite
**Zigbee-Netzwerk**. Die Bestätigung gilt für genau einen Vorgang. Dadurch kann
ein versehentlich stehen gelassener Auswahlwert bei einem späteren Neustart kein
produktives Netz vernichten.

## Netzwerkkarte

Die Karte **ersetzt die frühere Geräteliste**: Die Geräte stehen dort mit ihrer
Gattung, ihrem Zustand und ihren Funkstrecken im Zusammenhang. Erreichbar ist sie
als Kachel ganz oben auf der Unterseite **Zigbee-Netz**; beide Seiten sind
gegenseitig verlinkt. Die Knoten ordnen sich selbst an, der Coordinator bildet
die Mitte.

**Verbindungen.** Jede Linie ist eine gemessene Funkstrecke aus den
Nachbartabellen der Geräte. Ihre Qualität steckt gleich dreifach in der
Darstellung — in der Farbe, in der Strichstärke und im Abstand:

| Qualität | LQI | Linie |
|---|---|---|
| sehr gut | 192–255 | dick, grün |
| gut | 128–191 | kräftig, grün |
| ausreichend | 64–127 | schmal, gelb |
| schwach | 0–63 | dünn, rot |

Farbe allein wäre für farbfehlsichtige Betrachter nicht unterscheidbar; deshalb
trägt die Strichstärke dieselbe Aussage. Zusätzlich zieht eine gute Verbindung
zwei Knoten enger zusammen als eine schwache — schlecht angebundene Geräte
rücken damit von selbst an den Rand.

Kräftiger gezeichnete Linien sind Eltern-Kind-Beziehungen, also die tatsächlich
genutzte Route; blassere sind reine Funkkontakte zwischen Nachbarn.

**Knoten.** Jedes Gerät zeigt sein Piktogramm — Licht, Steckdose, Schaltaktor,
Rollladen, Thermostat, Schloss, Lüfter, Bewegungsmelder, Fenster-/Türkontakt,
Rauch- und Wassermelder, Taster, Sensor, Repeater. Die Gattung wird aus den
Exposes des Converters abgeleitet, es gibt also auch dafür keine gepflegte
Geräteliste. Ein durchgezogener Rand heißt erreichbar, ein gestrichelter nicht
erreichbar oder unbekannt; ein gelber Ring zeigt ein eingeschaltetes Gerät, ein
blauer Punkt ein Batteriegerät.

**Bedienen.** Berührt der Zeiger einen Knoten, erscheint direkt über ihm eine
**Bedienkachel**: Gerät, Gattung, Erreichbarkeit, Verbindungsqualität und
Batteriestand, darunter die Bedienelemente, die zu seinen Merkmalen passen:

| Merkmal | Bedienelement | Beispiel |
|---|---|---|
| ja/nein | Schalter | Schaltaktor, Kindersicherung |
| Zahl mit Bereich | Regler mit Wert und Einheit | Helligkeit, Position, Sollwert |
| bis zu vier Möglichkeiten | Tasten | Rollladen: Auf/Zu/Stopp |
| mehr Möglichkeiten | Auswahlliste | Lichteffekte |

Es gibt keine Sonderbehandlung je Gerätetyp — was der Converter als beschreibbar
ausweist, wird bedienbar. Merkmale, die das Expose als Konfiguration kennzeichnet,
liegen eingeklappt unter „Geräteeinstellungen". Regler senden erst beim
Loslassen, damit nicht jede Zwischenstellung einen Funkbefehl auslöst. Zum
Bedienen genügt das Bedienrecht; geprüft wird zusätzlich serverseitig.

Die Kachel bleibt offen, solange der Zeiger auf ihr liegt, und schließt kurz
danach. Ein **Klick auf den Knoten stellt sie fest**, damit sie beim Bedienen
nicht weggeht; Schließknopf oder Esc beenden das. Auf Telefon und Tablet — wo es
kein Überfahren gibt — öffnet das Antippen die Kachel. „Alle Angaben und
Funkstrecken" führt in das ausführliche Detailfeld unterhalb der Karte.

**Ermittlung der Funkstrecken.** Sie läuft **selbsttätig**: sobald das Netz
steht, und erneut bei jeder Änderung daran — ein Gerät kommt hinzu, wird
angelernt, verlässt das Netz oder wechselt seinen Weg. Dabei werden Coordinator
und Router nach ihren Nachbartabellen gefragt; das erzeugt Funkverkehr und dauert
je nach Netzgröße einige Minuten.

Damit daraus kein Dauerfunk wird, werden Änderungen gesammelt und zwischen zwei
Durchläufen liegen mindestens zehn Minuten. Über die Einstellung **Netzwerkkarte
selbsttätig aktualisieren** lässt sich die Automatik abschalten; die Schaltfläche
*Jetzt neu ermitteln* bleibt dann als einziger Weg. Endgeräte werden nie
abgefragt:
Sie führen keine Nachbartabelle, und batteriebetriebene Geräte würde die Abfrage
nur wecken. Geräte ohne erkannte Funkstrecke stehen abgesetzt am unteren Rand —
das ist ehrlicher, als eine Verbindung zu zeichnen, die nicht gemessen wurde.

Knoten lassen sich mit der Maus oder dem Finger verschieben; „Neu anordnen"
setzt das Bild zurück.

## Geräte umbenennen

In der **Verwaltung** trägt jedes Gerät ein Namensfeld. Der Name ist reiner
Anzeigetext:

- Die **State-Adresse bleibt** `<ieee-adresse>/<eigenschaft>` — eingetragene
  Topics überstehen jede Umbenennung.
- Der Name bestimmt die **Kategorie** im States-Baum und die Beschriftung auf der
  Karte.
- Ein **leeres Feld** stellt den Standardnamen (Modell + Adressende) wieder her.

## States

Die Eigenschaften eines Gerätes entstehen **dynamisch** aus dessen Exposes in
`zigbee-herdsman-converters`. Der Adapter führt bewusst keine eigene
Gerätedatenbank; die dort bekannten Geräte von Aqara, IKEA, Philips Hue, Sonoff,
Tuya, Ledvance, Bosch, Innr, Nous, Lidl und vielen weiteren Herstellern werden
damit automatisch unterstützt.

Die Adresse eines States lautet `<ieee-adresse>/<eigenschaft>`, der vollständige
Bezeichner also:

```text
zigbee://<instanz>/00124b002c3a7f69/temperature
```

Die IEEE-Adresse und nicht der Anzeigename bildet die Adresse: Ein umbenanntes
Gerät behält damit seine Topics. Der Anzeigename bestimmt die Kategorie im
States-Baum.

Jedes Gerät erhält zusätzlich `linkquality`, `available`, `last_seen` und
`interview_state`. Der Coordinator selbst meldet unter `coordinator/…` unter
anderem Verbindungszustand, IEEE-Adresse, Firmware, PAN-ID, Kanal und
Gerätezahl; `coordinator/permit_join` ist beschreibbar und öffnet das
Anlernfenster.

Schreibbare Merkmale — Ein/Aus, Helligkeit, Farbtemperatur, Farbe,
Rollladenposition, Thermostat-Sollwert, Betriebsmodus und alles Weitere, was der
jeweilige Converter anbietet — werden als beschreibbare States geführt.
Zusammengesetzte Werte wie `color` werden als JSON-Text übertragen, weil ein
homeESS-State genau einen Zahl-, Wahrheits- oder Textwert hält.

### Werttypen

| Merkmal laut Expose | State in homeESS | Beispiel |
|---|---|---|
| binär | **Wahrheitswert** | `state`, `contact`, `occupancy` |
| numerisch | Zahl | `brightness`, `temperature`, `position` |
| Auswahl | Text | `system_mode`, Rollladen-`state` (OPEN/CLOSE/STOP) |
| zusammengesetzt, Liste | JSON-Text | `color`, `options` |

Schaltzustände werden bewusst als **Wahrheitswert** geführt, nicht als „ON"/„OFF":
Die Auswertungen von homeESS — Messen und Schalten, Schaltgruppen, Systemwerte,
Bedingungen — erwarten dort einen booleschen Wert. Beim Schreiben nimmt der
Adapter alles Übliche entgegen (`true`, `1`, `"on"`, `"ein"`, …) und setzt es in
den Befehl um, den das Gerät versteht.

## Verfügbarkeit

Unterschieden werden Router, netzbetriebene Endgeräte und batteriebetriebene
Sleepy End Devices. Batteriegeräte werden **nie** aktiv abgefragt: Das würde sie
wecken und die Batterie belasten, ohne die Aussage zu verbessern. Ihr
Zeitfenster ist entsprechend lang voreingestellt (25 Stunden), damit ein Sensor,
der sich nur einmal täglich meldet, nicht fälschlich als offline erscheint.

## Sicherheit

- Der Netzwerkschlüssel liegt ausschließlich im Secret-Store von homeESS — nie
  in den Instanz-Einstellungen, nie im Klartext im Datenverzeichnis, nie im Log.
- Ausgaben der Zigbee-Bibliotheken durchlaufen eine Redaktion, die
  Schlüsselmaterial auch dann entfernt, wenn die Bibliothek es selbst ausgeben
  würde.
- Netzwerkparameter werden beim normalen Start nicht verändert: kein neuer
  Schlüssel, keine geänderte PAN-ID, keine geänderte Extended PAN-ID, kein
  Kanalwechsel.
- Das Anlernfenster ist immer begrenzt (höchstens 600 Sekunden). Ein dauerhaft
  offenes Zigbee-Netz lässt sich nicht einstellen.

## Robustheit

Ein einzelnes unbekanntes oder fehlerhaftes Gerät beendet den Adapter nicht.
Ebenso wenig ein kurzzeitig nicht erreichbarer Coordinator, eine getrennte
TCP-Verbindung, ein abgezogenes USB-Gerät, ein fehlerhaftes Zigbee-Paket, ein
gescheitertes Interview oder ein unbekannter Converter.

Bei Verlust der Verbindung meldet der Adapter den Coordinator als getrennt und
verbindet sich mit wachsendem Abstand neu (5 s bis 2 min). **Geräte werden dabei
nicht gelöscht und Netzwerkdaten nicht neu erzeugt.**

### Nur ein zuständiger Prozess

homeESS startet eine Instanz bei jeder Änderung neu. Überlappen sich zwei
Neustarts, kann ein Kindprozess übrig bleiben, den der Supervisor nicht mehr
führt. Er hielte den Coordinator besetzt, und der eigentlich zuständige Prozess
zeigte ein leeres Netz.

Der Adapter hinterlegt deshalb in seinem Datenverzeichnis (`instance.lock`),
welcher Prozess zuständig ist. Wer dort einen neueren vorfindet, gibt den
Coordinator frei und beendet sich. Im Protokoll steht dann:

```text
Diese Instanz läuft ein zweites Mal; ein neuerer Prozess (…) hat übernommen.
```

### Nur ein Client an der Bridge

Eine Zigbee-Bridge reicht genau einen seriellen Anschluss weiter und lässt
deshalb **nur einen Client gleichzeitig** zu. Hängt dort noch eine Verbindung,
wird jeder weitere Versuch abgewiesen; der Adapter meldet das als abgewiesene
Verbindung samt Ziel.

Der Adapter gibt seinen Anschluss in jedem Fall frei — auch wenn der
Verbindungsaufbau abbricht oder die Instanz mitten darin gestoppt wird. Bleibt
die Meldung dennoch bestehen, hält ein anderes Programm oder ein nicht beendeter
Prozess den Anschluss. Welcher das ist, zeigt auf dem homeESS-Server:

```bash
ss -tnp | grep <bridge-port>
```

## Persistenz

Alle Daten liegen im instanzeigenen Datenverzeichnis (0700):

| Datei | Inhalt |
|---|---|
| `devices.db` | Gerätedatenbank der Zigbee-Bibliothek |
| `devices.db.backup` | deren Sicherung |
| `coordinator_backup.json` | Coordinator-Backup |
| `network.json` | Netzwerkparameter **ohne** Schlüsselmaterial |

Der Netzwerkschlüssel liegt getrennt davon im Secret-Store.

## Abhängigkeiten

`zigbee-herdsman` und `zigbee-herdsman-converters` liegen im
`node_modules/`-Verzeichnis **dieses Adapters** und werden nicht global in
homeESS installiert. Nach der Installation des Adapters sind keine weiteren
Node-Pakete, Dienste oder Zigbee-Anwendungen von Hand einzurichten.

Werden die Adapterdateien ohne `node_modules/` übertragen, lassen sich die
Abhängigkeiten im Adapterverzeichnis nachinstallieren:

```bash
cd /opt/home-ess/adapter/zigbee
npm install --omit=dev
```

## Nicht enthalten

Architektonisch berücksichtigt, aber bewusst noch nicht umgesetzt: Zigbee
Groups, Binding, Scenes, Touchlink, OTA-Updates von Zigbee-Geräten,
Netzwerkkarte, Coordinator-Migration, Green Power, Install Codes und die
mDNS-Erkennung der Zigbee-Bridge.
