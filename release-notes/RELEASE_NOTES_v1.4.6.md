# homeESS v1.4.6 – Fahrzeuge, Infrarot und robuste Steuerung

**v1.4.6** erweitert homeESS um Renault-/Dacia-Fahrzeuge und hDP-
Infrarotgeräte. Gleichzeitig wird die Verarbeitung von Adapter-States
vereinheitlicht und die Wallbox-Steuerung gegen Readbacks und Retained-Werte
nach MQTT-Neustarts abgesichert.

## Hinzugefügt

### Renault / Dacia Connected Vehicle

Der neue Adapter bindet Fahrzeuge aus einem My-Renault- oder My-Dacia-Konto an,
insbesondere den Dacia Spring Electric. Je nach Fahrzeug und gebuchtem
Connected-Service-Vertrag stehen unter anderem folgende Werte bereit:

- Akkustand, Reichweite, Kapazität und verfügbare Energie
- Lade-, Stecker- und Restzeitstatus
- Kilometerstand
- Klima-, Innen- und Außentemperaturwerte

Laden und Vorklimatisierung können optional als schreibbare States freigegeben
werden. Die Steuerung ist standardmäßig deaktiviert. Das Passwort wird nur für
die Anmeldung verwendet, anschließend aus den Instanzeinstellungen entfernt
und durch ein erneuerbares Token im geschützten, serverseitigen Secret-Store
ersetzt. Tokens und Zugangsdaten werden nicht an den Browser gegeben oder
geloggt.

Die Fahrzeugdaten stammen aus der von den offiziellen Apps genutzten Cloud.
Renault bietet dafür keine öffentliche stabile API an; Verfügbarkeit und
Aktualität hängen daher vom Fahrzeug, Mobilfunkempfang, Connected-Service-
Vertrag und möglichen Änderungen der Cloud-Endpunkte ab.

### hDP-Infrarot-Transceiver

Der hDP-Adapter 1.2.6 unterstützt Geräte als IR-Receiver, IR-Blaster oder
kombinierten Transceiver. Die Hardwareeinrichtung prüft GPIO-Belegung,
Trägerfrequenz und den vom Gerät gemeldeten Funktionsumfang.

Im Passthrough-Modus wird ein empfangener Code an einen ausgewählten State
weitergereicht. Im Aufnahmemodus lassen sich Codes über die Verwaltungsseite
oder einen Trigger-Taster aufnehmen, dauerhaft benennen, umbenennen, löschen
und erneut senden. Aufzeichnungen erscheinen unter
`hdp://<instanz>/ir_recordings/<name>`; ein beschreibbarer Blaster-State nimmt
auch Codes aus anderen States oder Automationen entgegen.

### Adapterverwaltung als Einstellungsseite

Adapter können ihre eigene Verwaltungsseite mit `managementPage.asSettings`
direkt als Einstellungsziel einer Instanz verwenden. Anmeldung, Rollenprüfung
und Einbettung in die homeESS-Oberfläche bleiben dabei unverändert.

## Behoben

### hDP-Verbindungen laufen nach einem Binding-Fehler selbst wieder an

Ein aktives, bereits gekoppeltes Gerät konnte nach einem einmalig verpassten
Binding-Abgleich sichtbar bleiben, ohne erneut eine Laufzeitverbindung
aufzubauen. Ein unverändertes mDNS-Lebenszeichen stößt den Abgleich nun erneut
an, solange die Verbindung fehlt. Ein manueller Adapterneustart ist nicht mehr
nötig.

### Dynamische Adapter-States sind sofort lesbar

Werte, die ein Adapter bereits zusammen mit seinem dynamischen State-Katalog
meldet, gelangen sofort in den State-Bus und Retained-Cache. Persistierte
Objektwerte werden als JSON gespeichert. Dadurch stehen beispielsweise
gespeicherte IR-Codes direkt nach dem Adapterstart für Bedingungen und
Schreibaktionen bereit.

### Wallbox-Sync nach Broker- und ioBroker-Neustarts

Die Wallbox-Automatik trennt bestätigte Zustände nun von echten externen
Schreibwünschen. Ein lokaler Soll-Schatten verhindert, dass eigene Readbacks,
Retained-Werte oder wiederholte Anforderungen als manuelles Ausschalten
interpretiert werden. Eine Benutzeranforderung wird weiterhin übernommen, wenn
sie tatsächlich vom bekannten Sollwert abweicht.

### hDP-Richtungsindikator übernimmt geänderte Impulsabstände

Die Schleifendauer gehört jetzt zur Identität einer Timeline. Wird nur der
Impulsabstand geändert, spielt der Adapter die Timeline deshalb ebenfalls neu
auf.

## Geändert

### Einheitliche Adapter-State-Adressen

Leerzeichen und Unterstriche werden in Adapter-State-Adressen intern
gleichwertig behandelt. State-Bus, Cache, States-Baum, Wertekatalog und
State-Picker verwenden die kanonische Schreibweise mit Unterstrichen. Beim
Lesen und Schreiben übersetzt der Router sie zurück auf die vom Adapter
gemeldete Originaladresse; echte, bereits kanonische Adressen haben bei einer
Kollision Vorrang.

hDP veröffentlicht Adressen, Namen und Kategorien jetzt ebenfalls konsequent
mit Unterstrichen. Bestehende gespeicherte hDP-Adressen bleiben über die
Aliasauflösung erreichbar. Externe Systeme, die Topicnamen als Text vergleichen
oder außerhalb von homeESS direkt zusammensetzen, sollten ihre Konfiguration
nach dem Update einmal prüfen.

## Hinweise zum Update

- Die sichtbare homeESS-Version lautet **1.4.6**, der hDP-Adapter **1.2.6** und
  der Renault-/Dacia-Adapter **1.0.0**.
- Es gibt keine neue Datenbankmigration und keine Änderung an systemd-Units oder
  der realen Environment-Datei.
- Für IR-Funktionen muss das hDP-Gerät das Profil `ir-transceiver-v1`
  vollständig melden; ältere Firmware bleibt für ihre bisherigen Gerätetypen
  nutzbar.
- Nach dem Update empfiehlt sich ein einmaliges Neuladen geöffneter States- und
  Adapterseiten, damit die aktualisierten Client-Skripte aktiv sind.
- Der produktive Dienst wurde im Zuge der Release-Vorbereitung nicht neu
  gestartet.
