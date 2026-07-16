# homeESS v1.3.0 – Fernzugriff über Relay-Tunnel

**v1.3.0** ist der nächste öffentliche Release nach **v1.2.6** und bündelt die
Remote-Arbeit der letzten Entwicklungsphase: homeESS kann jetzt per QR-Code mit
der Android-App gekoppelt werden und stellt danach den Fernzugriff über einen
Relay-Tunnel bereit.

Damit ist Zugriff über das Internet möglich, ohne ein eigenes VPN einzurichten,
Ports freizugeben oder DynDNS zu betreiben. Ein Nutzeraccount ist ebenfalls nicht
erforderlich. Für die Internet-Nutzung wird die **homeESS Remote Lizenz** in der
App aus dem Google Play Store benötigt:

<https://play.google.com/store/apps/details?id=de.mykaefer.homeess>

Die Android-App und der Relay-Server sind ein eigenständiges Add-on und nicht
Teil des AGPLv3-lizenzierten homeESS-Servers.

---

## Neu

### Fernzugriff per QR-Code und Relay-Tunnel

Auf der neuen Seite **Fernzugriff** kann ein Admin eine Pairing-Session erzeugen.
Die App scannt den QR-Code, homeESS zeigt den Gerätefingerprint zur Prüfung an
und bestätigt danach die Kopplung. Anschließend richtet homeESS automatisch die
dauerhafte Identität ein und baut die authentifizierte Verbindung zum Relay auf.

Der Tunnel leitet App-Anfragen über den Relay an den lokalen homeESS-Server
weiter. Die Anfrage läuft weiterhin serverseitig über homeESS; der Browser
spricht nie direkt mit dem Relay.

### Dauerhafte Instanzidentität

homeESS erzeugt lokal ein Ed25519-Schlüsselpaar und speichert es im Identity
Store (`HOME_ESS_IDENTITY_DIR`, standardmäßig `<data>/identity`). Der private
Schlüssel bleibt auf dem homeESS-System, wird nicht an Browser, App oder Relay
ausgegeben und nicht geloggt.

### Gekoppelte Geräte

Die Fernzugriff-Seite zeigt gekoppelte Geräte, Relay-Verbindung und aktive
Geräte an. Entfernte oder unbekannte Geräte werden nicht durch reine
Statusmeldungen wieder lokal angelegt; der autoritative Link-Bestand kommt vom
Relay.

### Neues Seiten-Icon

Das neue homeESS-Logo ist als Browser-/App-Icon eingebunden.

### Installationsscript aktualisiert bestehende Installationen

Der bekannte Installationsbefehl kann erneut ausgeführt werden. Bei einer
bestehenden Git-Installation unter `/opt/home-ess` stoppt das Script den Dienst,
aktualisiert den Code aus `main`, installiert die Produktionsabhängigkeiten neu
und startet homeESS wieder. Daten unter `/var/lib/home-ess` bleiben erhalten,
insbesondere Datenbank und Fernzugriff-Identity-Store.

---

## Sicherheit

- Pairing-, Confirm-, Provisioning-, WebSocket- und Tunnel-Fluss laufen
  serverseitig über `Browser → homeESS → essrelay`.
- Origin-Token, QR-URI, private Schlüssel, Signaturen, Headerwerte, Cookies und
  Bodies werden nicht an den Browser ausgegeben und nicht geloggt.
- Tunnel-Requests werden streng validiert, größenbegrenzt und nur gegen den
  lokalen homeESS-HTTP-Server ausgeführt.
- Offene Tunnel-Requests werden bei Disconnects, Timeouts, Backpressure oder
  entfernten Links bereinigt.

---

## Konfiguration

Neue bzw. relevante Variablen:

- `ESS_RELAY_BASE_URL` – Basis-URL des Relay.
- `ESS_RELAY_WS_URL` – optional abweichende Origin-WebSocket-URL.
- `HOME_ESS_INSTANCE_NAME` – Anzeigename der homeESS-Instanz beim Pairing.
- `HOME_ESS_IDENTITY_DIR` – Verzeichnis für die dauerhafte Instanzidentität.
- `ESS_RELAY_CONNECTION_DISABLED=1` – Origin-WebSocket-Autostart abschalten.

---

## Hinweise zum Update

- Version springt offiziell von **1.2.6** auf **1.3.0**; interne
  Zwischenstände werden nicht als eigene Releases dokumentiert.
- Die Android-App und der Relay-Server sind nicht Bestandteil dieses Repos und
  nicht unter AGPLv3 lizenziert.
- Für produktiven Fernzugriff über das Internet ist die homeESS Remote Lizenz in
  der Play-Store-App erforderlich.
