# HDP Adapter

Der HDP-Adapter bindet Geräte gemäß der normativen Spezifikation
[`../../HDP.md`](../../HDP.md) direkt in homeESS ein. Es gilt ausschließlich
`1.0-draft`; ältere HMAC-, Shared-Secret- oder
`draft-physical-network`-Profile werden nicht parallel unterstützt.

## Discovery und Pairing

Der Adapter browsed `_homeess-hdp._tcp.local`, validiert alle verpflichtenden
TXT-Felder und führt Geräte anhand ihrer dauerhaften `device_id` über
Adressänderungen hinweg zusammen. **HDP Kopplung & Verwaltung** ist die
Kopplungs- und Konfigurationsseite; **HDP Geräte** bleibt die allgemeine
Geräte-/State-Übersicht.

Vor `POST /pairing/start` werden ein 16-Byte-`adapter_nonce` und ein
32-Byte-`binding_key` dauerhaft lokal gespeichert. Der Schlüssel liegt nur im
restriktiven Adapter-Secret-Store. Aktiv wird ein Binding erst, nachdem die aus
den rohen Key-Bytes berechnete `binding_id` übereinstimmt und
`GET /pairing/status` mit beiden Binding-Headern `match` meldet. Pending- und
aktive Bindings werden nach Neustart anhand der Recovery-Matrix aus `HDP.md`
abgeglichen; Konflikte überschreiben niemals das Binding des Geräts.

## Hardware, Renderer und Laufzeit

Im Runtime-Profil `pixel-timeline-v1` ist `device_type` für die Firmware opak.
Der Adapter interpretiert `percentage_indicator`, rendert Prozentwert, Farbe,
Plugin-Helligkeit und Richtungsindikator vollständig lokal und sendet nur
generische RGB-Frames beziehungsweise `hdtl-delta-v1`-Timelines. Physische
Maximalhelligkeit und Strombegrenzung verbleiben ausschließlich im Gerät.

GPIOs, Treiber, Farbreihenfolgen und sämtliche Output-/Timelinegrenzen stammen
aus dem Gerätemanifest. An das Gerät wird immer das vollständige normative
Output-Konfigurationsobjekt gesendet. Nach einem unsicheren `PUT /config` liest
der Adapter die Konfiguration zurück und wiederholt nur bei unveränderter
Revision. Meldet `last_boot.config_load_status` einen Recoveryfall, bleiben
automatische Schreibvorgänge gesperrt.

Der WebSocket nutzt HTTP Basic mit Instanz-ID und Binding-Key. Der Adapter prüft
Nachrichtenformat, das vom Manifest gemeldete Nachrichtenlimit und lückenlose
Sequenzen, wartet auf `session.ready`, synchronisiert abweichende
Konfigurationsrevisionen und verwendet den verbindlichen 15/45-Sekunden-
Heartbeat sowie die festgelegte Reconnect-Folge. Nach jeder neuen Sitzung wird
zuerst ein absoluter Frame oder eine vollständig hochgeladene Timeline
ausgegeben. Geräte ohne `runtime_profile` bleiben über einen isolierten
Legacy-`state.set`-Pfad kompatibel; ein vorhandenes abweichendes Profil wird
abgelehnt.

## Entkopplung und Firmware

Entkopplung sendet `preserve_hardware_config: true`. Bei verlorener Antwort wird
der Gerätezustand bis zu 60 Sekunden abgeglichen; der mutierende Request wird
nicht blind wiederholt. Danach werden lokaler Key, Verbindung und Abonnements
entfernt.

OTA prüft Familie, SemVer, Kanal, Plattform, Board, Variante, Protokoll,
Konfigurationsschema, Größe und SHA-256. Artefakte müssen über den konfigurierten
Ed25519-Release-Schlüssel authentifiziert sein. Die Signatur wird über die 32
rohen SHA-256-Bytes geprüft. Der Upload verwendet die normativen
Binding-/Metadatenheader. Nach dem separaten Neustart gilt das Update erst als
erfolgreich, wenn das Gerät innerhalb von 60 Sekunden mit der Zielversion und
Status `completed` wiederkehrt.
