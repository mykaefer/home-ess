#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/mykaefer/home-ess.git"

readonly APP_NAME="home-ess"
readonly APP_USER="homeess"
readonly APP_GROUP="homeess"
readonly INSTALL_DIR="/opt/home-ess"
readonly DATA_DIR="/var/lib/home-ess"
readonly DB_PATH="${DATA_DIR}/app.db"
readonly SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
readonly MIN_NODE_MAJOR=20
readonly MIN_NODE_MINOR=17

info() {
  printf '\n\033[1;34m[homeESS]\033[0m %s\n' "$*"
}

fail() {
  printf '\n\033[1;31m[homeESS] Fehler:\033[0m %s\n' "$*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  local line_number=$1
  printf '\n\033[1;31m[homeESS] Installation in Zeile %s fehlgeschlagen (Code %s).\033[0m\n' \
    "${line_number}" "${exit_code}" >&2
  exit "${exit_code}"
}

trap 'on_error ${LINENO}' ERR

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    fail "Bitte als root ausführen, z. B.: curl -fsSL <URL> | sudo bash"
  fi
}

check_platform() {
  [[ -r /etc/os-release ]] || fail "Linux-Distribution konnte nicht erkannt werden."
  # shellcheck disable=SC1091
  . /etc/os-release

  case "${ID:-}" in
    debian|ubuntu|raspbian) ;;
    *)
      if [[ " ${ID_LIKE:-} " != *" debian "* ]]; then
        fail "Unterstützt werden Debian, Ubuntu, Raspberry Pi OS und Debian-basierte Systeme."
      fi
      ;;
  esac

  command -v systemctl >/dev/null 2>&1 || fail "systemd wird auf diesem System benötigt."
  command -v apt-get >/dev/null 2>&1 || fail "apt-get wurde nicht gefunden."
}

check_installation_target() {
  [[ ! -e ${INSTALL_DIR} ]] || \
    fail "${INSTALL_DIR} existiert bereits. Vorhandene Installationen werden nicht überschrieben."
  [[ ! -e ${DB_PATH} ]] || \
    fail "${DB_PATH} existiert bereits. Vorhandene Einstellungen werden nicht überschrieben."
}

install_base_packages() {
  info "Installiere Systempakete"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    build-essential \
    python3
}

node_is_compatible() {
  [[ -x /usr/bin/node ]] || return 1

  local version major minor
  version="$(/usr/bin/node --version)"
  version="${version#v}"
  major="${version%%.*}"
  version="${version#*.}"
  minor="${version%%.*}"

  [[ ${major} -gt ${MIN_NODE_MAJOR} ]] || \
    [[ ${major} -eq ${MIN_NODE_MAJOR} && ${minor} -ge ${MIN_NODE_MINOR} ]]
}

install_nodejs() {
  if node_is_compatible; then
    info "Node.js $(/usr/bin/node --version) ist bereits geeignet"
    return
  fi

  info "Installiere Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
  node_is_compatible || fail "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} konnte nicht installiert werden."
}

create_service_account() {
  info "Richte Systembenutzer und Datenverzeichnis ein"
  if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id "${APP_USER}" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "${APP_GROUP}" \
      --home-dir "${DATA_DIR}" \
      --shell /usr/sbin/nologin \
      "${APP_USER}"
  fi

  install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}"
}

clone_application() {
  info "Lade homeESS von GitHub"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 "${REPOSITORY_URL}" "${INSTALL_DIR}"
  rm -rf "${INSTALL_DIR}/test"
  chown -R root:root "${INSTALL_DIR}"
  chmod -R u=rwX,go=rX "${INSTALL_DIR}"
}

install_dependencies() {
  info "Installiere Node.js-Abhängigkeiten"
  cd "${INSTALL_DIR}"
  npm ci --omit=dev --no-audit --no-fund
}

create_database() {
  info "Initialisiere eine neue, leere Datenbank"
  install -m 0640 -o "${APP_USER}" -g "${APP_GROUP}" /dev/null "${DB_PATH}"
}

install_systemd_service() {
  info "Richte systemd-Autostart ein"
  cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=homeESS Energy Storage System
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOME_ESS_DB=${DB_PATH}
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}.service"
}

verify_installation() {
  info "Prüfe Installation"
  if ! systemctl is-active --quiet "${APP_NAME}.service"; then
    systemctl status "${APP_NAME}.service" --no-pager || true
    fail "Der homeESS-Dienst konnte nicht gestartet werden."
  fi

  local address
  address="$(hostname -I 2>/dev/null | awk '{print $1}')"
  address="${address:-localhost}"

  printf '\n\033[1;32mhomeESS wurde erfolgreich installiert.\033[0m\n'
  printf 'Weboberfläche: http://%s:3000\n' "${address}"
  printf 'Erster Login: admin\n'
  printf 'Dienststatus: systemctl status %s\n\n' "${APP_NAME}"
}

main() {
  require_root
  check_platform
  check_installation_target
  install_base_packages
  install_nodejs
  create_service_account
  clone_application
  install_dependencies
  create_database
  install_systemd_service
  verify_installation
}

main "$@"
