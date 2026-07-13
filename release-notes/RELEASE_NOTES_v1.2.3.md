# homeESS v1.2.3 – Wallbox-An/Aus sauber getrennt & Heizung/Klima nach Leistung

**v1.2.3** trennt die An/Aus-Kanäle der Wallbox sauber (behebt Rückkopplungen der
Automatik in beide Richtungen) und stellt das Lernmodell für **Heizung / Klima**
von Energie auf **mittlere Leistung je 1-°C-Außentemperaturfenster** um.

## Behoben

### Wallbox: An/Aus-Kanäle getrennt – keine Rückkopplung durch die Automatik

Bisher diente **ein** Steuer-Topic zugleich als Aktor (Schalten) **und** als
Rückmelde-/Bedienkanal. Dadurch deutete homeESS eigene Schalt-Readbacks bzw. den
Gerätezustand nach einem Reconnect als Nutzerschaltung fehl:

- Schaltete die **Automatik** die Ladung ein, sprang die Steuerung fälschlich auf
  **Vollladen** und verließ den Automatikmodus (**Regel 1 verletzt**).
- Ein **Adapter-Reconnect** wurde als externes „Aus" fehlgedeutet und – seit die
  Übersteuerung persistiert wird (1.2.1/1.2.2) – über Neustarts hinweg festgehalten.

Neu sind die Kanäle strikt getrennt:

- Das **Steuer-Topic** ist ein **reiner Aktor**: homeESS schaltet die Wallbox
  darüber, liest es aber nie zur Bedienerkennung zurück.
- Ein neues, optionales **Steuerung-Sync-Topic** ist der bidirektionale
  An/Aus-Schalter. homeESS **spiegelt** darauf den aktuellen Zustand (Regel 1: bleibt
  dabei auf Automatik) und wertet **nur eine extern ausgelöste Änderung** (nicht von
  homeESS geschrieben) als Bedienbefehl:
  - **extern EIN** → einmalige Volladung bis 100 %/Leistungsabfall bzw. bis der
    Stecker gezogen wird, danach zurück auf Automatik;
  - **extern AUS während der Ladung** → aus bis zum nächsten Ladebeginn am Folgetag,
    dann zurück auf Automatik.
- Der gewählte Stand liegt **neustart-resistent** in der Datenbank. Ein
  **Re-Baseline-Fenster (45 s)** nach jedem MQTT-(Wieder-)Verbindungsaufbau stellt
  sicher, dass **Neustart, Adapter-Reconnect oder Topic-Refresh nie** als externe
  Schaltung gelten – nur ein direkt beobachteter, nicht selbst ausgelöster Wechsel
  zählt.

### Wallbox: Modus-Sync-Topic nur noch für den Ladeplan

- Das **Modus-Sync-Topic** hält ausschließlich den Ladeplan bidirektional synchron:
  **1 = Privat, 2 = Beruflich, 3 = Immer voll** (im Formular erläutert). Es schaltet
  die Ladung nicht ein oder aus – das übernimmt das Steuerung-Sync-Topic.

> **Hinweis zur Einrichtung:** In der Wallbox-Konfiguration das neue
> **Steuerung-Sync-Topic (an/aus)** eintragen (z. B. den bisherigen Schalter-
> Datenpunkt). Ohne dieses Topic gibt es keine externe An/Aus-Bedienung mehr –
> die Ladung läuft dann rein nach Automatik bzw. den Umschaltern in der Oberfläche.
> Stand die Steuerung durch den alten Fehler noch auf „Aus"/„Vollladen", einmal
> über die Oberfläche auf Automatik zurückstellen.

### Prognose: Balken sitzen wieder auf einer Nulllinie

- Die Achsen-Beschriftungen des Heizung/Klima-Diagramms lagen im Balkenfluss und
  verschoben beschriftete Balken nach oben. Sie sind jetzt unter der Nulllinie
  verankert; alle Balken teilen dieselbe Basis.

## Geändert

### Heizung/Klima: mittlere Leistung je 1-°C-Temperaturfenster

- Die Auflösung der Außentemperaturfenster wurde von **5 °C auf 1 °C** verfeinert.
- Gelernt und geplant wird jetzt die **mittlere Leistung (W)** je Fenster statt der
  Energie (kWh). Je Fenster werden bis zu **30 Messtage** vorgehalten (pro Tag die
  zeitgewichtete mittlere Leistung bei dieser Temperatur); der Modellwert ist deren
  **Mittel** — bewusst begrenzt statt eines dauerhaften Mittelwerts, damit die
  Anpassung nicht mit der Zeit immer weiter abflacht.
- Ein Fenster wird **nur an Tagen belegt, an denen diese Außentemperatur real
  auftrat**. Dadurch kann die **Sommer- die Winterkurve nicht überschreiben** (und
  umgekehrt) — im Winter werden schlicht keine sommerlichen Temperaturen erreicht.
- Die Prognose errechnet aus der Fensterleistung je Stunde nach der
  prognostizierten Außentemperatur den erwarteten Verbrauch (`kWh = W/1000 ×
  Stunden`). Heizlast fällt damit temperaturgetrieben in **jeder** Stunde an, nicht
  nur in zufällig „gelernten" Stunden.
- Das Diagramm der Prognose-Datenbasis zeigt je Fenster das **30-Tage-Mittel (W)**
  als Balken und den **heutigen Wert** als Markierungslinie.

## Hinweise

- **Neue Tabelle** `mess_schalt_temperature_power` wird beim Start automatisch
  angelegt; keine manuelle Migration nötig.
- Die vorhandene Historie wird **nicht** in das neue Modell übernommen; das
  Heizmodell füllt sich über die nächsten ~30 Messtage aus den Live-Werten neu. Das
  Stunden-Energielog (`mess_schalt_function_hourly`) bleibt bestehen (Jahres-
  Grundlast, Tagesanzeige), speist das Heizmodell aber nicht mehr.
