# homeESS v1.5.0 – Zigbee

**v1.5.0** macht homeESS zur eigenständigen Zigbee-Zentrale. Der neue
Zigbee-Adapter spricht den Coordinator direkt über Serial oder TCP an und führt
Netzwerk, Pairing, Geräte-Interviews und Gerätebefehle selbst — ohne
Zigbee2MQTT, ioBroker, deCONZ-Server, MQTT-Gateway oder Cloud-Dienst. Dazu
kommen eine kompakte Ansicht der Adapterseite, ein Topic-Browser im
MQTT-Broker-Adapter und eine geänderte Regel für adaptereigene Abhängigkeiten.

Der Sprung auf die Minor-Stelle folgt der Linie von 1.3.0 und 1.4.0: Ein
komplettes Funkprotokoll in Eigenregie ist mehr als ein Patch.

## Hinzugefügt

### Zigbee-Adapter

Der Adapter ist eigenständig versioniert und startet in dieser Auslieferung mit
**1.3.3**. Er wird wie jeder andere Adapter über „Adapter → Neue Instanz“
eingerichtet.

**Coordinator und Transport sind getrennt.** Derselbe Z-Stack-Coordinator lässt
sich lokal am Server betreiben oder über eine transparente Zigbee-Bridge im
Netz. Freigegeben ist Texas Instruments Z-Stack (CC2652, CC2652P/P7, CC1352,
Sonoff Zigbee 3.0 USB Dongle Plus); Silicon Labs Ember und Dresden Elektronik
deCONZ sind in der Treiberstruktur vorgesehen, aber noch nicht freigegeben. Für
serielle Anbindungen empfiehlt der Adapter die gleichbleibenden Pfade unter
`/dev/serial/by-id/…` statt `/dev/ttyUSBx`.

**Ein bestehendes Netz wird übernommen, nicht neu aufgebaut.** Vor der
Inbetriebnahme liest der Adapter den Coordinator rein lesend aus und übernimmt
dessen tatsächliche Netzwerkparameter; die im Coordinator-Backup verzeichneten
Geräte lassen sich in einem Schritt übernehmen und interviewen. Ein erneutes
Pairing der Geräte ist dafür nicht nötig. Zusätzlich lassen sich
Coordinator-Backups im Format `zigpy/open-coordinator-backup` — das
`coordinator_backup.json` von Zigbee2MQTT — sowie dessen `database.db`
einspielen.

**Geräte-States entstehen dynamisch** aus den Exposes von
`zigbee-herdsman-converters`. Damit werden die dort bekannten Geräte
unterstützt, ohne dass homeESS eine eigene Gerätedatenbank pflegt. Schreibbare
Merkmale werden als beschreibbare States geführt und über die toZigbee-Converter
in Zigbee-Kommandos übersetzt.

**Pairing** läuft über ein startbares und beendbares Anlernfenster mit
einstellbarem Zeitlimit und Restzeitanzeige. Geräte lassen sich entfernen — auch
erzwungen, wenn sie nicht mehr antworten.

**Verfügbarkeit** wird getrennt nach Routern, netzbetriebenen Endgeräten und
batteriebetriebenen Sleepy End Devices bewertet. Batteriegeräte werden nie aktiv
geweckt und nicht nach wenigen Minuten Stille als offline geführt.

### Netzwerkkarte

Die Karte ist die Startseite des Adapters (`…/manage/map`) und zeigt die
tatsächlich gemessenen Funkstrecken aus den Nachbartabellen von Coordinator und
Routern — keine geschätzte Topologie. Die Geräte ordnen sich kräftebasiert
selbst an, der Coordinator bildet die Mitte.

- Die Verbindungsqualität ist dreifach kodiert: Farbe, Strichstärke und Abstand.
  Die Karte bleibt damit auch für farbfehlsichtige Betrachter lesbar.
  Eltern-Kind-Beziehungen — die tatsächlich genutzte Route — heben sich von
  bloßen Nachbarkontakten ab.
- Jede Gerätegattung hat ihr Piktogramm (Licht, Steckdose, Schaltaktor,
  Rollladen, Thermostat, Schloss, Lüfter, Bewegungsmelder, Fenster-/Türkontakt,
  Rauch- und Wassermelder, Taster, Sensor, Repeater, Coordinator), abgeleitet
  aus den Exposes des Converters.
- Beim Überfahren eines Knotens erscheint eine Bedienkachel direkt über ihm:
  Gerät, Gattung, Erreichbarkeit, Verbindungsqualität — und das Schalten,
  Lampen mit Helligkeitsregler. Dafür genügt das Bedienrecht, geprüft wird
  serverseitig.
- Die Karte hält sich selbst aktuell: Sie erneuert sich bei jeder Änderung am
  Netz, gesammelt und mit mindestens zehn Minuten Abstand zwischen zwei
  Durchläufen. Abschaltbar über die Einstellung **Netzwerkkarte selbsttätig
  aktualisieren**; der Knopf auf der Karte bleibt davon unberührt.
- Knoten lassen sich mit Maus oder Finger verschieben, die Karte ist
  tastaturbedienbar und liegt in der mobilen Ansicht mit.

### Topic-Browser im MQTT-Broker-Adapter

Alle über MQTT erreichbaren Topics einer Broker-Instanz stehen als aufklappbarer
Verzeichnisbaum bereit — die von Clients angelegten Geräte-Topics und, sofern
freigeschaltet, der Systembaum unter `states/`. Jede Ebene zeigt die Anzahl der
States darunter, jede State-Zeile den letzten bekannten Wert und ein Schloss bei
schreibgeschützten States. Umschaltbar zwischen homeESS-Struktur und
MQTT-Pfad-Gliederung, mit Suchfeld und Kopierknopf je Zeile.

### Kompakte Ansicht der Adapterseite

Oben rechts steht neben „Inaktive Adapter ausblenden“ ein zweiter Haken
„Kompakte Ansicht“; die Auswahl wird browserlokal gespeichert. Aktiviert bleibt
je Adapter eine einzeilige Kopfzeile aus Name, Prefix und Version, darunter die
Instanzen. Kurzbeschreibungen, Copyright-Vermerk, Kurzinfo, Spaltenüberschriften
und die Adapteraktionen entfallen in dieser Ansicht. Auf Smartphones darf die
Adapter-Kopfzeile umbrechen, damit Name und Version vollständig lesbar bleiben.

## Geändert

### Adaptereigene Abhängigkeiten werden mitversioniert

Ein Adapter ist laut [ADAPTER.md](../ADAPTER.md) portabel und bringt seine
JavaScript-Abhängigkeiten im eigenen Verzeichnis mit; homeESS führt für Adapter
weder `npm install` noch einen globalen Installationsschritt aus. Die
`.gitignore`-Regeln `node_modules/` und `dist/` hätten genau diese Dateien
ausgeschlossen — nach Klon und Update hätten sie gefehlt. Die Ausnahme gilt eng
begrenzt für `adapter/*/node_modules/`; für den übrigen Programmcode bleiben
beide Regeln unverändert.

Anlass ist der Zigbee-Adapter, der `zigbee-herdsman` und
`zigbee-herdsman-converters` mitliefert. Die serielle Anbindung bringt ihre
vorkompilierten Binärdateien für alle gängigen Plattformen mit (linux-x64,
linux-arm, linux-arm64, jeweils glibc und musl, dazu darwin und win32) — ein
Kompilierschritt beim Update entfällt.

### MQTT-Broker: Punkte öffnen eine eigene Topic-Ebene

`system://homeess/geraet.3.leistung` erscheint jetzt als
`states/system/homeess/geraet/3/leistung` statt bisher
`states/system/homeess/geraet.3.leistung`. Die homeESS-Systemwerte gliedern sich
mit Punkten; ohne diese Regel lagen mehrere hundert States flach in einem
einzigen Verzeichnis. Ausgespart bleibt außerdem nur noch die eigene Instanz
statt des gesamten eigenen Prefixes.

### hDP: klare Meldung bei nicht erreichbaren Geräten

Kam die TCP-Verbindung nachweislich nicht zustande, meldet der Adapter jetzt
„nicht erreichbar (keine TCP-Verbindung innerhalb von 3000 ms)“ samt
Zieladresse, statt in jedem Fall einen säumigen WebSocket-Upgrade zu behaupten.
Die Fehlersuche begann dadurch bislang bei der Firmware statt beim Gerät.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.5.0**. Mitgelieferte Adapter:
  Zigbee **1.3.3**, hDP **1.2.9**, MQTT-Broker **1.0.1**, InfluxDB **1.0.0**,
  Renault **1.0.0**.
- **Achtung, MQTT-Broker-Adapter:** Abos und Retained Messages auf die alten,
  punktbehafteten Pfade greifen nicht mehr. Betroffene Clients müssen auf die
  neuen Topics umgestellt werden. Geräte-Topics und die Rückabbildung auf die
  homeESS-Adressen bleiben unverändert.
- Der Zigbee-Adapter ist nach dem Update vorhanden, aber **ohne Instanz**. Erst
  eine unter „Adapter“ angelegte Instanz nimmt Verbindung zum Coordinator auf.
- Vor der ersten Inbetriebnahme empfiehlt sich ein Backup des Coordinators.
  Betreiber, die bisher Zigbee2MQTT einsetzen, halten dessen
  `coordinator_backup.json` und `database.db` bereit und **beenden Zigbee2MQTT**
  — eine Zigbee-Bridge lässt nur einen Client zu.
- Der Netzwerkschlüssel liegt ausschließlich im Secret-Store, nie in den
  Instanz-Einstellungen und nie im Log. Ein Neuaufbau des Netzes verlangt die
  Einstellung *und* eine getrennte Bestätigung durch einen Administrator und
  gilt für genau einen Vorgang; fehlende homeESS-Persistenz ist ausdrücklich
  kein Grund für einen Neuaufbau.
- Das Anlernfenster ist immer zeitlich begrenzt (höchstens 600 Sekunden). Ein
  dauerhaft offenes Zigbee-Netz lässt sich nicht einstellen.
- Der Klon des Repositories bringt jetzt die adaptereigenen Abhängigkeiten mit
  (rund 930 Dateien unter `adapter/zigbee/node_modules/`). Ein `npm install` für
  Adapter ist weder nötig noch vorgesehen.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Dashboard-
  und Adapterseiten, damit die aktualisierten Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
