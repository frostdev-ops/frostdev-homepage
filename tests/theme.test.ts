import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bgKind, BRAND_DEFAULTS, FONTS, FONT_GROUPS, FONT_IDS, fontStack, previewStack, PREVIEW_GLYPHS, normalizeWardTheme, wardThemeAttrs, wardThemeStyle, WARD_STYLE_PROPS, headerSceneConfig, HDR_SCALE, normalizeTheme, parseTheme, rollPreset, sceneConfig, themeColor, themeHtmlAttrs, themeStyle, PRESET_KNOBS, PRESETS, SCENES } from '../src/lib/theme.ts';

test('parseTheme: null/garbage → null (stock theme)', () => {
  assert.equal(parseTheme(null), null);
  assert.equal(parseTheme(''), null);
  assert.equal(parseTheme('{corrupt'), null);
  assert.equal(parseTheme('"a string"'), null);
});

test('normalizeTheme: clamps numbers, whitelists enums, falls back to preset', () => {
  const t = normalizeTheme({ preset: 'glass', mode: 'nope', accent: 'red', glassAlpha: 99, glassBlur: -5, radius: 9 });
  assert.equal(t.mode, 'dark');
  assert.equal(t.accent, PRESETS.glass.accent);
  assert.equal(t.glassAlpha, 1);
  assert.equal(t.glassBlur, 0);
  assert.equal(t.radius, 1.25);
  assert.equal(t.background, 'aurora'); // preset default carried
  assert.equal(normalizeTheme({ accent: '#AB12EF' }).accent, '#ab12ef');
});

test('themeHtmlAttrs: glass gates on alpha/blur, dark class on non-light modes', () => {
  const glass = themeHtmlAttrs(normalizeTheme({ preset: 'glass' }));
  assert.equal(glass['data-glass'], '');
  assert.equal(glass['data-bg'], 'aurora');
  assert.equal(glass.class, 'dark');
  assert.match(glass.style, /--fd-glass-alpha: 62%/);
  assert.match(glass.style, /--fd-glass-blur: 16px/);
  assert.match(glass.style, /--radius-lg: 0\.75rem/);

  const solidLight = themeHtmlAttrs(normalizeTheme({ preset: 'frost', mode: 'light' }));
  assert.equal(solidLight['data-glass'], undefined);
  assert.equal(solidLight.class, undefined);
  assert.equal(solidLight['data-mode'], 'light');

  assert.deepEqual(themeHtmlAttrs(null), {});
});

test('oled preset emits surface token overrides; themeColor follows', () => {
  const style = themeStyle(normalizeTheme({ preset: 'oled' }));
  assert.match(style, /--fd-surface-2: light-dark\(#f4f4f5, #000000\)/);
  assert.equal(themeColor(normalizeTheme({ preset: 'oled' })), '#000000');
  assert.equal(themeColor(normalizeTheme({ mode: 'light' })), '#f3f7fb');
  assert.equal(themeColor(null), '#06121f');
});

test('roundtrip: stored JSON parses back to the same config', () => {
  const cfg = normalizeTheme({ preset: 'glass', mode: 'system', accent: '#ff8800', glassAlpha: 0.45 });
  assert.deepEqual(parseTheme(JSON.stringify(cfg)), cfg);
});

test('background: kind whitelist, knob clamping, per-scene defaults', () => {
  assert.equal(normalizeTheme({ background: 'nope' }).background, 'flat');
  assert.equal(normalizeTheme({ background: 'scene' }).background, 'scene');

  // Knobs default off the picked SCENE, not off the preset.
  const nebula = normalizeTheme({ background: 'scene', bgScene: 'nebula' });
  assert.equal(nebula.bgSpeed, SCENES.nebula.speed);
  assert.deepEqual([nebula.bgColor1, nebula.bgColor2, nebula.bgColor3], SCENES.nebula.colors);
  assert.equal(normalizeTheme({ bgScene: 'made-up' }).bgScene, 'aurora');

  const clamped = normalizeTheme({ bgBlur: 999, bgDim: -3, bgScale: 0, bgOpacity: 5, bgColor1: 'chartreuse' });
  assert.equal(clamped.bgBlur, 60);
  assert.equal(clamped.bgDim, 0);
  assert.equal(clamped.bgScale, 0.25);
  assert.equal(clamped.bgOpacity, 1);
  assert.equal(clamped.bgColor1, SCENES.aurora.colors[0]);

  // Checkboxes arrive as 'on'/'' from the form, booleans from stored JSON.
  assert.equal(normalizeTheme({ bgFixed: 'on' }).bgFixed, true);
  assert.equal(normalizeTheme({ bgFixed: '' }).bgFixed, false);
  assert.equal(normalizeTheme({}).bgFixed, true);
});

test('background: only a store-shaped name reaches the CSS url()', () => {
  const evil = normalizeTheme({ background: 'image', bgImage: '1-aaaaaaaaaaaaaaaa.webp"); background: url(//evil' });
  assert.equal(evil.bgImage, '');
  assert.equal(normalizeTheme({ bgImage: '../../etc/passwd' }).bgImage, '');
  assert.equal(normalizeTheme({ bgImage: '2-00ff00ff00ff00ff.webp' }).bgImage, '2-00ff00ff00ff00ff.webp');

  // …and an image background with no image left is simply flat.
  assert.equal(bgKind(evil), 'flat');
  assert.equal(themeHtmlAttrs(evil)['data-bg'], undefined);
  assert.doesNotMatch(themeStyle(evil), /--fd-bg-image/);

  const real = normalizeTheme({ background: 'image', bgImage: '2-00ff00ff00ff00ff.webp', bgBlur: 12, bgDim: 0.5 });
  assert.equal(themeHtmlAttrs(real)['data-bg'], 'image');
  assert.match(themeStyle(real), /--fd-bg-image: url\("\/api\/bg\/2-00ff00ff00ff00ff\.webp"\)/);
  assert.match(themeStyle(real), /--fd-bg-blur: 12px/);
  assert.match(themeStyle(real), /--fd-bg-dim: 50%/);
});

test('background: a scene stamps the knobs the client needs, others do not', () => {
  const scene = normalizeTheme({ background: 'scene', bgScene: 'grid', bgSpeed: 2 });
  const attrs = themeHtmlAttrs(scene);
  assert.equal(attrs['data-bg'], 'scene');
  assert.deepEqual(JSON.parse(attrs['data-bg-cfg']!), sceneConfig(scene));
  assert.equal(sceneConfig(scene).scene, 'grid');
  assert.equal(sceneConfig(scene).speed, 2);

  // flat/aurora need no JS at all.
  assert.equal(themeHtmlAttrs(normalizeTheme({ background: 'aurora' }))['data-bg-cfg'], undefined);
  assert.equal(themeHtmlAttrs(normalizeTheme({}))['data-bg-cfg'], undefined);
});

test('surfaces: knobs only emit when opted in, and a pick beats the preset token', () => {
  const off = normalizeTheme({ preset: 'frost' });
  assert.equal(off.surfaceCustom, false);
  assert.doesNotMatch(themeStyle(off), /--fd-surface:/); // frost has no preset token either
  assert.equal(themeHtmlAttrs(off)['data-surfaced'], undefined);

  const on = normalizeTheme({ preset: 'oled', surfaceCustom: 'on', surface: '#123456', surface2: '#ABCDEF', line: '#0F0F0F' });
  const style = themeStyle(on);
  assert.equal(on.surface2, '#abcdef');
  assert.equal(themeHtmlAttrs(on)['data-surfaced'], '');
  // OLED's token must come FIRST so the explicit pick later in the same
  // style attribute wins the cascade.
  assert.ok(style.indexOf('--fd-surface: light-dark') < style.indexOf('--fd-surface: #123456'));
  assert.equal(themeColor(on), '#abcdef');
});

test('trim knobs: clamped, always emitted, preset-defaulted', () => {
  const t = normalizeTheme({ border: 99, rim: -1, shadow: 'x' });
  assert.equal(t.border, 4);
  assert.equal(t.rim, 0);
  assert.equal(t.shadow, PRESETS.frost.shadow);
  assert.match(themeStyle(t), /--fd-border: 4px/);

  const glass = normalizeTheme({ preset: 'glass' });
  assert.equal(glass.rim, PRESETS.glass.rim);
  assert.match(themeStyle(glass), new RegExp(`--fd-rim: ${PRESETS.glass.rim}`));
});

test('header: chrome vars always emitted, presets reproduce the old bar', () => {
  // The header used to take alpha/blur from the [data-glass] rule; each preset
  // now restates the pair, so an existing theme looks identical.
  assert.match(themeStyle(normalizeTheme({ preset: 'frost' })), /--fd-hdr-alpha: 85%; --fd-hdr-blur: 8px/);
  assert.match(themeStyle(normalizeTheme({ preset: 'glass' })), /--fd-hdr-alpha: 62%; --fd-hdr-blur: 16px/);
  assert.match(themeStyle(normalizeTheme({})), /--fd-hdr-border: 1px/);
  assert.match(themeStyle(normalizeTheme({})), /--fd-hdr-pad: 0\.625rem/);

  // Bar colour only when opted in — otherwise the CSS fallback follows surface-2.
  assert.doesNotMatch(themeStyle(normalizeTheme({})), /--fd-hdr-bg:/);
  assert.match(themeStyle(normalizeTheme({ hdrCustom: 'on', hdrBg: '#AA00BB' })), /--fd-hdr-bg: #aa00bb/);
});

test('header banner: off by default, reuses the background scene defaults', () => {
  const off = normalizeTheme({});
  assert.equal(off.hdrScene, 'none');
  assert.equal(headerSceneConfig(off), null);
  assert.equal(themeHtmlAttrs(off)['data-hdr-cfg'], undefined);

  const on = normalizeTheme({ hdrScene: 'orbs' });
  assert.equal(on.hdrSpeed, SCENES.orbs.speed); // knobs default off SCENES, like bg*
  assert.deepEqual(headerSceneConfig(on), {
    scene: 'orbs',
    colors: SCENES.orbs.colors,
    speed: SCENES.orbs.speed,
    glow: SCENES.orbs.glow,
    scale: Math.round(SCENES.orbs.scale * HDR_SCALE * 100) / 100, // coarser: a 10:1 bar, not a 16:9 screen
    warp: SCENES.orbs.warp,
    parallax: 0, // a 3rem bar has nowhere to parallax to
    opacity: SCENES.orbs.opacity,
    res: SCENES.orbs.res,
    fps: 30,
    detail: 4,
    govern: true,
    hidpi: false,
  });
  assert.equal(themeHtmlAttrs(on)['data-hdr-cfg'], JSON.stringify(headerSceneConfig(on)));
  assert.equal(normalizeTheme({ hdrScene: 'nope' }).hdrScene, 'none');
});

test('header sweep: a running animation only exists when asked for', () => {
  assert.equal(themeHtmlAttrs(normalizeTheme({}))['data-hdr-sweep'], undefined);
  assert.equal(themeHtmlAttrs(normalizeTheme({ hdrSweep: 0.5 }))['data-hdr-sweep'], '');
  assert.equal(normalizeTheme({ hdrSweep: 9 }).hdrSweep, 1);
  assert.equal(normalizeTheme({ hdrAlpha: 0 }).hdrAlpha, 0.2);
});

test('brand: stock knobs reproduce the shipped wordmark, and are not a preset\'s', () => {
  const t = normalizeTheme({});
  assert.equal(t.brandText, 'RIMEWARD');
  assert.equal(t.brandSize, 0.875);
  assert.equal(t.brandWeight, 700);
  assert.equal(t.brandLogo, ''); // '' = the built-in mark
  const style = themeStyle(t);
  assert.match(style, /--fd-brand-font: ui-sans-serif/);
  assert.match(style, /--fd-brand-size: 0\.875rem/);
  assert.match(style, /--fd-brand-track: 0\.25em/);
  // Nothing to filter and nothing to move, so neither flag is stamped.
  assert.equal(themeHtmlAttrs(t)['data-brand-fx'], undefined);
  assert.equal(themeHtmlAttrs(t)['data-brand-pos'], undefined);
  assert.doesNotMatch(style, /--fd-brand-color/);
  assert.doesNotMatch(style, /--fd-brand-glow/);

  // A preset switch never touches the brand — a wordmark is the user's.
  assert.equal(rollPreset(normalizeTheme({ brandText: 'ACME', brandFont: 'mono' }), 'oled').brandText, 'ACME');
});

test('fonts: one catalogue, and astro.config builds its download list from it', () => {
  // astro.config.mjs imports FONTS and derives `fonts` from it,
  // so the two cannot drift — what it must not do is stop importing it.
  const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /from '\.\/src\/lib\/theme\.ts'/);
  assert.match(config, /cssVariable: `--font-\$\{id\}`/);

  for (const id of FONT_IDS) {
    const f = FONTS[id];
    assert.match(id, /^[a-z0-9]+$/, `${id} is not a usable CSS variable suffix`);
    // A face is EITHER downloaded (resolves through its variable) or a system
    // stack — never both, never neither.
    // Every var() carries a generic INSIDE it: an unresolvable var invalidates
    // the whole declaration, so a face still in flight must not blank the page.
    assert.equal(Boolean(f.google), fontStack(id).includes(`var(--font-${id},`), id);
    if (f.google) {
      assert.ok(fontStack(id).endsWith(`, ${f.google.fallback})`), id);
      // A face most machines already have is tried before the download.
      assert.equal(fontStack(id).startsWith(`${f.google.local},`), Boolean(f.google.local), id);
      // The picker's subset falls back to the real face, then to the generic.
      assert.ok(previewStack(id).endsWith(`var(--font-${id}-p, var(--font-${id}, ${f.google.fallback}))`), id);
      // Its subset only has to carry the characters of its own label.
      for (const ch of f.label) assert.ok(PREVIEW_GLYPHS.includes(ch), `${f.label}: ${ch} missing`);
    } else {
      assert.equal(previewStack(id), fontStack(id), id);
    }
    assert.equal(Boolean(f.stack), !f.google, id);
    assert.ok(f.google || f.cat === 'system', `${id} is a system stack outside the system group`);
    // Every id reaches a picker: the groups must cover the whole catalogue.
    assert.ok(FONT_GROUPS.some((g) => g.cat === f.cat), `${f.cat} has no picker group`);
  }
  assert.ok(FONT_IDS.filter((id) => FONTS[id].google).length >= 40, 'the catalogue lost most of its faces');
});

test('ward theme: only what a card actually overrides is stored', () => {
  // Absent means "whatever the dashboard says", so an unreadable knob is
  // dropped rather than defaulted — there is nothing to default TO.
  assert.equal(normalizeWardTheme({}), undefined);
  assert.equal(normalizeWardTheme(null), undefined);
  assert.equal(normalizeWardTheme({ accent: 'chartreuse', font: 'nope', mode: 'sideways' }), undefined);
  assert.deepEqual(normalizeWardTheme({ accent: '#FF0000', bogus: 1 }), { accent: '#ff0000' });
  assert.deepEqual(normalizeWardTheme({ radius: 99, glassBlur: '12' }), { radius: 1.25, glassBlur: 12 });
  // 0 is a value, not an absence.
  assert.deepEqual(normalizeWardTheme({ shadow: 0 }), { shadow: 0 });

  // Flags gate the same derivations the page's do.
  const plain = wardThemeAttrs(normalizeWardTheme({ accent: '#ff0000' }));
  assert.equal(plain['data-ward-theme'], '');
  assert.equal(plain['data-ward-surfaced'], undefined);
  assert.equal(plain['data-ward-glass'], undefined);
  const full = wardThemeAttrs(normalizeWardTheme({ surface: '#101010', glassBlur: 8, mode: 'light' }));
  assert.equal(full['data-ward-surfaced'], '');
  assert.equal(full['data-ward-glass'], '');
  assert.equal(full['data-ward-mode'], 'light');
  assert.deepEqual(wardThemeAttrs(undefined), {});

  // The client writer clears WARD_STYLE_PROPS before writing, so anything
  // wardThemeStyle can emit has to be in that list or it would never clear.
  const every = normalizeWardTheme({
    font: 'comic', mode: 'light', accent: '#ff0000', surface: '#101010', line: '#202020',
    radius: 1, border: 2, rim: 0.5, shadow: 0.5, glassAlpha: 0.6, glassBlur: 8, density: 'compact',
  })!;
  for (const decl of wardThemeStyle(every).split(';')) {
    const prop = decl.split(':')[0]!.trim();
    assert.ok((WARD_STYLE_PROPS as readonly string[]).includes(prop), `${prop} is not cleared by the client writer`);
  }
});

test('fonts: the dashboard has its own family, defaulting to the system stack', () => {
  assert.equal(normalizeTheme({}).uiFont, 'ui');
  assert.match(themeStyle(normalizeTheme({})), /--fd-ui-font: ui-sans-serif/);
  assert.match(themeStyle(normalizeTheme({ uiFont: 'lora' })), /--fd-ui-font: var\(--font-lora, serif\)/);
  assert.equal(normalizeTheme({ uiFont: 'not-a-font' }).uiFont, 'ui');
  // It is the user's, not the preset's: a preset switch never moves it.
  assert.equal(rollPreset(normalizeTheme({ uiFont: 'inter' }), 'oled').uiFont, 'inter');
  // …and it is independent of the wordmark's own face.
  const t = normalizeTheme({ uiFont: 'inter', brandFont: 'bebas' });
  assert.match(themeStyle(t), /--fd-brand-font: var\(--font-bebas, sans-serif\)/);
});

test('brand: text is sanitised, everything else is a whitelist or a clamp', () => {
  // Free text, but it is rendered as TEXT: control characters out, 24 max.
  assert.equal(normalizeTheme({ brandText: '  Hi\u0000\u200b there  ' }).brandText, 'Hi there');
  assert.equal(normalizeTheme({ brandText: 'x'.repeat(99) }).brandText.length, 24);
  assert.equal(normalizeTheme({ brandText: '' }).brandText, ''); // '' hides it
  assert.equal(normalizeTheme({ brandText: 42 }).brandText, BRAND_DEFAULTS.text);

  // The font is an id we own; only the stack we picked reaches CSS.
  assert.equal(normalizeTheme({ brandFont: 'monospace; }' }).brandFont, 'ui');
  assert.match(themeStyle(normalizeTheme({ brandFont: 'serif' })), /--fd-brand-font: ui-serif/);

  const clamped = normalizeTheme({ brandSize: 99, brandWeight: 733, brandTrack: -1, brandLogoSize: 99, brandPos: 'top' });
  assert.equal(clamped.brandSize, 2.5);
  assert.equal(clamped.brandWeight, 700); // snapped to the 100s
  assert.equal(clamped.brandTrack, 0);
  assert.equal(clamped.brandLogoSize, 3);
  assert.equal(clamped.brandPos, 'left');

  // The logo shares the background store's validation exactly.
  assert.equal(normalizeTheme({ brandLogo: '../../etc/passwd' }).brandLogo, '');
  assert.equal(normalizeTheme({ brandLogo: '2-00ff00ff00ff00ff.webp' }).brandLogo, '2-00ff00ff00ff00ff.webp');

  const loud = normalizeTheme({ brandGlow: 0.5, brandShadow: 0, brandPos: 'center', brandCustom: 'on', brandColor: '#AA00BB' });
  assert.equal(themeHtmlAttrs(loud)['data-brand-fx'], '');
  assert.equal(themeHtmlAttrs(loud)['data-brand-pos'], 'center');
  assert.match(themeStyle(loud), /--fd-brand-glow: 0\.5/);
  assert.match(themeStyle(loud), /--fd-brand-color: #aa00bb/);
});

test('rollPreset: untouched knobs follow the new preset', () => {
  const t = rollPreset(normalizeTheme({ preset: 'frost' }), 'glass');
  assert.equal(t.preset, 'glass');
  assert.equal(t.glassAlpha, PRESETS.glass.glassAlpha);
  assert.equal(t.background, PRESETS.glass.background);
  assert.equal(t.hdrAlpha, PRESETS.glass.hdrAlpha);
  assert.equal(t.hdrBlur, PRESETS.glass.hdrBlur);
});

test('rollPreset: knobs the user changed survive the switch', () => {
  const mine = normalizeTheme({
    preset: 'frost',
    background: 'scene',
    hdrAlpha: 0.4,
    hdrBlur: 24,
    hdrSweep: 0.8,
    hdrCustom: true,
    hdrBg: '#112233',
    accent: '#ff0000',
  });
  const t = rollPreset(mine, 'glass');
  assert.equal(t.preset, 'glass');
  // Kept — every one of these differs from frost's value.
  assert.equal(t.background, 'scene');
  assert.equal(t.hdrAlpha, 0.4);
  assert.equal(t.hdrBlur, 24);
  assert.equal(t.hdrSweep, 0.8);
  assert.equal(t.hdrCustom, true);
  assert.equal(t.hdrBg, '#112233');
  assert.equal(t.accent, '#ff0000');
  // Still at frost's value, so it rolls.
  assert.equal(t.radius, PRESETS.glass.radius);
});

test('rollPreset: never touches the scene/image knobs, and round-trips', () => {
  const mine = normalizeTheme({ preset: 'oled', bgScene: 'grid', bgSpeed: 2.5, hdrScene: 'orbs', bgImage: '' });
  const t = rollPreset(mine, 'frost');
  assert.equal(t.bgScene, 'grid');
  assert.equal(t.bgSpeed, 2.5);
  assert.equal(t.hdrScene, 'orbs');
  // A→B→A with nothing else touched is the identity.
  assert.deepEqual(rollPreset(rollPreset(mine, 'frost'), 'oled'), mine);
  // Every knob the presets own is reachable from PRESET_KNOBS.
  for (const k of PRESET_KNOBS) assert.ok(k in mine, `${k} is not a ThemeConfig field`);
});

test('graphics: knobs default off the scene, clamp, and ride the SceneConfig', () => {
  const t = normalizeTheme({ background: 'scene', bgScene: 'grid', hdrScene: 'nebula' });
  assert.equal(t.bgRes, SCENES.grid.res);
  assert.equal(t.hdrRes, SCENES.nebula.res);
  assert.equal(t.bgFps, 30);
  assert.equal(t.bgDetail, 4);
  assert.equal(t.gfxGovern, true);
  assert.equal(t.gfxHiDpi, false);

  // Form strings, off-list fps, out-of-range detail.
  const set = normalizeTheme({ bgRes: '0.4', bgFps: '24', bgDetail: '9', hdrFps: 45, gfxGovern: '', gfxHiDpi: 'on' });
  assert.equal(set.bgRes, 0.4);
  assert.equal(set.bgFps, 24);
  assert.equal(set.bgDetail, 5);
  assert.equal(set.hdrFps, 30);
  assert.equal(set.gfxGovern, false);
  assert.equal(set.gfxHiDpi, true);
  assert.equal(normalizeTheme({ bgRes: 0.01 }).bgRes, 0.25);

  const sc = sceneConfig(set);
  assert.equal(sc.res, 0.4);
  assert.equal(sc.fps, 24);
  assert.equal(sc.detail, 5);
  assert.equal(sc.govern, false);
  assert.equal(sc.hidpi, true);
  // The global pair reaches the banner too.
  const hdr = headerSceneConfig(normalizeTheme({ hdrScene: 'orbs', gfxHiDpi: true, hdrRes: 0.3 }))!;
  assert.equal(hdr.hidpi, true);
  assert.equal(hdr.res, 0.3);
});
