#!/usr/bin/env bash
set -Eeuo pipefail

# Installer für den Entwicklungszweig.
#
# homeESS wird hier aus `development` installiert statt aus `main`. Beide Zweige
# führen in ihrer VERSION.json eine eigene Versionsnummer; die Updateprüfung der
# Weboberfläche folgt anschließend dem Zweig, aus dem installiert wurde (in den
# Einstellungen umstellbar).
#
# Bewusst keine zweite Installationslogik: dieses Skript lädt den regulären
# Installer desselben Zweigs und ruft ihn mit `--branch development` auf. Alles
# Weitere (Dienstkonto, systemd-Units, Adapterauswahl, Self-Updater) bleibt damit
# an genau einer Stelle gepflegt.

readonly BRANCH="development"
readonly INSTALLER_URL="https://raw.githubusercontent.com/mykaefer/home-ess/${BRANCH}/install.sh"

info() {
  printf '\n\033[1;34m[homeESS]\033[0m %s\n' "$*"
}

fail() {
  printf '\n\033[1;31m[homeESS] Fehler:\033[0m %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    fail "Bitte als root ausführen, z. B.: curl -fsSL <URL> | sudo bash"
  fi
}

require_curl() {
  command -v curl >/dev/null 2>&1 || fail "curl wird benötigt: apt update && apt install -y curl"
}

main() {
  require_root
  require_curl
  info "Installiere homeESS aus dem Entwicklungszweig (${BRANCH})"
  printf '[homeESS] Hinweis: Der Entwicklungszweig kann unfertige Stände enthalten.\n'

  local installer
  installer="$(mktemp /tmp/home-ess-install.XXXXXXXX.sh)"
  # shellcheck disable=SC2064
  trap "rm -f -- '${installer}'" EXIT
  curl -fsSL "${INSTALLER_URL}" -o "${installer}" \
    || fail "Der Installer konnte nicht von GitHub geladen werden (${INSTALLER_URL})."
  [[ -s ${installer} ]] || fail "Der geladene Installer ist leer."

  bash "${installer}" --branch "${BRANCH}" "$@"
}

# Bei `curl ... | bash` ist BASH_SOURCE leer bzw. nicht gesetzt. Der Fallback
# auf $0 startet main() bei dieser Installationsart weiterhin, bleibt beim
# Sourcen der Datei (Tests/Wiederverwendung) aber nebenwirkungsfrei.
if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
