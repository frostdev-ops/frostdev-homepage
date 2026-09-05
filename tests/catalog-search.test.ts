import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, CATEGORIES } from '../src/lib/wards.ts';
import { ACTIONS, TRIGGERS } from '../src/lib/logic.ts';
import { registryDoes, searchCatalog, tokenSim, tokenize } from '../src/lib/catalog-search.ts';

const ENTRIES = Object.entries(CATALOG).filter(([, c]) => !c.legacy);
const DERIVED = registryDoes([...Object.values(TRIGGERS), ...Object.values(ACTIONS)]);
const rank = (q: string) => searchCatalog(q, ENTRIES, DERIVED).map((h) => h.type);

test('tokenize: lowercase, punctuation, stop words, light stems', () => {
  assert.deepEqual(tokenize("What's due? To-do lists, timers!"), ['due', 'list', 'timer']);
  assert.deepEqual(tokenize('Fires logic when finished'), ['fire', 'logic', 'when', 'finish']);
});

test('tokenSim: exact, prefix, one typo, bigram overlap, nothing', () => {
  assert.equal(tokenSim('timer', 'timer'), 1);
  assert.equal(tokenSim('tim', 'timer'), 0.8);
  assert.equal(tokenSim('gmial', 'gmail'), 0.6);
  assert.equal(tokenSim('note', 'notion'), 0);
  assert.equal(tokenSim('ab', 'abc'), 0);
});

test('empty query → catalog order; junk → nothing', () => {
  assert.deepEqual(rank(''), ENTRIES.map(([t]) => t));
  assert.deepEqual(rank('   '), ENTRIES.map(([t]) => t));
  assert.deepEqual(rank('zzzz'), []);
});

test('todo → the database ward first', () => assert.equal(rank('todo')[0], 'notion-db'));
test('pomodoro → timer first', () => assert.equal(rank('pomodoro')[0], 'timer'));
test('draw → the notepad first', () => assert.equal(rank('draw')[0], 'note'));
test("what's due → database and agenda both in the top three", () => {
  const r = rank("what's due").slice(0, 3);
  assert.ok(r.includes('notion-db') && r.includes('calendar'), r.join(','));
});
test('gmial (typo) → a mail ward first', () => assert.equal(CATALOG[rank('gmial')[0]!]!.category, 'mail'));
test('fires logic → the logic wards rank above weather', () => {
  const r = rank('fires logic');
  const at = (t: string) => (r.indexOf(t) === -1 ? Infinity : r.indexOf(t));
  for (const t of ['timer', 'flow']) assert.ok(at(t) < at('weather'), t);
});

test('every catalog entry carries a category and enough vocabulary', () => {
  for (const [t, c] of Object.entries(CATALOG)) {
    assert.ok(c.category in CATEGORIES, `${t} category`);
    assert.ok(c.concepts.length >= 5, `${t} concepts`);
    assert.ok(c.does.length >= 3, `${t} does`);
  }
});

test('registryDoes wires the real trigger/action labels into the functional half', () => {
  assert.ok(DERIVED.timer!.includes('Timer finished'));
  assert.ok(DERIVED.timer!.includes('Reset timer'));
  assert.ok(DERIVED.flow!.includes('Packet arrived'));
  assert.ok(DERIVED['notion-db']!.includes('Archive checked items'));
  // Without the registry "reset" finds nothing on the timer; with it the timer is first.
  assert.ok(!searchCatalog('reset', ENTRIES).some((h) => h.type === 'timer'));
  assert.equal(rank('reset')[0], 'timer');
});
