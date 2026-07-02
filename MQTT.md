# ioBroker MQTT – Regelwerk für fehlerfreie Kommunikation

Dieses Dokument beschreibt alle bekannten Eigenheiten des ioBroker-MQTT-Brokers und die bewährten Muster für eine stabile, fehlerfreie MQTT-Kommunikation. Es ist projektneutral und kann als direkte Referenz für neue Projekte verwendet werden.

---

## Grundprinzipien

1. **Kein automatisches Prefix.** ioBroker veröffentlicht State-Werte ohne `iobroker/`-Prefix. Dieses Prefix niemals automatisch voranstellen – es ist ausschließlich für interne ioBroker-Protokollnachrichten reserviert. Wenn ein Broker solche Topics blockiert, ist das erwünscht.

2. **State-ID ≠ MQTT-Topic.** ioBroker speichert States mit Punktnotation (`adapter.instanz.pfad`). Der MQTT-Adapter veröffentlicht sie wahlweise als Punkt-Topic (`adapter.instanz.pfad`) oder Slash-Topic (`adapter/instanz/pfad`). Beide kommen vor; welches Format zuverlässig geliefert wird, hängt vom ioBroker-MQTT-Adapter und dessen Version ab.

3. **QoS 0 ist Standard.** ioBroker-MQTT-Adapter verwenden in der Regel QoS 0. Höhere QoS-Level sind selten konfiguriert und schaffen oft mehr Probleme als sie lösen.

4. **`clean: true`.** MQTT.js sollte mit `clean: true` verbunden werden. Persistent sessions führen zu Zustellung alter Nachrichten bei Reconnect und verschleiern fehlerhafte Subscriptions.

5. **Bursts intern bündeln, Werte nicht verwerfen.** Mehrere zusammengehörige
   Adapterwerte werden im homeESS-Wertebus als Batch übernommen. Jeder State
   behält Wert und Frischezeitpunkt; abhängige Regelungen erhalten für den Batch
   ein gemeinsames Ereignis. MQTT-Topics, Retained-Verhalten und Pollintervalle
   bleiben davon unverändert.

---

## Topic-Formate in ioBroker

### Normalform / Normalisierung

Jedes Topic vor der Verarbeitung bereinigen:

```js
function normalizeMqttTopic(topic) {
  return String(topic || "").trim()
    .replace(/^\/+/, "")   // kein führender Slash
    .replace(/\/+/g, "/"); // keine doppelten Slashes
}
```

### State-ID → MQTT-Topic (Punkt → Slash)

ioBroker-State-IDs werden durch Ersetzen aller Punkte durch Slashes zu einem MQTT-Topic:

```js
function ioBrokerIdToMqttTopic(stateId) {
  return String(stateId || "")
    .replace(/^\/+/, "")
    .replace(/\./g, "/")
    .replace(/\/+/g, "/");
}
// "0_userdata.0.SoC" → "0_userdata/0/SoC"
```

### MQTT-Adapter-States erkennen

Wenn ein Nutzer eine ioBroker-State-ID in der Form `mqtt.0.Heizung.Vorlauf` konfiguriert (State des MQTT-Adapters selbst), ist das eigentliche Broker-Topic `Heizung/Vorlauf`:

```js
function mqttAdapterStateToBrokerTopic(topic) {
  const clean = normalizeMqttTopic(topic);
  const dotMatch = clean.match(/^mqtt\.\d+\.(.+)$/i);
  if (dotMatch) return ioBrokerIdToMqttTopic(dotMatch[1]);
  const slashMatch = clean.match(/^mqtt\/\d+\/(.+)$/i);
  if (slashMatch) return normalizeMqttTopic(slashMatch[1]);
  return "";
}
// "mqtt.0.Heizung.Vorlauf.Vorlauf" → "Heizung/Vorlauf/Vorlauf"
```

### Lese-Kandidaten pro konfiguriertem Topic

Für jedes konfigurierte Topic werden alle realistischen MQTT-Pfade erzeugt, auf denen Werte ankommen können:

```js
function mqttReadCandidates(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return [];
  const slashVariant = ioBrokerIdToMqttTopic(clean);
  const adapterVariant = mqttAdapterStateToBrokerTopic(clean);
  const result = new Set([clean]);
  if (slashVariant !== clean) result.add(slashVariant);
  if (adapterVariant && adapterVariant !== clean) result.add(adapterVariant);
  return Array.from(result);
}
// "0_userdata.0.SoC" → ["0_userdata.0.SoC", "0_userdata/0/SoC"]
// "mqtt.0.Heizung.Vorlauf" → ["mqtt.0.Heizung.Vorlauf", "mqtt/0/Heizung/Vorlauf", "Heizung/Vorlauf"]
```

---

## Kritischer Broker-Bug: State-IDs mit eingebetteten Slashes

### Problemstellung

Manche ioBroker-Adapter (z. B. Modbus, Victron Energy via MQTT-Adapter) erzeugen State-IDs, in denen der State-Name selbst Slashes enthält:

```
modbus.0.holdingRegisters.100.817_/Ac/Consumption/L1/Power
```

Das Dot-Prefix lautet hier `modbus.0.holdingRegisters.100.817_`, der State-Name beginnt direkt mit einem Slash: `/Ac/Consumption/L1/Power`.

### Warum ein exaktes Abo nicht funktioniert

Der ioBroker-MQTT-Broker konvertiert beim Matching einer Subscription **alle Slashes zurück zu Punkten**, um die State-ID zu finden. Bei obigem Beispiel würde er aus dem Slash-Topic `modbus/0/holdingRegisters/100/817_/Ac/Consumption/L1/Power` die State-ID `modbus.0.holdingRegisters.100.817_.Ac.Consumption.L1.Power` rekonstruieren – diese existiert nicht. Das Abo wird zwar bestätigt (SUBACK), aber:

- **Retained-Wert:** Kommt an (einmalig, oft leer), weil der Broker ihn direkt unter dem Topic gespeichert hat.
- **Live-Updates:** Kommen **nie** an, weil der Broker das Topic bei jeder Veröffentlichung nicht auf die Subscription matcht.

**Symptom:** Werte sind initial korrekt (aus Retained), werden aber nie aktualisiert. Im Cache sieht man Timestamps, die Stunden oder Tage alt sind, obwohl der Broker sekündlich publiziert.

**Nachweis:** Ein Wildcard-Abo `modbus/0/holdingRegisters/100/#` auf denselben Broker liefert die Live-Werte einwandfrei.

### Lösung: automatisches Wildcard-Abo

An der letzten reinen Punkt-Grenze vor dem ersten eingebetteten Slash ein `#`-Wildcard generieren:

```js
function mqttSlashStateWildcard(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  const firstSlash = clean.indexOf("/");
  if (firstSlash === -1) return ""; // kein eingebetteter Slash → kein Problem
  const dotPrefix = clean.slice(0, firstSlash);
  const lastDot = dotPrefix.lastIndexOf(".");
  if (lastDot === -1) return ""; // kein Punkt-Praefix → natives Slash-Topic, kein Problem
  const base = dotPrefix.slice(0, lastDot);
  const slashBase = ioBrokerIdToMqttTopic(base);
  return slashBase ? `${slashBase}/#` : "";
}
// "modbus.0.holdingRegisters.100.817_/Ac/Consumption/L1/Power"
//   → "modbus/0/holdingRegisters/100/#"
```

Dieses Wildcard **zusätzlich zu** den normalen Kandidaten abonnieren:

```js
function mqttSubscribeCandidates(configuredTopic) {
  const clean = normalizeMqttTopic(configuredTopic);
  if (!clean) return [];
  const candidates = new Set(mqttReadCandidates(clean));
  const wildcard = mqttSlashStateWildcard(clean);
  if (wildcard) candidates.add(wildcard);
  return Array.from(candidates);
}
```

**Wichtig:** Das Routing (welche eingehende Nachricht welchem Cache-Eintrag zugeordnet wird) weiterhin auf den exakten `mqttReadCandidates` aufbauen. Das Wildcard dient nur dem Empfang; die Zuordnung läuft über das genaue Topic der eingehenden Nachricht.

### Schreiben auf Slash-State-IDs ist nicht möglich

Das Wildcard löst ausschließlich das **Lesen**. **Schreiben** auf eine State-ID
mit eingebettetem Slash funktioniert prinzipiell nicht:

- Auf ein Wildcard (`#`/`+`) kann **nicht publiziert** werden — ein Publish geht
  immer an genau ein konkretes Topic.
- Der Broker bildet ein eingehendes konkretes Topic per `/`→`.` auf die State-ID
  zurück. Aus `modbus/0/holdingRegisters/100/3500_/ManualStart` wird so
  `modbus.0.holdingRegisters.100.3500_.ManualStart` — die echte ID enthält an
  dieser Stelle aber einen **Slash**. Der Schreibbefehl trifft nichts und
  versickert (selbst wenn man an alle Punkt-/Slash-Kandidaten schreibt).

**Symptom:** Der Zustand wird korrekt angezeigt/gelesen, ein Schaltbefehl ändert
den realen State im ioBroker aber nie.

**Lösung:** Für **Schalt-Ziel-Topics slash-freie** State-IDs verwenden (z. B. einen
schreibbaren Hilfs-State unter `0_userdata.0.…` anlegen und per Skript auf das
slash-behaftete Register spiegeln). Nur Lese-Topics dürfen den eingebetteten
Slash behalten.

---

## Reconnect – die häufigste Fehlerquelle

### Problem

MQTT.js reconnectet nach einem Verbindungsabbruch automatisch und feuert erneut das `connect`-Event. Wenn Subscribe-Tracking in einem Set gehalten wird (Deduplizierung), und dieses Set beim Reconnect **nicht geleert** wird, passiert folgendes:

1. `connect` feuert → `subscribeAllTopics()` wird aufgerufen.
2. Für jedes Topic: `if (subscribedTopics.has(topic)) return;` → früher Return.
3. Kein einziges SUBSCRIBE-Paket geht an den Broker.
4. Der Broker liefert keine Werte mehr.
5. Nur noch gecachte (veraltete) Werte sind sichtbar – oft stunden- oder tagelang.

**Das Set muss bei jedem `connect`-Event geleert werden:**

```js
client.on("connect", () => {
  subscribedTopics = new Set(); // KRITISCH: immer leeren, auch beim Auto-Reconnect
  subscribeAllTopics();
  requestStaleValues();
});
```

### Warum nicht im `reconnect`-Event?

Das `reconnect`-Event feuert *vor* dem Verbindungsaufbau. Zum Zeitpunkt des `reconnect`-Events ist der Client noch nicht verbunden, SUBSCRIBE-Pakete können nicht gesendet werden. Das Leeren dort ist folgenlos. Nur im `connect`-Event ist die Verbindung tatsächlich hergestellt.

### Client-Generationen bei asynchronen Events

MQTT.js-Events (`close`, `error`, `message`) können noch nach dem Schließen eines Clients eintreffen. Bei Reconnect-Logik, die einen neuen Client erzeugt, alten Client-Events anhand einer Generation-ID filtern:

```js
let clientGeneration = 0;
let mqttClient = null;

function reconnect() {
  const generation = ++clientGeneration;
  const client = mqtt.connect(url, options);
  client.on("connect", () => {
    if (generation !== clientGeneration) return; // veraltetes Event ignorieren
    // ...
  });
  client.on("message", (topic, buf) => {
    if (client !== mqttClient) return; // altes Client-Objekt ignorieren
    // ...
  });
  mqttClient = client;
}
```

---

## Payload-Formate

### ioBroker MQTT-Adapter: JSON-Wrapping

Der ioBroker MQTT-Adapter kann Werte in einem JSON-Objekt veröffentlichen:

```json
{ "val": 42, "ack": true, "ts": 1710000000000, "lc": 1710000000000 }
```

Auspacken vor der Verarbeitung:

```js
function unwrapMqttPayload(raw) {
  const text = String(raw);
  if (!text || (text[0] !== "{" && text[0] !== "[")) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "val" in parsed) {
      return parsed.val; // ioBroker-Format: { val, ack, ... }
    }
  } catch (_) {}
  return text; // anderes JSON oder Parse-Fehler → Rohstring zurückgeben
}
```

**Nur `val` auspacken.** Andere JSON-Objekte (z. B. `{"power": 123}`) bleiben als Rohstring.

### `ack`-Flag: bestätigter Zustand vs. Schreibwunsch

In ioBroker bedeutet `ack:true` den **bestätigten Ist-Zustand** eines States,
`ack:false` einen **Schreibwunsch/Kommando**. Schreibt ein Client einen Wert auf
das Haupt-Topic (`{val, ack:false}`, siehe unten), so empfängt er dieses
**eigene Echo** über seine Subscription wieder zurück. Wird das ungeprüft gecacht,
spiegelt der „Broker-Stand" nur den eigenen Befehl wider — eine Rückmeldungs-
Verifikation (Soll == Broker?) meldet dann fälschlich „bestätigt", obwohl der
Adapter/das Gerät den Wert gar nicht übernommen hat.

**Regel:** Beim Readback das `ack`-Flag auswerten und Nachrichten mit `ack:false`
**nicht** als Zustand cachen. Nur `ack:true` (bzw. JSON-lose Rohwerte von
Adaptern, die Zustände ohne Wrapper publizieren) gelten als bestätigter Wert.

```js
function unwrapMqttMessage(raw) {
  const text = String(raw);
  if (!text || (text[0] !== "{" && text[0] !== "[")) return { value: text, ack: null };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "val" in parsed) {
      return { value: parsed.val, ack: typeof parsed.ack === "boolean" ? parsed.ack : null };
    }
  } catch (_) {}
  return { value: text, ack: null };
}

// Im Message-Handler:
const { value, ack } = unwrapMqttMessage(payload);
if (ack === false) return; // Schreibwunsch/Echo – kein bestätigter Zustand
```

### Sinnlose Werte ignorieren

Leere Payloads, `null` und `NaN` sind im ioBroker-Kontext keine gültigen Werte:

```js
function isMeaningfulValue(value) {
  const text = String(value == null ? "" : value).trim();
  return text !== "" && text.toLowerCase() !== "null" && text.toLowerCase() !== "nan";
}
```

Diese Werte **nicht cachen** und **nicht an UI-Clients weitergeben**.

### Leere Retained-Payloads bei Dot-Topics

Wenn für ein Topic sowohl ein Dot-Topic als auch ein Slash-Topic abonniert wird, kann das Dot-Topic einen leeren Retained-Wert liefern (weil ioBroker beim State-Löschen oder -Initialisieren einen leeren Payload retained). Das Slash-Topic liefert dagegen den echten Wert.

Regel: Leere Payloads auf dem Dot-Topic ignorieren, wenn ein Slash-Topic existiert:

```js
function shouldIgnoreEmptyPayload(configuredTopic, incomingTopic, rawPayload) {
  if (isMeaningfulValue(rawPayload)) return false;
  const slashVariant = ioBrokerIdToMqttTopic(normalizeMqttTopic(configuredTopic));
  if (slashVariant === normalizeMqttTopic(configuredTopic)) return false; // kein Unterschied
  return normalizeMqttTopic(incomingTopic) !== slashVariant; // ignorieren, wenn nicht Slash-Variante
}
```

---

## Schreiben / Publizieren

### Normaler State (kein Command-Topic)

ioBroker erwartet Schreiboperationen auf zwei Wegen gleichzeitig:

```js
// 1. Direkt auf dem Topic, mit JSON-Body und ack: false
mqttClient.publish(topic, JSON.stringify({ val: value, ack: false }));
// 2. Auf dem /set-Subtopic, als Rohwert
mqttClient.publish(`${topic}/set`, String(value));
```

### Command-Topics (`_SET`, `.SET`, `/SET`)

Topics die auf `_SET`, `.SET` oder `/SET` enden, sind reine Schreib-Topics in ioBroker. Kein `/set`-Suffix anfügen, keinen JSON-Body senden – direkt den Rohwert publizieren:

```js
function isCommandTopic(topic) {
  const upper = normalizeMqttTopic(topic).toUpperCase();
  return upper.endsWith(".SET") || upper.endsWith("/SET") || upper.endsWith("_SET");
}

function publish(configuredTopic, value) {
  const baseTopic = resolveBaseTopic(configuredTopic); // Slash-Variante
  if (isCommandTopic(configuredTopic)) {
    mqttClient.publish(baseTopic, String(value));
    return;
  }
  mqttClient.publish(`${baseTopic}/set`, String(value));
  mqttClient.publish(baseTopic, JSON.stringify({ val: parseValue(value), ack: false }));
}
```

### Wert-Typen beim JSON-Publish

ioBroker erwartet den richtigen JavaScript-Typ im `val`-Feld:

```js
function parseValue(value) {
  const text = String(value);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text !== "" && Number.isFinite(Number(text))) return Number(text);
  return text;
}
```

---

## Aktive Wertabfrage (`/get`-Pattern)

ioBroker-States können per `/get`-Subtopic aktiv angefragt werden. Dabei antwortet ioBroker mit dem aktuellen Wert auf dem Haupt-Topic (nicht auf `/get`):

```js
// Anfrage senden:
mqttClient.publish(`${topic}/get`, "");
// Antwort kommt auf: topic (nicht auf topic/get)
```

Für alle Lese-Kandidaten eines konfigurierten Topics `/get`-Requests senden:

```js
function requestTopicValue(configuredTopic) {
  for (const candidate of mqttReadCandidates(configuredTopic)) {
    mqttClient.publish(`${candidate}/get`, "");
  }
}
```

**Wichtig:** Wildcard-Topics (`#`, `+`) niemals für `/get`-Requests verwenden. Nur exakte Kandidaten.

### Verifizierte HomeESS-Outputs

Die allgemeine Output-Engine behandelt ein erfolgreiches `publish()` nicht als
Erfolg. Jeder Ziel-State wird zusätzlich abonniert und in einem 30-Sekunden-Fenster
aktiv per `/get` abgefragt — jeder Output jedoch zu einem **zufälligen Zeitpunkt**
innerhalb des Fensters, damit nicht alle gleichzeitig den Broker belasten. Ein
bereits bestätigter State wird erst wieder aktiv abgefragt, wenn sein zuletzt
empfangener Ist-Wert älter als ein Prüffenster ist. Nur eine nach der Anfrage
empfangene `ack:true`- oder Rohwert-Rückmeldung mit typgleich übereinstimmendem
Wert bestätigt den Output. Fehlt sie oder weicht sie ab, wird der Sollwert mit
mindestens zehn Sekunden Abstand erneut geschrieben. Eigene `ack:false`-Echos
bleiben ausgeschlossen.

Command-Topics (`_SET`, `.SET`, `/SET`) liefern üblicherweise keinen belastbaren
Istwert und sind deshalb keine zulässigen Ziele für verifizierte Outputs.

---

## Subscription-Routing

### Vorberechnete Topic-Routen

Für jede eingehende MQTT-Nachricht gegen alle konfigurierten States zu prüfen ist O(n) und bei vielen States spürbar. Stattdessen beim Start (und bei Konfigurationsänderungen) eine Map aufbauen:

```js
// Map: incomingTopic → [{ cacheKey, configuredTopic, ... }]
const topicRoutes = new Map();

function buildTopicRoutes(stateDefinitions) {
  topicRoutes.clear();
  for (const state of stateDefinitions) {
    for (const candidate of mqttReadCandidates(state.topic)) {
      const routes = topicRoutes.get(candidate) || [];
      routes.push({ cacheKey: String(state.id), configuredTopic: state.topic });
      topicRoutes.set(candidate, routes);
    }
  }
}

function handleMqttMessage(topic, buffer) {
  const incomingTopic = normalizeMqttTopic(topic);
  const payload = unwrapMqttPayload(buffer.toString("utf8"));
  for (const route of topicRoutes.get(incomingTopic) || []) {
    if (!isMeaningfulValue(payload)) continue;
    cache.set(route.cacheKey, { value: payload, receivedAt: Date.now() });
  }
}
```

**Routing-Schlüssel sind immer exakte Topics** – niemals Wildcards in `topicRoutes` aufnehmen.

### Deduplizierung von Subscriptions

Gleiche Topics, die an mehreren Stellen konfiguriert sind (z. B. zwei States auf demselben MQTT-Topic), nur einmal abonnieren:

```js
let subscribedTopics = new Set();

function subscribeTopic(topic) {
  const clean = normalizeMqttTopic(topic);
  if (!clean || subscribedTopics.has(clean)) return;
  mqttClient.subscribe(clean, { qos: 0 }, (err) => {
    if (!err) subscribedTopics.add(clean);
  });
}
```

Beim `connect`-Event: `subscribedTopics = new Set()` vor dem ersten Subscribe-Aufruf.

---

## Topic-Watchdog (Stille Subscriptions erkennen)

Subscriptions können technisch aktiv sein, aber trotzdem keine Werte mehr liefern – z. B. wenn der Broker neu gestartet wurde und die Session verloren ging, oder bei der Slash-State-Sonderbehandlung. Ein Watchdog erkennt solche „stillen" Topics und erzwingt einen Re-Subscribe.

```js
const SILENT_THRESHOLD_MS = 3 * 60 * 1000; // 3 Minuten
const topicLastMessageAt = new Map(); // incomingTopic → timestamp

// In handleMqttMessage:
topicLastMessageAt.set(incomingTopic, Date.now());

// Watchdog (z. B. alle 3 Minuten):
function checkSilentSubscriptions(configuredTopics) {
  if (!mqttClient || !mqttConnected) return;
  const now = Date.now();
  for (const configuredTopic of configuredTopics) {
    const subCandidates = mqttSubscribeCandidates(configuredTopic);
    // Nur überwachen, wenn überhaupt aktiv abonniert
    if (!subCandidates.some((c) => subscribedTopics.has(c))) continue;
    // Letzten Empfangszeitpunkt über alle exakten Kandidaten ermitteln
    const lastMsg = mqttReadCandidates(configuredTopic)
      .reduce((max, c) => Math.max(max, topicLastMessageAt.get(c) || 0), 0);
    if (lastMsg && (now - lastMsg) < SILENT_THRESHOLD_MS) continue;
    // Topic ist still → Re-Subscribe erzwingen
    for (const c of subCandidates) subscribedTopics.delete(c);
    for (const c of subCandidates) subscribeTopic(c);
    requestTopicValue(configuredTopic); // /get anfragen
  }
}
```

**Achtung:** Stille Topics werden nicht sofort gemeldet. Der erste Watchdog-Lauf findet frühestens nach `SILENT_THRESHOLD_MS` statt. Deshalb ergänzend beim `connect`-Event alle Topics aktiv anfragen (`requestStaleValues()`).

---

## Force-Resubscribe für manuelle Wert-Abfragen

Wenn der Nutzer explizit einen frischen Wert anfordert (z. B. über einen Diagnose-Button), reicht es nicht, nur einen `/get`-Request zu senden. Der Broker liefert Retained-Werte erst nach einem (neuen) SUBSCRIBE. Deshalb das Topic temporär aus dem Deduplizierungs-Set entfernen, dann neu abonnieren:

```js
async function fetchLiveValue(configuredTopic, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    const candidates = mqttReadCandidates(configuredTopic);

    // Waiter registrieren
    for (const candidate of candidates) {
      const waiters = valueWaiters.get(candidate) || [];
      waiters.push({ resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
      valueWaiters.set(candidate, waiters);
    }

    // Force-Resubscribe: aus Set löschen → next subscribeTopic sendet echtes SUBSCRIBE
    for (const sub of mqttSubscribeCandidates(configuredTopic)) {
      subscribedTopics.delete(sub);
      subscribeTopic(sub);
    }
    requestTopicValue(configuredTopic); // /get ebenfalls anfragen
  });
}
```

**Wichtig:** Das Backend darf für Diagnose-Abfragen **keinen gecachten Wert zurückgeben**. Nur der tatsächlich empfangene Broker-Wert ist für Diagnosen nützlich.

---

## Zusammenfassung: Häufige Fallstricke

| Problem | Ursache | Lösung |
|---|---|---|
| Nach Reconnect keine Live-Werte mehr | `subscribedTopics`-Set nicht geleert | `subscribedTopics = new Set()` im `connect`-Event |
| Modbus/Victron Topics nie aktuell | State-ID mit eingebettetem Slash, exaktes Abo scheitert am Broker | `#`-Wildcard an letzter Punkt-Grenze vor erstem Slash |
| Dot-Topic liefert leere Werte | ioBroker retained leere Payloads unter Punkt-Namen | Leere Payloads auf Dot-Topics ignorieren wenn Slash-Variante existiert |
| Wert bleibt nach State-Änderung alt | `subscribedTopics` enthält noch alten Topic-Pfad | Nach Topic-Änderung altes Topic aus Set entfernen |
| `mqtt.0.X`-States liefern nichts | Falsche Kandidaten-Berechnung (Adapter-Prefix nicht abgezogen) | `mqttAdapterStateToBrokerTopic` vor Kandidatenberechnung |
| Schalter toggelt, ioBroker reagiert nicht | Nur `/set` oder nur JSON-Body gesendet | Immer beide senden: `/set` (Rohwert) + Haupt-Topic (JSON `{val, ack:false}`) |
| Command-Topic (`_SET`) sendet JSON-Body | `isCommandTopic` nicht geprüft | Command-Topics: nur Rohwert, kein `/set`, kein JSON |
| Alte Events nach Client-Neuaufbau | `close`/`error`/`message` Events des alten Clients | Generation-Counter oder Client-Objekt-Vergleich |
| Topics die stunden-/tagealt bleiben | Keine Watchdog-Logik für stille Subscriptions | `checkSilentSubscriptions` periodisch aufrufen |
| Readback meldet fälschlich „bestätigt" | Eigenes `ack:false`-Echo auf dem Haupt-Topic wird als Zustand gecacht | `ack:false`-Nachrichten beim Readback verwerfen; nur `ack:true`/Rohwerte cachen |
| Schaltbefehl ändert Slash-State nie | Schreiben auf State-ID mit eingebettetem Slash unmöglich (`/`→`.` trifft falsch) | Slash-freie Ziel-Topics verwenden; Wildcard hilft nur beim Lesen |

---

## Empfohlene Verbindungsoptionen (MQTT.js)

```js
const client = mqtt.connect("mqtt://host:port", {
  username: "...",
  password: "...",
  clientId: "dashboard_" + Math.random().toString(16).slice(2),
  clean: true,           // keine persistente Session
  reconnectPeriod: 5000, // Auto-Reconnect alle 5 Sekunden
  connectTimeout: 10000, // Verbindungs-Timeout 10 Sekunden
  keepalive: 60          // Heartbeat alle 60 Sekunden
});
```

Mit `clean: true` muss nach jedem Reconnect neu abonniert werden – das ist gewollt und der Grund, warum das `connect`-Event das Set leeren muss.
