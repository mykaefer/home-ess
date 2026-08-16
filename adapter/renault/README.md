# Renault / Dacia Connected Vehicle

Der Adapter bindet Fahrzeuge aus einem **My Renault**- oder **My Dacia**-Konto
an homeESS an. Er ist insbesondere für den Dacia Spring Electric ausgelegt und
stellt – soweit der fahrzeugseitige Connected-Service-Vertrag sie liefert –
Akkustand, Reichweite, Ladezustand, Kilometerstand und Klimadaten bereit.

## Einrichtung

1. Auf der Adapterseite eine Instanz anlegen.
2. E-Mail und Passwort des Kontos sowie das passende Land eintragen.
3. Bei mehreren Konten oder Fahrzeugen optional Kamereon-Konto-ID und FIN
   festlegen.
4. Instanz aktivieren. Nach der ersten erfolgreichen Anmeldung speichert
   homeESS ausschließlich das erneuerbare Login-Token im geschützten
   Adapter-Secret-Store und leert das Passwortfeld.
5. Steuerfunktionen nur bei Bedarf ausdrücklich aktivieren. Danach sind
   `hvac/enabled` und `charging/enabled` schreibbar.

Der Abruf weckt das Fahrzeug nicht auf. Zeitstempel und Werte können deshalb
hinter dem tatsächlichen Zustand zurückliegen. Klimatisierung und Laden werden
nur ausgeführt, wenn Fahrzeug, Mobilfunkempfang und aktiver Connected-Service-
Vertrag die jeweilige Funktion unterstützen.

## Wichtiger Hinweis

Renault stellt für diese Nutzung keine öffentliche, stabile API-Dokumentation
bereit. Der Adapter verwendet die von den offiziellen Apps genutzten
Cloud-Endpunkte. Renault kann Anmeldung, Endpunkte oder Antwortfelder jederzeit
ändern. Zugangsdaten und Tokens bleiben serverseitig und werden nicht geloggt.
