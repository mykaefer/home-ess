'use strict';

// Netzwerktopologie: wer funkt über wen.
//
// Die Daten stammen aus den Nachbartabellen (ZDO LQI_TABLE_REQUEST) des
// Coordinators und aller Router. Jeder Eintrag nennt Gegenstelle, Beziehung,
// Tiefe im Netz und die Verbindungsqualität. Daraus entsteht der Graph, den die
// Karte zeichnet.
//
// Der Scan ist ausdrücklich nichts, was nebenbei läuft: Er erzeugt Funkverkehr
// auf jedem Router und dauert bei größeren Netzen Minuten. Er wird deshalb nur
// auf Anforderung ausgeführt, immer nur einmal gleichzeitig, und sein Ergebnis
// wird zwischengespeichert.

// Beziehung laut Zigbee-Spezifikation (Tabelle 3.62).
const RELATIONSHIPS = {
  0: 'parent',
  1: 'child',
  2: 'sibling',
  3: 'none',
  4: 'previous-child',
};

const RELATIONSHIP_LABELS = {
  parent: 'Elternknoten',
  child: 'Kindknoten',
  sibling: 'Nachbar',
  none: 'keine',
  'previous-child': 'früheres Kind',
  unknown: 'unbekannt',
};

// Gerätetyp laut Zigbee-Spezifikation.
const NEIGHBOR_TYPES = { 0: 'Coordinator', 1: 'Router', 2: 'EndDevice', 3: 'Unknown' };

// LQI ist ein Rohwert von 0 bis 255. Für die Darstellung zählt die Einordnung,
// nicht die Zahl: Unterhalb von etwa 50 wird eine Verbindung unzuverlässig.
const QUALITY_STEPS = [
  { min: 192, key: 'excellent', label: 'sehr gut' },
  { min: 128, key: 'good', label: 'gut' },
  { min: 64, key: 'fair', label: 'ausreichend' },
  { min: 0, key: 'poor', label: 'schwach' },
];

function qualityFor(lqi) {
  // Ein fehlender Wert ist nicht dasselbe wie ein schlechter Wert: `Number(null)`
  // wäre 0 und damit fälschlich „schwach".
  if (lqi === null || lqi === undefined || lqi === '') {
    return { key: 'unknown', label: 'unbekannt', ratio: 0, lqi: null };
  }
  const value = Number(lqi);
  if (!Number.isFinite(value)) return { key: 'unknown', label: 'unbekannt', ratio: 0, lqi: null };
  const clamped = Math.max(0, Math.min(255, value));
  const step = QUALITY_STEPS.find((entry) => clamped >= entry.min) || QUALITY_STEPS[QUALITY_STEPS.length - 1];
  return { key: step.key, label: step.label, ratio: clamped / 255, lqi: clamped };
}

function normalizeAddress(value) {
  return String(value == null ? '' : value).replace(/^0x/i, '').toLowerCase();
}

/**
 * Fragt die Nachbartabelle eines Gerätes ab.
 * Antwortet es nicht, ist das kein Fehler des Adapters — schlafende oder
 * schlecht erreichbare Knoten sind der Normalfall.
 */
async function readNeighbours(zhDevice) {
  const table = await zhDevice.lqi();
  return (table || []).map((entry) => ({
    address: normalizeAddress(entry.eui64),
    networkAddress: Number(entry.nwkAddress),
    deviceType: NEIGHBOR_TYPES[entry.deviceType] || 'Unknown',
    relationship: RELATIONSHIPS[entry.relationship] || 'unknown',
    depth: Number(entry.depth),
    lqi: Number(entry.lqi),
  }));
}

/**
 * Führt einen vollständigen Scan durch.
 *
 * Abgefragt werden nur Coordinator und Router: Endgeräte führen keine
 * Nachbartabelle, und batteriebetriebene Geräte würden durch die Abfrage
 * lediglich geweckt.
 *
 * @param {object} options
 * @param {Array}  options.nodes     abzufragende Knoten `{ address, zh, ... }`
 * @param {function} options.onProgress Fortschrittsmeldung
 */
async function scanTopology({ nodes, onProgress, onWarning }) {
  const edges = new Map();
  const scanned = [];
  const unreachable = [];
  const depths = new Map();

  const addEdge = (from, to, entry) => {
    // Eine Funkstrecke wird von beiden Enden gemeldet. Beide Richtungen werden
    // zu einer Kante zusammengefasst und die jeweils bessere Qualität behalten —
    // maßgeblich ist, ob die Strecke trägt.
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const existing = edges.get(key);
    if (existing) {
      existing.reports += 1;
      if (entry.lqi > existing.lqi) existing.lqi = entry.lqi;
      existing.lqiMin = Math.min(existing.lqiMin, entry.lqi);
      // Eine Eltern-Kind-Beziehung ist die verlässlichere Aussage über die
      // tatsächliche Route und hat deshalb Vorrang vor „Nachbar".
      if (entry.relationship === 'parent' || entry.relationship === 'child') {
        existing.relationship = 'parent-child';
        if (entry.relationship === 'parent') existing.parent = to;
        else existing.parent = from;
      }
      return;
    }
    edges.set(key, {
      key,
      source: from,
      target: to,
      lqi: entry.lqi,
      lqiMin: entry.lqi,
      reports: 1,
      relationship: entry.relationship === 'parent' ? 'parent-child'
        : (entry.relationship === 'child' ? 'parent-child' : entry.relationship),
      parent: entry.relationship === 'parent' ? to : (entry.relationship === 'child' ? from : null),
    });
  };

  let index = 0;
  for (const node of nodes) {
    index += 1;
    if (typeof onProgress === 'function') {
      onProgress({ current: index, total: nodes.length, address: node.address, name: node.name });
    }
    try {
      const neighbours = await readNeighbours(node.zh);
      scanned.push(node.address);
      for (const neighbour of neighbours) {
        if (!neighbour.address || neighbour.address === node.address) continue;
        if (Number.isFinite(neighbour.depth) && neighbour.depth < 0xff) {
          const known = depths.get(neighbour.address);
          if (known == null || neighbour.depth < known) depths.set(neighbour.address, neighbour.depth);
        }
        addEdge(node.address, neighbour.address, neighbour);
      }
    } catch (error) {
      unreachable.push(node.address);
      if (typeof onWarning === 'function') {
        onWarning(node, error && error.message ? error.message : String(error));
      }
    }
  }

  return {
    edges: Array.from(edges.values()).map((edge) => ({
      ...edge,
      quality: qualityFor(edge.lqi),
    })),
    scanned,
    unreachable,
    depths,
  };
}

/**
 * Ordnet die Kanten den bekannten Geräten zu und verwirft alles, was zu keinem
 * dargestellten Knoten gehört. Ein Nachbar, den homeESS nicht kennt, würde als
 * Knoten ohne Bezeichnung in der Karte hängen.
 */
function buildGraph({ nodes, scan }) {
  const known = new Set(nodes.map((node) => node.address));
  const edges = scan.edges.filter((edge) => known.has(edge.source) && known.has(edge.target));
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  return {
    nodes: nodes.map((node) => ({
      ...node,
      depth: scan.depths.has(node.address) ? scan.depths.get(node.address) : null,
      links: degree.get(node.address) || 0,
    })),
    edges,
    scanned: scan.scanned,
    unreachable: scan.unreachable,
    // Ein Knoten ohne jede Kante ist erreichbar, aber seine Route ist unbekannt —
    // das ist eine andere Aussage als „nicht erreichbar" und wird getrennt
    // ausgewiesen, statt eine Verbindung zu erfinden.
    isolated: nodes.filter((node) => !degree.get(node.address)).map((node) => node.address),
  };
}

module.exports = {
  RELATIONSHIPS,
  RELATIONSHIP_LABELS,
  NEIGHBOR_TYPES,
  QUALITY_STEPS,
  qualityFor,
  normalizeAddress,
  readNeighbours,
  scanTopology,
  buildGraph,
};
