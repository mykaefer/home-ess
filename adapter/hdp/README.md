# hDP Adapter

Der hDP-Adapter bindet Geräte gemäß der normativen Spezifikation
[`../../hDP.md`](../../hDP.md) direkt in homeESS ein. Es gilt ausschließlich
`1.0-draft`; ältere HMAC-, Shared-Secret- oder
`draft-physical-network`-Profile werden nicht parallel unterstützt.

## Discovery und Pairing

Der Adapter browsed `_homeess-hdp._tcp.local`, validiert alle verpflichtenden
TXT-Felder und führt Geräte anhand ihrer dauerhaften `device_id` über
Adressänderungen hinweg zusammen. Die **Geräteverwaltung** ist der übersichtliche
Einstiegspunkt für Kopplung und Konfiguration; **hDP Geräte** bleibt die
allgemeine Geräte-/State-Übersicht.

Vor `POST /pairing/start` werden ein 16-Byte-`adapter_nonce` und ein
32-Byte-`binding_key` dauerhaft lokal gespeichert. Der Schlüssel liegt nur im
restriktiven Adapter-Secret-Store. Aktiv wird ein Binding erst, nachdem die aus
den rohen Key-Bytes berechnete `binding_id` übereinstimmt und
`GET /pairing/status` mit beiden Binding-Headern `match` meldet. Pending- und
aktive Bindings werden nach Neustart anhand der Recovery-Matrix aus `hDP.md`
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

Es gibt genau eine universelle Firmware; ein Release-Manifest beschreibt sie je
Plattform, Board und Variante. Sie wird deshalb einmal zentral in der
Geräteverwaltung hinterlegt und nicht je Gerät hochgeladen. Der Speicher hält je
Release-Kanal einen Stand unter `<datenverzeichnis>/firmware/<kanal>/`; ein Gerät
zieht ausschließlich den Kanal aus seinen Updateeinstellungen. Ein Kanal gilt
erst als installierbar, wenn zu jedem deklarierten Artefakt auch die Datei
vorliegt.

Der Adapter bringt einen geprüften Stable-Stand unter
`bundled-firmware/stable/` mit. Beim ersten Start wird er in den beschreibbaren
Firmwarespeicher übernommen. Bei späteren Adapterupdates wird nur ein weiterhin
als gebündelt markierter, älterer Stable-Stand ersetzt; sobald der Betreiber den
Kanal manuell befüllt, bleibt er vollständig unter seiner Kontrolle.

Optional kann `releaseSource` auf eine HTTPS-Basis-URL zeigen. Darunter erwartet
der Adapter je Kanal `<kanal>/manifest.json` und die im Manifest genannten
Artefakte, beispielsweise `stable/manifest.json`. Er prüft beim Start und danach
alle sechs Stunden. Online-Abrufe sind nur mit konfiguriertem Ed25519-
`firmwarePublicKey` möglich und verlangen für jedes Artefakt eine gültige
Signatur. Erst wenn alle Dateien Größen-, SHA-256- und Signaturprüfung bestehen,
wird der Kanal atomar ersetzt. Die Geräte sprechen weiterhin ausschließlich mit
homeESS im lokalen Netz.

OTA prüft Familie, SemVer, Kanal, Plattform, Board, Variante, Protokoll,
Konfigurationsschema, Größe und SHA-256. Ist ein Ed25519-Release-Schlüssel
konfiguriert, muss das Artefakt zusätzlich signiert und über die 32 rohen
SHA-256-Bytes verifizierbar sein; ohne Schlüssel bleibt ein selbst gebautes,
unsigniertes Image zulässig. Eine vorhandene, aber ungültige Signatur wird immer
abgelehnt. Der Upload verwendet die normativen Binding-/Metadatenheader. Nach dem
separaten Neustart gilt das Update erst als erfolgreich, wenn das Gerät innerhalb
von 60 Sekunden mit der Zielversion und Status `completed` wiederkehrt.

Die Installation erfolgt je Gerät per Klick oder automatisch: Bei Updatepolitik
`automatic` prüft der Adapter minütlich sowie nach jeder Rückkehr eines Geräts
und nach jedem Hinterlegen eines Releases, ob ein neuerer Stand des gewählten
Kanals vorliegt, und installiert ihn innerhalb des Wartungsfensters. Ein während
einer Abwesenheit verpasstes Fenster wird einmalig nachgeholt, sofern
„nach Wiederkehr nachholen“ aktiv ist. `notify_only` meldet den Kandidaten nur.
