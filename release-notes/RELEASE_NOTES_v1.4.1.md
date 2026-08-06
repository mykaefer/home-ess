# homeESS v1.4.1 – Self-Update repariert

**v1.4.1** ist ein reiner Fehlerbehebungs-Release direkt nach
[v1.4.0](RELEASE_NOTES_v1.4.0.md). Er repariert die interne Updatefunktion, die
beim Installieren der Abhängigkeiten abbrach. Funktional ändert sich sonst
nichts.

## Behoben

### Self-Update scheiterte beim Installieren der Abhängigkeiten

Der privilegierte Update-Helper läuft als gehärteter systemd-Dienst mit
`ProtectHome=true`. Darin ist `/root` ein leeres, schreibgeschütztes Verzeichnis
— npm konnte seinen Standardcache `$HOME/.npm` deshalb weder anlegen noch
beschreiben und brach mit `ENOENT` ab.

Sichtbar wurde das im Updatefortschritt direkt nach der Meldung
„Produktionsabhängigkeiten werden im neuen Release installiert" als:

```
/usr/bin/npm wurde mit Code 254 beendet: '/root/.npm'
npm error enoent This is related to npm not being able to find a file.
npm error Log files were not written due to an error writing to the directory: /root/.npm/_logs
```

Das Update brach an dieser Stelle ab, bevor die Installation umgeschaltet wurde;
die laufende Version blieb also unangetastet.

Helper und Service-Unit legen `HOME` und den npm-Cache jetzt ausdrücklich in das
beschreibbare Updateverzeichnis (`<data>/update`, standardmäßig
`/var/lib/home-ess/update`). Der Cache bleibt dort erhalten und beschleunigt
spätere Updates, ohne je in der Installation zu landen.

## Hinweise zum Update

Der Fix steckt im Update-Helper — also in genau dem Programm, das das Update
ausführt. Auf einer bestehenden Installation liegt dort noch die Fassung aus
v1.4.0, die erneut an derselben Stelle scheitern würde. Einer der beiden Wege ist
daher einmalig nötig:

**Ein Drop-in für die Service-Unit anlegen und danach normal über die Oberfläche
aktualisieren:**

```bash
mkdir -p /etc/systemd/system/home-ess-update.service.d
printf '[Service]\nEnvironment=HOME=/var/lib/home-ess/update\n' \
  > /etc/systemd/system/home-ess-update.service.d/npm-home.conf
systemctl daemon-reload
```

Ab v1.4.1 bringt die mitgelieferte Unit dieselbe Einstellung selbst mit; das
Drop-in ist dann überflüssig, stört aber nicht.

**Oder einmalig manuell aktualisieren**, was Helper und Unit direkt ersetzt:

```bash
cd /opt/home-ess && git pull && ./install.sh
```

Danach funktioniert die interne Updatefunktion wieder wie vorgesehen.
