# homeESS

[Click here for the English version.](README.md)

homeESS ist ein selbst betriebener Energiemanagement-Server für
Photovoltaikanlagen, Batteriespeicher und steuerbare elektrische Verbraucher.
Er liest Gerätewerte über MQTT oder isolierte Adapter, berechnet den aktuellen
Energiezustand und steuert Verbraucher über eine responsive Weboberfläche.

Der Server basiert auf Node.js und SQLite und ist für den dauerhaften Betrieb
auf kleinen, sparsamen Linux-Systemen ausgelegt. Eine ausführliche
Funktionsübersicht steht in [FEATURES_de.md](FEATURES_de.md).

## Hardwareanforderungen

| Ressource | Minimum | Empfohlen |
|---|---:|---:|
| CPU | 1 x86- oder ARM-Kern | 2 Kerne |
| Arbeitsspeicher | 512 MB RAM | 1 GB RAM |
| Speicher | 4 GB | 8 GB SSD oder eMMC |
| Netzwerk | WLAN | Kabelgebundenes Ethernet |

Bewährte Plattformen sind Raspberry Pi 4/5, kleine x86-Mini-PCs sowie virtuelle
Maschinen oder LXC-Container. Eine minimale Debian-Installation genügt.

## Softwareanforderungen

- Debian, Ubuntu, Raspberry Pi OS oder eine andere Debian-basierte Distribution
- `systemd` und `apt`
- Node.js ab Version 20.17; der Installer ergänzt bei Bedarf eine passende Version
- Ein MQTT-Broker ist für den ersten Start optional

## Installation

Auf einem Minimalsystem zunächst `curl` und `sudo` installieren:

```bash
apt update
apt install -y curl sudo
```

homeESS anschließend mit einem Befehl installieren:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
```

Der Installer legt die Anwendung unter `/opt/home-ess` und dauerhafte Daten
unter `/var/lib/home-ess` ab, installiert den systemd-Dienst
`home-ess.service` und startet die Weboberfläche auf Port `3000`.

Danach `http://<server-ip>:3000` öffnen und mit dem initialen Zugang
`admin` / `admin` anmelden. Dieses Passwort unmittelbar nach der ersten
Anmeldung ändern.

### Bestehende Installation aktualisieren

Denselben Befehl erneut ausführen. Anwendungscode und installierte offizielle
Adapter werden aktualisiert; Datenbank, Identitäten, hochgeladene Adapter und
die ausdrücklich gewählte Adapterauswahl bleiben erhalten:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash
```

In der Weboberfläche bewusst entfernte Adapter bleiben entfernt. Nur der
ausdrückliche Schalter `--all` stellt alle offiziellen Repository-Adapter
wieder her:

```bash
curl -fsSL https://raw.githubusercontent.com/mykaefer/home-ess/main/install.sh | sudo bash -s -- --all
```

Die interne Updatefunktion folgt immer der gespeicherten Adapterauswahl und
führt niemals selbstständig eine `--all`-Wiederherstellung aus.

## Lizenz

Der homeESS-Server steht unter der GNU Affero General Public License v3.0
(`AGPL-3.0-only`). Android-App, homeESS-Remote-Lizenz und essrelay-Dienst sind
ein separates proprietäres Add-on.
