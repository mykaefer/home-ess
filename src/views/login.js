'use strict';

const { escapeHtml, statusText } = require('./components');

// Login-Seite — eigenständige Hülle (vor der Anmeldung gibt es keine Sidebar).
// Die Nutzerauswahl erfolgt durch Klick auf einen Namen (nicht durch Tippen);
// danach folgt die Passworteingabe. „Passwort merken" hält die Sitzung 30 Tage
// und meldet den gewählten Nutzer beim nächsten Aufruf automatisch an.
// renderLogin({ users, error, remember, selectedUserId })
function renderLogin({ users = [], error = false, remember = false, selectedUserId = null } = {}) {
  const checked = remember ? ' checked' : '';
  const userTiles = users
    .map(
      (user) => `        <button type="button" class="login-user" data-id="${user.id}" data-name="${escapeHtml(user.name)}" onclick="selectUser(${user.id}, this.getAttribute('data-name'))">
          <span class="login-user-avatar" aria-hidden="true">${escapeHtml((user.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>
          <span class="login-user-name">${escapeHtml(user.name)}</span>
        </button>`
    )
    .join('\n');

  const emptyHint = users.length
    ? ''
    : '<p class="muted">Keine Benutzer vorhanden.</p>';

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login</title>
  <link rel="icon" href="/homeess-icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="page-login">
  <div class="login-card">
    <h2>Anmelden</h2>
    ${error ? statusText('Ungültiges Passwort') : ''}

    <div class="login-userlist" id="loginUserList">
      ${emptyHint}
${userTiles}
    </div>

    <form action="/login" method="POST" class="login-passform" id="loginPassForm" hidden>
      <div class="login-selected-user">
        <button type="button" class="login-back" onclick="backToUsers()" aria-label="Andere Anmeldung wählen">‹</button>
        <span class="login-user-avatar" id="loginSelectedAvatar" aria-hidden="true"></span>
        <span class="login-user-name" id="loginSelectedName"></span>
      </div>
      <input type="hidden" name="userId" id="loginUserId" value="">
      <input type="password" name="password" id="loginPassword" placeholder="Passwort" autocomplete="current-password">
      <label class="remember-row">
        <input type="checkbox" name="remember"${checked}>
        <span>Angemeldet bleiben</span>
      </label>
      <button type="submit">Anmelden</button>
    </form>
  </div>

  <script>
    function selectUser(id, name) {
      document.getElementById('loginUserList').hidden = true;
      var form = document.getElementById('loginPassForm');
      form.hidden = false;
      document.getElementById('loginUserId').value = id;
      document.getElementById('loginSelectedName').textContent = name;
      var avatar = document.getElementById('loginSelectedAvatar');
      avatar.textContent = (name || '?').trim().charAt(0).toUpperCase() || '?';
      document.getElementById('loginPassword').focus();
    }
    function backToUsers() {
      document.getElementById('loginPassForm').hidden = true;
      document.getElementById('loginUserList').hidden = false;
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginUserId').value = '';
    }
    // Nach einem Fehlversuch die zuvor gewählte Anmeldung wieder öffnen.
    (function () {
      var preselect = ${selectedUserId == null ? 'null' : Number(selectedUserId)};
      if (preselect == null) return;
      var tile = document.querySelector('.login-user[data-id="' + preselect + '"]');
      if (tile) selectUser(preselect, tile.getAttribute('data-name'));
    })();
  </script>
</body>
</html>`;
}

module.exports = renderLogin;
