import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERAL_ICON_SETS, ICON_IDS, ICON_SETS, ICONS, WMO_ICON, iconRef, type IconSet } from '../src/lib/icon-names.ts';
import { iconSvg } from '../src/lib/icons.ts';
import { iconConfig, normalizeTheme, themeHtmlAttrs, themeStyle } from '../src/lib/theme.ts';
import { CATALOG } from '../src/lib/wards.ts';
import { TRIGGERS, CONDITIONS, ACTIONS } from '../src/lib/logic.ts';

test('every semantic id resolves in every set, in every style', () => {
  for (const set of Object.keys(ICON_SETS) as IconSet[]) {
    const def = ICON_SETS[set];
    if (!def.pkg) continue;
    const styles = Object.keys(def.styles).length ? Object.keys(def.styles) : [''];
    for (const id of ICON_IDS) {
      const cfg = { set, style: '', stroke: 0, weather: 'follow' as const };
      const r = def.weatherOnly ? null : iconRef(cfg, id);
      const name = def.weatherOnly ? ICONS[id][6] : r && r.kind === 'mask' ? new URL(r.url, 'http://x').pathname.split('/').pop() : null;
      if (!name) {
        assert.ok(def.weatherOnly, `${set}:${id} produced no name`);
        continue;
      }
      for (const style of styles) assert.ok(iconSvg(set, name, style), `${set}:${name} (${style || 'base'}) missing`);
    }
  }
});

test('catalog and WMO map name real ids', () => {
  for (const [type, c] of Object.entries(CATALOG)) assert.ok(c.icon in ICONS, `${type} → ${c.icon}`);
  for (const [type, spec] of Object.entries({ ...TRIGGERS, ...CONDITIONS, ...ACTIONS })) assert.ok(spec.icon in ICONS, `${type} → ${spec.icon}`);
  for (const id of Object.values(WMO_ICON)) assert.ok(ICONS[id][6], `weather id ${id} needs a meteocons name`);
});

test('iconRef: emoji by default, mask in a set, img for weather art, free text passthrough', () => {
  assert.deepEqual(iconRef(null, 'mail'), { kind: 'text', text: '✉️' });
  assert.deepEqual(iconRef({ set: 'ph', style: 'fill', stroke: 2, weather: 'follow' }, 'mail'), { kind: 'mask', url: '/api/icon/ph/envelope?s=fill' });
  assert.deepEqual(iconRef({ set: 'lucide', style: '', stroke: 1.5, weather: 'follow' }, 'mail'), { kind: 'mask', url: '/api/icon/lucide/mail?sw=1.5' });
  assert.deepEqual(iconRef({ set: 'emoji', style: '', stroke: 2, weather: 'meteocons-fill' }, 'rain'), { kind: 'img', url: '/api/icon/meteocons/rain?s=fill' });
  assert.deepEqual(iconRef({ set: 'emoji', style: '', stroke: 2, weather: 'meteocons' }, 'mail'), { kind: 'text', text: '✉️' });
  // An applink's own icon: emoji stays text, a name goes to the set (Lucide when the theme is emoji).
  assert.deepEqual(iconRef(null, '🚀'), { kind: 'text', text: '🚀' });
  assert.deepEqual(iconRef(null, 'rocket'), { kind: 'mask', url: '/api/icon/lucide/rocket' });
  assert.deepEqual(iconRef({ set: 'tabler', style: 'filled', stroke: 2, weather: 'follow' }, 'rocket'), { kind: 'mask', url: '/api/icon/tabler/rocket?s=filled&sw=2' });
  assert.deepEqual(iconRef(null, '../x'), { kind: 'text', text: '../x' });
});

test('iconSvg: variant falls back to base, stroke rewrites stroke-width, unknown → null', () => {
  assert.equal(iconSvg('tabler', 'server', 'filled'), iconSvg('tabler', 'server'));
  assert.match(iconSvg('lucide', 'sun', '', 1.25)!, /stroke-width="1.25"/);
  assert.doesNotMatch(iconSvg('lucide', 'sun', '', 1.25)!, /stroke-width="2"/);
  assert.equal(iconSvg('lucide', 'no-such-icon'), null);
  assert.equal(iconSvg('emoji', 'sun'), null);
});

test('theme: icon knobs normalize per set and only surface when used', () => {
  const stock = normalizeTheme({});
  assert.equal(stock.iconSet, 'emoji');
  assert.equal(themeHtmlAttrs(stock)['data-icons'], undefined);
  assert.doesNotMatch(themeStyle(stock), /--fd-icon/);

  const ph = normalizeTheme({ iconSet: 'ph', iconStyle: 'nope', iconTint: 'accent', iconOpacity: 0.5, iconSize: 9, iconStroke: 0 });
  assert.equal(ph.iconStyle, 'regular');
  assert.equal(ph.iconSize, 2);
  assert.equal(ph.iconStroke, 0.5);
  assert.deepEqual(JSON.parse(themeHtmlAttrs(ph)['data-icons']), iconConfig(ph));
  assert.match(themeStyle(ph), /--fd-icon-color: var\(--fd-accent\)/);
  assert.match(themeStyle(ph), /--fd-icon-opacity: 0.5/);
  assert.equal(themeHtmlAttrs(stock)['data-icon-tint'], undefined);
  assert.equal(themeHtmlAttrs(ph)['data-icon-tint'], '');
  assert.equal(themeHtmlAttrs(normalizeTheme({ iconTint: 'accent' }))['data-icon-tint'], ''); // emoji set still gates the silhouette

  assert.equal(normalizeTheme({ iconSet: 'meteocons' }).iconSet, 'emoji'); // weather-only, never the general set
  assert.equal(normalizeTheme({ iconSet: 'material' }).iconStyle, 'outline');
  assert.match(themeStyle(normalizeTheme({ iconTint: 'custom', iconColor: '#ABCDEF' })), /--fd-icon-color: #abcdef/);
  for (const s of GENERAL_ICON_SETS) assert.equal(normalizeTheme({ iconSet: s }).iconSet, s);
});
