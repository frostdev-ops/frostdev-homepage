// Static thumbnails for the scene pickers on /account.
//
// Renders every scene ONCE, at a fixed time offset, into ONE reused WebGL
// context, and stamps the result onto its <option data-preview> — which
// SearchSelect turns into the background of that option's row. No three: this
// is the same bg-shaders program bg-scene.ts runs, wired by hand against the
// raw WebGL API, because pulling ~466KB of three onto the account page for
// eighteen 264x72 stills would be absurd.
//
// It is a still, not an animation: one draw per scene, no rAF, no resize
// handling, and the context is thrown away when the last scene is done.
import { GFX_DEFAULTS, SCENES, SCENE_IDS, SCENE_INDEX, type SceneId } from '../../lib/theme.ts';
import { bgFrag, bgVert } from './bg-shaders.ts';

const W = 264;
const H = 72;
/** Far enough in that every preset has developed its shapes. */
const T = 9;
/** The row is a ~3.7:1 strip where the page is ~16:9, and the shaders scale
 *  features off the aspect-corrected coordinate — an unscaled preset reads as
 *  noise this small. Same reasoning as theme.ts's HDR_SCALE, less extreme. */
const THUMB_SCALE = 0.55;
/** The scenes are drawn over the dark page canvas (--color-surface-2 dark);
 *  the airy ones are mostly transparent and need something behind them. */
const BASE: [number, number, number] = [0.024, 0.051, 0.094];

const srgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
  return sh;
}

/** A throwaway WebGL program that draws any scene, once, at one size. Throws
 *  if WebGL is out. `draw` returns the frame as a data URI; `dispose` releases
 *  the context — the caller holds it for one batch of stills, never a frame. */
function stills(w: number, h: number): { draw(id: SceneId, scaleMul: number): string; dispose(): void } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // alpha:false so the clear colour composites the airy scenes for us;
  // preserveDrawingBuffer so toDataURL still sees the frame we drew.
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  }) as WebGLRenderingContext | null;
  if (!gl) throw new Error('no webgl');

  // sceneWaves/sceneGrid use fwidth(); three injects this for us at runtime.
  const deriv = gl.getExtension('OES_standard_derivatives');
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, `attribute vec3 position;\nattribute vec2 uv;\n${bgVert}`));
  gl.attachShader(
    prog,
    compile(gl, gl.FRAGMENT_SHADER, `${deriv ? '#extension GL_OES_standard_derivatives : enable\n' : ''}${bgFrag}`)
  );
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);

  // One clip-space quad: position.xy is already the vertex, uv the 0–1 corner.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0, 0,
     1, -1, 0, 1, 0,
    -1,  1, 0, 0, 1,
     1,  1, 0, 1, 1,
  ]), gl.STATIC_DRAW);
  for (const [name, size, offset] of [['position', 3, 0], ['uv', 2, 12]] as const) {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset);
  }

  const u = (name: string) => gl.getUniformLocation(prog, name);
  gl.uniform2f(u('uRes'), w, h);
  gl.uniform1f(u('uTime'), T);
  gl.uniform2f(u('uMouse'), 0, 0);
  gl.uniform1i(u('uDetail'), GFX_DEFAULTS.detail);
  gl.viewport(0, 0, w, h);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return {
    draw(id, scaleMul) {
      const d = SCENES[id];
      gl.uniform3fv(u('uC1'), srgb(d.colors[0]));
      gl.uniform3fv(u('uC2'), srgb(d.colors[1]));
      gl.uniform3fv(u('uC3'), srgb(d.colors[2]));
      gl.uniform1f(u('uGlow'), d.glow);
      gl.uniform1f(u('uScale'), d.scale * scaleMul);
      gl.uniform1f(u('uWarp'), d.warp);
      gl.uniform1f(u('uOpacity'), d.opacity);
      gl.uniform1i(u('uScene'), SCENE_INDEX[id]);
      gl.clearColor(BASE[0], BASE[1], BASE[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // webp where it encodes, PNG everywhere else (toDataURL falls back on its own).
      return canvas.toDataURL('image/webp', 0.8);
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Renders each scene once and returns id → data URI. Throws if WebGL is out. */
function renderAll(): Map<string, string> {
  const s = stills(W, H);
  const out = new Map<string, string>();
  for (const id of SCENE_IDS) out.set(id, s.draw(id, THUMB_SCALE));
  s.dispose();
  return out;
}

/** One scene, one frame, at the given size — what a spacer ward shows once
 *  the live-context budget (wards.ts MAX_LIVE_SCENES) is spent. Same look
 *  as the live ward: same shader, the preset's own scale. Throws without WebGL. */
export function sceneStill(id: SceneId, w: number, h: number): string {
  const s = stills(w, h);
  try {
    return s.draw(id, 1);
  } finally {
    s.dispose();
  }
}

/**
 * Stamps a preview onto every option of every `select[data-scene-preview]`.
 * Idempotent, idle-deferred, and completely optional — if anything about WebGL
 * fails the pickers keep working with no previews at all.
 */
export function paintScenePreviews(): void {
  const selects = document.querySelectorAll<HTMLSelectElement>('select[data-scene-preview]:not([data-scene-painted])');
  if (!selects.length) return;
  const run = () => {
    let thumbs: Map<string, string>;
    try {
      thumbs = renderAll();
    } catch {
      return; // no WebGL, no previews. The picker is unaffected.
    }
    for (const sel of selects) {
      sel.dataset.scenePainted = '1';
      for (const opt of sel.options) {
        const src = thumbs.get(opt.value);
        if (src) opt.dataset.preview = src;
      }
    }
  };
  // The panel is built when it is opened, so there is no rush — and no reason
  // to compete with the theme editor's own live scene for the GPU at boot.
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 300);
}
