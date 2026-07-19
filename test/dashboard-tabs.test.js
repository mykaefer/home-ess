'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homeess-dashboard-tabs-'));
process.env.HOME_ESS_DB = path.join(TMP, 'app.db');

const test = require('node:test');
const assert = require('node:assert/strict');

const tabsRepo = require('../src/dashboard/tabs');
const groupsRepo = require('../src/dashboard/groups');
const widgetsRepo = require('../src/dashboard/widgets');
const { openDatabase } = require('../src/db');

function freshDb() {
  fs.rmSync(process.env.HOME_ESS_DB, { force: true });
  const db = openDatabase();
  return new Promise((resolve) => setTimeout(() => resolve(db), 300));
}

test('listTabs legt den Standard-Tab an und migriert Bestandsdaten ohne Tab', async () => {
  const db = await freshDb();
  // Bestandsdaten VOR dem ersten Tab-Zugriff (Konfiguration ohne Tabs).
  const group = await groupsRepo.createGroup(db, { title: 'Alt', width: 'half' });
  const widget = await widgetsRepo.createWidget(db, { sourceId: 'pv.current' });

  const tabs = await tabsRepo.listTabs(db);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].title, tabsRepo.DEFAULT_TAB_TITLE);

  // Gruppe und freies Widget hängen jetzt am Standard-Tab.
  const [migratedGroup] = await groupsRepo.listGroups(db);
  assert.equal(migratedGroup.id, group.id);
  assert.equal(migratedGroup.tabId, tabs[0].id);
  const [migratedWidget] = await widgetsRepo.listWidgets(db);
  assert.equal(migratedWidget.id, widget.id);
  assert.equal(migratedWidget.tabId, tabs[0].id);
  db.close();
});

test('Tab anlegen/umbenennen validiert Name und Länge', async () => {
  const db = await freshDb();
  await tabsRepo.listTabs(db);

  const tab = await tabsRepo.createTab(db, { title: '  Energie  ' });
  assert.equal(tab.title, 'Energie');

  await assert.rejects(() => tabsRepo.createTab(db, { title: '   ' }), /Namen/);
  await assert.rejects(
    () => tabsRepo.createTab(db, { title: 'x'.repeat(tabsRepo.MAX_TAB_TITLE_LENGTH + 1) }),
    /höchstens/
  );

  const renamed = await tabsRepo.renameTab(db, tab.id, { title: 'Haus' });
  assert.equal(renamed.title, 'Haus');
  await assert.rejects(() => tabsRepo.renameTab(db, tab.id, { title: '' }), /Namen/);
  db.close();
});

test('Der letzte Tab kann nicht gelöscht werden', async () => {
  const db = await freshDb();
  const [only] = await tabsRepo.listTabs(db);
  await assert.rejects(() => tabsRepo.deleteTab(db, only.id), /letzte Tab/);
  db.close();
});

test('Tab löschen verschiebt Gruppen und freie Widgets auf den Ziel-Tab', async () => {
  const db = await freshDb();
  const [first] = await tabsRepo.listTabs(db);
  const second = await tabsRepo.createTab(db, { title: 'Zweiter' });

  const group = await groupsRepo.createGroup(db, { title: 'G', width: 'full', tabId: second.id });
  const free = await widgetsRepo.createWidget(db, { sourceId: 'pv.current', tabId: second.id });
  const grouped = await widgetsRepo.createWidget(db, { sourceId: 'pv.today', groupId: group.id });

  const targetId = await tabsRepo.deleteTab(db, second.id, first.id);
  assert.equal(targetId, first.id);

  const tabs = await tabsRepo.listTabs(db);
  assert.equal(tabs.length, 1);
  const groups = await groupsRepo.listGroups(db);
  assert.equal(groups[0].tabId, first.id);
  const widgets = await widgetsRepo.listWidgets(db);
  const freeAfter = widgets.find((w) => w.id === free.id);
  const groupedAfter = widgets.find((w) => w.id === grouped.id);
  assert.equal(freeAfter.tabId, first.id);
  // Widget in Gruppe erbt den Tab über die Gruppe (keine eigene Zuordnung).
  assert.equal(groupedAfter.groupId, group.id);
  db.close();
});

test('Gruppe löschen: Widgets bleiben als freie Widgets auf dem Tab der Gruppe', async () => {
  const db = await freshDb();
  await tabsRepo.listTabs(db);
  const tab = await tabsRepo.createTab(db, { title: 'Pool' });
  const group = await groupsRepo.createGroup(db, { title: 'G', tabId: tab.id });
  const widget = await widgetsRepo.createWidget(db, { sourceId: 'pv.current', groupId: group.id });

  await groupsRepo.deleteGroup(db, group.id);
  const [after] = (await widgetsRepo.listWidgets(db)).filter((w) => w.id === widget.id);
  assert.equal(after.groupId, null);
  assert.equal(after.tabId, tab.id);
  db.close();
});

test('reorderTabs persistiert die Reihenfolge der Tab-Leiste', async () => {
  const db = await freshDb();
  const [first] = await tabsRepo.listTabs(db);
  const second = await tabsRepo.createTab(db, { title: 'B' });
  const third = await tabsRepo.createTab(db, { title: 'C' });

  await tabsRepo.reorderTabs(db, [
    { id: third.id, position: 0 },
    { id: first.id, position: 1 },
    { id: second.id, position: 2 },
  ]);
  const tabs = await tabsRepo.listTabs(db);
  assert.deepEqual(tabs.map((tab) => tab.id), [third.id, first.id, second.id]);
  db.close();
});

test('reorderWidgets persistiert Gruppe, Position und Tab', async () => {
  const db = await freshDb();
  const [first] = await tabsRepo.listTabs(db);
  const second = await tabsRepo.createTab(db, { title: 'B' });
  const a = await widgetsRepo.createWidget(db, { sourceId: 'a', tabId: first.id });
  const b = await widgetsRepo.createWidget(db, { sourceId: 'b', tabId: first.id });

  await widgetsRepo.reorderWidgets(db, [
    { id: b.id, groupId: null, tabId: second.id, position: 0 },
    { id: a.id, groupId: null, tabId: first.id, position: 0 },
  ]);
  const widgets = await widgetsRepo.listWidgets(db);
  assert.equal(widgets.find((w) => w.id === b.id).tabId, second.id);
  assert.equal(widgets.find((w) => w.id === a.id).tabId, first.id);
  db.close();
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* egal */
  }
});
