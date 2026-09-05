// Per-user theme: a small knob set stored as JSON on users.theme. All color
// DERIVATION lives in frost.css (`:root[data-themed]` reads the raw knob
// vars); this module only validates knobs and serializes them into
// attributes for <html>. The account editor applies the exact same
// props/attrs client-side for live preview — one derivation, two writers.

import { GENERAL_ICON_SETS, ICON_SETS, WEATHER_ICONS, type IconCfg, type IconSet, type WeatherIcons } from './icon-names.ts';

export type ThemeMode = 'dark' | 'light' | 'system';
export type IconTint = 'ink' | 'accent' | 'custom';
export type ThemePreset = 'frost' | 'glass' | 'oled';
export type ThemeDensity = 'compact' | 'cozy' | 'comfortable';
/** flat = page tokens only; aurora = the CSS blob backdrop; image = an uploaded
 *  photo; scene = the three.js background (scripts/app/bg-scene.ts). */
export type BackgroundKind = 'flat' | 'aurora' | 'image' | 'scene';
export type SceneId =
  | 'aurora' | 'nebula' | 'waves' | 'orbs' | 'starfield' | 'grid'
  | 'silk' | 'cells' | 'rain' | 'swirl' | 'bokeh' | 'mesh'
  | 'caustics' | 'truchet' | 'moire' | 'dunes' | 'bars' | 'hex';
/** The header banner runs the SAME scenes as the background, plus an off. */
export type HeaderScene = 'none' | SceneId;
/** A typeface in the FONTS catalogue below: either a stack the machine already
 *  has, or one of the faces astro.config.mjs downloads at build time. Used by
 *  the wordmark, the dashboard's own text, and any single ward. */
export type FontId = keyof typeof FONTS;
/** How the pickers group the catalogue. */
export type FontCat = 'system' | 'sans' | 'serif' | 'mono' | 'display' | 'hand';
/** Where the brand block sits in the header row. */
export type BrandPos = 'left' | 'center' | 'right';

/** Uploaded backgrounds are content-addressed webp written by lib/backgrounds.ts.
 *  The name goes into a CSS url() — nothing else may ever reach that var. */
export const BG_NAME_RE = /^\d+-[0-9a-f]{16}\.webp$/;

export interface ThemeConfig {
  mode: ThemeMode;
  preset: ThemePreset;
  /** #rrggbb */
  accent: string;
  /** Surface opacity, 0.3–1 (1 = solid, no backdrop-filter cost). */
  glassAlpha: number;
  /** Backdrop blur in px, 0–30. */
  glassBlur: number;
  /** rem for --radius-lg; md/xl derive at ×0.75/×1.5. 0–1.25. */
  radius: number;
  density: ThemeDensity;
  background: BackgroundKind;

  // --- surfaces, borders, trim ---
  /** Off = the stock palette. On, the three colours below REPLACE it in both
   *  modes, and ink/line-strong derive from them (see frost.css
   *  `:root[data-surfaced]`) so a dark pick stays readable in light mode. */
  surfaceCustom: boolean;
  /** #rrggbb — card + ward background. Under glass this is the glass tint. */
  surface: string;
  /** #rrggbb — page canvas + header. */
  surface2: string;
  /** #rrggbb — border colour; line-strong derives from it. */
  line: string;
  /** Card/ward border width in px, 0–4. */
  border: number;
  /** Inner top-edge highlight — the glass trim, 0–1. */
  rim: number;
  /** Outer drop shadow depth, 0–1. */
  shadow: number;

  // --- header chrome ---
  /** Off = the header follows the page colour (--color-surface-2). */
  hdrCustom: boolean;
  /** #rrggbb — header bar colour when hdrCustom. */
  hdrBg: string;
  /** Header opacity over whatever is behind it, 0.2–1. */
  hdrAlpha: number;
  /** Header backdrop blur in px, 0–30. */
  hdrBlur: number;
  /** Bottom border width in px, 0–4. */
  hdrBorder: number;
  /** Accent glow bleeding below the header, 0–1. */
  hdrHalo: number;
  /** Animated accent sweep across the bar, 0–1 (0 = no animation at all). */
  hdrSweep: number;
  /** Row padding in rem, 0.25–1.5 — the header's height. */
  hdrPad: number;

  // --- header banner (three.js, same scenes/shaders as the background) ---
  hdrScene: HeaderScene;
  /** #rrggbb ×3 — default off SCENES[hdrScene], like the background. */
  hdrColor1: string;
  hdrColor2: string;
  hdrColor3: string;
  hdrSpeed: number;
  hdrGlow: number;
  hdrScale: number;
  hdrWarp: number;
  hdrOpacity: number;
  /** Banner graphics — same knobs as bg*, defaults off SCENES[hdrScene]. */
  hdrRes: number;
  hdrFps: Fps;
  hdrDetail: number;

  /** The dashboard's own text — every ward, menu and dialog. A ward can
   *  override it (WardInstance.font); the wordmark never follows it. */
  uiFont: FontId;

  // --- header brand (the wordmark + logo at the left of the bar) ---
  /** The wordmark. '' hides the text entirely. */
  brandText: string;
  brandFont: FontId;
  /** Wordmark size in rem, 0.6–2.5. */
  brandSize: number;
  /** 100–900. */
  brandWeight: number;
  /** Letter-spacing in em, 0–0.5. */
  brandTrack: number;
  /** Off = the wordmark takes the header's ink colour. */
  brandCustom: boolean;
  /** #rrggbb — wordmark colour when brandCustom. */
  brandColor: string;
  /** Accent glow around text AND logo, 0–1. */
  brandGlow: number;
  /** Drop shadow under text AND logo, 0–1. */
  brandShadow: number;
  /** '' = the built-in mark; otherwise a name in the uploads store. */
  brandLogo: string;
  /** Logo box in rem, 0–3. 0 hides it. */
  brandLogoSize: number;
  brandPos: BrandPos;

  // --- image background (background: 'image') ---
  /** File name in the backgrounds store, '' = none. */
  bgImage: string;
  /** Blur radius in px, 0–60. */
  bgBlur: number;
  /** Veil of page color over the photo, 0–0.95. */
  bgDim: number;
  /** Saturation multiplier, 0–2 (0 = greyscale). */
  bgSat: number;
  /** Brightness multiplier, 0.2–1.8. */
  bgBright: number;
  /** Zoom, 1–1.6 — also hides the soft edge a big blur leaves. */
  bgZoom: number;
  /** Fixed (parallax-free) or scrolling with the page. */
  bgFixed: boolean;

  // --- three.js background (background: 'scene') ---
  bgScene: SceneId;
  /** #rrggbb ×3 — every scene reads all three. */
  bgColor1: string;
  bgColor2: string;
  bgColor3: string;
  /** Animation rate, 0–3 (0 = frozen). */
  bgSpeed: number;
  /** Bloom/glow strength, 0–2. */
  bgGlow: number;
  /** Feature scale/density, 0.25–4. */
  bgScale: number;
  /** Turbulence of the movement, 0–2. */
  bgWarp: number;
  /** Pointer parallax, 0–1. */
  bgParallax: number;

  // --- scene graphics (bg-scene.ts) — per surface, defaults off SCENES[x] ---
  /** Render scale, 0.25–1: the buffer is this fraction of the canvas box. */
  bgRes: number;
  /** Frame-rate cap. */
  bgFps: Fps;
  /** Noise octaves, 2–5 — only the fbm scenes (SceneDef.noise) read it. */
  bgDetail: number;
  /** Both surfaces: the governor may step resolution/fps down when frames run slow. */
  gfxGovern: boolean;
  /** Both surfaces: render at device pixels (up to 2×) instead of CSS pixels. */
  gfxHiDpi: boolean;

  // --- both ---
  /** Layer opacity, 0.05–1. */
  bgOpacity: number;

  // --- icons (lib/icon-names.ts) ---
  /** The set every ward icon is drawn from; emoji = stock, nothing fetched. */
  iconSet: IconSet;
  /** A style id of ICON_SETS[iconSet] — '' for sets with one look. */
  iconStyle: string;
  /** follow = the icon set; otherwise the Meteocons weather art (colour, animated). */
  weatherIcons: WeatherIcons;
  /** ink = currentColor, accent = the accent, custom = iconColor. */
  iconTint: IconTint;
  /** #rrggbb — icon colour when iconTint is custom. */
  iconColor: string;
  /** 0.1–1. */
  iconOpacity: number;
  /** Size multiplier over the surrounding text, 0.5–2. */
  iconSize: number;
  /** stroke-width for the stroke-drawn sets (Lucide, Tabler), 0.5–4. */
  iconStroke: number;
}

export type Fps = 15 | 24 | 30 | 60;
export const FPS_OPTIONS: readonly Fps[] = [15, 24, 30, 60];
/** The graphics defaults every scene shares (res is per scene). */
export const GFX_DEFAULTS = { fps: 30 as Fps, detail: 4, govern: true, hidpi: false } as const;
export const DETAIL_MIN = 2;
export const DETAIL_MAX = 5;

/** Per-scene knob defaults — the scene picker loads these, and they are the
 *  fallback when a stored theme predates a knob. */
export interface SceneDef {
  label: string;
  hint: string;
  colors: [string, string, string];
  speed: number;
  glow: number;
  scale: number;
  warp: number;
  opacity: number;
  /** True when the shader returns coverage 1 and paints the whole frame;
   *  false = airy, it returns partial coverage and sits over the page tokens. */
  solid: boolean;
  /** Render scale, 0–1: the fraction of the canvas box the buffer is, with the
   *  compositor upscaling the rest. Set per preset from the /perf diff harness:
   *  0.5 where a half-res render upscaled is pixel-indistinguishable (soft
   *  gradients), 0.75 where it needs a little more (soft edges), 1 for anything
   *  drawn as one-pixel lines or points. Every step down is that much less
   *  fragment work per frame, squared. */
  res: number;
  /** True for the presets built on fbm() — the only ones the Detail knob
   *  (noise octaves) changes. */
  noise?: true;
}

export const SCENES: Record<SceneId, SceneDef> = {
  aurora: {
    label: 'Aurora curtains',
    hint: 'drifting polar ribbons',
    colors: ['#17c8f4', '#3b2e94', '#00ffa3'],
    speed: 1,
    glow: 1,
    scale: 1,
    warp: 1,
    opacity: 0.9,
    solid: false,
    res: 0.5,
  },
  nebula: {
    noise: true,
    label: 'Nebula',
    hint: 'slow rolling gas clouds',
    colors: ['#123b66', '#7c3aed', '#17c8f4'],
    speed: 0.6,
    glow: 0.8,
    scale: 1.2,
    warp: 1.3,
    opacity: 0.85,
    solid: true,
    res: 0.5,
  },
  waves: {
    noise: true,
    label: 'Contour waves',
    hint: 'the brand topography, flowing',
    colors: ['#06121f', '#17c8f4', '#eaf6f9'],
    speed: 0.8,
    glow: 0.7,
    scale: 1,
    warp: 0.8,
    opacity: 0.8,
    solid: false,
    res: 1,
  },
  orbs: {
    label: 'Lava orbs',
    hint: 'metaball blobs, lava-lamp slow',
    colors: ['#17c8f4', '#f472b6', '#3b2e94'],
    speed: 0.7,
    glow: 1.2,
    scale: 0.9,
    warp: 0.6,
    opacity: 0.9,
    solid: true,
    res: 0.5,
  },
  starfield: {
    label: 'Starfield',
    hint: 'drifting, twinkling points',
    colors: ['#eaf6f9', '#17c8f4', '#060d18'],
    speed: 1,
    glow: 1,
    scale: 1.4,
    warp: 0.4,
    opacity: 1,
    solid: false,
    res: 1,
  },
  grid: {
    label: 'Neon grid',
    hint: 'perspective grid, scanning glow',
    colors: ['#17c8f4', '#f472b6', '#02060d'],
    speed: 1,
    glow: 1.1,
    scale: 1,
    warp: 0.3,
    opacity: 0.9,
    solid: true,
    res: 1,
  },
  silk: {
    label: 'Silk ribbons',
    hint: 'sine bands crossing the frame',
    colors: ['#17c8f4', '#7c3aed', '#00ffa3'],
    speed: 1,
    glow: 0.9,
    scale: 1,
    warp: 1,
    opacity: 0.85,
    solid: false,
    res: 0.5,
  },
  cells: {
    label: 'Crystal cells',
    hint: 'voronoi shards, lit walls',
    colors: ['#0b2540', '#17c8f4', '#eaf6f9'],
    speed: 0.6,
    glow: 0.8,
    scale: 1,
    warp: 0.8,
    opacity: 0.85,
    solid: true,
    res: 0.75,
  },
  rain: {
    label: 'Light rain',
    hint: 'falling streaks, two depths',
    colors: ['#17c8f4', '#eaf6f9', '#0b1b2e'],
    speed: 1,
    glow: 1,
    scale: 1,
    warp: 0.5,
    opacity: 0.9,
    solid: false,
    res: 0.75,
  },
  swirl: {
    label: 'Vortex',
    hint: 'spiral arms out of a lit core',
    colors: ['#3b2e94', '#17c8f4', '#04070f'],
    speed: 0.8,
    glow: 1,
    scale: 1,
    warp: 0.7,
    opacity: 0.9,
    solid: true,
    res: 0.5,
  },
  bokeh: {
    label: 'Bokeh',
    hint: 'out-of-focus discs drifting',
    colors: ['#17c8f4', '#f472b6', '#123b66'],
    speed: 0.7,
    glow: 1.1,
    scale: 1,
    warp: 0.8,
    opacity: 0.85,
    solid: false,
    res: 0.75,
  },
  mesh: {
    label: 'Mesh gradient',
    hint: 'soft colour blobs, very slow',
    colors: ['#7c3aed', '#17c8f4', '#06121f'],
    speed: 0.5,
    glow: 0.9,
    scale: 0.8,
    warp: 0.6,
    opacity: 1,
    solid: true,
    res: 0.5,
  },
  caustics: {
    noise: true,
    label: 'Caustics',
    hint: 'pool light on the floor',
    colors: ['#17c8f4', '#eaf6f9', '#06121f'],
    speed: 0.9,
    glow: 1,
    scale: 1,
    warp: 0.9,
    opacity: 0.9,
    solid: true,
    res: 0.75,
  },
  truchet: {
    label: 'Truchet arcs',
    hint: 'arc wards wired into a maze',
    colors: ['#17c8f4', '#00ffa3', '#7c3aed'],
    speed: 1,
    glow: 1,
    scale: 1,
    warp: 0.5,
    opacity: 0.85,
    solid: false,
    res: 1,
  },
  moire: {
    noise: true,
    label: 'Interference',
    hint: 'ring sources beating together',
    colors: ['#17c8f4', '#f472b6', '#7c3aed'],
    speed: 0.8,
    glow: 1.1,
    scale: 1,
    warp: 0.6,
    opacity: 0.85,
    solid: false,
    res: 0.5,
  },
  dunes: {
    noise: true,
    label: 'Dunes',
    hint: 'layered ridges, parallax drift',
    colors: ['#17c8f4', '#7c3aed', '#02060d'],
    speed: 0.5,
    glow: 0.9,
    scale: 1,
    warp: 0.8,
    opacity: 1,
    solid: true,
    res: 0.75,
  },
  bars: {
    label: 'Equaliser',
    hint: 'columns on their own beat',
    colors: ['#17c8f4', '#00ffa3', '#eaf6f9'],
    speed: 1,
    glow: 1.1,
    scale: 1,
    warp: 0.7,
    opacity: 0.85,
    solid: false,
    res: 0.75,
  },
  hex: {
    label: 'Honeycomb',
    hint: 'hex lattice, a lit wave crossing',
    colors: ['#17c8f4', '#7c3aed', '#eaf6f9'],
    speed: 0.9,
    glow: 1,
    scale: 1,
    warp: 0.4,
    opacity: 0.9,
    solid: false,
    res: 1,
  },
};

/** The background and brand knobs are NOT part of a preset — a preset picks
 *  the background kind, and the knobs default off SCENES / IMAGE_DEFAULTS /
 *  BRAND_DEFAULTS. A wordmark is the user's, not the preset's. */
type BgKnob =
  | 'uiFont'
  | 'iconSet' | 'iconStyle' | 'weatherIcons' | 'iconTint' | 'iconColor' | 'iconOpacity' | 'iconSize' | 'iconStroke'
  | 'brandText' | 'brandFont' | 'brandSize' | 'brandWeight' | 'brandTrack'
  | 'brandCustom' | 'brandColor' | 'brandGlow' | 'brandShadow'
  | 'brandLogo' | 'brandLogoSize' | 'brandPos'
  | 'bgImage' | 'bgBlur' | 'bgDim' | 'bgSat' | 'bgBright' | 'bgZoom' | 'bgFixed'
  | 'bgScene' | 'bgColor1' | 'bgColor2' | 'bgColor3'
  | 'bgSpeed' | 'bgGlow' | 'bgScale' | 'bgWarp' | 'bgParallax' | 'bgOpacity'
  | 'hdrScene' | 'hdrColor1' | 'hdrColor2' | 'hdrColor3'
  | 'hdrSpeed' | 'hdrGlow' | 'hdrScale' | 'hdrWarp' | 'hdrOpacity'
  | 'bgRes' | 'bgFps' | 'bgDetail' | 'hdrRes' | 'hdrFps' | 'hdrDetail' | 'gfxGovern' | 'gfxHiDpi';

interface PresetDef extends Omit<ThemeConfig, 'mode' | BgKnob> {
  label: string;
  /** Extra token overrides merged into the style attribute. */
  tokens?: Record<string, string>;
}

/** The stock dark palette, as the starting point for the colour pickers.
 *  surfaceCustom off means these are never emitted — frost.css owns the
 *  light/dark pair until the user opts in. */
const SURFACE_STOCK = {
  surfaceCustom: false,
  surface: '#0d1b2e',
  surface2: '#060d18',
  line: '#16283f',
} as const;

/** Header chrome that is the same across presets. alpha/blur are NOT here:
 *  they used to come from the [data-glass] rule, so each preset restates the
 *  pair that reproduces its old header. */
const HEADER_STOCK = {
  hdrCustom: false,
  hdrBg: '#060d18',
  hdrBorder: 1,
  hdrHalo: 0,
  hdrSweep: 0,
  hdrPad: 0.625,
} as const;

export const PRESETS: Record<ThemePreset, PresetDef> = {
  frost: {
    label: 'Frost',
    preset: 'frost',
    accent: '#17c8f4',
    glassAlpha: 1,
    glassBlur: 0,
    radius: 0.5,
    density: 'cozy',
    background: 'flat',
    ...SURFACE_STOCK,
    border: 1,
    rim: 0,
    shadow: 0,
    ...HEADER_STOCK,
    hdrAlpha: 0.85,
    hdrBlur: 8,
  },
  glass: {
    label: 'Liquid Glass',
    preset: 'glass',
    accent: '#17c8f4',
    glassAlpha: 0.62,
    glassBlur: 16,
    radius: 0.75,
    density: 'cozy',
    background: 'aurora',
    ...SURFACE_STOCK,
    border: 1,
    rim: 0.4,
    shadow: 0.35,
    ...HEADER_STOCK,
    hdrAlpha: 0.62,
    hdrBlur: 16,
  },
  oled: {
    label: 'OLED',
    preset: 'oled',
    accent: '#17c8f4',
    glassAlpha: 1,
    glassBlur: 0,
    radius: 0.5,
    density: 'cozy',
    background: 'flat',
    surfaceCustom: false,
    surface: '#050505',
    surface2: '#000000',
    line: '#1c1c1f',
    border: 1,
    rim: 0,
    shadow: 0,
    ...HEADER_STOCK,
    hdrBg: '#000000',
    hdrAlpha: 0.85,
    hdrBlur: 8,
    // Knob names, not --color-*: themeStyle emits these BEFORE the user's own
    // picks, so an explicit pick in the same style attribute still wins.
    tokens: {
      '--fd-surface': 'light-dark(#ffffff, #050505)',
      '--fd-surface-2': 'light-dark(#f4f4f5, #000000)',
      '--fd-line': 'light-dark(#e4e4e7, #1c1c1f)',
      '--color-line-strong': 'light-dark(#d4d4d8, #2c2c30)',
    },
  },
};

/** The fields a preset owns — everything in PresetDef that is a knob. */
export const PRESET_KNOBS = [
  'accent', 'glassAlpha', 'glassBlur', 'radius', 'density', 'background',
  'surfaceCustom', 'surface', 'surface2', 'line', 'border', 'rim', 'shadow',
  'hdrCustom', 'hdrBg', 'hdrAlpha', 'hdrBlur', 'hdrBorder', 'hdrHalo', 'hdrSweep', 'hdrPad',
] as const;

/** Switch preset WITHOUT discarding the user's own picks: a knob rolls to the
 *  new preset's value only while it still holds the outgoing preset's. A
 *  header, a background or an accent the user set is theirs and survives. */
export function rollPreset(cfg: ThemeConfig, next: ThemePreset): ThemeConfig {
  const from = PRESETS[cfg.preset];
  const to = PRESETS[next];
  const out: ThemeConfig = { ...cfg, preset: next };
  for (const k of PRESET_KNOBS) {
    if (cfg[k] === from[k]) (out[k] as unknown) = to[k];
  }
  return out;
}

const DENSITY_SPACING: Record<ThemeDensity, string> = {
  compact: '0.225rem',
  cozy: '0.25rem',
  comfortable: '0.275rem',
};

export const IMAGE_DEFAULTS = {
  blur: 0,
  dim: 0.35,
  sat: 1,
  bright: 1,
  zoom: 1.06,
  fixed: true,
  opacity: 1,
} as const;

/** THE font catalogue — the wordmark, the dashboard text and per-ward
 *  overrides all pick from this one list.
 *
 *  A `google` entry is downloaded at build time and served from our own origin:
 *  astro.config.mjs BUILDS ITS `experimental.fonts` FROM THIS OBJECT, so a face
 *  added here is registered automatically and `var(--font-<id>)` resolves. The
 *  system stacks cost no request at all and are the defaults.
 *
 *  Weights are the axis the Weight knob slides along: a range for a variable
 *  face, an explicit list for a static one (asking a static family for a range
 *  fails the build, which is the right way to find out). */
export interface FontDef {
  label: string;
  cat: FontCat;
  /** System stacks only — a downloaded face resolves through its variable. */
  stack?: string;
  google?: {
    name: string;
    weights: string[];
    fallback: 'sans-serif' | 'serif' | 'monospace' | 'cursive';
    /** Families to try BEFORE the download — for a face most machines already
     *  have, where the downloaded one is only the stand-in. */
    local?: string;
  };
}

const sys = (label: string, stack: string): FontDef => ({ label, cat: 'system', stack });
const web = (
  label: string,
  cat: FontCat,
  name: string,
  weights: string[],
  fallback: 'sans-serif' | 'serif' | 'monospace' | 'cursive' = 'sans-serif',
  local?: string
): FontDef => ({ label, cat, google: { name, weights, fallback, local } });

export const FONTS = {
  // --- already on the device ---
  ui: sys('System', 'ui-sans-serif, system-ui, sans-serif'),
  geometric: sys('Geometric', 'Futura, "Avenir Next", "Century Gothic", system-ui, sans-serif'),
  round: sys('Rounded', 'ui-rounded, "SF Pro Rounded", Quicksand, system-ui, sans-serif'),
  condensed: sys('Condensed', '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif'),
  serif: sys('Serif', 'ui-serif, Georgia, "Times New Roman", serif'),
  mono: sys('Mono', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'),

  // --- sans ---
  inter: web('Inter', 'sans', 'Inter', ['100 900']),
  roboto: web('Roboto', 'sans', 'Roboto', ['100 900']),
  opensans: web('Open Sans', 'sans', 'Open Sans', ['300 800']),
  montserrat: web('Montserrat', 'sans', 'Montserrat', ['100 900']),
  poppins: web('Poppins', 'sans', 'Poppins', ['300', '400', '500', '600', '700']),
  nunito: web('Nunito', 'sans', 'Nunito', ['200 1000']),
  worksans: web('Work Sans', 'sans', 'Work Sans', ['100 900']),
  dmsans: web('DM Sans', 'sans', 'DM Sans', ['100 1000']),
  manrope: web('Manrope', 'sans', 'Manrope', ['200 800']),
  jakarta: web('Plus Jakarta Sans', 'sans', 'Plus Jakarta Sans', ['200 800']),
  outfit: web('Outfit', 'sans', 'Outfit', ['100 900']),
  grotesk: web('Space Grotesk', 'sans', 'Space Grotesk', ['300 700']),
  rubik: web('Rubik', 'sans', 'Rubik', ['300 900']),
  quicksand: web('Quicksand', 'sans', 'Quicksand', ['300 700']),
  oswald: web('Oswald', 'sans', 'Oswald', ['200 700']),

  // --- serif ---
  playfair: web('Playfair Display', 'serif', 'Playfair Display', ['400 900'], 'serif'),
  merriweather: web('Merriweather', 'serif', 'Merriweather', ['300', '400', '700', '900'], 'serif'),
  lora: web('Lora', 'serif', 'Lora', ['400 700'], 'serif'),
  sourceserif: web('Source Serif 4', 'serif', 'Source Serif 4', ['200 900'], 'serif'),
  cormorant: web('Cormorant Garamond', 'serif', 'Cormorant Garamond', ['300', '400', '500', '600', '700'], 'serif'),
  ebgaramond: web('EB Garamond', 'serif', 'EB Garamond', ['400 800'], 'serif'),
  crimson: web('Crimson Pro', 'serif', 'Crimson Pro', ['200 900'], 'serif'),
  zilla: web('Zilla Slab', 'serif', 'Zilla Slab', ['300', '400', '500', '600', '700'], 'serif'),

  // --- mono ---
  jetbrains: web('JetBrains Mono', 'mono', 'JetBrains Mono', ['100 800'], 'monospace'),
  firacode: web('Fira Code', 'mono', 'Fira Code', ['300 700'], 'monospace'),
  plexmono: web('IBM Plex Mono', 'mono', 'IBM Plex Mono', ['400', '500', '600', '700'], 'monospace'),
  spacemono: web('Space Mono', 'mono', 'Space Mono', ['400', '700'], 'monospace'),
  robotomono: web('Roboto Mono', 'mono', 'Roboto Mono', ['100 700'], 'monospace'),

  // --- display ---
  orbitron: web('Orbitron', 'display', 'Orbitron', ['400 900']),
  bebas: web('Bebas Neue', 'display', 'Bebas Neue', ['400']),
  anton: web('Anton', 'display', 'Anton', ['400']),
  righteous: web('Righteous', 'display', 'Righteous', ['400']),
  audiowide: web('Audiowide', 'display', 'Audiowide', ['400']),
  michroma: web('Michroma', 'display', 'Michroma', ['400']),
  chakra: web('Chakra Petch', 'display', 'Chakra Petch', ['300', '400', '500', '600', '700']),
  rajdhani: web('Rajdhani', 'display', 'Rajdhani', ['300', '400', '500', '600', '700']),
  exo: web('Exo 2', 'display', 'Exo 2', ['100 900']),
  fredoka: web('Fredoka', 'display', 'Fredoka', ['300 700']),
  baloo: web('Baloo 2', 'display', 'Baloo 2', ['400 800']),
  lobster: web('Lobster', 'display', 'Lobster', ['400']),
  // The real thing where the machine has it (most do), Comic Neue as the
  // stand-in everywhere else — and a browser never downloads the stand-in
  // when the local family is already there.
  comic: web('Comic Sans', 'display', 'Comic Neue', ['300', '400', '700'], 'cursive', '"Comic Sans MS", "Chalkboard SE"'),

  // --- handwriting ---
  pacifico: web('Pacifico', 'hand', 'Pacifico', ['400']),
  caveat: web('Caveat', 'hand', 'Caveat', ['400 700']),
  dancing: web('Dancing Script', 'hand', 'Dancing Script', ['400 700']),
  marker: web('Permanent Marker', 'hand', 'Permanent Marker', ['400']),
} satisfies Record<string, FontDef>;

export const FONT_IDS = Object.keys(FONTS) as FontId[];

/** The CSS font-family value for a face. A downloaded one resolves through the
 *  variable astro.config.mjs registers for it (which already carries its own
 *  generic fallback).
 *
 *  The `, sans-serif` INSIDE the var() is not decoration: a declaration holding
 *  an unresolvable var() is invalid at computed-value time and is dropped
 *  WHOLE, so without it a face that has not arrived yet (fonts.ts is fetching
 *  it) would drop the page to the browser's default serif rather than to the
 *  generic we asked for. */
export const fontStack = (id: FontId): string => {
  const f = FONTS[id];
  if (!f.google) return f.stack!;
  const v = `var(--font-${id}, ${f.google.fallback})`;
  return f.google.local ? `${f.google.local}, ${v}` : v;
};

/** The CSS variable a downloaded face resolves through; null for a system stack. */
export const fontVar = (id: FontId): string | null => (FONTS[id].google ? `--font-${id}` : null);

/** The twin of every downloaded face, subset to the label glyphs — what a
 *  PICKER row renders in. Registered in astro.config.mjs beside the real one. */
export const previewVar = (id: FontId): string | null => (FONTS[id].google ? `--font-${id}-p` : null);

/** The font-family a picker row uses: the tiny subset, then the real face (for
 *  whatever the page is already painting), then the generic. NESTED fallbacks,
 *  not a comma list — see fontStack: one undefined var in a list would throw
 *  the whole declaration away, subset and all. */
export const previewStack = (id: FontId): string => {
  const f = FONTS[id];
  if (!f.google) return f.stack!;
  const v = `var(--font-${id}-p, var(--font-${id}, ${f.google.fallback}))`;
  return f.google.local ? `${f.google.local}, ${v}` : v;
};

/** The only characters a preview face has to carry: the ones in the labels it
 *  renders. Derived, so a new font's letters are covered automatically —
 *  ~50 glyphs instead of a full charset is 3KB a face instead of 35KB. */
export const PREVIEW_GLYPHS = [...new Set(Object.values(FONTS).map((f) => f.label).join(''))];

/** Picker order: the catalogue's own order, grouped. */
export const FONT_GROUPS: { label: string; cat: FontCat }[] = [
  { label: 'Sans', cat: 'sans' },
  { label: 'Display', cat: 'display' },
  { label: 'Serif', cat: 'serif' },
  { label: 'Mono', cat: 'mono' },
  { label: 'Handwriting', cat: 'hand' },
  { label: 'Already on the device', cat: 'system' },
];

/** The stock brand — these values reproduce the bar as it shipped, and are
 *  the fallback for a theme saved before the knobs existed. */
export const BRAND_DEFAULTS = {
  text: 'RIMEWARD',
  font: 'ui' as FontId,
  size: 0.875,
  weight: 700,
  track: 0.25,
  custom: false,
  color: '#ffffff',
  glow: 0,
  shadow: 0,
  logo: '',
  logoSize: 1.75,
  pos: 'left' as BrandPos,
} as const;

/** Longer than this is not a wordmark, it is a sentence in the header. */
const BRAND_MAX = 24;

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const hex = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
/** Form checkboxes arrive as 'on'; JSON round-trips as a real boolean. */
const bool = (v: unknown, fallback: boolean): boolean =>
  v === undefined || v === null ? fallback : v === true || v === 'true' || v === 'on' || v === '1';
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Form values are strings — '24' is 24 — and anything off the list is the default. */
const fps = (v: unknown): Fps => (FPS_OPTIONS.includes(Number(v) as Fps) ? (Number(v) as Fps) : GFX_DEFAULTS.fps);

export const SCENE_IDS = Object.keys(SCENES) as SceneId[];

/** id → the int bg-shaders branches on, and the ONE place that mapping lives:
 *  bg-scene.ts renders from it and scene-thumbs.ts draws its stills from it.
 *  Kept explicit rather than derived from SCENES order, because the shader's
 *  `if (uScene == n)` chain is the real authority — a reorder of the catalogue
 *  must not silently repoint a scene at another preset's branch. */
export const SCENE_INDEX: Record<SceneId, number> = {
  aurora: 0, nebula: 1, waves: 2, orbs: 3, starfield: 4, grid: 5,
  silk: 6, cells: 7, rain: 8, swirl: 9, bokeh: 10, mesh: 11,
  caustics: 12, truchet: 13, moire: 14, dunes: 15, bars: 16, hex: 17,
};

/** The banner box is roughly 10:1 where the page background is 16:9, and the
 *  shaders scale features off the aspect-corrected coordinate — the same scale
 *  value therefore repeats ~5x more often across a header and reads as noise.
 *  A banner starts this much coarser; the Scale knob tunes from there. */
export const HDR_SCALE = 0.35;

/** Build a complete, clamped ThemeConfig from any partial/untrusted object. */
export function normalizeTheme(raw: Record<string, unknown>): ThemeConfig {
  const preset = pick(raw.preset, ['frost', 'glass', 'oled'], 'frost');
  const base = PRESETS[preset];
  const scene = pick(raw.bgScene, SCENE_IDS, 'aurora');
  const sd = SCENES[scene];
  // The header banner reuses the background's scene catalogue wholesale, so
  // its knobs default off the SAME SceneDef the background's do.
  const hscene = pick(raw.hdrScene, ['none', ...SCENE_IDS] as HeaderScene[], 'none');
  const hd = SCENES[hscene === 'none' ? 'aurora' : hscene];
  const isImage = raw.background === 'image';
  const iconSet = pick(raw.iconSet, GENERAL_ICON_SETS, 'emoji');
  const styles = Object.keys(ICON_SETS[iconSet].styles);
  return {
    mode: pick(raw.mode, ['dark', 'light', 'system'], 'dark'),
    uiFont: pick(raw.uiFont, FONT_IDS, 'ui'),
    preset,
    accent: typeof raw.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toLowerCase() : base.accent,
    glassAlpha: Math.round(clamp(raw.glassAlpha, 0.3, 1, base.glassAlpha) * 100) / 100,
    glassBlur: Math.round(clamp(raw.glassBlur, 0, 30, base.glassBlur)),
    radius: Math.round(clamp(raw.radius, 0, 1.25, base.radius) * 100) / 100,
    density: pick(raw.density, ['compact', 'cozy', 'comfortable'], base.density),
    background: pick(raw.background, ['flat', 'aurora', 'image', 'scene'], base.background),

    surfaceCustom: bool(raw.surfaceCustom, base.surfaceCustom),
    surface: hex(raw.surface, base.surface),
    surface2: hex(raw.surface2, base.surface2),
    line: hex(raw.line, base.line),
    border: r2(clamp(raw.border, 0, 4, base.border)),
    rim: r2(clamp(raw.rim, 0, 1, base.rim)),
    shadow: r2(clamp(raw.shadow, 0, 1, base.shadow)),

    hdrCustom: bool(raw.hdrCustom, base.hdrCustom),
    hdrBg: hex(raw.hdrBg, base.hdrBg),
    hdrAlpha: r2(clamp(raw.hdrAlpha, 0.2, 1, base.hdrAlpha)),
    hdrBlur: Math.round(clamp(raw.hdrBlur, 0, 30, base.hdrBlur)),
    hdrBorder: r2(clamp(raw.hdrBorder, 0, 4, base.hdrBorder)),
    hdrHalo: r2(clamp(raw.hdrHalo, 0, 1, base.hdrHalo)),
    hdrSweep: r2(clamp(raw.hdrSweep, 0, 1, base.hdrSweep)),
    hdrPad: r3(clamp(raw.hdrPad, 0.25, 1.5, base.hdrPad)),

    hdrScene: hscene,
    hdrColor1: hex(raw.hdrColor1, hd.colors[0]),
    hdrColor2: hex(raw.hdrColor2, hd.colors[1]),
    hdrColor3: hex(raw.hdrColor3, hd.colors[2]),
    hdrSpeed: r2(clamp(raw.hdrSpeed, 0, 3, hd.speed)),
    hdrGlow: r2(clamp(raw.hdrGlow, 0, 2, hd.glow)),
    hdrScale: r2(clamp(raw.hdrScale, 0.25, 4, r2(hd.scale * HDR_SCALE))),
    hdrWarp: r2(clamp(raw.hdrWarp, 0, 2, hd.warp)),
    hdrOpacity: r2(clamp(raw.hdrOpacity, 0.05, 1, hd.opacity)),
    hdrRes: r2(clamp(raw.hdrRes, 0.25, 1, hd.res)),
    hdrFps: fps(raw.hdrFps),
    hdrDetail: Math.round(clamp(raw.hdrDetail, DETAIL_MIN, DETAIL_MAX, GFX_DEFAULTS.detail)),

    // The wordmark is the one free-text knob: it is rendered as TEXT (never
    // markup, never CSS), so stripping control characters and capping the
    // length is all it needs.
    brandText:
      typeof raw.brandText === 'string'
        ? raw.brandText.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, BRAND_MAX)
        : BRAND_DEFAULTS.text,
    brandFont: pick(raw.brandFont, FONT_IDS, BRAND_DEFAULTS.font),
    brandSize: r3(clamp(raw.brandSize, 0.6, 2.5, BRAND_DEFAULTS.size)),
    brandWeight: Math.round(clamp(raw.brandWeight, 100, 900, BRAND_DEFAULTS.weight) / 100) * 100,
    brandTrack: r2(clamp(raw.brandTrack, 0, 0.5, BRAND_DEFAULTS.track)),
    brandCustom: bool(raw.brandCustom, BRAND_DEFAULTS.custom),
    brandColor: hex(raw.brandColor, BRAND_DEFAULTS.color),
    brandGlow: r2(clamp(raw.brandGlow, 0, 1, BRAND_DEFAULTS.glow)),
    brandShadow: r2(clamp(raw.brandShadow, 0, 1, BRAND_DEFAULTS.shadow)),
    // Same store, same validation as a background photo: '' is the built-in
    // mark, anything else must be a store-shaped name (the /api/bg route
    // re-checks the owner prefix before it serves a byte).
    brandLogo: typeof raw.brandLogo === 'string' && BG_NAME_RE.test(raw.brandLogo) ? raw.brandLogo : '',
    brandLogoSize: r2(clamp(raw.brandLogoSize, 0, 3, BRAND_DEFAULTS.logoSize)),
    brandPos: pick(raw.brandPos, ['left', 'center', 'right'], BRAND_DEFAULTS.pos),

    // A name that does not match the store's shape never reaches a CSS url().
    bgImage: typeof raw.bgImage === 'string' && BG_NAME_RE.test(raw.bgImage) ? raw.bgImage : '',
    bgBlur: Math.round(clamp(raw.bgBlur, 0, 60, IMAGE_DEFAULTS.blur)),
    bgDim: r2(clamp(raw.bgDim, 0, 0.95, IMAGE_DEFAULTS.dim)),
    bgSat: r2(clamp(raw.bgSat, 0, 2, IMAGE_DEFAULTS.sat)),
    bgBright: r2(clamp(raw.bgBright, 0.2, 1.8, IMAGE_DEFAULTS.bright)),
    bgZoom: r2(clamp(raw.bgZoom, 1, 1.6, IMAGE_DEFAULTS.zoom)),
    bgFixed: bool(raw.bgFixed, IMAGE_DEFAULTS.fixed),

    bgScene: scene,
    bgColor1: hex(raw.bgColor1, sd.colors[0]),
    bgColor2: hex(raw.bgColor2, sd.colors[1]),
    bgColor3: hex(raw.bgColor3, sd.colors[2]),
    bgSpeed: r2(clamp(raw.bgSpeed, 0, 3, sd.speed)),
    bgGlow: r2(clamp(raw.bgGlow, 0, 2, sd.glow)),
    bgScale: r2(clamp(raw.bgScale, 0.25, 4, sd.scale)),
    bgWarp: r2(clamp(raw.bgWarp, 0, 2, sd.warp)),
    bgParallax: r2(clamp(raw.bgParallax, 0, 1, 0.3)),
    bgRes: r2(clamp(raw.bgRes, 0.25, 1, sd.res)),
    bgFps: fps(raw.bgFps),
    bgDetail: Math.round(clamp(raw.bgDetail, DETAIL_MIN, DETAIL_MAX, GFX_DEFAULTS.detail)),
    gfxGovern: bool(raw.gfxGovern, GFX_DEFAULTS.govern),
    gfxHiDpi: bool(raw.gfxHiDpi, GFX_DEFAULTS.hidpi),
    bgOpacity: r2(clamp(raw.bgOpacity, 0.05, 1, isImage ? IMAGE_DEFAULTS.opacity : sd.opacity)),

    iconSet,
    iconStyle: pick(raw.iconStyle, styles, styles[0] ?? ''),
    weatherIcons: pick(raw.weatherIcons, WEATHER_ICONS, 'follow'),
    iconTint: pick(raw.iconTint, ['ink', 'accent', 'custom'], 'ink'),
    iconColor: hex(raw.iconColor, '#ffffff'),
    iconOpacity: r2(clamp(raw.iconOpacity, 0.1, 1, 1)),
    iconSize: r2(clamp(raw.iconSize, 0.5, 2, 1)),
    iconStroke: r2(clamp(raw.iconStroke, 0.5, 4, 2)),
  };
}

/** The slice of a theme the icon renderers read (stamped on <html data-icons>). */
export function iconConfig(cfg: ThemeConfig): IconCfg {
  return { set: cfg.iconSet, style: cfg.iconStyle, stroke: cfg.iconStroke, weather: cfg.weatherIcons };
}

/* -------------------------------------------------------------- ward theme */

/** A per-ward theme: the card-scoped slice of a ThemeConfig. Every field is
 *  optional and an absent one inherits the page, so a ward stores only what it
 *  actually overrides. Nothing page-shaped (background, header chrome, the
 *  wordmark) is here — a card has nowhere to put it.
 *
 *  The DERIVATION is the same one the page uses: frost.css reads these knobs
 *  under `[data-ward-theme]` exactly as it reads them under `:root[data-themed]`,
 *  and because custom properties resolve per element, a card's own utilities
 *  (bg-surface, border-line, rounded-lg) pick up its values with no extra rules. */
export interface WardTheme {
  font?: FontId;
  /** Flips every light-dark() inside the card — a light ward on a dark board. */
  mode?: 'dark' | 'light';
  /** #rrggbb */
  accent?: string;
  /** #rrggbb — the card's own background; ink derives from it. */
  surface?: string;
  /** #rrggbb — its border. */
  line?: string;
  radius?: number;
  border?: number;
  rim?: number;
  shadow?: number;
  glassAlpha?: number;
  glassBlur?: number;
  density?: ThemeDensity;
}

/** Present-and-valid, or gone: unlike the page theme there is no fallback to
 *  fall back TO — an absent knob means "whatever the dashboard says". */
const opt = <T>(v: unknown, read: (v: unknown) => T | undefined): T | undefined =>
  v === undefined || v === null || v === '' ? undefined : read(v);
const optNum = (v: unknown, lo: number, hi: number, round = r2): number | undefined =>
  opt(v, (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? round(Math.min(Math.max(n, lo), hi)) : undefined;
  });
const optHex = (v: unknown): string | undefined =>
  opt(v, (x) => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : undefined));

/** Build a WardTheme from untrusted input. Undefined when nothing survives —
 *  an empty override is not an override, and must not be stored as one. */
export function normalizeWardTheme(raw: unknown): WardTheme | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const t: WardTheme = {
    font: opt(r.font, (v) => (FONT_IDS as string[]).includes(v as string) ? (v as FontId) : undefined),
    mode: opt(r.mode, (v) => (v === 'dark' || v === 'light' ? v : undefined)),
    accent: optHex(r.accent),
    surface: optHex(r.surface),
    line: optHex(r.line),
    radius: optNum(r.radius, 0, 1.25),
    border: optNum(r.border, 0, 4),
    rim: optNum(r.rim, 0, 1),
    shadow: optNum(r.shadow, 0, 1),
    glassAlpha: optNum(r.glassAlpha, 0.3, 1),
    glassBlur: optNum(r.glassBlur, 0, 30, Math.round),
    density: opt(r.density, (v) =>
      v === 'compact' || v === 'cozy' || v === 'comfortable' ? (v as ThemeDensity) : undefined
    ),
  };
  for (const k of Object.keys(t) as (keyof WardTheme)[]) if (t[k] === undefined) delete t[k];
  return Object.keys(t).length ? t : undefined;
}

/** The knob values as a style attribute — the ward half of themeStyle(). */
export function wardThemeStyle(t: WardTheme): string {
  const parts: string[] = [];
  if (t.font) parts.push(`--fd-ui-font: ${fontStack(t.font)}`);
  if (t.accent) parts.push(`--fd-accent: ${t.accent}`);
  if (t.surface) parts.push(`--fd-surface: ${t.surface}`);
  if (t.line) parts.push(`--fd-line: ${t.line}`);
  if (t.radius !== undefined) {
    parts.push(
      `--radius-md: ${r3(t.radius * 0.75)}rem`,
      `--radius-lg: ${r3(t.radius)}rem`,
      `--radius-xl: ${r3(t.radius * 1.5)}rem`
    );
  }
  if (t.border !== undefined) parts.push(`--fd-border: ${t.border}px`);
  if (t.rim !== undefined) parts.push(`--fd-rim: ${t.rim}`);
  if (t.shadow !== undefined) parts.push(`--fd-shadow: ${t.shadow}`);
  if (t.glassAlpha !== undefined) parts.push(`--fd-glass-alpha: ${Math.round(t.glassAlpha * 100)}%`);
  if (t.glassBlur !== undefined) parts.push(`--fd-glass-blur: ${t.glassBlur}px`);
  if (t.density) parts.push(`--spacing: ${DENSITY_SPACING[t.density]}`);
  return parts.join('; ');
}

/** Every custom property wardThemeStyle can emit. The client writer clears
 *  these before writing its own: a card's style attribute also carries layout
 *  values (--wd-h, the entrance delay) that must survive a theme edit. */
export const WARD_STYLE_PROPS = [
  '--fd-ui-font', '--fd-accent', '--fd-surface', '--fd-line',
  '--radius-md', '--radius-lg', '--radius-xl',
  '--fd-border', '--fd-rim', '--fd-shadow',
  '--fd-glass-alpha', '--fd-glass-blur', '--spacing',
] as const;

/** Attributes for the card. Server (Ward.astro) and client (edit.ts
 *  stampWardTheme) must stay symmetric with this — one derivation, two writers. */
export function wardThemeAttrs(t: WardTheme | undefined): Record<string, string> {
  if (!t || !Object.keys(t).length) return {};
  const attrs: Record<string, string> = { 'data-ward-theme': '', style: wardThemeStyle(t) };
  // Same gates the page uses: ink only re-derives off a surface the ward
  // actually picked, and glass only exists where it was asked for.
  if (t.surface || t.line) attrs['data-ward-surfaced'] = '';
  if (t.glassAlpha !== undefined || t.glassBlur !== undefined) attrs['data-ward-glass'] = '';
  if (t.glassBlur) attrs['data-ward-glass-blur'] = '';
  if (t.mode) attrs['data-ward-mode'] = t.mode;
  return attrs;
}

/** The kind actually in force: 'image' with nothing picked is just 'flat'. */
export function bgKind(cfg: ThemeConfig): BackgroundKind {
  return cfg.background === 'image' && !cfg.bgImage ? 'flat' : cfg.background;
}

/** Scene knobs for the client (bg-scene.ts uniforms). Serialized onto <html>
 *  as data-bg-cfg for boot; the account editor passes the same shape live. */
export interface SceneConfig {
  scene: SceneId;
  colors: [string, string, string];
  speed: number;
  glow: number;
  scale: number;
  warp: number;
  parallax: number;
  opacity: number;
  // graphics
  res: number;
  fps: Fps;
  detail: number;
  govern: boolean;
  hidpi: boolean;
}

/** A SceneConfig at the catalogue's own defaults — the ward scene ward. */
export function sceneDefaults(scene: SceneId): SceneConfig {
  const d = SCENES[scene];
  return { scene, colors: d.colors, speed: d.speed, glow: d.glow, scale: d.scale, warp: d.warp, parallax: 0, opacity: d.opacity, res: d.res, ...GFX_DEFAULTS };
}

export function sceneConfig(cfg: ThemeConfig): SceneConfig {
  return {
    scene: cfg.bgScene,
    colors: [cfg.bgColor1, cfg.bgColor2, cfg.bgColor3],
    speed: cfg.bgSpeed,
    glow: cfg.bgGlow,
    scale: cfg.bgScale,
    warp: cfg.bgWarp,
    parallax: cfg.bgParallax,
    opacity: cfg.bgOpacity,
    res: cfg.bgRes,
    fps: cfg.bgFps,
    detail: cfg.bgDetail,
    govern: cfg.gfxGovern,
    hidpi: cfg.gfxHiDpi,
  };
}

/** The header banner as a SceneConfig — null when the banner is off. Identical
 *  shape to sceneConfig(), so bg-scene.ts renders both with no branching.
 *  Parallax is fixed at 0: a 3rem-tall bar has nowhere to parallax to. */
export function headerSceneConfig(cfg: ThemeConfig): SceneConfig | null {
  if (cfg.hdrScene === 'none') return null;
  return {
    scene: cfg.hdrScene,
    colors: [cfg.hdrColor1, cfg.hdrColor2, cfg.hdrColor3],
    speed: cfg.hdrSpeed,
    glow: cfg.hdrGlow,
    scale: cfg.hdrScale,
    warp: cfg.hdrWarp,
    parallax: 0,
    opacity: cfg.hdrOpacity,
    res: cfg.hdrRes,
    fps: cfg.hdrFps,
    detail: cfg.hdrDetail,
    govern: cfg.gfxGovern,
    hidpi: cfg.gfxHiDpi,
  };
}

/** users.theme JSON → config; null/garbage → null (stock theme). */
export function parseTheme(raw: string | null | undefined): ThemeConfig | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return normalizeTheme(obj as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** The knob values as CSS custom properties for a style attribute. */
export function themeStyle(cfg: ThemeConfig): string {
  // Preset tokens FIRST — a user pick below must be able to override them.
  const parts = Object.entries(PRESETS[cfg.preset].tokens ?? {}).map(([k, v]) => `${k}: ${v}`);
  parts.push(
    `--fd-accent: ${cfg.accent}`,
    `--fd-glass-alpha: ${Math.round(cfg.glassAlpha * 100)}%`,
    `--fd-glass-blur: ${cfg.glassBlur}px`,
    `--radius-md: ${r3(cfg.radius * 0.75)}rem`,
    `--radius-lg: ${r3(cfg.radius)}rem`,
    `--radius-xl: ${r3(cfg.radius * 1.5)}rem`,
    `--spacing: ${DENSITY_SPACING[cfg.density]}`,
    // Every bit of text on the page hangs off this one (frost.css `body`).
    `--fd-ui-font: ${fontStack(cfg.uiFont)}`,
    `--fd-border: ${cfg.border}px`,
    `--fd-rim: ${cfg.rim}`,
    `--fd-shadow: ${cfg.shadow}`,
    // The header used to take its alpha/blur from the [data-glass] rule; it
    // owns them now, so these are always emitted (presets restate the old pair).
    `--fd-hdr-alpha: ${Math.round(cfg.hdrAlpha * 100)}%`,
    `--fd-hdr-blur: ${cfg.hdrBlur}px`,
    `--fd-hdr-border: ${cfg.hdrBorder}px`,
    `--fd-hdr-halo: ${cfg.hdrHalo}`,
    `--fd-hdr-sweep: ${cfg.hdrSweep}`,
    `--fd-hdr-pad: ${cfg.hdrPad}rem`
  );
  if (cfg.hdrCustom) parts.push(`--fd-hdr-bg: ${cfg.hdrBg}`);
  parts.push(
    // The stack is ours — the user only picks a catalogue id.
    `--fd-brand-font: ${fontStack(cfg.brandFont)}`,
    `--fd-brand-size: ${cfg.brandSize}rem`,
    `--fd-brand-weight: ${cfg.brandWeight}`,
    `--fd-brand-track: ${cfg.brandTrack}em`,
    `--fd-brand-logo-size: ${cfg.brandLogoSize}rem`
  );
  if (cfg.brandCustom) parts.push(`--fd-brand-color: ${cfg.brandColor}`);
  // Only read under [data-brand-fx], so an untouched brand pays for no filter.
  if (cfg.brandGlow > 0 || cfg.brandShadow > 0) {
    parts.push(`--fd-brand-glow: ${cfg.brandGlow}`, `--fd-brand-shadow: ${cfg.brandShadow}`);
  }
  if (cfg.surfaceCustom) {
    parts.push(`--fd-surface: ${cfg.surface}`, `--fd-surface-2: ${cfg.surface2}`, `--fd-line: ${cfg.line}`);
  }
  const kind = bgKind(cfg);
  if (kind === 'image') {
    // bgImage passed BG_NAME_RE in normalizeTheme — safe inside url().
    parts.push(
      `--fd-bg-image: url("/api/bg/${cfg.bgImage}")`,
      `--fd-bg-blur: ${cfg.bgBlur}px`,
      `--fd-bg-dim: ${Math.round(cfg.bgDim * 100)}%`,
      `--fd-bg-sat: ${cfg.bgSat}`,
      `--fd-bg-bright: ${cfg.bgBright}`,
      `--fd-bg-zoom: ${cfg.bgZoom}`,
      `--fd-bg-pos: ${cfg.bgFixed ? 'fixed' : 'absolute'}`
    );
  }
  if (kind !== 'flat') parts.push(`--fd-bg-opacity: ${cfg.bgOpacity}`);
  // Icons: the mask/img rules in frost.css read these; ink = no var at all,
  // so a stock icon inherits its text colour exactly as before.
  if (cfg.iconTint === 'accent') parts.push(`--fd-icon-color: var(--fd-accent)`);
  else if (cfg.iconTint === 'custom') parts.push(`--fd-icon-color: ${cfg.iconColor}`);
  if (cfg.iconOpacity < 1) parts.push(`--fd-icon-opacity: ${cfg.iconOpacity}`);
  if (cfg.iconSize !== 1) parts.push(`--fd-icon-size: ${cfg.iconSize}`);
  return parts.join('; ');
}

/** Attributes for <html>. Server (BaseLayout) and the live-preview editor
 *  must stay symmetric with this shape. */
export function themeHtmlAttrs(cfg: ThemeConfig | null): Record<string, string> {
  if (!cfg) return {};
  const attrs: Record<string, string> = {
    'data-themed': '',
    'data-mode': cfg.mode,
    style: themeStyle(cfg),
  };
  // dark is SSR'd for both dark and system; ThemeScript strips it pre-paint
  // for system users whose OS prefers light.
  if (cfg.mode !== 'light') attrs.class = 'dark';
  if (cfg.glassAlpha < 1 || cfg.glassBlur > 0) attrs['data-glass'] = '';
  // Separate gate: the translucent fill is free, the backdrop-filter is a
  // full pass over everything behind each surface. A glass theme with blur 0
  // must not pay it (frost.css splits the two rules on this).
  if (cfg.glassBlur > 0) attrs['data-glass-blur'] = '';
  // Gates the ink/line-strong derivation in frost.css off the picked surface.
  if (cfg.surfaceCustom) attrs['data-surfaced'] = '';
  const kind = bgKind(cfg);
  if (kind !== 'flat') attrs['data-bg'] = kind;
  // Only the three.js background needs JS; the image layer is pure CSS.
  if (kind === 'scene') attrs['data-bg-cfg'] = JSON.stringify(sceneConfig(cfg));
  // The sweep is a running CSS animation — gate it so a header that does not
  // use it never gets an animated pseudo-element at all.
  if (cfg.hdrSweep > 0) attrs['data-hdr-sweep'] = '';
  // Same idea for the brand: a filter and a re-ordered row only exist when
  // the user asked for one, so the stock header is byte-for-byte as it was.
  if (cfg.brandGlow > 0 || cfg.brandShadow > 0) attrs['data-brand-fx'] = '';
  if (cfg.brandPos !== 'left') attrs['data-brand-pos'] = cfg.brandPos;
  const hdr = headerSceneConfig(cfg);
  if (hdr) attrs['data-hdr-cfg'] = JSON.stringify(hdr);
  // Only stamped when something is fetched — an emoji theme renders as text
  // and never learns the attribute exists.
  if (cfg.iconSet !== 'emoji' || cfg.weatherIcons !== 'follow') attrs['data-icons'] = JSON.stringify(iconConfig(cfg));
  // Emoji cannot take `color`; under this gate frost.css draws them as a
  // flat silhouette in the tint instead (text-shadow trick).
  if (cfg.iconTint !== 'ink') attrs['data-icon-tint'] = '';
  return attrs;
}

/** <meta name="theme-color"> value. */
export function themeColor(cfg: ThemeConfig | null): string {
  if (cfg?.surfaceCustom) return cfg.surface2;
  if (cfg?.mode === 'light') return '#f3f7fb';
  if (cfg?.preset === 'oled') return '#000000';
  return '#06121f';
}
