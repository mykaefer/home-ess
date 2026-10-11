# Rollladensteuerung

Das optionale Modul verwendet die gemeinsamen Räume aus Heizung & Klima.
Neue Räume werden direkt im Rollladendialog über eine Textzeile angelegt;
vorhandene Räume werden im Dropdown ausgewählt. Die Übersicht zeigt nur Räume
mit Rollläden. Standort und Zeitzone stammen aus den vorhandenen Einstellungen.

Die Übersicht aktualisiert Positionen, Steuerungsgrund, Fehler und Raummodus
alle fünf Sekunden aus dem Laufzeit-Cache. Geöffnete Dialoge bleiben unberührt.

## Einrichtung

Ein Aktor benötigt entweder Hoch- und Runter-State zusammen oder einen
beschreibbaren Prozent-State. Alle drei können gemeinsam hinterlegt werden:
Endpositionen verwenden bevorzugt Hoch/Runter, Zwischenpositionen Prozent.
Fehlt der passende Richtungs-State, wird auch die Endposition per Prozent gesetzt.
Falls der Fahrbefehl und die tatsächliche Position verschiedene States haben,
kann der lesbare Istpositions-State separat gewählt werden. Bei Homematic-IP-
Rollladenaktoren wird für bestehende Konfigurationen mit Kanal `:4/LEVEL`
automatisch der Istwert von `:3/LEVEL` herangezogen; `:4/LEVEL` bleibt das
Schreibziel. Der `STOP`-State ist ein einmaliger Bedienimpuls, keine Position.
Invertierte Prozentwerte werden über die Werte für offen/geschlossen abgebildet.
Die Abdunkelung bei Sonne wird für Prozent-Aktoren mit einem Schieberegler
zwischen Offen und Geschlossen eingestellt. Die Richtung bleibt gleich, auch
wenn der Aktor 100 % als offen und 0 % als geschlossen interpretiert. Offen
bedeutet keine automatische Sonnenabdunkelung; reine Hoch-/Runter-Aktoren fahren beim Sonnenschutz vollständig zu.

Ohne Prozent-State ist keine gemessene Position verfügbar. Die Anzeige kennzeichnet
die gemerkte Endlage als geschätzt; die eingestellte Vollfahrzeit begrenzt das
Fahrtfenster. Ein gesendeter Befehl wird nicht wiederholt, nur weil eine Rückmeldung
fehlt. Hoch-/Runter-Flanken können manuelle Fahrten erkennen, wenn der Aktor diese
auch veröffentlicht. Lokale Bedienung ohne State-Meldung sowie manuelle
Zwischenstopps lassen sich ohne Positions- oder Stopprückmeldung nicht erkennen
oder exakt wiederherstellen. Anfangswerte nach dem Start gelten nicht als
Handbedienung. Die Fensterrichtung wird in Grad angegeben:
Nord 0, Ost 90, Süd 180, West 270.

Der optionale Kontakt erhält seinen Offen-Wert (true/false, 1/0, open/closed oder
on/off). Außerhalb des Kinos sperren unbekannte Kontaktwerte Schließfahrten.
Ein geöffnetes Fenster öffnet den Rollladen, auch während einer Schließfahrt,
sofern kein Heimkino im Raum aktiv ist. Bei eingerichtetem Prozent-State wartet
die Regelung auf dessen Positionswert; reine Richtungsaktoren benötigen diese
Rückmeldung nicht.

Die raumweise Resthelligkeit interpoliert die astronomische Sonnenhöhe zwischen
−18° (0 %, Beginn der astronomischen Dämmerung) und 0° (100 %). Beim Unterschreiten wird geschlossen, beim Überschreiten
geöffnet. Wolken ändern diese Tag-/Nachtgrenze nicht. Ohne Standort bleibt eine
neue astronomische Entscheidung aus.

## Vorausschauender Sonnenschutz

Die Fensterebene wird als vertikale Fläche mit derselben Sonnengeometrie und
Einfallswinkelprojektion wie das PV-Clear-Sky-Modell ausgewertet. Hindernisse wie
Nachbarhäuser oder Dachüberstände sind nicht modelliert.

Beschattung setzt voraus:

- Heizung & Klima ist aktiv und der Raum hat eine konfigurierte Solltemperatur
  sowie mindestens einen plausiblen Temperaturwert aus den letzten 30 Minuten.
- Die vorhandene 15-Minuten-Strahlungsprognose ist höchstens 90 Minuten alt und
  liefert für jetzt bis eine Stunde voraus durchgängig mindestens 120 W/m²
  direkte Strahlung auf das Fenster. Fehlende Daten lösen keine Beschattung aus.
- Sind PV-Sonnenintensitätsmessungen vorhanden, müssen sie mindestens acht der
  letzten zehn Minuten abdecken: mindestens fünf Proben, jede ≥55 %, Mittel ≥70 %.
  Dadurch verhindert ein gemessener Sonne-Wolken-Mix die Fahrt. Ohne PV-Messung
  entscheidet die vollständige Strahlungsprognose; sie ist keine Garantie für
  den tatsächlichen lokalen Wolkenverlauf.
- Die Raumtemperatur erreicht voraussichtlich innerhalb von 30 Minuten die
  Kühlgrenze minus 0,5 °C. Die Grenze ist dieselbe wie im Klimamodul:
  Maximum aus Solltemperatur + Kühloffset und optionaler Kühl-Mindesttemperatur.
  Der positive Temperaturtrend wird über bis zu 30 Minuten ermittelt und auf
  2 °C pro Stunde begrenzt. Ohne Trend entscheidet die aktuelle Temperatur.

Nach tatsächlichem Sonnenschutz-Schließen gilt mindestens eine Stunde Haltezeit.
Öffnen benötigt zusätzlich 20 Minuten ohne weiteren Sonnenbedarf. Nach einem
solchen Öffnen ist erneutes Sonnenschutz-Schließen eine weitere Stunde gesperrt.
Automatische Kühlung lässt der erfolgreich angestoßenen Beschattung höchstens
15 Minuten Wirkungszeit. Ein manueller Klimabefehl bleibt wirksam. Diese
Wartezeit ist keine Sperre einer notwendigen Kühlung für den ganzen Tag.

## Vorrang und manuelle Bedienung

1. Aktives Heimkino im zugeordneten Raum: schließen, auch bei offenem Fenster. Mehrere Heimkinos werden
   gemeinsam betrachtet; erst wenn alle aus sind, endet die Verdunkelung.
2. Offenes Fenster/Tür ohne aktives Kino: öffnen, keine Schließfahrt.
3. Manuelle Raumsteuerung: gespeicherte individuelle Positionen wiederherstellen.
4. Automatik: Nachtposition oder Sonnenschutz, sonst offen.

Eine externe Positionsänderung wird nach zwei Sekunden ohne weitere Änderung
als Handbedienung übernommen. Während eigener Fahrten werden Zwischenwerte bis
zur eingestellten Fahrzeit plus zehn Sekunden als Rückmeldungen erkannt;
Gegenbewegungen gelten bereits vorher als Handbedienung. Ein manueller Stopp
in derselben Richtung lässt sich allein aus dem Prozent-State erst nach dem
Fahrtfenster sicher von einer langsamen eigenen Fahrt unterscheiden.

Handbedienung setzt den ganzen Raum auf manuell. Kino- und Fensterfahrten ändern
seine gespeicherten Handpositionen nicht. Beim Ende der Übersteuerung werden
sie wiederhergestellt. Auch eine manuelle Nachtöffnung bleibt nach Öffnen und
Schließen des Fensters erhalten. Die Automatik kehrt erst beim nächsten
Tag-/Nachtwechsel oder durch manuelle Rückkehr aller betroffenen Rollläden zu
ihren geplanten Positionen zurück. Ein automatisches Kinoende nachts öffnet
folglich nicht, wenn weiterhin Nachtschluss vorgesehen ist.

Manuelle Bedienung, Fenster-Sicherheitsöffnung und expliziter Kinobetrieb haben
Vorrang vor den Sonnenschutz-Fahrpausen. Fahrbefehle werden nicht zyklisch
wiederholt. Fehlendes Schreibziel oder nicht bestätigte Zielposition führen
zu einem sichtbaren Fehler; eine neue externe Positionsänderung erlaubt die
erneute Auswertung. Eine Sicherheitsöffnung darf einen fehlgeschlagenen
Schließbefehl einmal übersteuern.

Raumübersteuerung, Handpositionen, Fahrtfenster und Sonnenschutzzeiten liegen
in SQLite und überleben einen Neustart. Nach dem Start wartet die Regelung zehn
Sekunden auf Rückmeldungen; Sicherheitsöffnungen sind sofort möglich.
