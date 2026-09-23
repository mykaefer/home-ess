'use strict';

// Zweige, aus denen homeESS aktualisiert werden darf.
//
// `main` trägt den veröffentlichten Stand, `development` den kommenden. Beide
// führen in ihrer VERSION.json eine eigene Nummer. Die Liste ist bewusst fest
// verdrahtet: Browserdaten dürfen niemals bestimmen, aus welchem Repository
// oder Zweig installiert wird (SSRF/Supply-Chain).

const fs = require('fs');
const path = require('path');

const BRANCHES = Object.freeze(['main', 'development']);
const DEFAULT_BRANCH = 'main';

const BRANCH_LABELS = Object.freeze({
  main: 'Stabil (main)',
  development: 'Entwicklung (development)',
});

const REPOSITORY = 'mykaefer/home-ess';
const RAW_BASE_URL = 'https://raw.githubusercontent.com';
const REPOSITORY_WEB_URL = `https://github.com/${REPOSITORY}`;

function isBranch(value) {
  return BRANCHES.includes(String(value || ''));
}

function normalizeBranch(value) {
  const branch = String(value == null ? '' : value).trim().toLowerCase();
  return isBranch(branch) ? branch : DEFAULT_BRANCH;
}

// Adresse der maßgeblichen VERSION.json eines Zweigs. Der Zweig wird vorher auf
// die feste Liste normalisiert – es kann keine fremde URL entstehen.
function versionFileUrl(branch) {
  return `${RAW_BASE_URL}/${REPOSITORY}/${normalizeBranch(branch)}/VERSION.json`;
}

// Anzeigeziel für „Was ist dort neu?" – der Zweig im Web.
function branchWebUrl(branch) {
  return `${REPOSITORY_WEB_URL}/tree/${normalizeBranch(branch)}`;
}

// Zweig der laufenden Installation. Installer und Self-Updater klonen jeweils
// mit `--branch`, weshalb `.git/HEAD` den Zweig verlässlich benennt. Fehlt die
// Angabe (entpacktes Archiv), gilt der stabile Zweig.
function installedBranch(rootDir = path.join(__dirname, '..', '..')) {
  try {
    const head = fs.readFileSync(path.join(rootDir, '.git', 'HEAD'), 'utf8');
    const match = /ref:\s*refs\/heads\/(\S+)/.exec(head);
    if (match && isBranch(match[1])) return match[1];
  } catch (_) { /* Rückfall auf den stabilen Zweig */ }
  return DEFAULT_BRANCH;
}

module.exports = {
  BRANCHES, DEFAULT_BRANCH, BRANCH_LABELS, REPOSITORY, REPOSITORY_WEB_URL,
  isBranch, normalizeBranch, versionFileUrl, branchWebUrl, installedBranch,
};
