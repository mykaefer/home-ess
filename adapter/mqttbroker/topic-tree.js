'use strict';

// Baumdarstellungen für den Topic-Browser der Verwaltungsseite. Zwei Sichten auf
// dieselbe Topic-Liste:
//
//   buildTopicTree  – gliedert nach dem MQTT-Pfad (jeder Abschnitt eine Ebene).
//   buildStateTree  – gliedert wie der homeESS-States-Baum: Kategoriepfad des
//                     States als Ebenen, Klarname als Blatt.
//
// In beiden Sichten trägt jedes Blatt den vollständigen MQTT-Pfad — das ist die
// Adresse, die der Kopierknopf übergibt.

const CATEGORY_SEPARATOR = /\s*\/\s*/;
const DEFAULT_CATEGORY = 'Allgemein';

function createNode(name, path, folder) {
  return { name, path, folder: !!folder, children: [], entry: null, count: 0 };
}

function compareNodes(a, b) {
  // Verzeichnisse zuerst, danach alphabetisch — das hält lange Listen lesbar.
  if (a.folder !== b.folder) return a.folder ? -1 : 1;
  return a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
}

// Blätter je Teilbaum zählen und Kinder sortieren. Liefert die Anzahl der
// States unterhalb (inklusive des Knotens selbst). Ein Verzeichnis bleibt auch
// ohne Inhalt eines — sonst sähe ein noch leerer Bereich wie ein State aus.
function finalize(node) {
  let count = node.entry ? 1 : 0;
  for (const child of node.children) count += finalize(child);
  node.children.sort(compareNodes);
  node.folder = node.folder || node.children.length > 0;
  node.count = count;
  return count;
}

// Kategoriepfad eines States in seine Ebenen zerlegen — dieselbe Regel wie im
// States-Baum von homeESS („System / Geräte", „Zuhause/EG-Zaehler").
function categoryLevels(category) {
  const parts = String(category == null ? '' : category)
    .split(CATEGORY_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [DEFAULT_CATEGORY];
}

function lastLevel(topic) {
  const levels = String(topic || '').split('/').filter(Boolean);
  return levels.length ? levels[levels.length - 1] : String(topic || '');
}

// Sicht 1: Gliederung nach dem MQTT-Pfad. Ein Knoten kann gleichzeitig Blatt
// und Verzeichnis sein — veröffentlicht ein Gerät auf `haus/temp` und auf
// `haus/temp/roh`, trägt die Ebene `temp` einen eigenen Wert *und* eine
// Unterebene. Doppelte Topics behält der erste Eintrag.
function buildTopicTree(entries) {
  const root = createNode('', '');
  const index = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const topic = String((row && row.topic) || '');
    if (!topic) continue;
    const levels = topic.split('/');
    let parent = root;
    let path = '';
    for (let i = 0; i < levels.length; i += 1) {
      path = i === 0 ? levels[i] : `${path}/${levels[i]}`;
      let node = index.get(path);
      if (!node) {
        node = createNode(levels[i], path);
        index.set(path, node);
        parent.children.push(node);
      }
      parent = node;
    }
    if (!parent.entry) parent.entry = { ...row, topic };
  }
  finalize(root);
  return root;
}

// Sicht 2: Gliederung wie der States-Baum. Die Verzeichnisse sind Kategorien und
// haben deshalb keinen MQTT-Pfad; jeder State ist ein Blatt mit seinem Klarnamen
// und dem vollständigen Topic.
//
// `options.folders` legt Kategoriepfade an, die auch ohne States im Baum stehen
// sollen — etwa der Bereich, in dem MQTT-Clients erst noch Topics anlegen.
function buildStateTree(entries, options = {}) {
  const root = createNode('', '', true);
  const index = new Map();

  const folderFor = (category) => {
    let parent = root;
    let key = '';
    for (const level of categoryLevels(category)) {
      key = key ? `${key} / ${level}` : level;
      let node = index.get(key);
      if (!node) {
        node = createNode(level, '', true);
        index.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    return parent;
  };

  for (const category of Array.isArray(options.folders) ? options.folders : []) {
    if (String(category || '').trim()) folderFor(category);
  }
  for (const row of Array.isArray(entries) ? entries : []) {
    const topic = String((row && row.topic) || '');
    if (!topic) continue;
    const leaf = createNode(String(row.name || lastLevel(topic)), topic, false);
    leaf.entry = { ...row, topic };
    folderFor(row.category).children.push(leaf);
  }
  finalize(root);
  return root;
}

module.exports = { buildTopicTree, buildStateTree, categoryLevels };
