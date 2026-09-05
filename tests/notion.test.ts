import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotionId, objectTitle, pickTaskProps, pickDateProp } from '../src/lib/notion.ts';

const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DASHED = 'deadbeef-dead-beef-dead-beefdeadbeef';

test('parseNotionId: raw 32-hex id', () => {
  assert.equal(parseNotionId(HEX), DASHED);
  assert.equal(parseNotionId(`  ${HEX}  `), DASHED);
  assert.equal(parseNotionId(HEX.toUpperCase()), DASHED.toUpperCase()); // case preserved, regex is case-insensitive
});

test('parseNotionId: dashed uuid', () => {
  assert.equal(parseNotionId(DASHED), DASHED);
});

test('parseNotionId: notion.so URL with hex id', () => {
  assert.equal(parseNotionId(`https://www.notion.so/frostdev/My-Page-${HEX}?v=abc`), DASHED);
  assert.equal(parseNotionId(`https://notion.so/${HEX}`), DASHED);
});

test('parseNotionId: garbage is null', () => {
  assert.equal(parseNotionId(''), null);
  assert.equal(parseNotionId('not an id'), null);
  assert.equal(parseNotionId('deadbeef'), null); // too short
  assert.equal(parseNotionId('https://www.notion.so/frostdev/My-Page'), null);
});

test('objectTitle: database-shaped object joins title rich text', () => {
  const db = { id: 'x', object: 'database', title: [{ plain_text: 'My ' }, { plain_text: 'DB' }] };
  assert.equal(objectTitle(db as Parameters<typeof objectTitle>[0]), 'My DB');
});

test('objectTitle: page-shaped object finds the title property', () => {
  const page = {
    id: 'y',
    object: 'page',
    properties: {
      Status: { type: 'select' },
      Name: { type: 'title', title: [{ plain_text: 'A page' }] },
    },
  };
  assert.equal(objectTitle(page as Parameters<typeof objectTitle>[0]), 'A page');
});

test('objectTitle: no title anywhere is empty string', () => {
  assert.equal(objectTitle({ id: 'z', object: 'page' } as Parameters<typeof objectTitle>[0]), '');
  assert.equal(
    objectTitle({ id: 'z', object: 'page', properties: { A: { type: 'select' } } } as Parameters<typeof objectTitle>[0]),
    ''
  );
});

// --------------------------------------------------- done-column heuristic

const props = (o: Record<string, unknown>) => pickTaskProps(o as Parameters<typeof pickTaskProps>[0]);

test('pickTaskProps: a checkbox always wins', () => {
  const p = props({
    Name: { type: 'title' },
    Status: { type: 'status', status: { options: [{ id: '1', name: 'Done' }], groups: [{ name: 'Complete', option_ids: ['1'] }] } },
    Done: { type: 'checkbox' },
    Due: { type: 'date' },
  });
  assert.equal(p.title, 'Name');
  assert.equal(p.date, 'Due');
  assert.deepEqual(p.done, { name: 'Done', kind: 'checkbox' });
});

test('pickTaskProps: a status reads its Complete / To-do groups', () => {
  const p = props({
    Task: { type: 'title' },
    Status: {
      type: 'status',
      status: {
        options: [
          { id: 'a', name: 'Not started' },
          { id: 'b', name: 'In progress' },
          { id: 'c', name: 'Done' },
        ],
        groups: [
          { name: 'To-do', option_ids: ['a'] },
          { name: 'In progress', option_ids: ['b'] },
          { name: 'Complete', option_ids: ['c'] },
        ],
      },
    },
  });
  assert.deepEqual(p.done, { name: 'Status', kind: 'status', doneValue: 'Done', openValue: 'Not started' });
  assert.equal(p.date, null);
});

test('pickTaskProps: a select falls back to option names', () => {
  const p = props({
    Name: { type: 'title' },
    Stage: { type: 'select', select: { options: [{ id: '1', name: 'Backlog' }, { id: '2', name: 'Shipped' }] } },
  });
  assert.deepEqual(p.done, { name: 'Stage', kind: 'select', doneValue: 'Shipped', openValue: 'Backlog' });
});

test('pickTaskProps: nothing to check off is null, not a throw', () => {
  const p = props({ Name: { type: 'title' }, Notes: { type: 'rich_text' } });
  assert.equal(p.done, null);
  assert.equal(p.title, 'Name');
});

test('pickTaskProps: a select with no done-ish option is not a done column', () => {
  const p = props({ Name: { type: 'title' }, Area: { type: 'select', select: { options: [{ id: '1', name: 'Home' }] } } });
  assert.equal(p.done, null);
});

test('pickDateProp: a Date/When/Start/Due column by name, else the first date column, else nothing', () => {
  const schema = (names: [string, string][]) => ({ id: 's', title: 't', props: names.map(([name, type]) => ({ name, type })), types: {} });
  assert.equal(pickDateProp(schema([['Work On', 'date'], ['Due', 'date']]))?.name, 'Due');
  assert.equal(pickDateProp(schema([['Dates', 'date'], ['Work On', 'date']]))?.name, 'Dates');
  assert.equal(pickDateProp(schema([['Name', 'title']])), undefined);
});
