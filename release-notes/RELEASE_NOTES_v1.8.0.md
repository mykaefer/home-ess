# homeESS v1.8.0 – Seitenfreigaben, Rollläden und Sprachausgabe

**Veröffentlichungsstand: 1.8.0 · 11. Oktober 2026**

homeESS 1.8 erweitert die Bedienung im Haus: Einzelne Seiten lassen sich per
Link anzeigen oder bedienen, Rollläden reagieren auf Dämmerung, Sonne und
Heimkino, und Nachrichten können lokal gesprochen werden. Dazu kommen ein
dynamischer Batterie-Mindest-SoC, eine lokale States API und eine gemeinsame
Logansicht.

Diese Release Notes fassen die wesentlichen Neuerungen, Verbesserungen und
Fehlerkorrekturen **nach 1.7.0** zusammen: die Zwischenstände 1.7.1 bis 1.7.9
und die mit 1.8.0 hinzugekommenen Änderungen.

## Einzelne Seiten freigeben

Hinter dem Seitentitel öffnet ein Freigabesymbol den neuen Dialog. Die Farbe
zeigt den gespeicherten Zugriff:

| Farbe | Zugriff | Verhalten |
|---|---|---|
| Grau | Nicht freigegeben | Kein öffentlicher Zugriff |
| Blau | Lesezugriff | Anzeigen, Änderungen werden serverseitig gesperrt |
| Rot | Schreibzugriff | Die freigegebene Seite lässt sich bedienen und bearbeiten |

Der Dialog zeigt **zwei kopierbare Links je Seite**, einen für das helle und
einen für das dunkle Theme. Beide nutzen dieselbe Freigabe; das gewählte Theme
bleibt bei Bedienhandlungen und Weiterleitungen erhalten.

Ein Freigabelink öffnet die Seite **ohne Anmeldung, homeESS-Menü oder
Titelleiste**. Unterseiten erhalten eigene Freigaben. Die Einstellungen bleiben
von der Freigabe ausgeschlossen. Freigaben werden mit einem schreibberechtigten
Benutzer verwaltet; Lesebenutzer können den Status und vorhandene Links ansehen.

Jeder mit dem Link erhält dessen ausgewählte Rechte. Beim Widerruf wird der
Link sofort ungültig; erneutes Freigeben erzeugt einen neuen Link. Die Links
verwenden die Adresse der bestehenden homeESS-Installation und richten keinen
zusätzlichen Fernzugang ein.

## Einheitliche Titel und automatische Aktualisierung

Seitentitel haben auf Desktop und Smartphone einheitliche Schriftgrößen,
Zeilenhöhen und obere Abstände. Das gilt auch für Einstellungen, öffentliche
Seiten und Adapterverwaltungen; das Freigabesymbol verschiebt den Titel nicht.

Seiten ohne eigene periodische Inhaltsaktualisierung erhalten eine gedrosselte
Änderungsprüfung. Ereignisse werden gebündelt, vollständige Seiten höchstens
einmal pro Minute geprüft und nur bei geändertem Inhalt neu geladen. Vorhandene
Live-Abfragen bleiben erhalten. Die Ergänzung umfasst auch öffentliche
Freigaben und Adapterseiten.

Hintergrund-Tabs, offene Dialoge, aktive Eingaben, Drag-and-drop und
ungespeicherte Formulare verhindern ein automatisches Neuladen. Auch ausgewählte
Dateien bleiben dabei geschützt.

## Batterie und Prognose

### Dynamischer Mindest-SoC

Die Batterieseite bietet eine aktivierbare Automatik für den Mindest-Ladezustand.
Sie passt den Wert **einmal täglich** an, wenn der prognostizierte PV-Höhepunkt
überschritten ist, keine weitere Überschussladung erwartet wird und der Akku
auch tatsächlich nicht mehr lädt. Das Ladepotenzial des Folgetags bestimmt,
welche Reserve bis zur nächsten Vollladung stehen bleiben soll.

Die Berechnung berücksichtigt den Hausverbrauch einschließlich Pool und
Funktionen sowie die Ladeverluste, **ohne Fahrzeugladung**. Wallbox-Lasten
verringern damit weder das Ladepotenzial des Hausakkus noch ziehen sie den
Auslösezeitpunkt vor.

Der Zielwert wird in ganzen Prozent gesetzt, mindestens 10 %, höchstens 95 %
und höchstens aktueller SoC minus 1 %. Ohne gültigen Zielwert bleibt die
Einstellung bestehen. Der Tagesschlüssel übersteht einen Neustart; die
Batterieseite zeigt die letzte automatische Anpassung. Änderungen werden mit
ihrer Quelle im Journal festgehalten.

Der manuelle Regler behält sein 5-%-Raster, zeigt automatisch gesetzte
Zwischenwerte aber unverfälscht an. Ein zurückgespiegelter Remote-Wert gilt
nicht erneut als externe Änderung.

### Gelernte PV-Variabilität

homeESS vergleicht Vortagsprognosen je Wetterklasse mit gemessenen Stunden.
Gelernter möglicher Mehrertrag wird anhand einer Klarhimmel-Referenz, des
gleichzeitigen Hausverbrauchs und der Ladeverluste als zusätzliches Ladepotenzial
für den dynamischen Mindest-SoC bewertet.

Bis genügend geeignete Messungen aus mehreren Tagen vorliegen, bleibt die
normale Prognose maßgeblich. Die Prognoseseite zeigt die Lernphase beziehungsweise
das gelernte Zusatzpotenzial. Abgeregelte, unvollständige und veraltete Messungen
werden nicht gelernt. Die Versorgungssicherheit und das Betriebslevel verwenden
weiterhin die normale Prognose.

### Versorgung vor Verbraucherfreigabe

Betriebslevel 5 setzt neben Überschuss und vollem Akku eine gesicherte Versorgung
voraus. Im Netzparallelbetrieb haben rote und gelbe Prognosen Vorrang; im
Autarkbetrieb muss die Mehrtagesreserve ausreichend sein. Ein kurzzeitiger
Überschuss bei vollem Akku gibt deshalb nicht allein alle Verbraucher frei.

## Rollladensteuerung und Heimkino

Das optionale Modul Rollladensteuerung nutzt gemeinsame Räume, auswählbare
Aktor- und Fensterkontakt-States, Fensterrichtung und eine raumweise
Dämmerungsschwelle. Vorausschauender Sonnenschutz kann vor automatischer
Kühlung einsetzen. Manuelle Raumübersteuerungen bleiben gespeichert; der
Sonnenschutz hält mindestens eine Stunde.

Aktoren können Hoch/Runter, einen Prozent-State oder beides verwenden. Bei
kombinierter Einrichtung werden Endlagen über Hoch/Runter und Zwischenlagen
über Prozent angefahren. Die Sonnenschutzposition lässt sich unabhängig von
invertierten Prozentwerten einstellen. Richtungsaktoren ohne Rückmeldung nutzen
gemerkte Endlagen und Fahrzeiten. Unbestätigte Fahrten werden nicht zyklisch
wiederholt.

Ein Heimkino kann vorhandenen Räumen zugeordnet werden. Ein aktives Kino
verdunkelt deren Rollläden und hat Vorrang vor geöffneten Fenstern. Beim Beenden
gilt wieder die Fensterregel oder die gespeicherte manuelle beziehungsweise
geplante Position.

Die Übersicht zeigt Helligkeit, Positionen, Steuerungsgrund, Fehler und Raummodus
und aktualisiert sie alle fünf Sekunden. Die Auswertung reagiert unmittelbar
nur auf zugeordnete Positions- und Kontakt-States; ohne angelegte Rollläden
bleibt sie inaktiv. Die Helligkeitsanzeige berücksichtigt bereits die frühe
Dämmerung ab −18° Sonnenhöhe.

## Lokale Sprachausgabe und Audio Bus

Unter **Nachrichten → Sprachausgabe** lassen sich persistente Audio-Endpunkte
benennen und vorhandenen Räumen zuordnen. Nachrichten können über den bisherigen
Relay-Weg, die lokale CPU-Sprachausgabe oder beide Wege ausgegeben werden.
Lokales Audio kann einen Endpunkt, einen Raum oder alle aktiven Endpunkte
erreichen. Eine begrenzte Warteschlange und getrennte Versandergebnisse machen
den Ablauf nachvollziehbar.

Die lokale Stimme verwendet **Piper mit dem deutschen Modell Thorsten High**.
Die bestehenden Installer für Main und Development installieren beides
automatisch. Pegel, Vorlauf, Nachlauf und Paketdauer sind dauerhaft einstellbar
und gelten ab der nächsten Ansage. Vorlauf und Nachlauf betragen standardmäßig
je 1000 ms; Pegelreserve und zeitlich ausgerichtete Audio-Pakete verbessern die
Ausgabe.

Der neue **Audio Bus** ermöglicht bidirektionales Audio für externe Clients und
Plugins. Er nutzt die Anmeldung der States API und begrenzt Sessions,
Warteschlangen und Datenmengen. Sein Sessionlimit lässt sich in den Einstellungen
zwischen 1 und 256 ändern, ohne Neustart oder Trennung bestehender Sessions.
Weitere Informationen stehen in [AUDIO-BUS.md](../AUDIO-BUS.md).

Nachrichten und Sprachausgabe verwenden responsive Karten und für Touch
geeignete Aktionen. Die Nachrichtenseite benötigt auf Smartphones keine
horizontal scrollende Tabelle mehr.

## States API und gemeinsame Räume

Die neue lokale **States API v1** lässt externe Clients den State-Baum
durchsuchen, Werte lesen und beschreibbare States setzen. Sie ist standardmäßig
deaktiviert und wird unter **Einstellungen → States API** eingerichtet.

Das API-Passwort wird als Hash gespeichert. Zugangstokens gelten zwölf Stunden
und verlieren bei Passwortänderung, Deaktivieren, Abmelden oder Neustart ihre
Gültigkeit. Fehlgeschlagene Anmeldungen sind begrenzt. Einzelne States oder
ganze Verzeichnisse können ausgeschlossen werden; die Ausschlüsse gelten auch
für Listen, Suche und direkten Zugriff. Die API nutzt die vorhandenen zentralen
States und Schreibwege. Dokumentation: [STATES-API.md](../STATES-API.md).

Geräte aus **Messen + Schalten** sind nun über ihren Schalten-State bedienbar,
auch in Aktionsfolgen und über die API. „Immer an“ und die Freigabe durch das
Betriebslevel werden weiterhin berücksichtigt.

Räume lassen sich direkt im Geräte-Dialog allein mit einem Namen anlegen.
Eine Solltemperatur ist optional: Ohne sie dienen Räume der Zuordnung und
nehmen nicht an Heizungs- oder Klimaregelung teil. Beim Entfernen eines Sollwerts
werden laufende Raumgeräte abgeschaltet und die Regelungs-States entfernt.
Zugeordnete Gerätestates erscheinen unter **System → Räume** mit Angaben zu
Gerät, Raum und effektiver Funktionsgruppe, einschließlich Gruppenvererbung.

## Logs und Updates

Die neue Seite **Logs** sammelt Laufzeitmeldungen aller Hintergrunddienste in
einem begrenzten Speicherpuffer. Filter nach Art und Quelle, Textsuche,
Dringlichkeitsfarben, Seiten mit je 200 Zeilen und ein Pause-Knopf erleichtern
die Fehlersuche. Der Aktualisierungstakt ist zwischen einer und 60 Sekunden
wählbar. Unveränderte Listen verursachen nur eine kleine Statusantwort.
Ein Neustart leert den Puffer; bestehende Prozessausgaben bleiben erhalten.
Die Seite kann je Benutzer ausgeblendet werden.

Die bestehenden Updatewege unterstützen **Main und Development**. In den
Updateeinstellungen lässt sich der Zielzweig wählen; die Oberfläche zeigt auch
den tatsächlich installierten Zweig. Ein Zweigwechsel erlaubt gleiche oder
kleinere Zielversionen. `VERSION.json` ist die gemeinsame maßgebliche Quelle
für Versionsanzeige und Updateprüfung. Der Entwicklungs-Installer verwendet
die bestehende Installationslogik des gewählten Zweigs.

## Weitere Fehlerkorrekturen und Sicherheit

- **Heizung:** Kleine Vorlaufänderungen werden innerhalb des Rauschbands
  zusammengezählt. Langsame Heizzyklen werden wieder als getrennte Brennerläufe
  erkannt. Ohne zentrale Wärmeanforderung und außerhalb des Schornsteinfeger-Modus
  erkennt auch ein fortgesetzter Abfall um mehr als 1 °C das Brennerende;
  Plateaus und kleine Schwankungen erhalten den bisherigen Zustand.
- **Homematic:** CCU-Positionswerte mit Einheit `100%` und Rohbereich 0–1,01
  werden beim Lesen und Schreiben richtig umgerechnet. Positionsfelder und
  STOP-Impulse nutzen die CCU-Datentypen; HmIP-Kanal 4 erhält seine
  Positionsrückmeldung von Kanal 3.
- **Zigbee / SONOFF ZBMINIR2:** Hersteller-Cluster, Binding und Reporting werden
  zuverlässig eingerichtet. Lokale Schaltungen und homeESS-Befehle lesen den
  tatsächlichen Relaiszustand zurück, statt ihn aus einem Toggle abzuleiten.
- **Abhängigkeiten:** Die Release-Lockdatei aktualisiert `ip-address`,
  `proxy-addr`, `qs`, `tar` und `undici` auf korrigierte Versionen innerhalb der
  bestehenden Abhängigkeitsbereiche.

## Hinweise zum Update

- Die Versionsangabe lautet **1.8.0** und folgt dem bestehenden Format aus drei
  Zahlen. Die Versionierung und Installerlogik erhalten keine Beta-Erweiterung.
- Datenbankmigrationen laufen beim Start automatisch. Seit 1.7.0 hinzugekommene
  Funktionen ergänzen unter anderem Einstellungen für die States API,
  Sprachausgabe und Rollläden sowie Tabellen für Seitenfreigaben und PV-Lerndaten.
  Vor dem Update eine Sicherung des bestehenden Datenverzeichnisses anlegen.
- Seiten sind standardmäßig nicht freigegeben. Der dynamische Mindest-SoC,
  die States API und die optionalen Module werden bei Bedarf aktiviert.
- Für lokale Sprachausgabe werden Piper und das Sprachmodell benötigt; die
  bestehenden Installer übernehmen deren Installation.
- Nach dem Update geöffnete Browserseiten einmal neu laden, damit die neuen
  Stile und Client-Skripte aktiv sind.
- Die Internet-Nutzung des eigenständigen Fernzugriff-Add-ons erfordert weiterhin
  die homeESS Remote Lizenz aus dem Google Play Store.
