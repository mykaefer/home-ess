# homeESS v1.7.0 – Nachrichten: Push-Benachrichtigungen aus States

**v1.7.0** bringt eine neue Hauptseite: **Nachrichten**. Damit schickt homeESS
Push-Benachrichtigungen auf gekoppelte Smartphones — ausgelöst von den States der
eigenen Anlage. Es klingelt an der Tür, das Netz fällt aus, der Gefrierschrank
wird zu warm: Sie legen eine Regel an, homeESS meldet sich.

Der Versand läuft über die **bereits vorhandene Fernzugriff-Verbindung**. Es gibt
keinen zweiten Server, keinen neuen Zugang und nichts einzurichten außer der
Regel selbst — wer sein Smartphone schon gekoppelt hat, ist fertig.

Dazu kommen vier Korrekturen aus dem laufenden Betrieb, die alle denselben Kern
haben: **homeESS soll auch dann richtig entscheiden, wenn eine Meldung ausbleibt
oder ungewöhnlich aussieht.** Ein Netzausfall wurde bei angehobener Netzfrequenz
nicht erkannt, das Betriebslevel fiel bei zugeschaltetem Netz auf 1, und ein
verlorener Einschaltbefehl konnte ein „Immer an"-Gerät dauerhaft ausgeschaltet
lassen.

## Hinzugefügt

### Neue Seite „Nachrichten"

Die Seite steht im Hauptmenü direkt hinter *Bedingungen*. Sie zeigt alle Regeln
in einer Tabelle — Name, State, Trigger, Nachricht, Priorität, ob die Regel aktiv
ist und wann sie zuletzt ausgelöst hat.

Eine Regel entsteht über **+ Nachricht erstellen**:

| Feld | Bedeutung |
|---|---|
| Name | frei wählbar, nur zur Wiedererkennung in der Liste |
| State | aus der bestehenden State-Liste gewählt (Auswahl-Knopf neben dem Feld) |
| Trigger | wann gemeldet wird |
| Vergleichswert | nur bei den Triggern, die einen brauchen |
| Titel | Überschrift der Meldung auf dem Smartphone |
| Nachricht | Text der Meldung |
| Ereignistyp | Kurzkennung, z. B. `doorbell` — die App kann danach unterscheiden |
| Priorität | *Normal* oder *Kritisch* |
| Cooldown | Mindestabstand zwischen zwei Meldungen derselben Regel |
| Aktiv | Ja/Nein |

Der State wird **ausschließlich über die vorhandene State-Auswahl** gewählt. Es
gibt keine zweite State-Liste und kein freies Eintippen einer Adresse, bei dem
sich ein Tippfehler erst Wochen später als ausbleibende Meldung zeigt.

### Fünf Trigger — und warum keiner davon spammt

Alle Trigger reagieren auf den **Übergang**, nicht auf den Zustand:

| Trigger | meldet, wenn |
|---|---|
| Wert ändert sich | sich der Wert tatsächlich ändert |
| Ist gleich | der Wert auf den Vergleichswert **wechselt** |
| Ist ungleich | der Wert den Vergleichswert **verlässt** |
| Steigt über | der Wert die Grenze **überschreitet** |
| Fällt unter | der Wert die Grenze **unterschreitet** |

Das ist der entscheidende Unterschied zu einer reinen Zustandsprüfung. Ein
Klingeltaster, der im Sekundentakt `true` meldet, löst genau **einmal** aus —
beim Übergang `false → true`. Ein Gefrierschrank, der stundenlang über −10 °C
liegt, meldet sich **einmal** beim Überschreiten und nicht bei jedem Messwert.

Dazu kommt der **Cooldown** je Regel (Vorgabe 5 Sekunden, `0` erlaubt): Trifft
die Regel währenddessen erneut zu, bleibt es still. Ein prellender Taster oder
ein zappelnder Sensor erzeugt damit keine Kaskade. Wichtig: Ein unterdrückter
Push verlängert den Cooldown **nicht** — die Sperre läuft ab dem letzten
tatsächlich gesendeten Push.

**Steigt über** und **Fällt unter** stehen nur für Zahlen-States zur Verfügung.
Bei einem Schalter sind sie in der Auswahl gesperrt, und der Server nimmt sie
auch dann nicht an, wenn es jemand direkt versucht.

### Beispiel: Türklingel

```
Name:            Türklingel
State:           <Klingeltaster aus der State-Liste>
Trigger:         Ist gleich
Vergleichswert:  true
Titel:           Türklingel
Nachricht:       Es klingelt an der Tür.
Ereignistyp:     doorbell
Priorität:       Normal
Cooldown:        5 Sekunden
Aktiv:           ja
```

Weitere naheliegende Regeln: `Stromausfall` auf dem Netz-State (*Ist gleich*
`false`, Priorität **Kritisch**), `Netzversorgung wiederhergestellt` (*Ist
gleich* `true`) und ein Temperaturalarm (*Steigt über* `-10`).

### Testen, ohne zu warten

Jede Regel hat einen **Testen**-Knopf. Er schickt die Nachricht sofort — der
State bleibt unangetastet, die Triggerbedingung wird nicht nachgestellt, und der
„letzte Trigger" der Regel wird nicht verändert. Sie sehen unmittelbar, ob Text
und Zustellung stimmen:

- *Nachricht an 1 Gerät gesendet.*
- *Keine gekoppelten Push-Geräte vorhanden.*
- *Relay derzeit nicht verfügbar.*

### Was homeESS dabei **nicht** verschickt

Der Versand läuft über die vorhandene, kryptografisch authentifizierte
Verbindung zwischen Ihrer Anlage und dem Relay. Übertragen werden ausschließlich
**Titel, Text, Ereignistyp und Priorität**.

Instanz-Kennungen, Geräte-IDs, Empfängerlisten und Push-Token verlassen homeESS
nie — sie werden auch in keiner Regel gespeichert. Welche Geräte die Meldung
bekommen, ergibt sich allein aus den aktiven Kopplungen beim Relay. Eine Regel
kann deshalb technisch weder eine fremde Anlage noch ein bestimmtes fremdes
Gerät ansprechen.

Im Protokoll landen nur Kenndaten (Regel, Ereignistyp, Priorität,
Empfängeranzahl, Grund) — **nie der Nachrichtentext**. Was Sie in eine Meldung
schreiben, bleibt zwischen Ihrer Anlage und Ihrem Telefon.

### Wenn das Smartphone nicht erreichbar ist

Ist die Verbindung zum Relay unterbrochen, scheitert **nur der Push**. Die
auslösende Funktion und die gesamte State-Verarbeitung laufen unverändert weiter
— eine Nachrichtenregel kann keine Schaltung und keine Messung aufhalten.

Verpasste Meldungen werden **nicht nachgeliefert**. Das ist Absicht: Eine
Türklingel von vorgestern oder ein Stromausfall, der längst vorbei ist, sind
keine Benachrichtigung mehr, sondern eine Irritation.

### Regeln auf gelöschte States

Verschwindet ein State — etwa weil eine Adapterinstanz entfernt wurde — löst die
Regel nicht mehr aus und wird in der Übersicht deutlich als **State nicht
vorhanden** markiert. Sie wird **nicht** automatisch gelöscht, damit Sie ihr
einen neuen State zuweisen können, statt sie neu anzulegen.

## Behoben

### Netzausfall wird auch bei zu hoher Netzfrequenz erkannt

Ein Netzausfall galt bisher nur bei exakt 0 Hz als solcher. Am 14.09.2026 meldete
der Netzeingang des Batteriewechselrichters stattdessen **52 Hz** — bei null
Netzbezug. Notstrombetrieb und Warnung blieben aus, bis der Akku unter den
Mindest-SoC fiel.

Jetzt zählt auch eine Frequenz über **51,5 Hz** nach derselben Wartezeit als
Netzausfall — aber nur, solange der Ladezustand unter der oberen
Grid-Control-Schwelle liegt. Darüber hebt der Wechselrichter die Frequenz
absichtlich an, um AC-gekoppelte PV abzuregeln; das ist kein Ausfall. 0 Hz bleibt
unabhängig vom Ladezustand ein Ausfall. Aufgehoben wird der Notstrombetrieb nur
noch bei plausibler Frequenz auf allen drei Phasen. Die Warnung nennt die
Frequenz als Ursache.

### Betriebslevel 1 nur noch im echten Notstrombetrieb

Die Prognose senkte das Betriebslevel auf 1, sobald der Ladezustand unter den
Mindest-SoC fiel — auch bei zugeschaltetem Netz. Es genügte, den Mindest-SoC von
10 % auf 20 % anzuheben, um bei 10 % Ladung alles ab Priorität 2 abzuschalten,
obwohl das Netz den Bedarf problemlos deckte.

Level 1 ist jetzt ausschließlich zulässig, wenn **kein Netz vorhanden** und der
Notstrombetrieb erkannt ist. Sonst ist Level 2 die Untergrenze. Beginn und Ende
des Notstrombetriebs lösen die Bewertung sofort aus; ein bestehendes Level 1 wird
mit der Rückkehr des Netzes auch ohne aktives Verhaltensmodell verlassen.

### „Immer an"-Geräte bleiben nach einem verlorenen Befehl nicht mehr aus

Messen + Schalten wiederholt einen Schaltbefehl nicht bei jedem 30-Sekunden-Takt,
solange das Gerät ihn nicht bestätigt hat — sonst würde der Bus geflutet. Diese
Sperre galt bisher **ohne Ablauf**: Ging ein Befehl verloren, weil eine Steckdose
nach einem Stromausfall gerade neu startete, wurde nie wieder gesendet. Das Gerät
blieb trotz „Immer an" und freigegebenem Betriebslevel aus.

Ein unbestätigter Befehl wird jetzt nach 1, 2, 4 und 8 Minuten und danach alle
10 Minuten wiederholt, bis das Gerät seinen Zustand meldet.

### Mindest-Ladezustand: Regler wirkt sofort, Änderungen sind nachvollziehbar

Der Schieberegler auf der Batterieseite war nur ein Feld des
Einstellungsformulars. Ohne „Konfiguration speichern" blieb eine Änderung
wirkungslos und war nach dem Neuladen verschwunden; eine Änderung über das
Remote-Topic wurde erst nach dem Neuladen sichtbar.

Beim Loslassen übernimmt der Regler den Wert jetzt sofort (in 5-%-Schritten) und
sendet ihn wie das Formular an Ziel- und Remote-Topic. Die übrigen
Batterieeinstellungen bleiben unberührt. Der Regler folgt außerdem externen
Änderungen live — außer während er gerade bedient wird.

Zusätzlich schreibt **jede** Änderung des Mindest-SoC eine Zeile ins Journal, mit
Quelle (Oberfläche oder Remote-Topic), altem und neuem Wert und beim Remote-Topic
dem empfangenen Rohwert. Damit lässt sich belegen, wenn ein extern gemeldeter
Wert eine gerade gespeicherte Einstellung zurückdreht.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.7.0**. Adapterstände: hDP **1.2.14**
  (neu), Tasmota **1.0.3** (neu), hm-rpc **1.1.8**, Zigbee **1.3.4**, InfluxDB
  **1.0.3**, Modbus **1.1.2**, MQTT-Broker **1.0.2**, Renault **1.0.0**, Shelly
  **1.0.0**.
- **Datenbankänderung:** Es kommt die Tabelle `notification_rules` hinzu. Die
  Migration läuft beim ersten Start automatisch; bestehende Tabellen bleiben
  unverändert. Ohne angelegte Regel ändert sich am Verhalten nichts.
- **Keine Konfigurationsänderung.** Bestehende Bedingungen, Widgets, Outputs und
  Adapterinstanzen laufen unverändert weiter.
- **Voraussetzung für Push:** ein gekoppeltes Smartphone und eine aktive
  Fernzugriff-Verbindung. Ohne Kopplung lassen sich Regeln zwar anlegen und
  speichern, der Testversand meldet dann aber *Relay derzeit nicht verfügbar*
  bzw. *Keine gekoppelten Push-Geräte vorhanden*. Für die Nutzung über das
  Internet ist die homeESS Remote Lizenz aus dem Google Play Store erforderlich.
- **Keine Meldungswelle nach dem Neustart.** Nach einem Start dient der erste
  empfangene Wert einer Regel nur als Ausgangsbasis. Gemeldet wird erst der
  nächste echte Übergang — ein Neustart löst also keine Sammelbenachrichtigung
  aus.
- **Prüfen Sie nach dem Update Ihre Grid-Control-SoC-Schwellen**, wenn Ihr
  Wechselrichter die Netzfrequenz zur PV-Abregelung anhebt. Die neue
  Ausfallerkennung wertet eine erhöhte Frequenz nur unterhalb der oberen
  SoC-Schwelle als Netzausfall.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter Seiten, damit
  die aktualisierten Stile und Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
