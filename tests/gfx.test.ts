import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gfxDefaults, gfxImpact, gfxLoad } from '../src/lib/gfx.ts';
import { sceneDefaults } from '../src/lib/theme.ts';

test('gfx: a scene at its own defaults is load 1, and every knob moves it the right way', () => {
  const base = sceneDefaults('nebula');
  assert.equal(gfxLoad(base), 1);
  assert.deepEqual(gfxDefaults('nebula'), { res: base.res, fps: 30, detail: 4, govern: true, hidpi: false });

  // Pixels are squared: half the res is a quarter of the work.
  assert.equal(gfxLoad({ ...base, res: base.res / 2 }), 0.25);
  assert.equal(gfxLoad({ ...base, fps: 60 }), 2);
  assert.equal(gfxLoad({ ...base, fps: 15 }), 0.5);
  // Detail only counts on the fbm scenes.
  assert.ok(gfxLoad({ ...base, detail: 5 }) > 1);
  assert.equal(gfxLoad({ ...sceneDefaults('orbs'), detail: 5 }), 1);
  // Hi-DPI is what THIS display pays: nothing on a 1× screen, 4× on a phone.
  assert.equal(gfxLoad({ ...base, hidpi: true }, 1), 1);
  assert.equal(gfxLoad({ ...base, hidpi: true }, 3), 4);
});

test('gfx: impact levels are 0–4 and say when a knob does nothing', () => {
  const nebula = sceneDefaults('nebula');
  assert.deepEqual(gfxImpact('res', { ...nebula, res: 1 }), { gpu: 4, battery: 4 });
  assert.deepEqual(gfxImpact('res', { ...nebula, res: 0.5 }), { gpu: 2, battery: 2 });
  assert.deepEqual(gfxImpact('res', { ...nebula, res: 0.25 }), { gpu: 1, battery: 1 });
  assert.equal(gfxImpact('fps', { ...nebula, fps: 60 }).gpu, 4);
  assert.equal(gfxImpact('fps', { ...nebula, fps: 15 }).battery, 1);
  assert.equal(gfxImpact('detail', nebula).gpu, 3);
  assert.match(gfxImpact('detail', sceneDefaults('grid')).note!, /no effect/);
  assert.equal(gfxImpact('hidpi', nebula).gpu, 0);
  assert.equal(gfxImpact('hidpi', { ...nebula, hidpi: true }).battery, 4);
  assert.match(gfxImpact('govern', { ...nebula, govern: false }).note!, /hot/);
});
