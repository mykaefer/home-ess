'use strict';

// Einstiegspunkt: App zusammenbauen und Server starten.
// Die eigentliche Logik liegt modular unter src/.
const config = require('./src/config');
const { createApp } = require('./src/app');
const pairingState = require('./src/remote-access/pairing-state');
const connectionService = require('./src/remote-access/connection-service');

const { app } = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`homeESS läuft auf Port ${config.PORT}`);
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
  server.close(() => process.exit(0));
  // Notausstieg, falls Verbindungen nicht rechtzeitig schließen.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
