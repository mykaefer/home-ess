'use strict';

// Einstiegspunkt: App zusammenbauen und Server starten.
// Die eigentliche Logik liegt modular unter src/.
const config = require('./src/config');
const { createApp } = require('./src/app');
const pairingState = require('./src/remote-access/pairing-state');
const connectionService = require('./src/remote-access/connection-service');
const updateService = require('./src/update/service');

const { app, db } = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`homeESS läuft auf Port ${config.PORT}`);
  // Erst die persistierte Intervall-/Automatikkonfiguration laden, dann den
  // ersten Release-Check planen. So löst ein Neustart bei z. B. monatlichem
  // Intervall nicht kurzzeitig den täglichen Default-Check aus.
  updateService.init(db)
    .catch((error) => {
      console.error('[update] Einstellungen konnten nicht geladen werden:', error && error.message);
    })
    .finally(() => updateService.start());
});

// Kontrollierter Shutdown: flüchtigen Pairing-Zustand (Token/QR) aus dem
// Speicher entfernen, Cleanup-Timer beenden und den Server schließen.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`homeESS beendet (${signal}) …`);
  pairingState.shutdown();
  // Origin-WebSocket kontrolliert schließen (Reconnect stoppen, Timer löschen).
  connectionService.shutdown();
  updateService.shutdown();
  server.close(() => process.exit(0));
  // Notausstieg, falls Verbindungen nicht rechtzeitig schließen.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
