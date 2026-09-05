import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS } from '../src/lib/targets.ts';
import { getDb } from '../src/lib/db.ts';
import { getDashboard } from '../src/lib/dashboard.ts';
import { getGraph } from '../src/lib/logic-engine.ts';
import { validateGraph } from '../src/lib/logic.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { migrateGraph, migrateLayout, migrateLegacyWards, migrateWardKeys, wardKeysGraph, wardKeysHistory } from '../src/lib/migrate-wards.ts';

const HEX = 'deadbeef-dead-beef-dead-beefdeadbeef';
const LEGACY = [
  { i: 'sv', type: 'service', size: '1x1', config: { service: TARGETS[0]!.id } },
  { i: 'h', type: 'host', size: '2x1' },
  { i: 'nf', type: 'notion-fields', size: '2x1', config: { page: HEX, props: ['A'], head: false } },
  { i: 'nf2', type: 'notion-fields', size: '2x1', title: 'Mine', config: { page: HEX } },
  { i: 'g', type: 'gmail', size: '2x2', title: 'Work mail' },
  { i: 'o', type: 'outlook', size: '2x1' },
  { i: 'z', type: 'zoho', size: '2x2', hidden: true },
  { i: 'mb', type: 'mailbox', size: '2x2', in: 'grp' },
  { i: 'nc', type: 'notion-capture', size: '2x1' },
  { i: 'sep', type: 'separator', size: '6x1', title: 'Section', config: { effect: 'glass' } },
  { i: 'w', type: 'weather', size: '2x1' },
  { i: 'grp', type: 'container', size: '2x1' },
];

test('migrateLayout: every legacy shape lands on the table, everything else is untouched', () => {
  const { layout, changed, skipped } = migrateLayout(LEGACY);
  assert.equal(changed, true);
  assert.deepEqual(skipped, []);
  const by = Object.fromEntries((layout as { i: string }[]).map((w) => [w.i, w]));
  assert.deepEqual(by.sv, { i: 'sv', type: 'service-group', size: '1x1', config: { services: [TARGETS[0]!.id] } });
  assert.deepEqual(by.h, { i: 'h', type: 'service-group', size: '2x1', title: 'Host', config: { services: ['host:cpu', 'host:mem', 'host:disk'] } });
  assert.deepEqual(by.nf, { i: 'nf', type: 'notion-page', size: '2x1', title: 'Page fields', config: { show: ['props'], page: HEX, props: ['A'], head: false } });
  assert.deepEqual(by.nf2, { i: 'nf2', type: 'notion-page', size: '2x1', title: 'Mine', config: { show: ['props'], page: HEX } });
  assert.deepEqual(by.g, { i: 'g', type: 'mail', size: '2x2', title: 'Work mail', config: { account: 'google' } });
  assert.deepEqual(by.o, { i: 'o', type: 'mail', size: '2x1', title: 'Outlook', config: { account: 'microsoft' } });
  assert.deepEqual(by.z, { i: 'z', type: 'mail', size: '2x2', hidden: true, title: 'Zoho Mail', config: { account: 'zoho' } });
  assert.deepEqual(by.mb, { i: 'mb', type: 'mail', size: '2x2', in: 'grp', title: 'Mailbox', config: { account: 'mailbox' } });
  assert.deepEqual(by.nc, { i: 'nc', type: 'notion-page', size: '2x1', title: 'Quick capture', config: { show: ['add'] } });
  assert.deepEqual(by.sep, { i: 'sep', type: 'spacer', size: '6x1', title: 'Section', config: { effect: 'glass', rule: true } });
  assert.deepEqual(by.w, { i: 'w', type: 'weather', size: '2x1' });
  assert.deepEqual(by.grp, { i: 'grp', type: 'container', size: '2x1' });
  assert.ok(validateLayout(layout), 'the migrated layout validates');
  // a second pass is a no-op
  const again = migrateLayout(layout);
  assert.equal(again.changed, false);
  assert.deepEqual(again.layout, layout);
  // a service ward that cannot be carried is skipped, not guessed
  assert.deepEqual(migrateLayout([{ i: 'bad', type: 'service', size: '1x1' }]).skipped, ['bad']);
  assert.deepEqual(migrateLayout('nope').skipped, ['not an array']);
});

test('migrateGraph: the per-provider mail triggers become mail-arrived with an account filter', () => {
  const layout = validateLayout(migrateLayout(LEGACY).layout)!;
  const edge = (id: string, ward: string, trigger: string) => ({
    id,
    source: { ward, trigger, params: {} },
    conditions: [],
    action: { type: 'notion.capture-append', params: { text: '{{mail.subject}}' } },
    enabled: true,
  });
  const raw = { edges: [edge('e1', 'o', 'outlook-arrived'), edge('e2', 'z', 'zoho-arrived'), edge('e3', 'mb', 'mailbox-arrived'), edge('e4', 'g', 'mail-arrived'), edge('e5', 'sv', 'service-status')] };
  const { graph, changed } = migrateGraph(raw);
  assert.equal(changed, true);
  const strict = validateGraph(graph, layout, { isAdmin: true });
  assert.ok(strict, 'every edge survives a strict validation against the migrated layout');
  assert.deepEqual(strict.edges.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5']);
  const e1 = strict.edges[0]!;
  assert.equal(e1.source.trigger, 'mail-arrived');
  assert.deepEqual(e1.source.params, { account: 'microsoft' });
  assert.equal(strict.edges[3]!.source.params.account, undefined); // an existing mail-arrived edge stays a wildcard
  assert.equal(migrateGraph({ edges: [edge('x', 'g', 'mail-arrived')] }).changed, false);
  assert.equal(migrateGraph(null).changed, false);
});

test('migrateLegacyWards: rewrites the rows once, and the boot hook records it', () => {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('mig@t.dev', 'x', 'admin')`).run();
  const u = (db.prepare(`SELECT id FROM users WHERE email = 'mig@t.dev'`).get() as { id: number }).id;
  db.prepare('INSERT INTO dashboards (user_id, layout_json) VALUES (?, ?)').run(u, JSON.stringify(LEGACY));
  const edges = [
    { id: 'e1', source: { ward: 'o', trigger: 'outlook-arrived', params: {} }, conditions: [], action: { type: 'notion.capture-append', params: { text: 'x' } }, enabled: true },
    { id: 'e2', source: { ward: 'sv', trigger: 'service-status', params: {} }, conditions: [], action: { type: 'notion.capture-append', params: { text: 'x' } }, enabled: true },
  ];
  db.prepare('INSERT INTO logic_graphs (user_id, graph_json) VALUES (?, ?)').run(u, JSON.stringify({ edges }));
  // The boot hook already ran on this fresh db (nothing to do then); run it again as a fresh boot would.
  db.prepare(`DELETE FROM applied_migrations WHERE name = '011_legacy_tiles'`).run();
  migrateLegacyWards(db);
  const stored = JSON.parse((db.prepare('SELECT layout_json FROM dashboards WHERE user_id = ?').get(u) as { layout_json: string }).layout_json);
  assert.deepEqual(stored, migrateLayout(LEGACY).layout);
  assert.deepEqual(getDashboard(u), validateLayout(stored));
  const g = getGraph(u);
  assert.equal(g.edges.length, 2);
  assert.equal(g.edges[0]!.source.trigger, 'mail-arrived');
  assert.deepEqual(g.edges[0]!.source.params, { account: 'microsoft' });
  // idempotent: a second run leaves both rows byte-identical
  const before = db.prepare('SELECT layout_json, graph_json FROM dashboards d JOIN logic_graphs l ON l.user_id = d.user_id WHERE d.user_id = ?').get(u);
  migrateLegacyWards(db);
  assert.deepEqual(db.prepare('SELECT layout_json, graph_json FROM dashboards d JOIN logic_graphs l ON l.user_id = d.user_id WHERE d.user_id = ?').get(u), before);
  // a layout that cannot be carried stays as it was
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('mig2@t.dev', 'x', 'admin')`).run();
  const u2 = (db.prepare(`SELECT id FROM users WHERE email = 'mig2@t.dev'`).get() as { id: number }).id;
  const broken = JSON.stringify([{ i: 'bad', type: 'service', size: '1x1' }, { i: 'g', type: 'gmail', size: '2x2' }]);
  db.prepare('INSERT INTO dashboards (user_id, layout_json) VALUES (?, ?)').run(u2, broken);
  migrateLegacyWards(db);
  assert.equal((db.prepare('SELECT layout_json FROM dashboards WHERE user_id = ?').get(u2) as { layout_json: string }).layout_json, broken);
});

test('wardKeysGraph: every tile key becomes ward, values and everything else untouched', () => {
  const edges = [
    {
      id: 'e1',
      source: { tile: 'f1', trigger: 'packet-arrived', params: { channel: 'in' } },
      conditions: [{ type: 'packet-count-above', params: { tile: 'f1', count: 3 } }],
      action: { type: 'flow.pass-waiting', tile: 'f2', params: { note: 'from {{trigger.tileTitle}}' } },
      enabled: true,
    },
  ];
  const { graph, changed } = wardKeysGraph({ edges });
  assert.equal(changed, true);
  assert.deepEqual((graph as { edges: unknown[] }).edges[0], {
    id: 'e1',
    source: { ward: 'f1', trigger: 'packet-arrived', params: { channel: 'in' } },
    conditions: [{ type: 'packet-count-above', params: { ward: 'f1', count: 3 } }],
    action: { type: 'flow.pass-waiting', ward: 'f2', params: { note: 'from {{trigger.wardTitle}}' } },
    enabled: true,
  });
  // already on the new keys: nothing to do
  assert.equal(wardKeysGraph(graph).changed, false);
  assert.equal(wardKeysGraph({ edges: 'nope' }).changed, false);
});

test('wardKeysHistory: packet history entries follow', () => {
  const { history, changed } = wardKeysHistory([{ at: 't', tile: 'f1', event: 'created' }, { at: 't', ward: 'f2', event: 'moved' }]);
  assert.equal(changed, true);
  assert.deepEqual(history, [{ at: 't', event: 'created', ward: 'f1' }, { at: 't', ward: 'f2', event: 'moved' }]);
  assert.equal(wardKeysHistory([{ at: 't', ward: 'f2', event: 'moved' }]).changed, false);
});

test('migrateWardKeys: rewrites stored graphs and packet histories once', () => {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('keys@t.dev', 'x', 'admin')`).run();
  const u = (db.prepare(`SELECT id FROM users WHERE email = 'keys@t.dev'`).get() as { id: number }).id;
  const old = { edges: [{ id: 'e1', source: { tile: 't1', trigger: 'timer-finished', params: {} }, conditions: [], action: { type: 'notion.capture-append', params: { text: 'x' } }, enabled: true }] };
  db.prepare('INSERT INTO logic_graphs (user_id, graph_json) VALUES (?, ?)').run(u, JSON.stringify(old));
  db.prepare('INSERT INTO packets (user_id, ward, channel, text, history_json) VALUES (?, ?, ?, ?, ?)').run(u, 'f1', 'in', 'hi', JSON.stringify([{ at: 't', tile: 'f1', event: 'created' }]));
  migrateWardKeys(db);
  const graph = JSON.parse((db.prepare('SELECT graph_json FROM logic_graphs WHERE user_id = ?').get(u) as { graph_json: string }).graph_json);
  assert.deepEqual(graph.edges[0].source, { ward: 't1', trigger: 'timer-finished', params: {} });
  const history = JSON.parse((db.prepare('SELECT history_json FROM packets WHERE user_id = ?').get(u) as { history_json: string }).history_json);
  assert.deepEqual(history, [{ at: 't', event: 'created', ward: 'f1' }]);
  const before = db.prepare('SELECT graph_json FROM logic_graphs WHERE user_id = ?').get(u);
  migrateWardKeys(db);
  assert.deepEqual(db.prepare('SELECT graph_json FROM logic_graphs WHERE user_id = ?').get(u), before);
});
