# homeESS v1.5.2 – Dunkles Farbthema und Feinschliff an den Diagrammen

**v1.5.2** bringt ein dunkles Farbthema, das jeder Benutzer für sich wählt —
wahlweise für alle Seiten oder nur fürs Dashboard. Titelleiste und Seitenmenü
bleiben dabei unverändert; eingefärbt wird allein die Arbeitsfläche. Dazu
bekommen die Diagramm-Kacheln aus v1.5.1 zwei Ergänzungen: gefüllte Flächen je
Linie und eine einstellbare Behandlung von Aufzeichnungslücken.

## Hinzugefügt

### Dunkles Farbthema je Benutzer

Unter **Einstellungen → Allgemeine Einstellungen** steht die neue Karte
**Darstellung** mit drei Themen:

- **Hell** — die bisherige Oberfläche, weiterhin die Vorgabe.
- **Dunkel** — alle Seiten auf dunklem Grund.
- **Nur Dashboard dunkel** — das Dashboard dunkel, alle übrigen Seiten hell.
  Gedacht für den Dauerbetrieb auf einem Wandmonitor, während die
  Arbeitsseiten hell bleiben.

Die Wahl gilt **je Benutzer** und wird sofort wirksam; die Auswahlliste zeigt
das dunkle Thema schon während der Auswahl in der Vorschau. Ändern darf sie
**jede Rolle** — auch „Lesen", denn die Darstellung betrifft nur den eigenen
Zugang und verändert nichts an der Anlage. Zusätzlich lässt sich das Thema im
Benutzerdialog der Benutzerverwaltung setzen, sodass ein Administrator es auch
für Zugänge vergeben kann, denen die Einstellungsseite nicht freigeschaltet ist.

**Titelleiste und Seitenmenü behalten in jedem Thema ihre Farben.** Sie sind die
Wiedererkennung der Oberfläche und stehen ohnehin schon auf dunklem Grund; nur
die Arbeitsfläche wechselt. Das Corporate Design bleibt vollständig erhalten:

- dieselbe grün-graue Farbfamilie wie das Seitenmenü,
- dasselbe Aktionsgrün, nur so weit aufgehellt, dass es auf dunklem Grund
  trägt — für Schaltflächen und für Schrift getrennt abgestimmt,
- dieselbe fachliche Zuordnung der Energiearten (Batterie blau, Netz rot,
  Eigenverbrauch lila, Photovoltaik gelb). Dafür dienen die aufgehellten
  Varianten, die der dunkle Header schon immer verwendet — Kopfzeile und
  Seitenfläche sprechen im dunklen Thema also dieselbe Farbsprache,
- dieselbe Bedeutung der Zustandsfarben: grün gut, gelb Hinweis, rot Störung,
  blau/cyan Information. Jedes Paar aus Tönungsgrund und Schrift kehrt sich
  geschlossen um, statt helle Plaketten auf dunklen Karten stehen zu lassen.

Mitgedacht sind die Randfälle: Native Bedienelemente (Scrollbalken,
Auswahllisten, Datumswähler) folgen dem Thema, das systemweite Warnband behält
sein kräftiges Rot, und der QR-Code der Gerätekopplung bleibt weiß — sonst wäre
er nicht mehr scannbar.

**Die Verwaltungsseiten der mitgelieferten Adapter ziehen mit.** hDP, Zigbee,
MQTT-Broker und InfluxDB beziehen ihre Farben aus denselben Tokens; besonders
die hDP-Geräteverwaltung und die einzelnen Geräteseiten sind damit im dunklen
Thema durchgehend lesbar.

Die Anmeldeseite bleibt hell — dort steht noch nicht fest, wer sich anmeldet.

### Flächenfüllung je Diagrammlinie

Jede Linie einer Diagramm-Kachel lässt sich einzeln auf **Füllen** stellen: Der
Bereich zwischen Linie und Nulllinie wird dann in der Linienfarbe hinterlegt,
mit einer je Linie einstellbaren **Deckkraft** (5–80 %, Vorgabe 20 %). Alle
Flächen liegen unter allen Linien, damit keine Fläche eine andere Linie
verdeckt; Aufzeichnungslücken unterbrechen die Fläche genauso wie die Linie.

Sobald eine Linie füllt, reicht die Werteachse bis zur Null. Eine Fläche „bis 0"
auf einer Grundlinie, die keine Null ist, würde die Größenverhältnisse
vortäuschen.

### Lückenbehandlung in der Diagramm-Kachel

Neue Einstellung **Aufzeichnungslücken** im Diagramm-Dialog. Zeitabschnitte ohne
Messwerte — etwa weil der Server aus war — können

- als **Lücke** stehen bleiben (die Linie bricht ab, wie bisher und weiterhin
  Standard),
- mit einer **durchgezogenen Linie** überbrückt,
- auf dem **letzten bekannten Wert gehalten** oder
- **auf Null gesetzt** werden.

Die beiden letzten Varianten lässt bereits die Datenbank auffüllen
(`fill(previous)` bzw. `fill(0)`), sodass auch das Fadenkreuz durchgehend Werte
anzeigt.

### InfluxDB-Adapter: Speichermodus „In festen Abständen und bei Änderung"

Bisher schloss die Auswahl je State einander aus: entweder ein fester Abstand
oder — entprellt — jede Wertänderung. Der neue dritte Modus macht beides
zugleich: Änderungen gehen weiterhin entprellt sofort in die Datenbank, und
zusätzlich schreibt der Zeitgeber im eingestellten Abstand den zuletzt bekannten
Wert. Damit hat eine Messreihe auch dann durchgehende Stützpunkte, wenn sich der
Wert über Stunden nicht ändert.

## Geändert

### Farben laufen über Design-Tokens

Flächen-, Linien-, Text- und Zustandsfarben stehen als benannte Tokens im
`:root` von [`public/styles.css`](../public/styles.css); die Regeln greifen
darauf zu, statt Festwerte zu wiederholen. Dasselbe gilt für die
Verwaltungs-Stylesheets der mitgelieferten Adapter.

Das ist die Grundlage des Farbthemas: Für das dunkle Thema genügt dadurch ein
einziger Block, der die Tokens umdefiniert, statt hunderte Regeln zu doppeln.
Kopfzeile und Seitenmenü bekommen die hellen Werte gezielt zurückgestellt — so
musste keine einzige ihrer Regeln angefasst werden.

**Im hellen Thema bleibt die Darstellung unverändert.** Die Tokens tragen die
bisherigen Werte; lediglich einzelne, beinahe gleiche Grautöne sind zu einer
Stufe zusammengefasst worden. Eine Ausnahme ist ausdrücklich gewollt: Die
Hinweiszeile eines hDP-Geräts nimmt jetzt die Schriftfarbe der Hinweisfamilie,
aus der ihr Grund ohnehin stammt, und ist damit dasselbe Braun wie alle übrigen
Hinweise.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.5.2**. Die mitgelieferten Adapter
  werden eigenständig versioniert: hDP **1.2.10**, Zigbee **1.3.4**, InfluxDB
  **1.0.3**, MQTT-Broker **1.0.2** — Einzelheiten stehen in deren CHANGELOG.
- Beim ersten Start ergänzt homeESS die Spalte `theme` in der Tabelle `users`.
  Das läuft automatisch; ein manueller Eingriff ist nicht nötig. **Bestehende
  Zugänge starten auf „Hell" und sehen die Oberfläche damit unverändert** —
  Rollen und sichtbare Seiten bleiben unberührt.
- Wer das dunkle Thema nutzen möchte, stellt es je Zugang unter „Einstellungen →
  Allgemeine Einstellungen → Darstellung" ein. Es gibt bewusst keine
  systemweite Vorgabe: Die Darstellung ist eine persönliche Einstellung.
- Bestehende Diagramm-Kacheln bleiben unverändert. Füllung und
  Lückenbehandlung sind neue Einstellungen mit den bisherigen Vorgabewerten
  (keine Füllung, Lücken bleiben stehen) und wirken erst, wenn sie im Dialog
  gesetzt werden.
- Der neue InfluxDB-Speichermodus muss je State ausgewählt werden; vorhandene
  Einstellungen behalten ihren bisherigen Modus.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Dashboard-
  und Einstellungsseiten, damit die aktualisierten Stile und Client-Skripte
  aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
