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

Der hDP-Adapter 1.2.7 unterstützt Geräte als IR-Receiver, IR-Blaster oder
kombinierten Transceiver. Die Hardwareeinrichtung prüft GPIO-Belegung,
Trägerfrequenz und den vom Gerät gemeldeten Funktionsumfang.

Im Passthrough-Modus wird ein empfangener Code an einen ausgewählten State
weitergereicht. Im Aufnahmemodus lassen sich Codes über die Verwaltungsseite
oder einen Trigger-Taster aufnehmen, dauerhaft benennen, umbenennen, löschen
und erneut senden. Aufzeichnungen erscheinen unter
`hdp://<instanz>/ir_recordings/<name>`; ein beschreibbarer Blaster-State nimmt
auch Codes aus anderen States oder Automationen entgegen.

### Firmware ist direkt verfügbar

Der aktuelle Stable-Stand 0.7.3 für ESP8266/D1 Mini wird mit dem Adapter
ausgeliefert und beim ersten Start in den lokalen Firmware-Store übernommen.
Ein vorhandener, manuell verwalteter Stable-Kanal wird nicht überschrieben.

Optional kann homeESS neue Releases von einer HTTPS-Basis-URL beziehen. Dieser
Abruf setzt einen Ed25519-Prüfschlüssel voraus; jedes Remote-Artefakt wird vor
der atomaren Übernahme gegen Größe, SHA-256 und Signatur geprüft. Die hDP-Geräte
selbst greifen zu keinem Zeitpunkt auf das Internet zu.

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

### Wallbox-Sync nach Broker-Neustarts

Die Wallbox-Automatik trennt bestätigte Zustände nun von echten externen
Schreibwünschen. Ein lokaler Soll-Schatten verhindert, dass eigene Readbacks,
Retained-Werte oder wiederholte Anforderungen als manuelles Ausschalten
interpretiert werden. Eine Benutzeranforderung wird weiterhin übernommen, wenn
sie tatsächlich vom bekannten Sollwert abweicht.

### hDP-Richtungsindikator übernimmt geänderte Impulsabstände

Die Schleifendauer gehört jetzt zur Identität einer Timeline. Wird nur der
Impulsabstand geändert, spielt der Adapter die Timeline deshalb ebenfalls neu
auf.

### Fehlgeschlagener Eigenschaftendialog nennt seine Ursache

Ließ sich der Eigenschaftendialog eines States nicht laden oder speichern, blieb
es bei einer allgemeinen Meldung, und der eigentliche Grund war nirgends
nachvollziehbar. Der Fehler wird jetzt mit vollständigem Stack ins Log
geschrieben; im Dialog bleibt die Meldung unverändert.

Praktisch hilft das vor allem in einem Fall: Läuft der Dienst schon längere Zeit,
während der Programmcode zwischenzeitlich aktualisiert wurde, arbeitet er
weiterhin mit dem beim Start geladenen Stand. Passen Oberfläche und geladener
Stand nicht mehr zusammen, konnte sich das als kommentarlos scheiternder
Eigenschaftendialog zeigen. Ein Neustart des Dienstes übernimmt den aktuellen
Stand; das Log benennt den Grund nun eindeutig.

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

- Die sichtbare homeESS-Version lautet **1.4.6**, der hDP-Adapter **1.2.7** und
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
