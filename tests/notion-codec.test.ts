import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { editorFor, plainText, readProp, readProps, writeProp, writeProps } from '../src/lib/notion-props.ts';
import { readBlock, updateBlockBody, writeBlock } from '../src/lib/notion-blocks.ts';
import { buildFilter, opsFor } from '../src/lib/notion-filter.ts';

const rp = (p: unknown) => readProp(p as Parameters<typeof readProp>[0]);

// ------------------------------------------------------------- properties

test('readProp: every value type flattens to text plus a structured value', () => {
  assert.deepEqual(rp({ type: 'title', title: [{ plain_text: 'Buy ' }, { plain_text: 'milk' }] }), {
    type: 'title',
    text: 'Buy milk',
    value: 'Buy milk',
    editable: true,
  });
  assert.equal(rp({ type: 'number', number: 0 }).text, '0'); // 0 is a value, not empty
  assert.equal(rp({ type: 'number', number: null }).text, '');
  assert.equal(rp({ type: 'checkbox', checkbox: false }).text, '—');
  assert.equal(rp({ type: 'select', select: { name: 'High', color: 'red' } }).color, 'red');
  assert.equal(rp({ type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }).text, 'a, b');
  assert.deepEqual(rp({ type: 'multi_select', multi_select: [{ name: 'a' }] }).value, ['a']);
  assert.equal(rp({ type: 'date', date: { start: '2026-09-01', end: '2026-09-03' } }).text, '2026-09-01 → 2026-09-03');
  assert.equal(rp({ type: 'people', people: [{ id: 'u1', name: 'Sam' }] }).text, 'Sam');
  assert.equal(rp({ type: 'relation', relation: [{ id: 'p1' }, { id: 'p2' }] }).text, '2 linked');
  assert.equal(rp({ type: 'formula', formula: { number: 42 } }).text, '42');
  assert.equal(rp({ type: 'rollup', rollup: { type: 'array', array: [{ type: 'number', number: 3 }] } }).text, '3');
  assert.equal(rp({ type: 'unique_id', unique_id: { prefix: 'TASK', number: 7 } }).text, 'TASK-7');
});

test('readProp: computed types are never editable', () => {
  for (const type of ['formula', 'rollup', 'created_time', 'last_edited_by', 'unique_id']) {
    assert.equal(rp({ type }).editable, false, type);
    assert.equal(editorFor(type), 'none', type);
  }
  assert.equal(rp({ type: 'rich_text', rich_text: [] }).editable, true);
});

test('writeProp: builds the PATCH body Notion expects', () => {
  assert.deepEqual(writeProp('title', 'Hi'), { title: [{ type: 'text', text: { content: 'Hi' } }] });
  assert.deepEqual(writeProp('number', '4.5'), { number: 4.5 });
  assert.deepEqual(writeProp('number', ''), { number: null }); // clearing is legal
  assert.deepEqual(writeProp('select', ''), { select: null });
  assert.deepEqual(writeProp('multi_select', 'a, b'), { multi_select: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(writeProp('date', { start: '2026-09-01', end: '' }), { date: { start: '2026-09-01' } });
  assert.deepEqual(writeProp('date', ''), { date: null });
  assert.deepEqual(writeProp('checkbox', 'on'), { checkbox: true });
  assert.deepEqual(writeProp('people', [{ id: 'u1' }, 'u2']), { people: [{ object: 'user', id: 'u1' }, { object: 'user', id: 'u2' }] });
  assert.deepEqual(writeProp('files', [{ name: 'a.pdf', file_upload_id: 'fu1' }]), {
    files: [{ type: 'file_upload', name: 'a.pdf', file_upload: { id: 'fu1' } }],
  });
  assert.deepEqual(writeProp('url', ''), { url: null });
});

test('writeProp: refuses what Notion computes, and a status it cannot clear', () => {
  assert.throws(() => writeProp('formula', 'x'), /cannot be written/);
  assert.throws(() => writeProp('rollup', 'x'), /cannot be written/);
  assert.throws(() => writeProp('status', ''), /cannot be cleared/);
  assert.throws(() => writeProp('number', 'abc'), /not a number/);
});

test('writeProps: drops unknown and computed columns instead of failing the edit', () => {
  const schema = { Name: { type: 'title' }, Total: { type: 'formula' }, Done: { type: 'checkbox' } };
  const { properties, skipped } = writeProps(schema, { Name: 'x', Total: 9, Done: true, Ghost: 1 });
  assert.deepEqual(Object.keys(properties).sort(), ['Done', 'Name']);
  assert.deepEqual(skipped.sort(), ['Ghost', 'Total']);
});

test('readProps keys by column name and plainText joins runs', () => {
  assert.equal(plainText([{ plain_text: 'a' }, { text: { content: 'b' } }]), 'ab');
  const props = readProps({ Name: { type: 'title', title: [{ plain_text: 'n' }] } } as never);
  assert.equal(props.Name!.text, 'n');
});

// ----------------------------------------------------------------- blocks

test('readBlock: text, media, and structural types', () => {
  const todo = readBlock({ id: 'b1', type: 'to_do', to_do: { rich_text: [{ plain_text: 'ship it' }], checked: true } });
  assert.equal(todo.text, 'ship it');
  assert.equal(todo.checked, true);
  assert.equal(todo.editable, true);

  const code = readBlock({ id: 'b2', type: 'code', code: { rich_text: [{ plain_text: 'x=1' }], language: 'python' } });
  assert.equal(code.language, 'python');

  const bookmark = readBlock({ id: 'b3', type: 'bookmark', bookmark: { url: 'https://x.dev', caption: [] } });
  assert.equal(bookmark.url, 'https://x.dev');
  assert.equal(bookmark.text, 'https://x.dev'); // no caption → the url reads as the label

  const img = readBlock({ id: 'b4', type: 'image', image: { external: { url: 'https://i/x.png' }, caption: [{ plain_text: 'cap' }] } });
  assert.equal(img.url, 'https://i/x.png');
  assert.equal(img.editable, false); // displayed, not round-tripped

  const child = readBlock({ id: 'b5', type: 'child_page', child_page: { title: 'Sub' }, has_children: true });
  assert.equal(child.text, 'Sub');
  assert.equal(child.editable, false);

  assert.equal(readBlock({ id: 'b6', type: 'divider', divider: {} }).text, '');
});

test('writeBlock: shapes each family, and refuses what it cannot create', () => {
  assert.deepEqual(writeBlock({ type: 'paragraph', text: 'hi' }), { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'hi' } }] } });
  assert.deepEqual(writeBlock({ type: 'divider' }), { type: 'divider', divider: {} });
  assert.equal((writeBlock({ type: 'to_do', text: 't', checked: true }).to_do as { checked: boolean }).checked, true);
  assert.equal((writeBlock({ type: 'code', text: 'x' }).code as { language: string }).language, 'plain text');
  assert.deepEqual(writeBlock({ type: 'bookmark', url: 'https://x.dev' }), { type: 'bookmark', bookmark: { url: 'https://x.dev' } });
  assert.throws(() => writeBlock({ type: 'bookmark', text: 'not a url' }), /http\(s\) URL/);
  assert.throws(() => writeBlock({ type: 'image', url: 'https://x/y.png' }), /cannot be created/);
  assert.throws(() => writeBlock({ type: 'table_row' }), /cannot be created/);
});

test('updateBlockBody drops the type key — Notion rejects retyping a block', () => {
  const body = updateBlockBody({ type: 'paragraph', text: 'x' });
  assert.equal(body.type, undefined);
  assert.ok(body.paragraph);
});

// ---------------------------------------------------------------- filters

const TYPES = { Name: { type: 'title' }, Due: { type: 'date' }, N: { type: 'number' }, Done: { type: 'checkbox' }, Tags: { type: 'multi_select' } };

test('buildFilter: one condition passes through, several are ANDed', () => {
  assert.deepEqual(buildFilter(TYPES, [{ property: 'Name', op: 'contains', value: 'milk' }]), {
    property: 'Name',
    title: { contains: 'milk' },
  });
  const both = buildFilter(TYPES, [
    { property: 'Done', op: 'equals', value: false },
    { property: 'Due', op: 'past_week' },
  ]) as { and: unknown[] };
  assert.equal(both.and.length, 2);
  assert.deepEqual(both.and[0], { property: 'Done', checkbox: { equals: false } });
  assert.deepEqual(both.and[1], { property: 'Due', date: { past_week: {} } }); // window ops take {}
});

test('buildFilter: emptiness ops always send true, numbers are coerced', () => {
  assert.deepEqual(buildFilter(TYPES, [{ property: 'Tags', op: 'is_empty' }]), { property: 'Tags', multi_select: { is_empty: true } });
  assert.deepEqual(buildFilter(TYPES, [{ property: 'N', op: 'greater_than', value: '3' }]), { property: 'N', number: { greater_than: 3 } });
});

test('buildFilter: an unknown column, a wrong op, or a missing value is a 400', () => {
  assert.equal(buildFilter(TYPES, []), undefined); // Notion rejects an empty `and`
  assert.throws(() => buildFilter(TYPES, [{ property: 'Ghost', op: 'equals', value: 'x' }]), /no column named/);
  assert.throws(() => buildFilter(TYPES, [{ property: 'Done', op: 'contains', value: 'x' }]), /not a filter for a checkbox/);
  assert.throws(() => buildFilter(TYPES, [{ property: 'Name', op: 'contains', value: '' }]), /needs a value/);
  assert.throws(() => buildFilter(TYPES, [{ property: 'N', op: 'greater_than', value: 'x' }]), /needs a number/);
});

test('opsFor: only the types Notion can filter offer ops', () => {
  assert.ok(opsFor('date').includes('on_or_after'));
  assert.deepEqual(opsFor('button'), []);
});

// -------------------------------------------------------- formatting kept

test('readProp: styled or linked runs ride along; plain text ships as text alone', () => {
  const plain = rp({ type: 'rich_text', rich_text: [{ plain_text: 'just words', annotations: { bold: false, color: 'default' } }] });
  assert.equal(plain.runs, undefined);
  const styled = rp({
    type: 'title',
    title: [
      { plain_text: 'Read ', annotations: { bold: false, color: 'default' } },
      { plain_text: 'Ch. 1', annotations: { bold: true, color: 'default' }, href: 'https://x.dev' },
    ],
  });
  assert.equal(styled.text, 'Read Ch. 1');
  assert.deepEqual(styled.runs, [{ plain_text: 'Read ' }, { plain_text: 'Ch. 1', href: 'https://x.dev', annotations: { bold: true, color: 'default' } }]);
  assert.equal(rp({ type: 'rich_text', rich_text: [{ plain_text: 'red', annotations: { color: 'red' } }] }).runs?.length, 1);
});

test('readProp: multi_select keeps a colour per option', () => {
  const v = rp({ type: 'multi_select', multi_select: [{ name: 'Exam', color: 'red' }, { name: 'Quiz', color: 'orange' }, { name: 'Task' }] });
  assert.deepEqual(v.colors, ['red', 'orange', 'default']);
  assert.equal(v.color, 'red');
  assert.equal(rp({ type: 'multi_select', multi_select: [] }).colors, undefined);
});

test('readBlock: styled runs and table cells survive', () => {
  const b = readBlock({ id: 'b9', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'bold', annotations: { bold: true } }, { plain_text: ' tail' }] } });
  assert.equal(b.text, 'bold tail');
  assert.equal(b.runs?.length, 2);
  assert.equal(readBlock({ id: 'b8', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'plain' }] } }).runs, undefined);
  const row = readBlock({ id: 'b7', type: 'table_row', table_row: { cells: [[{ plain_text: 'a' }], [{ plain_text: 'b' }, { plain_text: 'c' }]] } });
  assert.deepEqual(row.cells, ['a', 'bc']);
  assert.equal(row.text, 'a | bc');
});
