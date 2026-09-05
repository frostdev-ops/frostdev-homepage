import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { BG_DIR, backgroundPath, deleteBackground, listBackgrounds, saveBackground } from '../src/lib/backgrounds.ts';
import { BG_NAME_RE } from '../src/lib/theme.ts';

const png = (shade: number) =>
  sharp({ create: { width: 8, height: 6, channels: 3, background: { r: shade, g: shade, b: shade } } })
    .png()
    .toBuffer();

test('store: re-encodes to webp, content-addressed, per user', async () => {
  const a = await saveBackground(1, await png(10));
  assert.match(a, BG_NAME_RE);
  assert.ok(a.startsWith('1-'));
  assert.equal(fs.readFileSync(`${BG_DIR}/${a}`).subarray(8, 12).toString(), 'WEBP');

  // Same photo twice is one file, not two.
  assert.equal(await saveBackground(1, await png(10)), a);
  assert.deepEqual(listBackgrounds(1), [a]);

  const b = await saveBackground(1, await png(200));
  assert.notEqual(b, a);
  assert.equal(listBackgrounds(1).length, 2);

  // Another user sees none of it.
  assert.deepEqual(listBackgrounds(2), []);
  assert.equal(backgroundPath(2, a), null);
  assert.ok(backgroundPath(1, a));

  deleteBackground(1, a);
  assert.deepEqual(listBackgrounds(1), [b]);
});

test('store: refuses traversal, foreign names, and non-images', async () => {
  assert.equal(backgroundPath(1, '../../homepage.db'), null);
  assert.equal(backgroundPath(1, '1-aaaaaaaaaaaaaaaa.webp/../x'), null);
  assert.equal(backgroundPath(1, 'anything.png'), null);
  // A delete with a hostile name must not touch anything.
  deleteBackground(1, '../homepage.db');
  assert.ok(fs.existsSync(process.env.HOMEPAGE_DATA_DIR!));

  await assert.rejects(saveBackground(1, Buffer.from('this is not an image')), /not an image/);
});
