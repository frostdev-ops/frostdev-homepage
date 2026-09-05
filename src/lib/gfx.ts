// The graphics knobs' cost model — pure, ships to the browser (the /account
// editor re-scores on every input) and is exercised by tests/gfx.test.ts.
//
// Two readings per knob: an IMPACT level 0–4 for the GPU and for a phone's
// battery at the knob's current value, and one LOAD number for the whole
// surface, relative to the scene's own defaults (1 = what the preset ships
// with). The levels are a rule of thumb, not a measurement: fragment work is
// pixels × frames × per-pixel cost, battery follows the same product but is
// punished harder by frame rate (every rendered frame also re-runs every
// glass backdrop-filter on the page) and by device-pixel rendering.
import { GFX_DEFAULTS, SCENES, type SceneConfig, type SceneId } from './theme.ts';

export type GfxKey = 'res' | 'fps' | 'detail' | 'govern' | 'hidpi';
export interface Impact {
  gpu: number;
  battery: number;
  /** Shown instead of the dots when the knob does nothing here. */
  note?: string;
}

const FPS_LEVEL: Record<number, number> = { 15: 1, 24: 2, 30: 3, 60: 4 };

/** Impact of ONE knob at its current value on a given scene. */
export function gfxImpact(key: GfxKey, cfg: SceneConfig): Impact {
  switch (key) {
    case 'res': {
      // Work is res², so 0.5 is a quarter of the pixels of 1.
      const lvl = Math.max(1, Math.ceil(cfg.res * 4 - 1e-9));
      return { gpu: lvl, battery: lvl };
    }
    case 'fps': {
      const lvl = FPS_LEVEL[cfg.fps] ?? 3;
      return { gpu: lvl, battery: Math.min(4, lvl + (cfg.fps >= 60 ? 0 : 0)) };
    }
    case 'detail': {
      if (!SCENES[cfg.scene].noise) return { gpu: 0, battery: 0, note: 'no effect on this scene' };
      const lvl = cfg.detail - 1; // 2→1 … 5→4
      return { gpu: lvl, battery: Math.max(1, lvl - 1) };
    }
    case 'govern':
      return cfg.govern ? { gpu: 0, battery: 0, note: 'steps down when frames run slow' } : { gpu: 0, battery: 0, note: 'never steps down — may run hot on phones' };
    case 'hidpi':
      return cfg.hidpi ? { gpu: 4, battery: 4 } : { gpu: 0, battery: 0, note: 'CSS pixels' };
  }
}

/** Fragment work per second relative to the scene's defaults: 1 = as shipped.
 *  `dpr` is the device's pixel ratio, so the hidpi factor is what THIS screen
 *  would pay (a 1× display pays nothing for it). */
export function gfxLoad(cfg: SceneConfig, dpr = 1): number {
  const d = SCENES[cfg.scene];
  const px = (cfg.res / d.res) ** 2;
  const frames = cfg.fps / GFX_DEFAULTS.fps;
  // fbm is ~half a noise scene's fetches; each octave is one more fetch per call.
  const detail = d.noise ? (4 + cfg.detail) / (4 + GFX_DEFAULTS.detail) : 1;
  const hidpi = cfg.hidpi ? Math.min(dpr, 2) ** 2 : 1;
  return px * frames * detail * hidpi;
}

/** The scene-default SceneConfig slice the load compares against. */
export const gfxDefaults = (scene: SceneId): Pick<SceneConfig, GfxKey> => ({ res: SCENES[scene].res, ...GFX_DEFAULTS });
