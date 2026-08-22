# Changelog – Zigbee-Adapter

Alle nennenswerten Änderungen dieses Adapters. Der Adapter ist eigenständig und
wird unabhängig von homeESS versioniert; die Version steht in
[adapter.json](adapter.json). Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/).

## [1.3.4] — 2026-08-22

### Geändert

- **Die Verwaltungsseite folgt dem Farbthema des Benutzers.** homeESS bietet je
  Benutzer ein helles oder dunkles Farbthema an. Die Festfarben dieses Adapters
  laufen dafür jetzt über die Design-Tokens von homeESS (Flächen, Linien, Text
  und Zustandsfarben), sodass die Seite im dunklen Thema mitzieht, statt weiße
  Kästen mit dunkler Schrift stehen zu lassen. Im hellen Thema bleibt die
  Darstellung unverändert — die Tokens tragen dort dieselben Werte.

- **Der Koordinator in der Netzkarte bleibt sichtbar.** Sein Knoten trägt die
  Farbe der homeESS-Hülle, die auf dunklem Grund verschwand; im dunklen Thema
  übernimmt dort die Haupttextfarbe.

## [1.3.3] — 2026-08-19

### Behoben

- **Der Hinweis „Noch keine Geräte im Netz" stand über der fertigen Karte — und
  machte sie zugleich unbedienbar.** Der Hinweis wird über das Attribut `hidden`
  geschaltet, das der Browser normalerweise mit `display: none` durchsetzt. Die
  Klasse `.zb-map-empty` setzte darunter jedoch selbst ein `display: grid`; eine
  Klassenregel gewinnt gegen diese Vorgabe, also blieb der Hinweis sichtbar,
  auch wenn längst alle Knoten gezeichnet waren.

  Schwerer wog die zweite Folge: Der Hinweis liegt als Schicht über der ganzen
  Karte. Da er nie verschwand, fing er sämtliche Zeigerereignisse ab — der
  Mauszeiger erreichte keinen einzigen Knoten, und deshalb erschien beim
  Überfahren **keine Bedienkachel** und auch das Anklicken eines Gerätes blieb
  wirkungslos.

  Die Stilvorlage hält jetzt jedes mit `hidden` ausgezeichnete Element des
  Adapters verborgen, unabhängig von späteren `display`-Regeln, und die
  Hinweisschicht ist als reine Beschriftung von Zeigerereignissen ausgenommen.

## [1.3.2] — 2026-08-19

### Behoben

- **Ein überzähliger Kindprozess legte den Adapter lahm.** homeESS startet eine
  Instanz bei jeder Änderung neu. Überlappen sich zwei solche Neustarts — etwa
  weil kurz hintereinander ein Gerät umbenannt und eines entfernt wird —,
  entsteht ein Kindprozess, den der Supervisor nicht mehr führt und deshalb nie
  beendet. Er hielt den Coordinator besetzt; der eigentlich zuständige Prozess
  bekam ihn nie, kannte kein einziges Gerät und zeigte eine **leere
  Netzwerkkarte** — ohne Knoten, folglich auch ohne Bedienkacheln.

  Der Adapter hinterlegt jetzt im instanzeigenen Datenverzeichnis, welcher
  Prozess zuständig ist. Findet ein Prozess dort einen neueren vor, gibt er den
  Coordinator frei und beendet sich; der zuletzt gestartete gewinnt, und genau
  das ist der vom Supervisor geführte. Geprüft wird das vor jedem
  Verbindungsversuch und laufend im Betrieb. Eine fehlende oder unlesbare Marke
  gilt ausdrücklich als „zuständig" — ein Dateisystemfehler darf keinen
  laufenden Adapter beenden.

  Die Ursache selbst liegt im Neustartablauf von homeESS und bleibt unberührt;
  der Adapter trägt die Folgen jetzt selbst aus.

## [1.3.1] — 2026-08-19

### Geändert

- **Die Bedienung liegt jetzt als Kachel über dem Knoten.** In 1.3.0 steckte sie
  im Detailfeld unterhalb der Karte und erschien erst nach einem Klick auf den
  Knoten — praktisch unauffindbar. Sie erscheint nun, sobald der Zeiger einen
  Knoten berührt, direkt über ihm:
  - Die Kachel nennt Gerät, Gattung, Erreichbarkeit, Verbindungsqualität und
    Batteriestand und trägt darunter die Bedienelemente.
  - Sie bleibt offen, solange der Zeiger auf ihr liegt — sonst ließe sich kein
    Regler ziehen — und schließt kurz verzögert danach.
  - Ein Klick auf den Knoten stellt sie fest, damit sie beim Bedienen nicht
    weggeht; ein Schließknopf und die Esc-Taste beenden das. Auf Geräten ohne
    Zeiger (Telefon, Tablet) übernimmt das Antippen diese Rolle.
  - Sie folgt dem Knoten beim Verschieben und Neuanordnen und aktualisiert sich
    nach jedem Schaltvorgang.
  - „Alle Angaben und Funkstrecken" führt weiterhin in das ausführliche
    Detailfeld; dort stehen jetzt nur noch Angaben, keine doppelte Bedienung.

## [1.3.0] — 2026-08-19

### Hinzugefügt

- **Geräte lassen sich auf der Karte unmittelbar bedienen.** Ein Klick auf einen
  Knoten öffnet die Bedienelemente, die zu seinen Merkmalen passen:
  - Ja/Nein-Merkmale werden zu einem **Schalter**, dessen Stellung den Zustand
    zeigt (Schaltaktor, Kindersicherung, …).
  - Zahlen mit Bereich werden zu einem **Regler** samt Wert und Einheit
    (Helligkeit, Farbtemperatur, Rollladenposition, Thermostat-Sollwert).
  - Mehrwertige Zustände mit bis zu vier Möglichkeiten werden zu **Tasten**
    (Rollladen: Auf, Zu, Stopp; Thermostat: Aus, Automatik, Heizen), mehr
    Möglichkeiten zu einer Auswahlliste.
  - Merkmale, die das Expose als Konfiguration ausweist, liegen eingeklappt
    unter „Geräteeinstellungen" und stehen nicht zwischen der Bedienung.

  Es gibt dabei keine Sonderbehandlung je Gerätetyp: Was der Converter als
  beschreibbar ausweist, wird bedienbar. Regler senden erst beim Loslassen,
  damit nicht jede Zwischenstellung einen Funkbefehl auslöst. Zum Bedienen
  genügt das Bedienrecht; geprüft wird zusätzlich serverseitig.

### Geändert

- **Die Karte benennt Knoten, statt sie zu zählen.** Aus „1 Knoten haben ihre
  Nachbartabelle nicht beantwortet" wird der Gerätename. Eine bloße Anzahl war
  für die Fehlersuche wertlos. Dass ein Router die Abfrage nicht beantwortet,
  heißt dabei nicht, dass er nicht arbeitet — der Hinweis sagt das jetzt auch.
  Gleiches gilt für Geräte ohne erkannte Funkstrecke.

## [1.2.2] — 2026-08-19

### Behoben

- **Ein eingeschalteter Schaltaktor wurde unter „Messen und Schalten" als aus
  angezeigt.** Der Adapter meldete Schaltzustände als Text „ON"/„OFF", wie es in
  der Zigbee-Welt üblich ist. Die Auswertungen von homeESS erkennen an den
  maßgeblichen Stellen aber nur `true`, `1`, `"1"`, `"true"` und teilweise `"on"`
  in Kleinschreibung — ein „ON" kam dort durchweg als *aus* an, in
  `messen-schalten/aggregation`, `messen-schalten/schaltgruppen`,
  `states/system-values` und `adapters/state-editor` gleichermaßen. Lediglich die
  Bedingungen werteten es richtig aus, weil sie den Text zuvor kleinschreiben.

  Merkmale, die das Expose als **binär** ausweist, werden jetzt als
  Wahrheitswert gemeldet. Mehrwertige Zustände bleiben Text: Aus den
  Rollladenbefehlen OPEN/CLOSE/STOP oder mehreren Thermostat-Betriebsarten ließe
  sich kein Wahrheitswert bilden, ohne Bedeutung zu verlieren. Der interne
  Gerätezustand behält die Schreibweise der Converter — sie bekommen ihn als
  `meta.state` zurück und erwarten dort ihre eigene Form.
- **„Verfügbar" ist kein Mischtyp mehr.** Solange der Zustand nicht feststeht,
  wird nichts gemeldet, statt den Text „unbekannt" zu senden — den hätte jede
  Auswertung als *wahr* gelesen.

## [1.2.1] — 2026-08-19

### Geändert

- **Altlasten aus der Adressverwaltung des Coordinators sind als solche
  erkennbar.** Ein Coordinator führt mitunter Adressen weiter, hinter denen kein
  Gerät mehr steht — ein abgebrochener Anlernversuch oder ein längst entferntes
  Gerät. Bei der Geräteübernahme kamen solche Einträge bisher wie reguläre
  Geräte in die Liste. Ein Eintrag ohne Modellkennung, ohne Endpunkte und ohne je
  empfangene Meldung wird jetzt als **nicht identifiziert** ausgewiesen statt mit
  „automatisch erzeugtem Converter"; ein Hinweis erklärt Herkunft und Entfernung.
- **Die Übernahme benennt Einträge ohne eigenen Sicherheitsschlüssel.** Ein
  regulär angelerntes Gerät besitzt einen solchen Schlüssel; fehlt er, ist der
  Eintrag verdächtig. Er wird weiterhin übernommen — ältere Geräte können
  legitim ohne eigenen Schlüssel angelernt sein —, aber im Protokoll benannt.
- **Entfernen wirkt dauerhaft.** Entfernte Adressen werden gemerkt und bei einer
  späteren Geräteübernahme nicht erneut aus dem Coordinator-Backup angelegt.
  Wird dasselbe Gerät bewusst neu angelernt, entfällt die Sperre automatisch.
- **Unbestätigte Funkstrecken sehen nicht mehr wie lebende aus.** Führt der
  Coordinator einen Knoten in seiner Nachbartabelle, ohne dass von diesem je
  etwas empfangen wurde, wird die Linie blass und gestrichelt gezeichnet und im
  Tooltip als „Eintrag des Coordinators, vom Gerät nie bestätigt" erklärt. Die
  Legende führt den Fall auf.

## [1.2.0] — 2026-08-19

### Hinzugefügt

- **Die Funkstrecken werden selbsttätig ermittelt.** Sobald das Netz steht, und
  erneut bei jeder Änderung daran — ein Gerät kommt hinzu, wird angelernt,
  verlässt das Netz oder wechselt seinen Weg durch das Netz. Die Karte ist
  damit ohne Knopfdruck aktuell.
  Zwei Bremsen verhindern Dauerfunk: Änderungen werden gesammelt (mehrere
  Geräte beim Anlernen ergeben einen Durchlauf), und zwischen zwei Durchläufen
  liegen mindestens zehn Minuten. Läuft gerade einer, holt die Karte das
  Ergebnis von selbst ab.
  Abschaltbar über die neue Einstellung **Netzwerkkarte selbsttätig
  aktualisieren**; die Schaltfläche auf der Karte bleibt davon unberührt.

### Geändert

- **Die Verwaltungsseite bleibt die Startseite des Adapters.** In 1.1.0 war sie
  versehentlich hinter die Karte gerutscht — sie liegt wieder unter
  `…/manage`. Die Karte hat weiterhin ihre eigene Seite (`…/manage/map`) und
  wird von der Verwaltung aus als Kachel ganz oben angeboten, an der Stelle der
  entfallenen Geräteseite.

## [1.1.0] — 2026-08-19

### Behoben

- **Auf der Geräteseite erschien jedes Gerät als offline**, obwohl der Adapter
  verbunden war und die Netzwerkkarte aktive Verbindungen zeigte. Die Geräteliste
  wurde einmal beim Start geschrieben — zu einem Zeitpunkt, an dem die
  Verfügbarkeit noch gar nicht ausgewertet war — und danach nie wieder
  aktualisiert. Sie wird jetzt bei jeder tatsächlichen Zustandsänderung
  nachgeführt; unveränderte Listen werden weiterhin nicht geschrieben, damit
  nicht jede eingehende Zigbee-Nachricht die Einstellungen berührt.

### Geändert

- **Die Netzwerkkarte ist die Startseite des Adapters** und ersetzt die
  generische Geräteseite. Der Verwaltungslink auf der Adapterseite führt damit
  direkt auf die Karte: Sie zeigt die Geräte samt ihrer Funkstrecken, ihres
  Zustands und ihrer Gattung und lässt sie unmittelbar schalten.
- **Die generische Geräteseite entfällt** (`devicePage` im Manifest entfernt).
  Sie zeigte dieselben Geräte ohne Zusammenhang und bot außer dem Umbenennen
  nichts, was die Karte nicht besser darstellt.
- **Umbenennen liegt jetzt in der Verwaltung** (`…/manage/verwaltung`), bei
  jedem Gerät in der Geräteliste. Der Adapter führt die eigenen Gerätenamen
  damit selbst. Ein Name ist reiner Anzeigetext: Die State-Adressen folgen der
  IEEE-Adresse und bleiben unverändert, eingetragene Topics gelten also weiter.
  Ein leeres Feld stellt den Standardnamen wieder her.

## [1.0.2] — 2026-08-19

### Behoben

- **Der Adapter blockierte sich nach einem Neustart der Instanz selbst.** Beim
  Umbenennen eines Gerätes startet homeESS die Instanz neu. Der alte Prozess gab
  die Verbindung zum Coordinator dabei nicht rechtzeitig frei, der neue fand den
  Anschluss belegt und meldete dauerhaft „Error while opening socket".
  Ursache waren zwei Punkte:
  - `Znp.close()` von zigbee-herdsman zerstört den Port nur, wenn die
    Initialisierung zuvor abgeschlossen wurde. Brach der lesende
    Coordinator-Zugriff vorher ab — Zeitlimit, stummer Coordinator, Stopp der
    Instanz —, blieb die TCP-Verbindung für die gesamte Prozesslaufzeit
    bestehen. Da eine Zigbee-Bridge nur einen Client zulässt, genügte eine
    einzige solche Leiche, um jeden weiteren Versuch scheitern zu lassen. Der
    Adapter gibt die Schnittstelle jetzt bedingungslos frei.
  - `stop()` wartete auf einen laufenden Verbindungsaufbau und konnte damit über
    20 Sekunden benötigen. homeESS beendet einen Adapterprozess jedoch drei
    Sekunden nach dem Stoppsignal hart, sodass der Anschluss nie geordnet
    freigegeben wurde. `stop()` kappt die Verbindung nun zuerst und ist nach
    weniger als einer Sekunde fertig.

### Geändert

- **Die Netzwerkkarte hat eine eigene Seite** (`…/manage/map`). Auf der
  Verwaltungsseite steht nur noch ein Verweis mit dem Stand des letzten Scans.
  Die Karte braucht den ganzen Platz, und die Verwaltungsseite bleibt dadurch
  übersichtlich; nebenbei lädt sie das umfangreiche Kartenskript nicht mehr mit.
- **Verständliche Meldung bei abgewiesener Verbindung.** Statt „Error while
  opening socket" nennt der Adapter jetzt das Ziel und den häufigsten Grund —
  ein bereits belegter Anschluss an der Bridge — samt der ursprünglichen
  Meldung.

## [1.0.1] — 2026-08-18

### Hinzugefügt

- **Netzwerkkarte auf der Unterseite „Zigbee-Netzwerk".** Die Geräte ordnen sich
  kräftebasiert selbst an, der Coordinator bildet die Mitte. Gezeichnet werden
  die tatsächlich gemessenen Funkstrecken aus den Nachbartabellen
  (ZDO `LQI_TABLE_REQUEST`) von Coordinator und Routern.
- **Verbindungsqualität dreifach kodiert:** Farbe, Strichstärke und Abstand. Die
  Farbe allein wäre für farbfehlsichtige Betrachter nicht unterscheidbar; eine
  gute Strecke zieht zwei Knoten zudem enger zusammen als eine schwache.
  Eltern-Kind-Beziehungen — die tatsächlich genutzte Route — heben sich von
  bloßen Nachbarkontakten ab.
- **Piktogramm je Gerätegattung** (Licht, Steckdose, Schaltaktor, Rollladen,
  Thermostat, Schloss, Lüfter, Bewegungsmelder, Fenster-/Türkontakt, Rauch- und
  Wassermelder, Taster, Sensor, Repeater, Coordinator). Die Gattung wird aus den
  Exposes des Converters abgeleitet; eine gepflegte Geräteliste gibt es auch
  hierfür nicht. Erreichbarkeit, Schaltzustand und Batteriebetrieb sind ohne
  Anklicken ablesbar.
- **Direkte Bedienung aus der Karte.** Ein Knoten öffnet seine Angaben samt
  Funkstrecken und lässt sich von dort schalten; Lampen erhalten einen
  Helligkeitsregler. Dafür genügt das Bedienrecht, geprüft wird serverseitig.
- **Topologiescan** auf Anforderung, mit Schreibrecht. Endgeräte werden nicht
  abgefragt — sie führen keine Nachbartabelle, und Batteriegeräte würde die
  Abfrage nur wecken. Geräte ohne erkannte Funkstrecke werden abgesetzt
  dargestellt, statt eine nicht gemessene Verbindung zu zeichnen.
- Knoten lassen sich mit Maus oder Finger verschieben; die Karte ist
  tastaturbedienbar und liegt in der mobilen Ansicht mit.

### Geändert

- Die Anordnung liegt in `lib/map-layout.js` und wird von dort in das
  Seitenskript eingebettet. Damit läuft im Browser genau die Fassung, die die
  Tests prüfen — statt einer zweiten, ungetesteten Abschrift.

## [1.0.0] — 2026-08-18

Erste Fassung. homeESS wird damit zur eigenständigen Zigbee-Zentrale: Netzwerk,
Pairing, Geräte-Interviews und Gerätebefehle laufen vollständig im Adapter.
Weder Zigbee2MQTT noch ioBroker, Home Assistant, ein deCONZ-Server, ein
MQTT-Gateway oder ein Cloud-Dienst werden benötigt.

### Hinzugefügt

- **Coordinator-Anbindung über Serial und TCP.** Coordinator-Typ und Transport
  sind getrennt: Derselbe Z-Stack-Coordinator lässt sich lokal am Server oder
  über eine transparente Zigbee-Bridge im Netz betreiben. Für serielle
  Anbindungen empfiehlt der Adapter die gleichbleibenden Pfade unter
  `/dev/serial/by-id/…` und weist auf `/dev/ttyUSBx` ausdrücklich hin.
- **Texas Instruments Z-Stack** als freigegebener Coordinator-Typ (CC2652,
  CC2652P/P7, CC1352, Sonoff Zigbee 3.0 USB Dongle Plus). Silicon Labs Ember und
  Dresden Elektronik deCONZ sind in der Treiberstruktur vorgesehen, aber noch
  nicht freigegeben.
- **Übernahme eines bestehenden Zigbee-Netzes ohne erneutes Pairing.** Vor der
  Inbetriebnahme liest der Adapter den Coordinator rein lesend aus und
  übernimmt dessen tatsächliche Netzwerkparameter. Zusätzlich lassen sich die
  im Coordinator-Backup verzeichneten Geräte in einem Schritt übernehmen und
  interviewen.
- **Import.** Coordinator-Backups im Format `zigpy/open-coordinator-backup`
  (das `coordinator_backup.json` von Zigbee2MQTT) sowie die Gerätedatenbank
  `database.db` lassen sich einspielen. Vorhandene Dateien werden vorher
  gesichert.
- **Dynamische States aus den Exposes** der Converter-Bibliothek
  `zigbee-herdsman-converters`; damit werden die dort bekannten Geräte
  automatisch unterstützt, ohne eigene Gerätedatenbank. Schreibbare Merkmale
  werden als beschreibbare States geführt und über die toZigbee-Converter in
  Zigbee-Kommandos übersetzt.
- **Pairing** mit startbarem und beendbarem Anlernfenster, konfigurierbarem
  Zeitlimit, verbleibender Zeit, Geräte-Interview und Entfernen von Geräten —
  auch erzwungen, wenn ein Gerät nicht mehr antwortet.
- **Verfügbarkeit** getrennt nach Routern, netzbetriebenen Endgeräten und
  batteriebetriebenen Sleepy End Devices. Batteriegeräte werden nie aktiv
  geweckt und nicht nach wenigen Minuten Stille als offline geführt.
- **Verwaltungsseite** mit Coordinator- und Netzstatus, Anlernen, Geräteliste,
  Backup und Übernahme, einschließlich mobiler Ansicht.

### Sicherheit

- Der Netzwerkschlüssel wird ausschließlich im Secret-Store von homeESS
  abgelegt, nie in den Instanz-Einstellungen, nie im Adapter-Datenverzeichnis
  im Klartext und nie im Log. Ausgaben der Zigbee-Bibliotheken durchlaufen eine
  Redaktion, die Schlüsselmaterial auch dann entfernt, wenn die Bibliothek es
  selbst ausgeben würde.
- **Ein bestehendes Netz wird nie beiläufig neu aufgebaut.** Fehlende
  homeESS-Persistenz ist ausdrücklich kein Grund, ein neues Netz zu erzeugen.
  Ein Neuaufbau verlangt die Einstellung *und* eine getrennte Bestätigung durch
  einen Administrator und gilt für genau einen Vorgang.
- Meldet der Coordinator einen aktiven und einen davon abweichenden alternativen
  Netzwerkschlüssel, startet der Adapter nicht. In diesem Zustand würde die
  Zigbee-Bibliothek das vorhandene Netz nicht als passend erkennen und neu
  kommissionieren — alle Geräte wären abgemeldet.
- Das Anlernfenster ist immer zeitlich begrenzt (höchstens 600 Sekunden); ein
  dauerhaft offenes Zigbee-Netz lässt sich nicht einstellen.
