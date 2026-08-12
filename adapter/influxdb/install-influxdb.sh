#!/bin/bash
# Richtet eine lokale InfluxDB 1.x für homeESS ein: Paket installieren, Dienst
# starten, Datenbank, Benutzer und Aufbewahrungsregel anlegen, Anmeldung
# einschalten.
#
# Aufruf in einer Root-Konsole, zum Beispiel:
#   bash /opt/home-ess/adapter/influxdb/install-influxdb.sh \
#     --database homeess --user homeess --port 8086 --retention 730
#
# Das Kennwort wird verdeckt abgefragt (oder aus INFLUX_SETUP_PASSWORD
# übernommen) und steht dadurch weder in der Shell-History noch in der
# Prozessliste. Es muss mit dem Kennwort in den Instanzeinstellungen
# übereinstimmen.
#
# Das Skript ist mehrfach ausführbar: Vorhandene Datenbanken, Benutzer und
# Regeln werden nicht überschrieben.

set -euo pipefail

DATABASE="homeess"
DB_USER="homeess"
PORT="8086"
RETENTION_DAYS="730"
CONFIG_FILE="/etc/influxdb/influxdb.conf"

usage() {
  cat <<'USAGE'
Verwendung: install-influxdb.sh [Optionen]

  --database NAME    Name der Datenbank        (Standard: homeess)
  --user NAME        Datenbankbenutzer         (Standard: homeess)
  --port PORT        HTTP-Port der InfluxDB    (Standard: 8086)
  --retention TAGE   Aufbewahrung in Tagen     (Standard: 730, 0 = unbegrenzt)
  --help             Diese Hilfe

Das Kennwort wird verdeckt abgefragt oder aus INFLUX_SETUP_PASSWORD gelesen.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database) DATABASE="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --retention) RETENTION_DAYS="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo "Dieses Skript muss als root laufen. Bitte in einer Root-Konsole starten." >&2
  exit 1
fi

name_ok() { [[ $1 =~ ^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$ ]]; }
name_ok "${DATABASE}" || { echo "Ungültiger Datenbankname: ${DATABASE}" >&2; exit 2; }
name_ok "${DB_USER}" || { echo "Ungültiger Benutzername: ${DB_USER}" >&2; exit 2; }
[[ ${PORT} =~ ^[0-9]+$ ]] || { echo "Ungültiger Port: ${PORT}" >&2; exit 2; }
[[ ${RETENTION_DAYS} =~ ^[0-9]+$ ]] || { echo "Ungültige Aufbewahrung: ${RETENTION_DAYS}" >&2; exit 2; }

PASSWORD="${INFLUX_SETUP_PASSWORD:-}"
if [[ -z ${PASSWORD} ]]; then
  read -r -s -p "Kennwort für \"${DB_USER}\" (wie in homeESS hinterlegt): " PASSWORD
  echo
fi
if [[ ${#PASSWORD} -lt 8 ]]; then
  echo "Das Kennwort muss mindestens acht Zeichen lang sein." >&2
  exit 2
fi
if [[ ${PASSWORD} =~ [\'\"\\] ]]; then
  echo "Das Kennwort darf keine Anführungszeichen und keinen Backslash enthalten." >&2
  exit 2
fi

if [[ ${RETENTION_DAYS} -gt 0 ]]; then
  POLICY="homeess_${RETENTION_DAYS}d"
  DURATION="${RETENTION_DAYS}d"
else
  POLICY="homeess_forever"
  DURATION="INF"
fi

echo "==> InfluxDB installieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y influxdb influxdb-client

echo "==> Dienst starten"
systemctl enable --now influxdb

echo "==> Auf die HTTP-Schnittstelle warten"
for _ in $(seq 1 60); do
  if influx -port "${PORT}" -execute "SHOW DATABASES" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> Benutzer, Datenbank und Aufbewahrungsregel anlegen"
# IF NOT EXISTS gibt es in InfluxQL nur für CREATE DATABASE; die übrigen
# Anweisungen dürfen an einem bereits vorhandenen Objekt scheitern.
influx -port "${PORT}" -execute "CREATE USER \"${DB_USER}\" WITH PASSWORD '${PASSWORD}' WITH ALL PRIVILEGES" \
  || echo "    Benutzer besteht bereits – unverändert übernommen."
influx -port "${PORT}" -execute "CREATE DATABASE \"${DATABASE}\""
influx -port "${PORT}" -execute "CREATE RETENTION POLICY \"${POLICY}\" ON \"${DATABASE}\" DURATION ${DURATION} REPLICATION 1 DEFAULT" \
  || echo "    Aufbewahrungsregel besteht bereits – unverändert übernommen."

echo "==> Anmeldung verbindlich machen"
if grep -qE '^[[:space:]]*auth-enabled[[:space:]]*=[[:space:]]*true' "${CONFIG_FILE}"; then
  echo "    Bereits aktiv."
else
  cp -n "${CONFIG_FILE}" "${CONFIG_FILE}.homeess-backup" || true
  if grep -qE '^[[:space:]]*#?[[:space:]]*auth-enabled[[:space:]]*=[[:space:]]*false' "${CONFIG_FILE}"; then
    sed -i 's/^[[:space:]]*#\?[[:space:]]*auth-enabled[[:space:]]*=[[:space:]]*false.*/  auth-enabled = true/' "${CONFIG_FILE}"
  else
    sed -i '/^\[http\]/a\  auth-enabled = true' "${CONFIG_FILE}"
  fi
  systemctl restart influxdb
fi

echo
echo "Fertig. Datenbank \"${DATABASE}\" auf Port ${PORT}, Benutzer \"${DB_USER}\","
echo "Aufbewahrung ${DURATION}. Zurück in homeESS auf \"Verbindung prüfen\" klicken."
