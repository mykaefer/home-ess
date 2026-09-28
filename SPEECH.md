# Lokale Sprachausgabe

Unter **Einstellungen → Module → Sprachausgabe** aktivieren. Die Modul-Seite
liegt unter **Nachrichten → Sprachausgabe** und führt eine eigene, persistente Liste der auf dem Audiobus erkannten Geräte.
Pro Geräte-ID lassen sich ein lesbarer Name und ein vorhandener Raum zuweisen.
Die Räume stammen aus derselben Verwaltung wie Heizung & Klima und
Messen + Schalten. Clientseitige Raumangaben überschreiben diese Zuordnung
nicht. Beim Löschen eines Raums wird die Zuordnung aufgehoben.

## Voraussetzung

Die Installer für Main und Development installieren **Piper 1.8.0** und die
neuronale deutsche Stimme **Thorsten High** (`de_DE-thorsten-high`) automatisch.
Piper liegt in einer eigenen Python-Umgebung unter
`/opt/home-ess-tts/venv`, das Modell und seine Konfiguration unter
`/opt/home-ess-tts/voices`. Beide liegen außerhalb des Git-Checkouts und bleiben
bei Updates erhalten. Der Dienst benötigt dort ausschließlich Leserechte.

Für eine manuell eingerichtete Bestandsinstallation kann ausschließlich der
TTS-Teil des Installers ausgeführt werden (im Repository-Verzeichnis, als root):

```sh
apt-get install -y --no-install-recommends python3-venv
bash -c 'source ./install.sh; install_piper'
```

Das startet homeESS nicht neu und verändert keine Environment-Datei. Für den
Wechsel von bereits geladenem Anwendungscode gilt der normale Neustartablauf.

Nur die Installation benötigt Internetzugang für Python-Pakete und Modell
(ca. 114 MB für das Modell). Piper ist auf eine Paketversion festgelegt;
Modell, Konfiguration und Modellkarte stammen aus einem festen Repository-Stand
und werden vor der Übernahme per SHA-256 geprüft. Bei erneuter Installation
werden bereits korrekt vorhandene Modelldateien nicht nochmals heruntergeladen.
Die Modellkarte mit Herkunft und Lizenzhinweis bleibt neben dem Modell erhalten.

Die Synthese läuft vollständig lokal auf der CPU, mit maximal zwei ONNX-
Rechenthreads und ohne GPU oder Cloud-Zugang. ONNX-Telemetrie ist deaktiviert.
Piper bringt die zur Aussprachevorbereitung benötigten eSpeak-Daten mit; die
hörbare Stimme erzeugt das neuronale Modell. Das separate Systempaket
`espeak-ng` wird nicht mehr aufgerufen oder vom Installer vorausgesetzt.

Das Modul startet pro Ansage einen Python-Prozess ohne Shell und ohne zusätzlichen
HTTP-Server. Das Laden des Modells verursacht eine kurze Anlaufzeit. Text läuft
über stdin, WAV-Audio wird ausschließlich im Speicher verarbeitet. Text und
Audio werden nicht als Dateien abgelegt. Prozesslaufzeit (30 Sekunden),
Ausgabemenge (16 MiB) und Warteschlange (höchstens acht laufende/wartende Ansagen)
sind begrenzt. Fehlende Piper-Installation oder Modelldateien meldet der
Testversand ausdrücklich; es gibt keinen Rückfall auf die alte Stimme.

Unter **Nachrichten → Sprachausgabe → Wiedergabeeinstellungen** sind Pegel
(10–100 %, Standard 70 %), Audiovorlauf (100–5000 ms, Standard 1000 ms),
Nachlauf (0–5000 ms, Standard 1000 ms) und Paketdauer (10/20/50/100 ms,
Standard 50 ms) einstellbar. Die Werte bleiben in SQLite gespeichert und gelten
ab der nächsten Ansage ohne Neustart; laufende Ansagen behalten ihre Werte.
Zum Vergleichen dient der Testversand einer Nachrichtenregel.

Der Vorlauf stellt die vorausgesendete Audiomenge ein, nicht den Wiedergabepuffer
von Widgetbar. Der Nachlauf verzögert nur das Stream-Ende; er behebt keine
Knackser zwischen Wörtern. Dafür müssen gegebenenfalls das erzeugte Signal und
die kontinuierliche Wiedergabe im Client getrennt untersucht werden.

Die Stimme wird standardmäßig mit 70 % Spitzenpegel ausgegeben (rund 3 dB Reserve).
Beim Versand liefert homeESS standardmäßig bis zu 1000 ms Audio vorab und plant weitere Pakete
anhand der absoluten Sample-Zeit. Dadurch summieren sich Timer-Verzögerungen
nicht zu Aussetzern. Alle PCM-Samples werden unverändert und in Reihenfolge
übertragen; ein kurzer Nachlauf lässt dem Empfänger Zeit für die letzten Samples.
Der Client muss weiterhin zusammenhängend puffern und das angekündigte
Output-Format verwenden (Thorsten High: 22050 Hz, 16 Bit, mono).

## Nachrichten

In jeder Nachrichtenregel stehen bei aktiviertem Modul drei Versandarten zur
Wahl: **Text über Relay**, **Sprachausgabe**, **Text und Sprachausgabe**.
Bestehende Regeln bleiben bei Text über Relay. Als Audio-Ziel sind ein Endpunkt,
ein Raum oder alle Endpunkte wählbar. Gesprochen werden Titel und Nachricht.
Die Test-Schaltfläche verwendet dieselben Versandwege wie die automatische Regel.
Bei kombiniertem Versand werden beide Wege unabhängig versucht und ihre
Ergebnisse getrennt gemeldet. Audio-Ziele werden niemals an den Relay gesendet.

Das Modul beobachtet Session-Starts und -Enden, abonniert aber keine
Mikrofon-Audiodaten. Es entdeckt beim Aktivieren auch bereits laufende Sessions.
Namen und Räume bleiben bei Neustart, Reconnect und Deaktivierung erhalten.
Der Online-Status wird aus aktuellen Sessions abgeleitet. Mehrere Sessions
mit derselben Geräte-ID ergeben nur eine Ausgabe (zuletzt gelistete Session).

Ausgegeben wird PCM über den vorhandenen [Audiobus](AUDIO-BUS.md). Erreichbar
sind ausschließlich Geräte mit aktiver Audio-Session. Clients müssen ihre
Session entsprechend den bestehenden Audiobus-Timeouts halten bzw. erneuern;
eine bloße WebSocket-Verbindung reicht nicht. Offline-Geräte werden nicht
nachträglich beliefert. Ein fehlendes Ziel wird nicht durch einen Rundruf ersetzt.
Belegte, getrennte oder dauerhaft überlastete Ausgänge werden als fehlgeschlagen
gezählt; andere Ziele können die Ansage weiterhin empfangen. Ein Erfolg bedeutet
Übergabe an den Audiobus, keine Bestätigung einer hörbaren Wiedergabe.

Beim Deaktivieren werden der TTS-Prozess und eigene Ausgabestreams beendet;
wartende Ansagen werden verworfen. Gespeicherte Nachrichten mit Audio-Ausgabe
behalten ihre Auswahl. Bei „beides“ kann der Relay-Teil weiterhin senden.

[Piper-Dokumentation](https://github.com/OHF-Voice/piper1-gpl) ·
[Modellkarte Thorsten High](https://huggingface.co/rhasspy/piper-voices/blob/375a0fe641dea077c2a47b4e9a056d6da521eed3/de/de_DE/thorsten/high/MODEL_CARD)
