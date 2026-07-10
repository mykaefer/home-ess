'use strict';

// Datengrundlage der Unterseite „Energiefluss". Reine, DB-freie Aufbereitung
// (für Tests wiederverwendbar): sie fügt die bereits berechneten Live-Werte zu
// einem Momentaufnahme-Graphen zusammen, den die View als animiertes
// Flussdiagramm zeichnet.
//
// Modell:
//   • Eingangsseitig bündeln sich die einzelnen PV-Anlagen zu einem Gesamtzweig.
//   • Der Netzbezug ist ein Eingangszweig, der bei Einspeisung negativ wird.
//   • Die Batterie ist eine neutrale Stabstelle (laden = positiv, entladen =
//     negativ).
//   • Zentraler Knoten ist der Eigenverbrauch, über den alles läuft.
//   • Ausgangsseitig verzweigt der Fluss auf die (verschachtelten) Gruppen;
//     einzelne Geräte werden bewusst NICHT gezeigt – Gruppensummen genügen.

function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Ausgangs-Baum aus der flachen Gruppenliste + dem Ebene/Gesamt-Baum. Damit das
// Diagramm in sich geschlossen ist, wird nur die Gruppenleistung als Ast
// dargestellt, deren Haken „mit Gesamtverbrauch verrechnen" gesetzt ist – diese
// Gruppen sind aus dem übergeordneten „Sonstige"-Rest herausgerechnet. Der Rest
// (eigene Ebene + nicht verrechnete Untergruppen) bleibt als „Sonstige
// Verbraucher"-Blatt am Knoten. So gilt an jedem Knoten:
//   Gesamt(Knoten) = Σ(gezeichnete Kinder) + Sonstige(Knoten).
function buildGroupNodes(groups, groupTree, groupStatus, groupEnergy) {
  const idSet = new Set((groups || []).map((g) => g.id));
  const childrenByParent = new Map();
  for (const g of groups || []) {
    const parent = g.parentId != null && idSet.has(g.parentId) ? g.parentId : null;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(g);
  }
  const tree = groupTree instanceof Map ? groupTree : new Map();
  const status = groupStatus instanceof Map ? groupStatus : new Map();
  const energy = groupEnergy instanceof Map ? groupEnergy : new Map();
  const gesamt = (id) => {
    const t = tree.get(id);
    return t && t.gesamtW != null ? t.gesamtW : null;
  };
  // Nur angehakte (verrechnete) Untergruppen werden als eigener Ast gezeichnet.
  const drawnChildren = (id) =>
    (childrenByParent.get(id) || []).filter((c) => c.offsetTotalConsumption !== false);

  function build(group, guard) {
    if (guard.has(group.id)) return null; // defensiv gegen Datenzyklen
    guard.add(group.id);
    const t = tree.get(group.id) || {};
    const drawn = drawnChildren(group.id);
    const children = drawn.map((c) => build(c, guard)).filter(Boolean);
    const st = status.get(group.id) || {};
    const en = energy.get(group.id) || {};
    // „Sonstige Verbraucher dieser Gruppe" = Gesamt − Σ(gezeichnete Kinder), für
    // Leistung wie Energie (heute/Jahr) baum-konsistent nach demselben Prinzip.
    let sonstigeW = null;
    let sonstigeTodayKwh = null;
    let sonstigeYearKwh = null;
    if (children.length && t.gesamtW != null) {
      let sub = 0;
      for (const c of drawn) { const cg = gesamt(c.id); if (cg != null) sub += cg; }
      sonstigeW = Math.max(0, t.gesamtW - sub);
    }
    if (children.length && en.todayKwh != null) {
      let subT = 0;
      for (const c of drawn) { const ce = energy.get(c.id); if (ce && ce.todayKwh != null) subT += ce.todayKwh; }
      sonstigeTodayKwh = Math.max(0, en.todayKwh - subT);
    }
    if (children.length && en.yearKwh != null) {
      let subY = 0;
      for (const c of drawn) { const ce = energy.get(c.id); if (ce && ce.yearKwh != null) subY += ce.yearKwh; }
      sonstigeYearKwh = Math.max(0, en.yearKwh - subY);
    }
    return {
      id: group.id,
      title: group.title,
      powerW: t.gesamtW == null ? null : t.gesamtW,
      meterGroup: t.meterGroup === true,
      color: group.color || '',
      deactivated: st.deactivated === true,
      sonstigeW,
      sonstigeTodayKwh,
      sonstigeYearKwh,
      // Verbrauch heute / dieses Jahr (baum-konsistent zur Leistung).
      todayKwh: en.todayKwh == null ? null : en.todayKwh,
      yearKwh: en.yearKwh == null ? null : en.yearKwh,
      children,
    };
  }
  const roots = (childrenByParent.get(null) || []).filter((g) => g.offsetTotalConsumption !== false);
  const nodes = roots.map((g) => build(g, new Set())).filter(Boolean);
  return { nodes, roots };
}

// pvValues: Ergebnis von readPhotovoltaikValues ({ plants:[{id,name,current}], totals:{current} })
// stromValues: { eigenverbrauchPower, netzbezugPower }
// batteryData: { soc, power } (Rohwerte), batteryConfig: { powerTopic, socTopic }
// groups: flache Gruppenliste, groupTree: readGroupPowerTree-Map
function assembleEnergiefluss({
  pvValues = {},
  stromValues = {},
  batteryData = {},
  batteryConfig = {},
  groups = [],
  groupTree = new Map(),
  groupStatus = new Map(),
  groupEnergy = new Map(),
} = {}) {
  const plants = (pvValues.plants || []).map((p) => ({
    id: p.id,
    name: p.name || `PV ${p.id}`,
    powerW: p.current == null ? null : parseNum(p.current),
  }));
  const pvTotal = pvValues.totals ? parseNum(pvValues.totals.current) : null;
  const batteryPresent = !!(batteryConfig && (batteryConfig.powerTopic || batteryConfig.socTopic));
  // Tages-/Jahresenergien aus den vorhandenen Aggregationen (kWh).
  const pvTotals = pvValues.totals || {};
  const bd = stromValues.breakdown || {};
  const bdToday = bd.today || {};
  const bdYear = bd.year || {};

  const { nodes: groupNodes } = buildGroupNodes(groups, groupTree, groupStatus, groupEnergy);
  // Globaler „Sonstige Verbraucher"-Ast: Eigenverbrauch minus die als eigener Ast
  // gezeichneten (verrechneten) obersten Gruppen. So bleibt der zentrale Knoten
  // ebenfalls in sich geschlossen.
  const eigen = parseNum(stromValues.eigenverbrauchPower);
  const eigenToday = parseNum(bdToday.eigenverbrauch);
  const eigenYear = parseNum(bdYear.eigenverbrauch);
  let drawnSum = 0;
  let drawnToday = 0;
  let drawnYear = 0;
  for (const n of groupNodes) {
    if (n.powerW != null) drawnSum += n.powerW;
    if (n.todayKwh != null) drawnToday += n.todayKwh;
    if (n.yearKwh != null) drawnYear += n.yearKwh;
  }
  const globalSonstigeW = eigen == null ? null : Math.max(0, eigen - drawnSum);
  const globalSonstigeToday = eigenToday == null ? null : Math.max(0, eigenToday - drawnToday);
  const globalSonstigeYear = eigenYear == null ? null : Math.max(0, eigenYear - drawnYear);

  return {
    // Eingang: PV (gebündelt) …
    pv: { totalW: pvTotal, plants, todayKwh: parseNum(pvTotals.today), yearKwh: parseNum(pvTotals.year) },
    // … Netz (>0 Bezug, <0 Einspeisung; Energie = Bezug − Einspeisung) …
    grid: { powerW: parseNum(stromValues.netzbezugPower), todayKwh: parseNum(bdToday.netzbezug), yearKwh: parseNum(bdYear.netzbezug) },
    // … Batterie als neutrale Stabstelle (>0 laden, <0 entladen).
    battery: {
      present: batteryPresent,
      powerW: parseNum(batteryData.power),
      soc: parseNum(batteryData.soc),
    },
    // Zentraler Knoten.
    eigenverbrauch: { powerW: eigen, todayKwh: eigenToday, yearKwh: eigenYear },
    // Ausgang: verschachtelte Gruppen …
    groups: groupNodes,
    // … plus der globale Restposten als eigener Ast (Leistung + Energie).
    sonstige: { powerW: globalSonstigeW, todayKwh: globalSonstigeToday, yearKwh: globalSonstigeYear },
  };
}

module.exports = { assembleEnergiefluss, buildGroupNodes, parseNum };
