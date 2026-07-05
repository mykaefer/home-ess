# homeESS v1.1.0 – Mobile Bedienung, Schaltgruppen und robuste Prognosedaten

Mit **v1.1.0** erhält homeESS eine vollständige mobile Bedienoberfläche, frei
zusammenstellbare Schaltgruppen und eine deutlich transparentere Datenbasis für
die Verbrauchsprognose. Zugleich wurden die Adapter-Persistenz und insbesondere
die ereignisbasierte Homematic-Anbindung stabilisiert.

## Highlights

### Vollständige mobile Ansicht

- Kompakter mobiler Header, untere Tab-Bar und vollflächiges Menü-Sheet ersetzen
  die Desktop-Seitenleiste auf kleinen Bildschirmen.
- Dialoge erscheinen als Bottom-Sheets, Bedienelemente besitzen ausreichend
  große Touch-Ziele und Formulare verhindern den iOS-Auto-Zoom.
- Dashboard, Stromverbrauch, Batterie, Prognose, PV, Wallbox, Messen + Schalten,
  Adapter, States, Output, Module, Pool, Grid-Control und Login besitzen jeweils
  eine eigene Smartphone-Anordnung statt lediglich verkleinerter Desktopkarten.
- Details und Pflegezustand sind in [MOBILE.md](MOBILE.md) dokumentiert.

### Schaltgruppen für Messen + Schalten

- Neue Unterseite mit Drag-and-Drop-Zuordnung vorhandener Geräte.
- Eine Gruppe ist an, sobald mindestens ein Mitglied an ist, und erst aus, wenn
  alle Mitglieder aus sind.
- Optionales **„Schaltet als Einheit“** zieht jede Ein- oder Ausschaltflanke auf
  alle Gruppenmitglieder.
- Toggle, beschreibbarer virtueller State und optionales Remote-Topic arbeiten
  bidirektional. Externe Remote-Änderungen schalten die Gruppe; Änderungen des
  Gruppen-Istzustands werden unmittelbar zurückgespiegelt.
- Die virtuellen States `schaltgruppe://gruppen/<id>` erscheinen in States,
  State-Picker und Wertekatalog.
- Statuspunkte und Toggle-Schalter folgen live dem bestätigten Istzustand.

### Belastbare Prognose-Datenbasis

- Optionaler dreiphasiger Eigenverbrauchszähler kann anstelle der bilanzierten
  Tagesenergie als Primärquelle dienen.
- Eine stündliche Selbstzählung integriert die gemessene Eigenverbrauchsleistung.
- Ohne echten Zähler ersetzt ein Guard die Bilanz nur bei gleichzeitig großer
  relativer und absoluter Abweichung; reale Verbrauchsspitzen bleiben erhalten.
- Das neue 24-Stunden-Diagramm stellt Messung/Bilanz, Selbstzählung und den
  tatsächlich übernommenen Prognosewert transparent gegenüber.

### Batterie und Verbrauchsverrechnung

- Der Mindest-SoC besitzt ein optionales, bidirektionales Remote-Topic.
- Messen-+-Schalten-Gruppen können einzeln festlegen, ob ihre Verbrauchssumme bei
  „Sonstige Verbraucher“ vom Gesamtverbrauch abgezogen wird.

## Adapter und Homematic

- **HM-RPC-Adapter 1.1.2** implementiert die vollständige XML-RPC-Logikschicht:
  `listDevices(interface_id)` wird gemeldet und beantwortet, Geräteänderungen
  kommen über `event`/`system.multicall` unmittelbar von der CCU.
- Die Abmeldung verwendet spezifikationskonform dieselbe Callback-URL mit leerer
  `interface_id`.
- Die ersten fünf Callbackmethoden nach einer Anmeldung werden zur Diagnose
  protokolliert.
- Der optionale Hintergrund-Refresh liest weiterhin ausschließlich den
  CCU-`VALUES`-Cache, seriell und ohne Funk- oder Duty-Cycle-Last.
- Dynamische Adapterdaten wie die HM-RPC-Geräteliste werden beim Speichern von
  Einstellungen atomar erhalten; Formularfelder und Adaptermetadaten können sich
  nicht mehr gegenseitig überschreiben.
- Der Hauptsystem-Code enthält keine HM-RPC-Sonderabfrage. Die Trennung aus
  [ADAPTER.md](ADAPTER.md) bleibt gewahrt.

## Datenbank und Upgrade

Bestehende Installationen werden automatisch erweitert:

- `mess_schalt_switch_groups` und `mess_schalt_actors.switch_group_id`
- `mess_schalt_groups.offset_total_consumption`
- `batterie_config.remote_topic`
- `stromverbrauch_config.eigenverbrauch_zaehler_l1..3_topic`
- `prognosis_hourly_consumption.primary_kwh`, `self_kwh` und `reconciled`

Es sind keine manuellen Datenbankmigrationen erforderlich. Nach dem Update muss
homeESS neu gestartet werden, damit Hauptsystem **1.1.0** und HM-RPC **1.1.2**
geladen werden.

## Behobene Fehler

- Homematic-Push-Events kamen wegen der unvollständigen Callback-Logikschicht
  nicht zuverlässig an; Zustände wurden deshalb teils erst beim Seitenaufruf
  aus dem CCU-Cache sichtbar.
- Schaltgruppen-Remote-Topics konnten bei direkten Geräteänderungen hinter dem
  Gruppenstatus zurückbleiben oder retained Werte als neue Befehle behandeln.
- Geräte- und Gruppen-Toggles blieben nach einem Klick durch den Browserfokus
  optisch stehen, obwohl der Statuspunkt bereits den neuen Zustand zeigte.
- Das Speichern von Adaptereinstellungen konnte parallel aktualisierte
  Gerätelisten überschreiben.

