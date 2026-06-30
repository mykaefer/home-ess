# homeESS

Basis für ein **Energy Storage System**. Der Server abonniert MQTT-Topics eines
ioBroker-Brokers und soll daraus ableiten, wie Lasten zu schalten sind.
Bedienung über ein Web-Dashboard mit vorgeschaltetem Login.

> Architektur & Entwickler-Einstieg: siehe [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).
> ioBroker-MQTT-Regelwerk: siehe [MQTT.md](MQTT.md).
> Neue Verbraucher ans Lastmanagement anbinden: siehe [LEVEL_HANDLING.md](LEVEL_HANDLING.md).

## Features (aktuell)

- 🔐 **Login** mit Passwort und „Passwort merken" (persistentes Cookie).
- 🖥️ **Dashboard** — frei konfigurierbare **Widgets** (jeder berechnete Wert als
  Live-Kachel), **Gruppen** mit Titel und Breite (voll/halb/viertel),
  Anordnung per **Drag & Drop** (Widgets und Gruppen); Widgets per Drag in
  Gruppen verschiebbar, Widgets/Gruppen bearbeit- und löschbar. Die Wertauswahl
  erfolgt über den zentralen **Wertekatalog** (siehe Output).
- ⚡ **Stromverbrauch** — KPI-Kacheln: Eigenverbrauch, Netzbezug, Heute,
  Woche, Jahr (inkl. Vorjahr), konfigurierbare MQTT-Topics je Phase sowie
  Tagesstart-Abgleich für Woche/Jahr.
- ☀️ **Photovoltaik** — PV-Anlagenverwaltung mit MQTT-Topics und Metadaten
  (Zelltyp, **Konverter-/Reglertyp**); je Anlage **aktuelle Leistung groß,
  Idealwert (Clear-Sky-Modell) klein**. Idealwert berücksichtigt Zelltyp- und
  **Konverter-Wirkungsgrad** (temperaturabhängig); Sonnenstand via echter
  **Ortssonnenzeit** (Längengrad, Zeitzone inkl. Sommerzeit, Zeitgleichung).
  **Direkte-Sonne-Erkennung** je Anlage und globales **Himmelssymbol in der
  Titelzeile** (☀️/☁️/🌙). Ertrag heute/Woche/Jahr inkl. Vorjahr.
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
- 📈 **Prognose** — Energiebilanz für heute plus drei Tage direkt unterhalb der
  Batterie im Menü. Kombiniert PV-Wetterprognose, nutzbare Batterieladung und ein
  selbstlernendes Verbrauchsmodell (Jahresmittel, gewichteter 28-Tage-Mittelwert,
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
  signierte Batterieleistung vor dem Lernen herausgerechnet.
  Oben rechts lässt sich ein Verhaltensmodell aktivieren: **Netzparallelbetrieb**
  bewertet ausschließlich die Versorgung bis zum nächsten Ladebeginn und nutzt
  danach das Netz als Reserve; **Autarkbetrieb** bewertet mehrere Prognosetage
  und reduziert Verbraucher deutlich früher bis hin zu vorbeugendem Level 1.
  Die Prognose verwaltet alle
  Betriebslevel 1–5; im Netzparallelbetrieb greift Level 1 erst bei tatsächlich
  unterschrittenem Mindest-SoC und auch ohne
  aktiviertes Verhaltensmodell. Im Autarkbetrieb gilt der Akku erst über 98 %
  als voll und Überschuss aktiviert dann Level 5. Im Netzparallelbetrieb stammt
  die Voll-Schwelle aus der oberen Grid-Control-SoC-Schwelle, bei deaktiviertem
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
- 🚗 **Wallbox** (optionales Modul, aktivierbar unter `/module`):
  - Mehrere Wallboxen einzeln anlegbar (wie die PV-Anlagen). Je Box ein
    Pflicht-**Steuer-Topic** sowie optional Status, Leistung (W/kW), fortlaufender
    Zähler (Wh/kWh), Soll-Leistung, „Fahrzeug angesteckt" und Fahrzeug-SoC (%);
    zusätzlich Maximalleistung und Fahrzeug-Akkugröße.
  - **Verbrauchszählung** je Box für Tag/Woche/Monat/Jahr inkl. Vorjahr; ohne
    Zähler-Topic aus der Leistung abgeleitet. Fehlt das SoC-Topic, wird der
    Ladezustand aus der seit Einstecken geladenen Energie geschätzt.
  - **Drei Lademodi** (Privat / Beruflich / Immer voll) mit je eigener Priorität:
    Privat lädt bis zum Mindest-Ladestand, darüber nur PV-Überschuss; Beruflich
    stellt das Auto an gewählten Wochentagen vorausschauend voll bereit; Immer
    voll lädt durchgehend. Mit Soll-Leistungs-Topic wird gegen den Überschuss
    fein moduliert. Optionaler **Modus-Sync** über ein eigenes Topic.
  - Als **Verbraucher am Betriebslevel-Handler** angemeldet (Priorität des aktiven
    Modus): Einschalten nur nach Freigabe, Zwangsabschaltung bei Levelabfall.
  - **Sonderfälle**: hängt der Ladestart trotz Befehl unter der Leerlaufschwelle, wird
    nach einer konfigurierbaren Vorgabezeit kurz aus-/eingeschaltet; manuelles Einschalten
    am Broker löst eine einmalige Volladung aus; manuelles Ausschalten hält bis zum
    Folgetag (PV-Leistung erstmals über Wallbox-Leistung) an; das unzuverlässige
    „angesteckt"-Signal sperrt das Laden nicht.
  - Die Prognose führt je Wallbox getrennte Tages- und Stundenstatistiken nach
    Wochentag. Gemessene Ladeenergie wird aus dem allgemeinen Hausverbrauch
    herausgerechnet und anschließend als eigener Wallboxbedarf eingeplant. Der
    Vorausplan nutzt dabei denselben aktiven Lademodus wie die Automatik sowie
    Fahrzeug-SoC, Akkugröße, Mindestladung und Arbeitstage. Pflichtladungen werden
    fest berücksichtigt; mehrere flexible Wallboxen teilen sich den erwarteten
    PV-Überschuss nach Priorität, statt ihn mehrfach zu verplanen.
- ⚖️ **Betriebslevel / Lastmanagement** — ein zentraler Handler setzt registrierte
  Verbraucher nach **Priorität** (= Betriebslevel, ab dem sie laufen dürfen) gegen das
  prognosegeführte Betriebslevel durch. Erste Verbraucher: Filter-/Solarpumpe, Wallbox.
  Anleitung für neue Verbraucher: siehe [LEVEL_HANDLING.md](LEVEL_HANDLING.md).
- 📤 **Output** — beliebige berechnete Werte an ioBroker-Ziel-Topics zurückgeben;
  geschlossene Regelschleife mit aktivem Readback alle 30 Sekunden. Fehlende oder
  abweichende Bestätigungen werden erneut geschrieben und je Output angezeigt.
  Nicht rücklesbare Command-Topics sind als Ziel bewusst ausgeschlossen. Werte
  werden über den zentralen **Wertekatalog** gewählt — eine durchsuchbare,
  nach Herkunft (Photovoltaik, Stromverbrauch, Batterie, Prognose, …) geordnete
  und einklappbare Liste mit Ist-Werten; angelegte Outputs erscheinen ebenso als
  dichte, kategorisierte Liste.
- 🧩 **Module** — Verwaltungsseite zum Aktivieren/Deaktivieren optionaler Module;
  aktive Module erscheinen automatisch in der Sidebar.
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

## Voraussetzungen

- Node.js ≥ 20.17
- Ein erreichbarer MQTT-Broker (z. B. ioBroker) — optional zum Start.

## Installation & Start

### Automatische Installation (Debian/Ubuntu/Raspberry Pi OS)

homeESS lässt sich auf einem frischen System mit einem Befehl installieren:

```bash
curl -fsSL https://raw.githubusercontent.com/kleinVIEH/home-ess/main/install.sh | sudo bash
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
  auth/            Passwort-Hashing, Sessions, Login-Routen
  mqtt/            Topic-Helfer, Config, Verbindungs-Manager (inkl. publish,
                   Ad-hoc-Subscriptions), State-Definitionen
  stromverbrauch/  Topic-Konfiguration + Aggregation
  photovoltaik/    PV-Anlagen, Clear-Sky-Modell, Konvertertypen, Sonnenintensität,
                   Prognose (forecast.js), Selbstkalibrierung (calibration.js)
  wetter/          Open-Meteo-Abruf (Strahlungsprognose) + In-Memory-Cache
  batterie/        Topic-Konfiguration + State-Definitionen + Cache-Reader
  prognosis/       Verbrauchslernen, Batterie-Simulation + Modellkonfiguration
  pool/            Pool-Config + Pump-Automation (solar/filter)
  grid-control/    Schaltlogik + verifizierte Regelschleife + Audit-Log (optional)
  wallbox/         Wallbox-CRUD (boxes.js), Zähler/SoC-Aggregation, Lademodus-
                   Planer (planner.js), Steuerschleife (automation.js) (optional)
  operating-state.js  Globaler Zustand (Betriebslevel, Notstrom, Autark-Latch)
  operating-level/    Betriebslevel-Handler / Lastmanagement (handler.js)
  output/          Wert-Katalog (PV, Prognose, Strom, Batterie, Pool, Sonne),
                   Output-CRUD, Publish-Engine
  dashboard/       Widget- und Gruppen-CRUD
  routes/          Eine Datei je Seite/Feature
  views/           Dynamische HTML-Renderer (je Seite eine Datei),
                   value-catalog.js = zentrale Wertekatalog-Routine
                   (Output- und Dashboard-Dialoge)
public/styles.css  Statisches Asset (CSS)
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
