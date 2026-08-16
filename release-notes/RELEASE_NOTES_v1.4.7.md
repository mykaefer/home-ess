# homeESS v1.4.7 – Heimkino

**v1.4.7** bringt das optionale Heimkino-Modul: beliebig viele Räume mit einem
schaltbaren Kinomodus und je einer eigenen Aktionsfolge für „An“ und „Aus“.
Ergänzend sortieren sich Module und Modulseiten einheitlich, und die mit dem
hDP-Adapter ausgelieferte Stable-Firmware steigt auf 0.7.4.

## Hinzugefügt

### Heimkino-Modul

Das Modul wird unter „Einstellungen → Module“ aktiviert und ist danach als
eigene Seite erreichbar. Es verwaltet beliebig viele frei benannte Räume. Jeder
Raum bringt unter „System / Heimkino“ einen beschreibbaren booleschen State mit
seinem Namen mit (`heimkino://raeume/<id>`), der den Kinomodus zugleich anzeigt
und festlegt. Damit ist der Kinomodus überall dort verwendbar, wo homeESS States
verarbeitet — in Bedingungen, in Automationen und über MQTT.

Auf dem Dashboard steht derselbe Schaltzustand als Ziel „Kinomodus Raum …“ für
Schaltwidgets bereit, neben Geräten aus Messen + Schalten und Schaltgruppen.
Das Widget schaltet über die Modullogik; eine zweite Schreiblogik gibt es nicht.

### Aktionsfolgen je Raum

Ein Raum öffnet sich als eigenständige Seite (`/heimkino/raum/<id>`) in Liste
und Design der Bedingungen, mit je einem Verzeichnis für die Folge „An“ und
„Aus“. Jede Zustandsänderung ruft die passende Folge nacheinander ab. Zur
Verfügung stehen drei Aktionen:

- **Wert zuweisen** – wie das „Dann“ der Bedingungen: fester Wert oder Wert
  eines anderen Topics, wahlweise mit Rechenfunktion und Rundung
- **Pause** – wartet, bevor die Folge weiterläuft
- **Schleife** – nimmt weitere Aktionen auf und durchläuft ihren Inhalt so oft
  wie eingestellt

Schleifen lassen sich ineinander verschachteln. Alle Aktionen sind per
Dragfläche frei verschiebbar.

### Sync-Topic je Raum

Optional wird ein frei wählbares Topic bidirektional mit dem Kinomodus synchron
gehalten. Wechselt es extern auf an, schaltet der Raum ein und spielt seine
Aktionsfolge ab; wird in homeESS geschaltet, folgt das Topic sofort — als 1/0
oder true/false, je nach seiner bisherigen Darstellung.

Beim Neustart von homeESS und nach jedem MQTT-Wiederverbindungsaufbau ist der
im Topic hinterlegte Zustand maßgeblich. Er wird übernommen, ohne die
Aktionsfolge zu durchlaufen. So löst ein Neustart keine Schaltwelle aus,
während der angezeigte Kinomodus trotzdem der Realität entspricht.

### Plausibilitätsprüfung in Schleifen

Eine Schleife kann eine Bedingung in einem festlegbaren Abstand immer wieder
prüfen, gezählt ab ihrer letzten Ausführung beziehungsweise ab dem Start von
homeESS. Trifft die Bedingung nicht zu, wird ausschließlich diese Schleife
erneut abgespult — die übrige Aktionsfolge bleibt unberührt.

Damit bleibt ein extern verstellter Verbraucher nicht in einem unbekannten
Schaltzustand: Wurde etwa der Verstärker per Fernbedienung ausgeschaltet,
während der Raum im Kinomodus steht, zieht die Prüfung ihn wieder nach. Geprüft
wird jeweils nur die Folge, die zum aktuellen Kinomodus des Raums gehört.

## Behoben

### Mitgelieferte hDP-Firmware auf 0.7.4

Der bisher gebündelte Stable-Stand 0.7.3 konnte sein Manifest bei knappem Heap
abgeschnitten ausliefern — mit einer `Content-Length`, die zur gekappten Länge
passte. Die Antwort fiel deshalb erst beim Parsen auf, und der Manifestabgleich
scheiterte nach jedem Verbindungsaufbau mit „Ungültige JSON-Antwort (HTTP 200)“.
Betroffene Geräte blieben bedienbar, zeigten in der Geräteverwaltung aber
dauerhaft einen Hinweis.

Der Adapter liefert jetzt 0.7.4 aus, das das Manifest wieder vollständig
sendet. Ein vorhandener, manuell gepflegter Stable-Kanal wird wie bisher nicht
überschrieben; die Anhebung wirkt für Neuinstallationen und für Bootstraps, die
weiterhin von homeESS verwaltet werden. Geräte, die bereits auf 0.7.4 laufen,
bekommen kein erneutes Update angeboten.

## Geändert

### Einheitliche Sortierung von Modulen und Modulseiten

Module stehen alphanumerisch aufsteigend – in der Modulverwaltung wie in ihrem
eigenen Navigationsblock unterhalb der Kernseiten. Auch die Heimkino-Räume sind
alphanumerisch sortiert. Die Reihenfolge im Menü kann sich dadurch gegenüber
1.4.6 ändern.

### Räume im Zeilendesign der Adapterseite

Die Heimkino-Übersicht zeigt je Raum Name, Kinomodus-State, Sync-Topic, Zustand
und die Zahl der Aktionen in großzügigeren Zeilen. Die Spaltenüberschriften
stehen exakt über ihren Spalten, und je nach Fensterbreite entfallen Spalten in
Kopf- und Datenzeile gemeinsam. Als Schaltflächen gestaltete Links
(Adapter-Zeilen, Seitenköpfe) sehen jetzt wie echte Buttons aus.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.4.7**, der hDP-Adapter **1.2.8**.
- Das Heimkino-Modul ist nach dem Update **nicht** aktiv. Es wird unter
  „Einstellungen → Module“ eingeschaltet; erst danach erscheinen Seite,
  Kinomodus-States und Schaltziele.
- Beim ersten Start legt homeESS die Tabellen `heimkino_rooms` und
  `heimkino_actions` an. Eine Bestandsdatenbank aus einem Zwischenstand ohne
  Sync-Topic wird um die Spalte `remote_topic` ergänzt. Beide Schritte laufen
  automatisch; ein manueller Eingriff ist nicht nötig.
- Benutzer mit eingeschränkter Seitenauswahl sehen die neue Seite „Heimkino“
  erst, wenn sie in ihrem Profil freigegeben wird. Administratoren und Benutzer
  ohne Einschränkung sehen sie sofort, sobald das Modul aktiv ist.
- Für hDP-Geräte, die noch auf 0.7.3 laufen, steht 0.7.4 nach dem Update im
  Stable-Kanal bereit. Die Installation bleibt der eingestellten Updatepolitik
  des jeweiligen Geräts überlassen.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Dashboard-
  und Modulseiten, damit die aktualisierten Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
