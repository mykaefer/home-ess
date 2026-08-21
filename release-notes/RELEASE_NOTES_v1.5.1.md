# homeESS v1.5.1 – Datenbank, Diagramme und ruhigere Warnungen

**v1.5.1** gibt homeESS eine zentrale Zeitreihen-Datenbank und die erste
Diagramm-Kachel fürs Dashboard. Dazu kommt eine systemweite Warnfunktion mit
Warnband auf jeder Seite — und die Netzsteuerung meldet sich nur noch, wenn
wirklich etwas zu tun ist statt bei jedem kurzen Aussetzer.

## Hinzugefügt

### Zentrale Datenbankanbindung

homeESS kann eine **InfluxDB 1.x** als Zeitreihen-Datenbank für Diagramme und
Auswertungen nutzen. Das darf dieselbe Datenbank sein, in die der
InfluxDB-Adapter schreibt — oder eine beliebige andere, auch auf einem anderen
Server. Die eigenen Betriebsdaten bleiben unverändert in SQLite.

Eingerichtet wird sie unter **Einstellungen → Allgemein** in der neuen Karte
„Datenbank" unterhalb der MQTT-Einstellungen: Protokoll, Server, Port,
Datenbank, Zugangsdaten und TLS-Prüfung, dazu ein Verbindungstest, der die
gerade eingetippten Werte prüft, ohne sie vorher zu speichern. Ohne Häkchen bei
„Datenbankanbindung verwenden" fragt kein Diagramm Daten ab.

Auf der Einstellungsseite einer InfluxDB-Adapterinstanz sitzt der Knopf **„Als
Standard-Datenbank für homeESS übernehmen"**. Er kopiert Server, Port, Datenbank
und Zugangsdaten dieser Instanz in die Systemeinstellungen und schaltet die
Anbindung ein; die Herkunft wird in den Einstellungen mit Zeitpunkt angezeigt.
Die Übernahme ist eine **einmalige Kopie der gespeicherten** Instanzwerte —
spätere Änderungen am Adapter wirken erst nach erneuter Übernahme, und die
Systemdatenbank bleibt jederzeit von Hand bearbeitbar. Speichert man sie von
Hand, gilt sie als selbst gepflegt und die Herkunft entfällt.

Serverseitig steht die Abfrage-Schicht unter `src/database/` bereit
(Messreihen auflisten, Zeitreihen je Zeitfenster, Raster und Aggregat lesen),
erreichbar als JSON über `/database/status`, `/database/measurements` und
`/database/series`. Der Browser spricht nie direkt mit der Datenbank;
Zugangsdaten bleiben auf dem Server.

Umgesetzt ist der Übernahme-Knopf über das neue Manifest-Feld `systemDatabase`
(siehe [ADAPTER.md](../ADAPTER.md)) — künftige Datenbank-Adapter bekommen ihn
dadurch ohne Sonderfall im Kern.

### Diagramm-Kachel fürs Dashboard

Der neue Widget-Typ **Diagramm** zeichnet bis zu vier Messreihen aus der
Systemdatenbank als Zeitreihe. Einstellbar sind Zeitraum (6 Stunden, 24 Stunden,
7 Tage, 30 Tage), Verdichtung (Mittelwert, Minimum, Maximum, Summe, letzter
Wert), eine Überschrift und die Einheit. Je Linie lassen sich **Farbe und Name
für die Legende** frei wählen; ohne Namen steht dort die Messreihe. Die Farbe
hängt an der Linie — entfernt man eine andere, behalten die übrigen ihre Farbe.

- Die **Legende nennt jede Linie samt aktuellem Wert**, sodass der Stand auch
  ohne Zeiger und auf dem Handy ablesbar ist.
- Ein **Fadenkreuz mit Werteanzeige** liest jeden Zeitpunkt ab, auch per
  Fingertipp.
- **Messlücken brechen die Linie**, statt quer über das Loch zu ziehen.
- Achsenzahlen werden ab 10.000 einheitlich auf k bzw. M gekürzt.
- Die vier Linienfarben sind auf Farbfehlsichtigkeit und Kontrast geprüft
  (benachbarte Paare ΔE ≥ 8 bei Deuteranopie, alle ≥ 3:1 gegen die Kachel).

Das SVG entsteht wie alle Ansichten **serverseitig**; die Kachel lädt es nach
dem Seitenaufbau und danach im Minutentakt nach. Eine langsame oder nicht
erreichbare Datenbank bremst das Dashboard damit nie aus — sie zeigt einen
Hinweis in der Kachel, alles andere läuft weiter.

### Systemweite Warnfunktion

Unter **System → Betrieb** gibt es zwei neue States: `operating.warnungText`
(„Warnungstext") und `operating.warnungAktiv` („Warnung aktiv"). Meldet eine
Automatik einen Warntext, steht er im Text-State und das Aktiv-Flag geht auf
`true`. Solange es steht, zeigt homeESS auf **jeder** Seite ein rotes Warnband
mit dem Text und einem Knopf „Quittieren".

Quittieren setzt das Flag auf `false`, leert den Warntext und räumt zusätzlich
das MQTT-Warntopic der Netzsteuerung auf — die Visualisierung bleibt damit nicht
auf „Warnung" stehen. Die Warnung überdauert einen Neustart. Quittieren zählt
als Bedienhandlung; die Rolle „bedienen" genügt dafür.

Grundsatz dahinter: Auf dem Warntopic und im Warnband landen ausschließlich
Fehler, die ein Eingreifen erfordern.

### Adapterseite: Neustart je Adapter

In der Titelzeile jedes Adapters sitzt oben rechts ein schmaler Knopf „↻"
(Tooltip „Neu starten"). Er liest das Manifest neu ein und startet alle
Instanzen dieses Adapters neu, sodass ausgetauschter Adaptercode übernommen
wird, ohne homeESS neu zu starten.

## Geändert

### Netzsteuerung meldet nur noch echte Dauerfehler

Bisher genügten 20 Sekunden ohne Rückmeldung, damit eine Schaltung als „nicht
bestätigt" auf dem Warntopic und rot im Protokoll landete. Kurze
Netzwerkaussetzer und ein spät antwortendes Cerbo-GX haben dadurch regelmäßig
Fehlalarme erzeugt.

Neu ist die Meldung gestaffelt:

- Bis **90 Sekunden** gilt die ausbleibende Bestätigung als normaler Roundtrip.
- Der Befehl wird alle **10 Sekunden** wiederholt; eine frisch erkannte
  Abweichung (verlorener Write, externe Änderung am Ziel-Topic) wird weiterhin
  sofort nachgesetzt.
- **Gewarnt wird erst**, wenn die Abweichung **5 Minuten** durchgehend besteht
  und dabei mindestens **10 Wiederholungen** erfolglos blieben.
- Ohne Broker-Verbindung läuft diese Uhr **gar nicht erst weiter** — ein
  Verbindungsabriss ist kein Schaltfehler.

Erst der so bestätigte Dauerfehler erreicht Warntopic, Warnband und Protokoll;
die Auflösung („wird wieder bestätigt") wird ebenfalls festgehalten. Ein
Rückwärtssprung der Systemzeit blockiert die Wiederholungen nicht mehr.

### Keine unplausiblen Einspeise-Warnungen mehr

Die Überschusseinspeisung ist erst oberhalb der oberen SoC-Offset-Schwelle
gefordert. Schaltet das Netz nur wegen der Wechselrichtergrenzen, liegt gar kein
Überschuss vor — eine fehlende Bestätigung ist dort bedeutungslos und warnt
nicht mehr. Bei Soll „aus" meldet die Netzsteuerung nur noch einen aktiven
Widerspruch (der Broker meldet weiterhin `1`); bei Soll „ein" gilt unverändert
jede anhaltende Abweichung.

### Adapterseite scannt das Adapterverzeichnis bei jedem Aufruf

Nachträglich abgelegte Adapter erscheinen sofort, entfernte verschwinden aus der
Liste — bisher war dafür ein Neustart von homeESS nötig. Instanzen eines
entfernten Adapters bleiben als eigener, rot markierter Block sichtbar und
lassen sich weiterhin deaktivieren und löschen. Ein vorübergehend unlesbares
Adapterverzeichnis (etwa während eines Updates) verwirft den geladenen Stand
nicht mehr.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.5.1**, der InfluxDB-Adapter **1.0.1**.
- Beim ersten Start legt homeESS die Tabellen `system_database` und
  `system_warning` an. Das läuft automatisch; ein manueller Eingriff ist nicht
  nötig.
- Die Datenbankanbindung ist nach dem Update **nicht** aktiv. Sie wird unter
  „Einstellungen → Allgemein → Datenbank" eingerichtet — oder mit einem Klick
  aus einer bestehenden InfluxDB-Adapterinstanz übernommen. Erst danach lassen
  sich Diagramm-Kacheln mit Daten füllen.
- Die Auswahlliste im Diagramm-Dialog zeigt die Messreihen, die in der
  Datenbank tatsächlich vorhanden sind. Sie entstehen dort, sobald für einen
  State im Eigenschaften-Dialog die Historie eingeschaltet ist.
- Bestehende Netzsteuerungs-Konfigurationen bleiben unverändert; die neuen
  Fristen gelten sofort und ohne Einstellung. Eine gerade offene Warnung auf dem
  Warntopic bleibt stehen, bis sie quittiert wird.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Dashboard-
  und Einstellungsseiten, damit die aktualisierten Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
