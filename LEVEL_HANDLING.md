# Betriebslevel & Verbraucher – Leitfaden für neue Verbraucher

Dieses Dokument beschreibt, wie ein neuer schaltbarer Verbraucher in homeESS an den
zentralen **Betriebslevel-Handler** (Lastmanagement) angebunden wird. Es ist als
Schritt-für-Schritt-Referenz gedacht, damit dafür nicht jedes Mal das gesamte Projekt
analysiert werden muss. Referenz-Implementierungen sind Filter- und Solarpumpe in
[`src/pool/automation.js`](src/pool/automation.js) sowie die Wallboxen in
[`src/wallbox/automation.js`](src/wallbox/automation.js) (Priorität je Lademodus,
mehrere Instanzen, Registrierung/Abmeldung beim Hinzufügen/Löschen einer Box).

---

## Grundprinzipien

1. **Betriebslevel (1–5).** Es gibt genau ein globales Betriebslevel, gehalten in
   [`src/operating-state.js`](src/operating-state.js) und laufend von der Prognose gesetzt.
   1 = strengster Sparbetrieb, 5 = freier Betrieb (Überschuss).

   Im **Netzparallelbetrieb** bedeuten die Zwischenstufen konkret: Level 1 bei
   bereits unterschrittenem Mindest-SoC, Level 2 bei knapper Reserve, Level 3 bei
   prognostiziertem Netzbedarf vor dem nächsten Ladebeginn, Level 4 bei sicherer
   Deckung bis dahin und Level 5 bei freiem Überschuss. Der **Autarkbetrieb**
   bewertet dagegen den gesamten sichtbaren Prognosehorizont und kann früher
   vorsorglich abregeln.

2. **Priorität = Freigabe-Level.** Jeder Verbraucher hat eine Priorität (1–5). Die Priorität
   ist das Betriebslevel, **ab dem** der Verbraucher laufen darf:

   > **erlaubt ⇔ aktuelles Betriebslevel ≥ Priorität**

   Beispiel: Priorität 4 ⇒ erlaubt bei Level 4 und 5, gesperrt bei 1–3.

3. **Drei Betriebsmodi pro Verbraucher: `an` / `aus` / `automatik`.**
   - **`automatik`** – die Schaltlogik des Verbrauchers entscheidet, **läuft aber immer über
     das Gate** des Betriebslevel-Handlers (Einschalten nur nach Freigabe, Zwangsabschaltung
     bei Levelabfall).
   - **`an`** – manuelle Übersteuerung durch den Bediener: Verbraucher läuft **unabhängig**
     vom Betriebslevel, das Gate wird **ignoriert**.
   - **`aus`** – manuell aus, ebenfalls unabhängig vom Level.

4. **Das Gate hat im Automatik-Modus immer Vorrang.** Im Automatik-Modus darf der Verbraucher
   niemals gegen das Betriebslevel einschalten, und eine Abschalt-Aufforderung des Handlers
   ist **sofort** umzusetzen.

---

## Der Handler

[`src/operating-level/handler.js`](src/operating-level/handler.js) – die zentrale Stelle.
Relevante API:

```js
const levelHandler = require('../operating-level/handler');

// Anmelden / Priorität aktualisieren (erneuter Aufruf = Re-Registrierung)
levelHandler.register(id, priority, { onMustTurnOff: () => { /* sofort abschalten */ } });

// Abmelden (Topic entfernt, Modul deaktiviert, Hand-Modus aktiv)
levelHandler.unregister(id);

// Einschalt-Freigabe holen (true ⇔ registriert UND erlaubt)
levelHandler.requestTurnOn(id);

// Reine Level-Prüfung ohne Registrierung (für aufgabenspezifische Prioritäten)
levelHandler.isAllowed(priority);

// Aktuelles Betriebslevel
levelHandler.currentOperatingLevel();
```

Der Handler beobachtet das Betriebslevel dauerhaft selbst (Abo bei `operatingState`).
Bei jedem Levelwechsel ruft er für jeden nicht mehr erlaubten Verbraucher dessen
`onMustTurnOff()` auf – ein Verbraucher muss sich darum **nicht** selbst kümmern.

---

## Checkliste: neuen Verbraucher anlegen

### 1. Konfiguration
- Feld **Priorität** (1–5) in der Config des Verbrauchers ergänzen (Spalte + Default,
  Formularfeld). Default sinnvoll wählen (z. B. 4 für „nice to have“, 2 für „wichtig“).
- Feld **Modus** (`an` / `aus` / `automatik`) bereitstellen. Default `automatik`.

### 2. Eindeutige Verbraucher-ID
- Stabile ID nach Schema `<domäne>.<gerät>` vergeben, z. B. `pool.filter`, `pool.solar`,
  `warmwasser.heizstab`. Als Konstante hinterlegen (vgl. `POOL_CONSUMER`).

### 3. Registrierung pflegen (pro Steuer-Tick)
Nur registrieren, wenn der Verbraucher **gemanagt** wird, d. h.
**Kommando-Topic gesetzt UND Modus === `automatik`**. Sonst `unregister` (kein Topic
oder Hand-Modus → Level ignorieren):

```js
function syncRegistration(cfg) {
  if (cfg.commandTopic && getMode() === 'auto') {
    levelHandler.register(CONSUMER_ID, cfg.priority, {
      onMustTurnOff: () => forceOff(cfg),
    });
  } else {
    levelHandler.unregister(CONSUMER_ID);
  }
}
```
Die Re-Registrierung bei **Prioritätsänderung** passiert dadurch automatisch (jeder Tick
ruft `register` mit der aktuellen Priorität auf).

### 4. Einschalten nur über das Gate (Automatik-Pfad)
Jedes Einschalten im Automatik-Modus über eine Freigabe absichern. Ist das Level zu
niedrig, wird `off` erzwungen – kein Ein-/Ausschalt-Flackern innerhalb eines Ticks:

```js
function gatedSend(topic, on, priority) {
  const effective = !!on && levelHandler.isAllowed(priority);
  send(topic, effective);
  return effective;          // tatsächlich geschalteter Zustand
}
// internen Status immer auf das *tatsächliche* Ergebnis setzen:
const on = gatedSend(cfg.commandTopic, desiredOn, cfg.priority);
state.output = on ? 'on' : 'off';
```
Hinweis: Ausschalten (`on === false`) ist immer erlaubt und muss nicht gegated werden.

### 5. Sofort-Abschaltung bereitstellen
`onMustTurnOff` muss die Last **unmittelbar** abschalten (nicht erst beim nächsten Tick):

```js
function forceOff(cfg) {
  if (!cfg.commandTopic) return;
  send(cfg.commandTopic, false);
  state.output = 'off';
}
```

### 6. Manuelle Modi am Gate vorbei
Die Sende-Pfade für `an` / `aus` schalten **direkt** (ohne `gatedSend`) und der Verbraucher
ist in diesen Modi **nicht registriert** – so übersteuert der Bediener das Betriebslevel
bewusst.

### 7. Initialisierung
Der Handler wird in [`src/app.js`](src/app.js) gestartet (`operatingLevelHandler.init()`).
Neue Verbraucher brauchen dort nichts; sie registrieren sich aus ihrer eigenen
Steuerschleife heraus, sobald sie aktiv sind.

---

## Tests
- Handler-Verhalten ist in [`test/operating-level.test.js`](test/operating-level.test.js)
  abgedeckt (Freigabe-Logik, Zwangsabschaltung, Re-Registrierung, unregister).
- Für einen neuen Verbraucher mindestens prüfen: Einschalten gesperrt bei zu niedrigem Level,
  Zwangsabschaltung bei Levelabfall, Hand-Modus ignoriert das Level.

---

## Kurzfassung

| Modus       | Registriert? | Gate aktiv? | Verhalten bei zu niedrigem Level |
|-------------|--------------|-------------|----------------------------------|
| `automatik` | ja           | ja          | bleibt aus / wird zwangsabgeschaltet |
| `an`        | nein         | nein        | läuft unabhängig vom Level       |
| `aus`       | nein         | nein        | aus                              |

**Faustregel:** Im Automatik-Modus entscheidet immer zuerst das Betriebslevel, dann erst die
eigene Logik des Verbrauchers. In `an`/`aus` zählt nur der Bedienerwille.
