# homeESS

Basis für ein **Energy Storage System**. Der Server abonniert MQTT-Topics eines
ioBroker-Brokers und soll daraus ableiten, wie Lasten zu schalten sind.
Bedienung über ein Web-Dashboard mit vorgeschaltetem Login.

> Architektur & Entwickler-Einstieg: siehe [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).
> ioBroker-MQTT-Regelwerk: siehe [MQTT.md](MQTT.md).
> Neue Verbraucher ans Lastmanagement anbinden: siehe [LEVEL_HANDLING.md](LEVEL_HANDLING.md).

## Features (aktuell)

- 🔐 **Login** mit Passwort und „Passwort merken" (persistentes Cookie).
- 🖥️ **Dashboard** — frei konfigurierbare **Widgets** in zwei Sorten (Dialog mit
  Tabs): **Wert-Kachel** (jeder berechnete Wert als Live-Kachel, Auswahl über den
  zentralen **Wertekatalog**) und **Info-Kachel** (System-Infos wie homeESS-/Node-
  Version, Plattform, CPU-/RAM-Auslastung als Fortschrittsbalken u. a. — Felder per
  Häkchen wählbar). **Gruppen** mit Titel und Breite (voll/halb/viertel), Anordnung
  per **Drag & Drop** (Widgets und Gruppen); Widgets per Drag in Gruppen
  verschiebbar, Widgets/Gruppen bearbeit- und löschbar.
- ⚡ **Stromverbrauch** — KPI-Kacheln: Eigenverbrauch, Netzbezug, Heute,
  Woche, Jahr (inkl. Vorjahr), konfigurierbare MQTT-Topics je Phase. Der Button
  **„Wert abgleichen"** (oben rechts) setzt zum Tagesstart wahlweise die Wochen-,
  Jahres- oder **Vorjahressumme** (Netzbezug + Einspeisung) sowie das **Minimum/
  Maximum** von Netzbezug bzw. Eigenverbrauch (Wert + Datum). Wird ein Zähler-Topic
  gewechselt (z. B. Zählertausch), gilt der erste neue Rohwert als Ist-Stand und
  wird nicht als Zählersprung gezählt.
- ☀️ **Photovoltaik** — PV-Anlagenverwaltung mit MQTT-Topics und Metadaten
  (Zelltyp, **Konverter-/Reglertyp**); je Anlage **aktuelle Leistung groß,
  Idealwert (Clear-Sky-Modell) klein**. Idealwert berücksichtigt Zelltyp- und
  **Konverter-Wirkungsgrad** (temperaturabhängig); Sonnenstand via echter
  **Ortssonnenzeit** (Längengrad, Zeitzone inkl. Sommerzeit, Zeitgleichung).
  **Direkte-Sonne-Erkennung** je Anlage und globales **Himmelssymbol in der
  Titelzeile** (☀️/☁️/🌙). Ertrag heute/Woche/Jahr inkl. Vorjahr; Button
  **„Wert abgleichen"** (oben rechts) für Wochen-/Jahres-/Vorjahressumme und
  Minimum/Maximum (Wert + Datum).
  - **Sonnenreferenz-Cutoff** je Anlage (getrennt morgens/abends, Default 10 %):
    nur Anlagen, auf die die Sonne brauchbar scheint (Idealwert ≥ Anteil der
    kWp-Spitze), zählen für Sonnenintensität und ☀️/☁️ — verhindert falsche
    Sonnenwerte einer groß dimensionierten, off-axis stehenden Anlage.
  - **PV-Prognose** (Open-Meteo, kostenlos & ohne API-Key): erwarteter Tagesertrag
    für **Heute + 3 Tage**; die Heute-Karte zeigt zusätzlich *bis jetzt* und
    *noch erwartet*. Nutzt dasselbe Clear-Sky-Modell wie der Live-Idealwert.
  - **Selbstkalibrierung** (je Anlage aktivierbar): tageszeit-abhängiger
    Kalibrierfaktor je **15-Minuten-Fenster**, der den gemessenen Schnitt der
    letzten 15 Minuten mit der von Open-Meteo gelieferten Strahlung desselben
    Fensters vergleicht und sich sanft nachzieht (in **beide Richtungen**) — erkennt
    u. a. Verschattungen und fließt in Idealwert und Prognose ein. Kalibriert wird
    je Anlage nur bei brauchbarem Sonnenstand (Sonnenreferenz-Cutoff morgens/abends);
    Randzeiten erben den nächstgelegenen Faktor. **„Kalibrierung löschen"** im
    Bearbeiten-Dialog setzt eine Anlage zurück.
- 🔋 **Batterie** — Das zentrale Element der Plattform.
  - Konfigurierbare MQTT-Topics für SoC, Leistung, Spannung, Temperatur.
  - KPI-Kacheln (nur wenn Topic konfiguriert), SoC-Balken mit Farbwechsel
    (grün ≥ 50 %, dunkelgelb 20–49 %, rot < 20 %), Leistungsanzeige mit
    Richtungsindikator (Laden/Entladen/Bereit).
  - **Batterie-Ladeanzeige in der Titelzeile**: Icon in Batterieform mit
    Füllstand und Prozentzahl, erscheint automatisch sobald SoC-Daten
    vorliegen, live aktualisiert via SSE.
  - Mindest-SoC mit MQTT-Ziel-Topic und 5-%-Schieberegler sowie Batterietyp,
    Zellzahl, Kapazität in Ah und manuell anpassbaren unteren/oberen Spannungsgrenzen.
- 🔌 **Messen + Schalten** (Menü unter Batterie) — Dashboard-artige Seite für
  schaltbare/messbare Geräte.
  - Frei anlegbare **Gruppen** und **Geräte-Kacheln**, per Drag & Drop zwischen
    Gruppen oder ohne Gruppe anordbar.
  - Je Gerät bis zu vier MQTT-Topics: **Schalten, Status, Leistung, Zähler**
    (mindestens Schalten, Leistung oder Zähler). Ohne Status-Topic gilt das
    Schalt-Topic (sonst die Leistung) als Ist-Stand. Ist nur ein Zähler gesetzt,
    wird die Leistung aus dem Zählerfortschritt abgeleitet und fällt nach über
    10 Minuten ohne Fortschritt auf 0 W.
  - Alle Geräte mit Schalt-Topic laufen über das **Betriebslevel-Gate** und werden
    unterhalb ihrer Priorität ausgeschaltet; Einschalten ist dann auch manuell nicht
    erlaubt. **„Immer an"** schaltet bei erneuter Freigabe automatisch wieder ein.
    Ohne diese Option bleibt das Gerät aus, bis es über den Kachel-Schalter manuell
    eingeschaltet wird. Priorität je Gerät oder – per Häkchen – von der Gruppe.
  - Die Werte der gesetzten Topics stehen im Wertekatalog (Kategorie **Geräte**);
    die Gruppen bilden **Verbrauchssummen** und zeigen sie in der Titelzeile.
- 📈 **Prognose** — Energiebilanz für heute plus drei Tage direkt unterhalb der
  Batterie im Menü. Kombiniert PV-Wetterprognose, nutzbare Batterieladung und ein
  selbstlernendes Verbrauchsmodell (bereinigter Tagesverlauf, gewichteter 28-Tage-Mittelwert,
  persönliches Stundenprofil und Tageskalibrierung). Netzbedarf, Überschuss,
  Batterie-Endstand, heutiger Autark-Status und die autarken Tage des laufenden
  Jahres stehen auch im Wertekatalog bereit. Der Jahreszähler kann bidirektional
  mit einem optionalen MQTT-Topic abgeglichen werden. Beim Jahreswechsel wird er
  nach „Autarke Tage Vorjahr“ übernommen; auch dieser Stand besitzt optional ein
  eigenes bidirektionales Abgleich-Topic.
  Die Versorgungsampel bewertet vorrangig den prognostizierten SoC beim ersten
  ab dem Folgetag sichtbaren Ladebeginn. Bei Dunkelflaute wird über weitere
  Open-Meteo-Prognosetage kumuliert. Ein erwartetes Erreichen des Mindest-SoC
  wird mit Tag und Uhrzeit ausgewiesen; Tagesend-SoC bleibt als Zusatzwert sichtbar.
  Für jeden Wochentag wird eine eigene Verbrauchskurve gelernt. Da der aus
  Netzbezug und PV abgeleitete Gesamtverbrauch auch Akkuladung enthält, wird die
  signierte Batterieleistung vor dem Lernen herausgerechnet. Wallbox, Poolpumpen
  und funktionszugeordnete Messen-+-Schalten-Geräte (Licht, Waschen, Warmwasser,
  Heizung / Klima, Kochen) werden ebenfalls aus dem reinen Hausbedarf entfernt und
  anschließend separat eingeplant — Heizung / Klima über Stundenprofile je
  Außentemperatur-Bucket (5-°C-Schritte), die übrigen Funktionen je Wochentag.
  Ungelernte Wochentage übernehmen ausschließlich die Lernkurve des jüngsten
  abgeschlossenen Tages (Vortag) als Vorlage; die Tageskalibrierung passt sie an
  den laufenden Verlauf an, und der abgeschlossene Tag wird wieder Vorlage für den
  nächsten. Je Prognosetag zeigt ein 24-h-Balkendiagramm das erwartete
  Stundenprofil; bereits gelernte Stunden des laufenden Tages erscheinen in
  abweichender Farbe samt Soll-Marke, sodass Abweichungen sofort sichtbar sind.
  Oben rechts lässt sich ein Verhaltensmodell aktivieren: **Netzparallelbetrieb**
  bewertet ausschließlich die Versorgung bis zum nächsten Ladebeginn und nutzt
  danach das Netz als Reserve; **Autarkbetrieb** bewertet mehrere Prognosetage
  und reduziert Verbraucher deutlich früher bis hin zu vorbeugendem Level 1.
  Die Prognose verwaltet alle
  Betriebslevel 1–5; im Netzparallelbetrieb greift Level 1 erst bei tatsächlich
  unterschrittenem Mindest-SoC und auch ohne
  aktiviertes Verhaltensmodell. Im Autarkbetrieb gilt der Akku erst über 98 %
  als voll und Überschuss aktiviert dann Level 5. Im Netzparallelbetrieb stammt
  Level 4 bedeutet dort, dass der Bedarf bis zum nächsten Ladebeginn sicher
  gedeckt ist. Die Ampel ist direkt zugeordnet: Grün setzt Level 4, Gelb Level 3
  und Rot Level 2; Level 1 greift erst unter Mindest-SoC. Die
  Voll-Schwelle stammt aus der oberen Grid-Control-SoC-Schwelle, bei deaktiviertem
  Grid-Control werden 90 % verwendet. Das aktivierte Modell setzt den globalen
  Betriebslevel direkt, wird bei MQTT-Änderungen neu bewertet und spätestens
  alle 30 Sekunden unabhängig vom Verbrauchssampling ausgeführt.
- 🔌 **Grid-Control** (optionales Modul): schaltet Netz und optional
  Überschusseinspeisung nach getrennten unteren/oberen SoC- und
  Spannungsfenstern mit kleiner lokaler Hysterese sowie nach einer
  Wechselrichter-Temperaturwarnung. Schutzwarnungen und fünf Grid-Zustände sind
  per MQTT/Output-Katalog verfügbar. Eine dreiphasige, konfigurierbare
  Netzfrequenz-Überwachung verriegelt bereits beim Ausfall einer Phase den
  **Notstrombetrieb**, bis auf allen drei Phasen wieder Frequenz erkannt wird.
  Grid-Control schaltet nur diesen Notstromzustand ein und aus und verändert
  selbst kein Betriebslevel. Das globale
  Betriebslevel 1–5 erscheint als rot-grüne Balkenanzeige in der Titelzeile.
  Eine dreiphasige Wechselrichterlast-Hysterese nutzt die vorhandenen
  Eigenverbrauchsleistungen L1–L3, schaltet bei Überlast einer Phase zu und
  erst unter allen drei Rückschaltschwellen wieder ab.
  Der globale Katalogwert **Autark** startet jeden Tag auf `true`, sofern keine
  Mindest-SoC-Netzschaltung aktiv ist, und bleibt nach einer solchen Schaltung
  für den restlichen Tag auf `false`. Die obere SoC-Grenze schaltet das Netz nur
  zu, wenn **Überschusseinspeisung aktiviert** ist.
  - **Verifizierte Schaltung:** Jeder Schaltbefehl wird gegen die tatsächliche
    Broker-Rückmeldung geprüft und bei Abweichung selbstheilend wiederholt; je
    Befehls-Topic ein Badge „bestätigt"/„nicht bestätigt!" plus Verbindungsanzeige.
  - **Protokoll:** scrollbares Audit-Log unten — nur Schwellen-Übertritte mit
    Aktionen (gelb) und kritische Zustände (rot), einzeilig mit Zeitstempel und
    Werten; paginiert, Seite 1 live, ab Seite 2 statisch.
- 🏊 **Poolsteuerung** (optionales Modul, aktivierbar unter `/module`):
  - Solarpumpe und Filterpumpe mit je Status-/Steuerungs-Topic und Priorität.
  - **Drei Modus-Buttons** je Pumpe: An / Aus / Automatik.
  - Solarautomatik: sonnenbasiert, 2-Min-Mindesthaltedauer, Maximaltemperatur
    mit Probezyklus (Filterpumpe optional). Probeläufe starten nur bei direkter
    Sonneneinstrahlung; eine laufende Probe läuft bei Beschattung zu Ende; der
    Pausenzähler läuft bei Beschattung weiter — nach Sonnenrückkehr startet
    sofort eine neue Probe wenn die Pausenzeit abgelaufen ist.
  - Filterautomatik: bis zu 3 Zeitfenster, Follow-Solar, Akku-Override
    (liest Batterie-SoC aus dem zentralen Cache).
  - KPI-Kacheln für Wassertemperatur, Pumpen, pH, Chlor (je nach Konfiguration).
  - Beide Pumpen sind als **Verbraucher am Betriebslevel-Handler** angemeldet: im
    Automatik-Modus schalten sie nur ein, wenn das Betriebslevel ihre Priorität
    freigibt, und schalten bei Levelabfall sofort ab. Hand An/Aus übersteuert das
    Level bewusst.
  - Ein Energiemodell lernt die Pumpenleistung aus realen Schaltvorgängen, zieht
    tatsächliche Laufzeiten aus dem gelernten Hausbedarf ab und plant sie separat:
    Solar aus den erwarteten PV-Stunden, Filter aus Zeitfenstern, Follow-Solar und
    Akku-Override. Maximaltemperatur und Probeläufe werden nicht vorausgesagt,
    rückwirkend aber vollständig bereinigt.
- 🚗 **Wallbox** (optionales Modul, aktivierbar unter `/module`):
  - Mehrere Wallboxen einzeln anlegbar (wie die PV-Anlagen). Je Box ein
    Pflicht-**Steuer-Topic** sowie optional Status, Leistung (W/kW), fortlaufender
    Zähler (Wh/kWh), Soll-Leistung, „Fahrzeug angesteckt" und Fahrzeug-SoC (%);
    zusätzlich Maximalleistung und Fahrzeug-Akkugröße.
  - **Verbrauchszählung** je Box für Tag/Woche/Monat/Jahr inkl. Vorjahr; ohne
    Zähler-Topic aus der Leistung abgeleitet. Fehlt das SoC-Topic, wird der
    Ladezustand aus der seit Einstecken geladenen Energie geschätzt.
  - **Drei Lademodi** (Privat / Beruflich / Immer voll) mit je eigener Priorität:
    Privat lädt bis zum Mindest-Ladestand, darüber nur prognostizierten, vom
    Hausakku nicht mehr speicherbaren PV-Überschuss; Beruflich berechnet aus
    Fahrzeug-SoC, Akkugröße und Ladeleistung den rechtzeitigen Start für 06:00 Uhr
    an gewählten Arbeitstagen; Immer voll lässt das Ladegerät aktiviert. Mit
    Soll-Leistungs-Topic wird vorsichtig gegen den Live-Überschuss moduliert;
    ohne Sollwert startet die Box erst bei vollständig gedeckter Ladeleistung.
    Optionaler **Modus-Sync** über ein eigenes Topic.
  - Als **Verbraucher am Betriebslevel-Handler** angemeldet (Priorität des aktiven
    Modus): Einschalten nur nach Freigabe, Zwangsabschaltung bei Levelabfall.
  - **Sonderfälle**: hängt der Ladestart trotz Befehl unter der Leerlaufschwelle, wird
    nach einer konfigurierbaren Vorgabezeit kurz aus-/eingeschaltet; manuelles Einschalten
    am Broker löst eine einmalige Volladung bis Leistungsabfall oder Abziehen aus;
    manuelles Ausschalten hält bis zum Folgetag mit vollständiger PV-Deckung und
    ausreichender Hausakku-Reserve an; das unzuverlässige
    „angesteckt"-Signal sperrt das Laden nicht.
  - Die Prognose führt je Wallbox getrennte Tages- und Stundenstatistiken nach
    Wochentag. Gemessene Ladeenergie wird aus dem allgemeinen Hausverbrauch
    herausgerechnet und anschließend als eigener Wallboxbedarf eingeplant. Der
    Vorausplan nutzt dabei denselben aktiven Lademodus wie die Automatik sowie
    Fahrzeug-SoC, Akkugröße, Mindestladung und Arbeitstage. Pflichtladungen werden
    fest über alle sichtbaren Tage fortgeführt; mehrere flexible Wallboxen teilen
    sich nur den nach dem Hausakku verbleibenden PV-Überschuss nach Priorität,
    statt ihn mehrfach zu verplanen. Ein unveränderliches gecachtes Basismodell
    wird dabei für jede Prognose mit dem aktuellen Akku-/Fahrzeugzustand neu geplant.
- ⚖️ **Betriebslevel / Lastmanagement** — ein zentraler Handler setzt registrierte
  Verbraucher nach **Priorität** (= Betriebslevel, ab dem sie laufen dürfen) gegen das
  prognosegeführte Betriebslevel durch. Erste Verbraucher: Filter-/Solarpumpe, Wallbox.
  Anleitung für neue Verbraucher: siehe [LEVEL_HANDLING.md](LEVEL_HANDLING.md).
- 📤 **Output** — beliebige berechnete Werte an ioBroker-Ziel-Topics zurückgeben;
  geschlossene Regelschleife mit aktivem Readback im 30-Sekunden-Fenster. Jeder
  Output wird zu einem **zufälligen Zeitpunkt** innerhalb des Fensters geprüft
  (statt alle gleichzeitig) und entlastet so den Broker; bereits bestätigte Werte
  werden nur erneut abgefragt, wenn ihr Ist-Wert älter als ein Prüffenster ist.
  Fehlende oder abweichende Bestätigungen werden erneut geschrieben und je Output
  angezeigt. Nicht rücklesbare Command-Topics sind als Ziel bewusst ausgeschlossen.
  Werte werden über den zentralen **Wertekatalog** gewählt — eine durchsuchbare,
  nach Herkunft (Photovoltaik, Stromverbrauch, Batterie, Prognose, …) geordnete
  und einklappbare Liste mit Ist-Werten; darin auch **statistische Jahreswerte**
  (gestern, Durchschnitt, Minimum/Maximum inkl. Datum, Jahres-/Vorjahressumme) und
  automatisch alle **Adapter-States**. Angelegte Outputs erscheinen als dichte,
  kategorisierte Liste, deren Auf-/Zu-Zustand pro Kategorie gemerkt wird.
- 🧩 **Module** — Verwaltungsseite zum Aktivieren/Deaktivieren optionaler Module;
  aktive Module erscheinen automatisch in der Sidebar.
- 🔌 **Adapter** — austauschbare Geräte-Anbindungen (z. B. Modbus) als eigene
  Verzeichnisse unter `/adapter/`, **ohne Eingriff in den Quellcode**. Pro Adapter
  mehrere benannte Instanzen anlegen/aktivieren; jede läuft isoliert als eigener
  Kindprozess. Werte werden über `prefix://instanz/adresse` geroutet (Topics ohne
  Schema laufen weiter über den MQTT-Broker). Regelwerk: [ADAPTER.md](ADAPTER.md),
  Vorlage: `adapter/demo`. Mitgeliefert: **Modbus-TCP-Adapter** (`adapter/modbus`)
  mit Register-Verwaltung und **Presets** (Vorlagen zum Anlegen der Live-States,
  inkl. Upload; Format: `adapter/modbus/PRESET.md`). Zusammenhängende Register
  gleicher Unit-ID, Registerart und Pollrate werden blockweise gelesen und als
  gemeinsamer State-Batch verteilt; Pollintervalle und State-Adressen bleiben gleich.
- 🗂️ **States** — klappt als Unterpunkt unter **Adapter** auf: Baumansicht aller
  von Adaptern gemeldeten Werte (Instanz → Kategorie → State) mit Live-Werten;
  hinter Topic-Feldern direkt per Auswahldialog übernehmbar. Alle States sind
  zusätzlich automatisch im Wertekatalog als Quelle verfügbar.
- 🌤️ **Sonnenintensität** (% des Clear-Sky-Ideals, auf 100 % gedeckelt):
  aktuell sowie 10-Minuten-/Tages-/Vortagsmittel. Nur Anlagen oberhalb ihres
  größenrelativen Sonnenreferenz-Cutoffs fließen ein.
- ⚙️ **Einstellungen** (Karten-Layout): Passwort ändern, **Standort & Zeit**
  (Breiten-/Längengrad, Zeitzone, automatische Zeitumstellung — für das
  Clear-Sky-Modell), MQTT-Broker konfigurieren & Verbindung testen.
- 📡 MQTT-Verbindungs-Manager mit Reconnect-Handling, Wert-Cache und **Publish**
  (nach den Regeln aus [MQTT.md](MQTT.md)); Live-Updates per SSE (`/live/events`).
- 🚀 **systemd-Service** — startet automatisch beim Systemboot.

Alle Seiten werden **dynamisch** serverseitig gerendert — es gibt keine
statischen HTML-Seiten.

## Hardware-Empfehlungen

homeESS ist schlank (Node.js + SQLite + MQTT-Client); jede aktive Adapter-Instanz
läuft als eigener Prozess. Es genügt bescheidene Hardware für den Dauerbetrieb:

| Ressource | Minimum | Empfohlen |
| --------- | ------- | --------- |
| CPU       | 1 Kern (x86/ARM) | **2 Kerne** — Hauptprozess ist single-threaded, Adapter laufen als eigene Prozesse |
| RAM       | 512 MB  | **1 GB** |
| Speicher  | 4 GB    | **8 GB SSD/eMMC** — die SQLite-DB bleibt klein; SD-Karten leiden an Dauerschreibzyklen |
| Netzwerk  | WLAN    | **kabelgebundenes Ethernet** für eine stabile MQTT-Verbindung |

Bewährte Plattformen: **Raspberry Pi 4/5** (ab 2 GB), ein **Mini-PC** (z. B.
Intel N100/NUC) oder eine **kleine VM / LXC-Container** (z. B. unter Proxmox
genügen 2 vCPU + 1 GB RAM). Voraussetzung ist ein Debian-basiertes System mit
`systemd` und `apt` (siehe Installation).

## Voraussetzungen

- Debian/Ubuntu/Raspberry Pi OS mit `systemd` und `apt` (für die Installation).
- Node.js ≥ 20.17 (wird vom Setup-Skript bei Bedarf automatisch installiert).
- Ein erreichbarer MQTT-Broker (z. B. ioBroker) — optional zum Start.

## Installation & Start

### Schnellstart auf frischem Debian

Von der leeren Maschine bis zur laufenden Instanz:

1. **Debian installieren** — eine minimale Server-Variante (ohne Desktop) reicht.
   Danach als `root` anmelden oder mit `su -` zu root wechseln.
2. **curl und sudo bereitstellen** (auf einer Minimalinstallation oft nicht dabei):

   ```bash
   apt update
   apt install -y curl sudo
   ```

3. **homeESS installieren** (ein Befehl):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
   ```

   > Als `root` kannst du `sudo` weglassen; mit einem normalen Benutzer muss dieser
   > in der `sudo`-Gruppe sein (`usermod -aG sudo <benutzer>`, danach neu anmelden).

Danach ist die Weboberfläche unter `http://<host-ip>:3000` erreichbar
(Standard-Login: **`admin`**).

### Automatische Installation (Debian/Ubuntu/Raspberry Pi OS)

Auf einem bereits vorbereiteten System genügt der reine Installationsbefehl:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
```

Das Skript installiert die System- und Node.js-Abhängigkeiten, klont homeESS
nach `/opt/home-ess`, legt eine neue Datenbank unter
`/var/lib/home-ess/app.db` an und aktiviert den systemd-Dienst. Eine vorhandene
Installation oder Datenbank wird aus Sicherheitsgründen nicht überschrieben.

### Manuelle Installation

```bash
npm ci
npm start          # startet auf http://localhost:3000
```

Entwicklung mit Auto-Reload:

```bash
npm run dev        # node --watch
```

### Erster Login

Standard-Passwort beim ersten Start: **`admin`**.
Nach dem Login unter **Einstellungen → Neues Passwort** ändern.

### Konfiguration über Umgebungsvariablen

| Variable      | Default            | Beschreibung                         |
| ------------- | ------------------ | ------------------------------------ |
| `PORT`        | `3000`             | HTTP-Port                            |
| `HOME_ESS_DB` | `./data/app.db`    | Pfad zur SQLite-Datenbank            |

## Service-Verwaltung

Der Server läuft als systemd-Service und startet automatisch beim Systemboot.

```bash
systemctl status home-ess      # Status prüfen
systemctl restart home-ess     # Neustart (z. B. nach Updates)
journalctl -u home-ess -f      # Live-Log
```

## Projektstruktur (Kurzform)

```
server.js          Einstiegspunkt
src/
  config.js        Konstanten
  db.js            SQLite (Schema, Seed, Migration)
  app.js           Express-App + periodische Jobs
  modules/         Modul-Registry (optionale Features)
  state-bus.js     Gemeinsamer Wert-Cache + Event-Bus (Broker und Adapter)
  adapters/        Adapter-Schnittstelle: Registry, Instanzen-CRUD, Prefix-Router,
                   Host/Supervisor (fork je Instanz), Runtime-Shim, States-Aggregat
  auth/            Passwort-Hashing, Sessions, Login-Routen
  mqtt/            Topic-Helfer (inkl. prefix://-Schema), Config, Verbindungs-Manager
                   (inkl. publish, Ad-hoc-Subscriptions, Adapter-Routing), State-Defs
  stromverbrauch/  Topic-Konfiguration + Aggregation
  photovoltaik/    PV-Anlagen, Clear-Sky-Modell, Konvertertypen, Sonnenintensität,
                   Prognose (forecast.js), Selbstkalibrierung (calibration.js)
  wetter/          Open-Meteo-Abruf (Strahlungsprognose) + In-Memory-Cache
  batterie/        Topic-Konfiguration + State-Definitionen + Cache-Reader
  prognosis/       Verbrauchslernen, Batterie-Simulation + Modellkonfiguration
  pool/            Pool-Config + Pump-Automation und separates Energiemodell
  grid-control/    Schaltlogik + verifizierte Regelschleife + Audit-Log (optional)
  wallbox/         Wallbox-CRUD (boxes.js), Zähler/SoC-Aggregation, Lademodus-
                   Planer (planner.js), Steuerschleife (automation.js) (optional)
  messen-schalten/ Geräte-/Gruppen-CRUD, Live-Aggregation (Leistung aus Zähler),
                   Level-Gate-Steuerschleife (Seite „Messen + Schalten")
  operating-state.js  Globaler Zustand (Betriebslevel, Notstrom, Autark-Latch)
  operating-level/    Betriebslevel-Handler / Lastmanagement (handler.js)
  output/          Wert-Katalog (PV, Prognose, Strom, Batterie, Pool, Sonne),
                   Output-CRUD, Publish-Engine
  dashboard/       Widget- und Gruppen-CRUD
  routes/          Eine Datei je Seite/Feature
  views/           Dynamische HTML-Renderer (je Seite eine Datei),
                   value-catalog.js = zentrale Wertekatalog-Routine
                   (Output- und Dashboard-Dialoge),
                   state-picker.js = Auswahldialog für Adapter-States
public/styles.css  Statisches Asset (CSS)
adapter/           Adapter-Verzeichnis (je Adapter ein Unterordner mit
                   adapter.json + index.js); enthält den Demo-Referenzadapter
```

## Daten

SQLite unter `data/app.db` (gitignored). Wichtige Tabellen:
`users`, `mqtt_config`, `sessions`,
`stromverbrauch_config`/`_aggregation`/`_counter_state`,
`pv_plants`/`pv_aggregation`/`pv_summary_aggregation`/`pv_calibration_buckets`,
`sun_intensity_samples`,
`batterie_config`, `battery_daily_state`, `prognosis_config`, `prognosis_daily_consumption`,
`prognosis_hourly_consumption`,
`modules`, `pool_config`, `grid_control_config`, `operating_state`,
`grid_control_log`, `wallboxes`/`wallbox_counter_state`/`wallbox_summary_state`,
`outputs`, `dashboard_groups`, `dashboard_widgets`.

Passwörter werden als scrypt-Hash gespeichert.

## Lizenz

GNU Affero General Public License v3.0 (`AGPL-3.0-only`) – siehe
[LICENSE](LICENSE).
