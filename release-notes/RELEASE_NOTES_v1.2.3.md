# homeESS v1.2.3 – Wallbox neustart-fest & Heizung/Klima nach Leistung

**v1.2.3** behebt einen ungewollten „Aus"-Sprung der Wallbox-Steuerung nach
Neustart/Reconnect und stellt das Lernmodell für **Heizung / Klima** von Energie
auf **mittlere Leistung je 1-°C-Außentemperaturfenster** um.

## Behoben

### Wallbox: Neustart/Reconnect schaltet nicht mehr ungewollt auf „Aus"

- Bei jedem MQTT-(Wieder-)Verbindungsaufbau spielt der Broker alle retained-Werte
  erneut ein — auch den des **Steuer-Topics**, u. U. mit dem echten (abweichenden)
  Gerätezustand (z. B. wenn das Relais/der Adapter beim CCU-Neustart kurz „aus"
  meldet und kein separates Status-Topic konfiguriert ist).
- Der bisherige Neustart-Schutz entschärfte nur den **allerersten** Wert nach
  Prozessstart. Ein **späterer Adapter-Reconnect** wurde als „Nutzer hat
  ausgeschaltet" fehlgedeutet — und seit die manuelle Übersteuerung persistiert
  wird (1.2.1/1.2.2), über Neustarts hinweg festgehalten. Ergebnis: Die Steuerung
  sprang ohne Zutun auf „Aus".
- Die Steuerschleife öffnet nach jedem Reconnect (Connect-Epoch aus dem
  MQTT-Client) je Box ein kurzes **Re-Baseline-Fenster (45 s)**: der erneut
  eingespielte Steuer-Topic-Wert wird nur als **Ausgangszustand** übernommen, nie
  als Nutzerschaltung. Damit gilt wieder verlässlich: **Neustart, Adapter-Reconnect
  oder Topic-Refresh ändern den Schaltzustand nicht** (auto bleibt auto, aus bleibt
  aus). Echte Nutzerschaltungen im laufenden Betrieb werden weiter sofort erkannt.

> **Hinweis:** Stand die Steuerung durch den alten Fehler bereits fälschlich auf
> „Aus", einmalig über die Oberfläche zurück auf Automatik stellen — danach hält
> der Fix sie dort.

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
