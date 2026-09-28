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
readonly UPDATE_SERVICE_FILE="/etc/systemd/system/${APP_NAME}-update.service"
readonly UPDATE_PATH_FILE="/etc/systemd/system/${APP_NAME}-update.path"
readonly UPDATE_HELPER_DIR="/usr/local/lib/${APP_NAME}"
readonly UPDATE_HELPER_FILE="${UPDATE_HELPER_DIR}/self-update.js"
readonly LEGACY_SERVICE_FILE="/etc/systemd/system/server.service"
readonly LEGACY_DATA_DIR="${INSTALL_DIR}/data"
readonly ADAPTER_SELECTION_FILE="${DATA_DIR}/adapter-selection.json"
readonly MIN_NODE_MAJOR=20
readonly MIN_NODE_MINOR=17
readonly PIPER_DIR="/opt/home-ess-tts"
readonly PIPER_VERSION="1.8.0"
readonly PIPER_VOICE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/375a0fe641dea077c2a47b4e9a056d6da521eed3/de/de_DE/thorsten/high"
INSTALL_MODE="install"
RESTORE_ALL_ADAPTERS=0
ADAPTER_BACKUP_DIR=""
# Zweig, aus dem installiert wird. `main` trägt den veröffentlichten Stand,
# `development` den kommenden. Beide führen in ihrer VERSION.json eine eigene
# Versionsnummer. install-dev.sh ruft dieses Skript mit --branch development auf.
readonly DEFAULT_BRANCH="main"
BRANCH="${DEFAULT_BRANCH}"
BRANCH_EXPLICIT=0

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
  local failed_command=${2:-unbekannt}
  printf '\n\033[1;31m[homeESS] Installation in Zeile %s fehlgeschlagen (Code %s).\033[0m\n' \
    "${line_number}" "${exit_code}" >&2
  printf '[homeESS] Fehlgeschlagener Befehl: %s\n' "${failed_command}" >&2
  restore_adapter_backup
  exit "${exit_code}"
}

trap 'on_error "${LINENO}" "${BASH_COMMAND}"' ERR

# Nur Zweige dieses Repositorys sind zulässig; ein freier Wert könnte sonst in
# die git-Aufrufe gelangen.
validate_branch() {
  case "${1}" in
    main|development) return 0 ;;
    *) fail "Unbekannter Zweig: ${1}. Zulässig sind main und development." ;;
  esac
}

set_branch() {
  validate_branch "${1}"
  BRANCH="${1}"
  BRANCH_EXPLICIT=1
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "${1}" in
      --all) RESTORE_ALL_ADAPTERS=1 ;;
      --branch=*) set_branch "${1#--branch=}" ;;
      --branch)
        [[ $# -ge 2 ]] || fail "--branch erwartet einen Zweignamen (main oder development)."
        set_branch "${2}"
        shift
        ;;
      *) fail "Unbekannte Option: ${1}. Unterstützt werden --all und --branch <main|development>."
    esac
    shift
  done
}

# Beim Update ohne ausdrückliche Angabe bleibt der Zweig erhalten, der bereits
# installiert ist: ein Update darf niemanden unbemerkt von development auf main
# (oder umgekehrt) ziehen.
adopt_existing_branch() {
  [[ ${BRANCH_EXPLICIT} -eq 0 ]] || return 0
  local current
  current="$(git -C "${INSTALL_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  case "${current}" in
    main|development) BRANCH="${current}" ;;
  esac
}

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
  if [[ -d ${INSTALL_DIR}/.git ]]; then
    INSTALL_MODE="update"
    info "Bestehende homeESS-Installation gefunden – Update-Modus"
    return
  fi

  if [[ -e ${INSTALL_DIR} ]]; then
    fail "${INSTALL_DIR} existiert bereits, ist aber kein Git-Checkout. Bitte manuell sichern/prüfen."
  fi

  if [[ -e ${DB_PATH} ]]; then
    info "Bestehende Datenbank gefunden – sie wird weiterverwendet"
  fi
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
    python3 \
    python3-venv
}

install_piper_file() (
  # Download zunächst separat prüfen; ein Abbruch erhält die bestehende Datei.
  local filename="$1" checksum="$2" target temporary
  target="${PIPER_DIR}/voices/${filename}"
  if [[ -f ${target} ]] && printf '%s  %s\n' "${checksum}" "${target}" | sha256sum --check --status; then
    return 0
  fi
  temporary="$(mktemp "${PIPER_DIR}/voices/.download.XXXXXXXX")"
  trap 'rm -f -- "${temporary}"' EXIT
  curl -fLsS --retry 3 --connect-timeout 20 --max-time 600 "${PIPER_VOICE_URL}/${filename}" -o "${temporary}"
  printf '%s  %s\n' "${checksum}" "${temporary}" | sha256sum --check --status \
    || fail "Prüfsumme der Piper-Datei ${filename} stimmt nicht."
  chmod 0644 "${temporary}"
  mv -f -- "${temporary}" "${target}"
)

install_piper() {
  info "Installiere lokale Piper-Sprachausgabe mit Thorsten High"
  # Eigene Python-Umgebung außerhalb des Checkouts, für den Dienst nur lesbar.
  install -d -m 0755 "${PIPER_DIR}" "${PIPER_DIR}/voices"
  python3 -m venv "${PIPER_DIR}/venv"
  "${PIPER_DIR}/venv/bin/python3" -m pip install --disable-pip-version-check "piper-tts==${PIPER_VERSION}"
  install_piper_file de_DE-thorsten-high.onnx 9df1c43c61149ef9b39e618e2b861fbe41e1fcea9390b2dac62e8761573ea4f1
  install_piper_file de_DE-thorsten-high.onnx.json 6de734444e4c3f9e33b7ebe2746dbc19b71e85f613e79c65acf623200b99a76a
  install_piper_file MODEL_CARD 35cd458c7691a668ec59c63eec3ccad5c7ce7ed36c9f946766616b266a038d57
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

is_legacy_homeess_service_file() {
  local service_file="${1:-${LEGACY_SERVICE_FILE}}"
  [[ -f ${service_file} && ! -L ${service_file} ]] || return 1
  grep -Fqx "ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js" "${service_file}"
}

# Sehr frühe Installationen verwendeten die generische server.service. Nur eine
# Unit, deren ExecStart eindeutig auf diese homeESS-Installation zeigt, darf
# automatisch entfernt werden; eine fremde gleichnamige Unit bleibt unberührt.
remove_legacy_homeess_service() {
  [[ -e ${LEGACY_SERVICE_FILE} || -L ${LEGACY_SERVICE_FILE} ]] || return 0
  if ! is_legacy_homeess_service_file "${LEGACY_SERVICE_FILE}"; then
    info "Vorhandene server.service gehört nicht eindeutig zu homeESS – bleibt unverändert"
    return
  fi

  info "Entferne veraltete homeESS-Unit server.service"
  systemctl stop server.service || true
  systemctl disable server.service || true
  rm -f -- "${LEGACY_SERVICE_FILE}"
  systemctl daemon-reload
}

stop_service_for_update() {
  if [[ ${INSTALL_MODE} != "update" ]]; then
    return
  fi

  if systemctl list-unit-files "${APP_NAME}.service" >/dev/null 2>&1; then
    info "Stoppe laufenden homeESS-Dienst für das Update"
    systemctl stop "${APP_NAME}.service" || true
  fi
}

clone_application() {
  info "Lade homeESS von GitHub (Zweig ${BRANCH})"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "${BRANCH}" "${REPOSITORY_URL}" "${INSTALL_DIR}"
  reconcile_adapter_selection
  rm -rf "${INSTALL_DIR}/test"
  set_application_permissions
}

backup_adapter_directory() {
  ADAPTER_BACKUP_DIR="$(mktemp -d /opt/.home-ess-adapters.XXXXXXXX)"
  if [[ -d ${INSTALL_DIR}/adapter && ! -L ${INSTALL_DIR}/adapter ]]; then
    mv -- "${INSTALL_DIR}/adapter" "${ADAPTER_BACKUP_DIR}/adapter"
  else
    install -d -m 0755 "${ADAPTER_BACKUP_DIR}/adapter"
  fi
}

restore_adapter_backup() {
  [[ -n ${ADAPTER_BACKUP_DIR} && -d ${ADAPTER_BACKUP_DIR}/adapter && -d ${INSTALL_DIR} ]] || return 0
  rm -rf -- "${INSTALL_DIR}/adapter"
  mv -- "${ADAPTER_BACKUP_DIR}/adapter" "${INSTALL_DIR}/adapter"
  rmdir -- "${ADAPTER_BACKUP_DIR}" 2>/dev/null || true
  ADAPTER_BACKUP_DIR=""
}

cleanup_adapter_backup() {
  [[ -n ${ADAPTER_BACKUP_DIR} && -d ${ADAPTER_BACKUP_DIR} ]] || return 0
  rm -rf -- "${ADAPTER_BACKUP_DIR}"
  ADAPTER_BACKUP_DIR=""
}

reconcile_adapter_selection() {
  local previous="-"
  if [[ -n ${ADAPTER_BACKUP_DIR} ]]; then
    previous="${ADAPTER_BACKUP_DIR}/adapter"
  fi
  /usr/bin/node "${INSTALL_DIR}/src/adapters/selection-policy.js" \
    reconcile "${previous}" "${INSTALL_DIR}/adapter" "${ADAPTER_SELECTION_FILE}" "${RESTORE_ALL_ADAPTERS}"
}

# Anwendungscode gehört root und ist nur lesbar. Ein vorhandener alter
# data/-Bestand wird bewusst ausgespart: insbesondere private Instanzschlüssel
# dürfen durch ein Update niemals auf 0644 aufgeweitet werden.
set_application_permissions() {
  find "${INSTALL_DIR}" -path "${LEGACY_DATA_DIR}" -prune -o -exec chown root:root {} +
  find "${INSTALL_DIR}" -path "${LEGACY_DATA_DIR}" -prune -o -exec chmod u=rwX,go=rX {} +
  # Nur die Wurzel darf der Webprozess um neue, zuvor geprüfte Adapterordner
  # ergänzen. Mitgelieferter Anwendungscode bleibt root-owned und read-only.
  install -d -m 2775 -o root -g "${APP_GROUP}" "${INSTALL_DIR}/adapter"
}

update_application() {
  adopt_existing_branch
  info "Aktualisiere homeESS aus GitHub (Zweig ${BRANCH})"
  cd "${INSTALL_DIR}"

  local remote_url
  remote_url="$(git config --get remote.origin.url || true)"
  if [[ -z ${remote_url} ]]; then
    git remote add origin "${REPOSITORY_URL}"
  elif [[ ${remote_url} != "${REPOSITORY_URL}" ]]; then
    info "Setze Git-Remote origin auf ${REPOSITORY_URL}"
    git remote set-url origin "${REPOSITORY_URL}"
  fi

  GIT_TERMINAL_PROMPT=0 git fetch --depth 1 origin "${BRANCH}"
  backup_adapter_directory
  git checkout -B "${BRANCH}" FETCH_HEAD
  git reset --hard FETCH_HEAD
  reconcile_adapter_selection
  rm -rf "${INSTALL_DIR}/test"
  set_application_permissions
}

install_or_update_application() {
  if [[ ${INSTALL_MODE} == "update" ]]; then
    update_application
  else
    clone_application
  fi
}

install_dependencies() {
  info "Installiere Node.js-Abhängigkeiten"
  cd "${INSTALL_DIR}"
  npm ci --omit=dev --no-audit --no-fund
}

create_database() {
  migrate_legacy_data

  if [[ -e ${DB_PATH} ]]; then
    info "Bestehende Datenbank bleibt erhalten"
    chown "${APP_USER}:${APP_GROUP}" "${DB_PATH}"
    chmod 0640 "${DB_PATH}"
    return
  fi

  info "Initialisiere eine neue, leere Datenbank"
  install -m 0640 -o "${APP_USER}" -g "${APP_GROUP}" /dev/null "${DB_PATH}"
}

install_self_updater() {
  info "Richte sicheren Self-Updater ein"
  install -d -m 0750 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/update"
  install -d -m 0755 -o root -g root "${UPDATE_HELPER_DIR}"
  install -m 0755 -o root -g root "${INSTALL_DIR}/updater/self-update.js" "${UPDATE_HELPER_FILE}"
  install -m 0644 -o root -g root "${INSTALL_DIR}/updater/home-ess-update.service" "${UPDATE_SERVICE_FILE}"
  install -m 0644 -o root -g root "${INSTALL_DIR}/updater/home-ess-update.path" "${UPDATE_PATH_FILE}"
  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}-update.path"
}

# Der alte Standardpfad lag im Git-Checkout. Neben SQLite gehören auch die
# dauerhafte Instanzidentität, Adapterdaten und Laufzeitprotokolle zum Bestand.
# Migriert wird deshalb der komplette data/-Inhalt, aber ausschließlich wenn am
# neuen Ort noch keine Datenbank und auch sonst keine Daten liegen. So wird nie
# ein bestehender Zielbestand vermischt oder überschrieben.
migrate_legacy_data() {
  [[ ! -e ${DB_PATH} ]] || return 0
  [[ -f ${LEGACY_DATA_DIR}/app.db && ! -L ${LEGACY_DATA_DIR}/app.db ]] || return 0

  if find "${DATA_DIR}" -mindepth 1 -print -quit | grep -q .; then
    fail "${DATA_DIR} enthält bereits Daten, aber keine app.db. Altbestand aus ${LEGACY_DATA_DIR} wurde nicht automatisch eingemischt."
  fi

  info "Migriere bestehenden Datenbestand nach ${DATA_DIR}"
  cp -a -- "${LEGACY_DATA_DIR}/." "${DATA_DIR}/"
  chown -R "${APP_USER}:${APP_GROUP}" "${DATA_DIR}"
  chmod 0750 "${DATA_DIR}"
  chmod 0640 "${DB_PATH}"
  if [[ -d ${DATA_DIR}/identity ]]; then
    find "${DATA_DIR}/identity" -type d -exec chmod 0700 {} +
    find "${DATA_DIR}/identity" -type f -exec chmod 0600 {} +
  fi
  info "Der alte Datenbestand bleibt als Sicherung unter ${LEGACY_DATA_DIR} erhalten"
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
Environment=HOME_ESS_DATA_DIR=${DATA_DIR}
Environment=HOME_ESS_DB=${DB_PATH}
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=on-failure
RestartSec=5
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}/adapter

[Install]
WantedBy=multi-user.target
EOF

  chmod 0644 "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  if [[ ${INSTALL_MODE} == "update" ]]; then
    systemctl restart "${APP_NAME}.service"
  else
    systemctl start "${APP_NAME}.service"
  fi
}

# Versionsnummer der Installation. Maßgeblich ist VERSION.json
# ({ "version": "1.7.3" }); fehlt sie (sehr alter Stand) oder trägt sie keine
# gültige Nummer, gilt die Angabe aus package.json. Beide Dateien sind JSON und
# werden mit dem ohnehin installierten Node.js gelesen, nicht mit Textmustern.
installed_version() {
  local dir="${1:-${INSTALL_DIR}}"
  local version=""
  local file
  for file in VERSION.json package.json; do
    [[ -r ${dir}/${file} ]] || continue
    version="$(/usr/bin/node -e 'const p = require("path"); process.stdout.write(String(require(p.resolve(process.argv[1])).version || ""))' "${dir}/${file}" 2>/dev/null || true)"
    if [[ ${version} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      break
    fi
    version=""
  done
  printf '%s' "${version:-unbekannt}"
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

  if [[ ${INSTALL_MODE} == "update" ]]; then
    printf '\n\033[1;32mhomeESS wurde erfolgreich aktualisiert.\033[0m\n'
  else
    printf '\n\033[1;32mhomeESS wurde erfolgreich installiert.\033[0m\n'
  fi
  printf 'Zweig: %s (Version %s)\n' "${BRANCH}" "$(installed_version)"
  printf 'Weboberfläche: http://%s:3000\n' "${address}"
  if [[ ${INSTALL_MODE} != "update" ]]; then
    printf 'Erster Login: admin\n'
  fi
  printf 'Dienststatus: systemctl status %s\n\n' "${APP_NAME}"
}

main() {
  parse_arguments "$@"
  require_root
  check_platform
  check_installation_target
  install_base_packages
  install_piper
  install_nodejs
  create_service_account
  remove_legacy_homeess_service
  stop_service_for_update
  install_or_update_application
  install_dependencies
  create_database
  install_self_updater
  install_systemd_service
  verify_installation
  cleanup_adapter_backup
}

# Bei `curl ... | bash` ist BASH_SOURCE leer bzw. nicht gesetzt. Der Fallback
# auf $0 startet main() bei dieser Installationsart weiterhin, bleibt beim
# Sourcen der Datei (Tests/Wiederverwendung) aber nebenwirkungsfrei.
if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
