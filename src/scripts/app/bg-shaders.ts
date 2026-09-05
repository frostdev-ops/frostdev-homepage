// GLSL for the dashboard background scenes. One full-screen quad, one program:
// every preset is a branch on uScene, so switching presets is a uniform write,
// not a rebuild. Plain template strings — no imports, no deps.
//
// Each branch returns rgb + COVERAGE (a, 0 = let the page tokens through), so
// airy presets (aurora, starfield, waves) sit over the theme instead of
// replacing it, while solid ones (nebula, orbs, grid) paint the frame.
//
// The noise here is the same cheap value-noise the splash uses, restated
// rather than shared: the splash's fbm is tuned for terrain displacement in a
// VERTEX shader, this one runs per-pixel in 2D.

export const bgVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0); // already in clip space
}
`;

export const bgFrag = /* glsl */ `
precision highp float;

uniform vec2 uRes;
uniform float uTime;    // seconds, already scaled by the speed knob
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform float uGlow;    // 0–2
uniform float uScale;   // 0.25–4 — feature size / density
uniform float uWarp;    // 0–2 — turbulence of the movement
uniform float uOpacity; // 0.05–1
uniform vec2 uMouse;    // parallax offset, already scaled by the knob
uniform int uScene;
uniform int uDetail;    // fbm octaves, 2–5 (4 = the tuned look)

varying vec2 vUv;

// Bench hook: define SCENE_ID as a literal and the chain in main() folds to one
// preset. Production leaves it undefined (measured: no difference on Apple
// silicon); /perf's "single program" checkbox is the A/B for other GPUs.
#ifndef SCENE_ID
#define SCENE_ID uScene
#endif

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
// The Detail knob is the octave count. Fewer octaves = fewer fetches AND a
// lower sum, so the result is renormalised to the four-octave sum (1.03125)
// — the thresholds every preset was tuned against — which leaves the default
// bit-identical and only softens the fine grain at 2–3.
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= uDetail) break;
    v += a * noise(p);
    sum += a;
    p = p * 2.03 + vec2(11.3, 7.9);
    a *= 0.5;
  }
  return v * 1.03125 / max(sum, 1e-4);
}
// Two octaves, for domain warps only. A warp field is multiplied by ~0.5 and
// fed back into another fbm, so its third and fourth octaves are below the
// noise floor of the result — four octaves there is 8 noise fetches per pixel
// bought for nothing.
float fbm2(vec2 p) {
  return 0.55 * noise(p) + 0.275 * noise(p * 2.03 + vec2(11.3, 7.9));
}
// Three octaves. Only for the aurora fibre: its fourth octave is a 22px ripple
// at 0.07 weight and the diff harness could not see it go. It COULD see it go
// from nebula's highlights, caustics' web and dunes' ridges — those stay at four.
float fbm3(vec2 p) {
  float v = 0.55 * noise(p);
  p = p * 2.03 + vec2(11.3, 7.9);
  v += 0.275 * noise(p);
  p = p * 2.03 + vec2(11.3, 7.9);
  return v + 0.1375 * noise(p);
}
// A slow pseudo-random wander in -0.5..0.5, for things that drift (orb and blob
// centres). The old code sampled noise() here, but its arguments were a loop
// index and uTime — identical for every pixel on screen — so that was 8 hash
// fetches per pixel to compute one number per frame. Two incommensurate sines
// wander just as aimlessly for two transcendentals.
vec2 wander(float seed, float t) {
  return 0.5 * vec2(sin(t * 0.83 + seed * 2.1) * sin(t * 0.31 + seed * 1.3),
                    sin(t * 0.67 + seed * 1.7) * sin(t * 0.47 + seed * 0.9));
}

// --------------------------------------------------------------- presets

// 0 — aurora curtains: three warped ribbons, each its own colour.
vec4 sceneAurora(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float cover = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float t = uTime * (0.06 + 0.02 * fi);
    float wob = fbm2(vec2(uv.x * 2.2 * uScale + t, t * 0.6 + fi * 4.0));
    float centre = 0.62 - fi * 0.14 + (wob - 0.5) * 0.5 * uWarp;
    float d = (uv.y - centre) * (5.5 + fi);
    float ribbon = exp(-d * d);
    // Vertical streaks give the curtain its fibre.
    ribbon *= 0.55 + 0.45 * fbm3(vec2(uv.x * 14.0 * uScale + fi * 20.0, t * 2.0));
    vec3 c = i == 0 ? uC1 : (i == 1 ? uC2 : uC3);
    col += c * ribbon * (0.8 + 0.7 * uGlow);
    cover += ribbon;
  }
  // A wash of the first colour along the bottom, like light on cloud.
  float wash = smoothstep(0.0, 0.75, 1.0 - uv.y) * 0.25;
  col += uC1 * wash * uGlow;
  return vec4(col, clamp(cover + wash, 0.0, 1.0));
}

// 1 — nebula: domain-warped fbm clouds. Fills the frame.
vec4 sceneNebula(vec2 uv, vec2 p) {
  vec2 q = p * uScale * 1.4;
  float t = uTime * 0.05;
  vec2 warp = uWarp * vec2(fbm2(q + t), fbm2(q + vec2(5.2, 1.3) - t * 0.8));
  float f = fbm(q + warp);
  float g = fbm(q * 2.1 + warp * 1.5 - t * 0.5);
  vec3 col = mix(uC1, uC2, smoothstep(0.25, 0.8, f));
  col = mix(col, uC3, pow(clamp(g, 0.0, 1.0), 2.5) * (0.6 + 0.8 * uGlow));
  col *= 0.75 + 0.55 * f;
  return vec4(col, 1.0);
}

// 2 — contour waves: the brand topography, flowing. Lines are derivative-
// width so they stay one pixel wide at any scale.
vec4 sceneWaves(vec2 uv, vec2 p) {
  float t = uTime * 0.06;
  vec2 q = p * 1.6 * uScale;
  vec2 warp = uWarp * 0.6 * vec2(fbm2(q + t), fbm2(q - t * 1.2 + 3.7));
  float h = fbm(q + warp + vec2(t * 0.8, -t * 0.3));
  float v = h * 14.0;
  float band = abs(fract(v) - 0.5) / max(fwidth(v), 1e-4);
  float line = 1.0 - smoothstep(0.4, 1.6, band);
  vec3 col = mix(uC1, uC2, smoothstep(0.2, 0.85, h));
  col += uC3 * line * (0.35 + 0.65 * uGlow);
  float cover = 0.35 + 0.5 * line + 0.25 * h;
  return vec4(col, clamp(cover, 0.0, 1.0));
}

// 3 — lava orbs: five metaballs, slow.
vec4 sceneOrbs(vec2 uv, vec2 p) {
  float field = 0.0;
  vec2 nearest = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float t = uTime * 0.12;
    vec2 c = vec2(
      sin(t * (0.7 + fi * 0.11) + fi * 1.7) * 0.75,
      cos(t * (0.5 + fi * 0.09) + fi * 2.3) * 0.5
    );
    c += uWarp * 0.25 * wander(fi, t);
    float r = (0.20 + 0.07 * sin(fi * 2.1)) / uScale;
    field += (r * r) / max(dot(p - c, p - c), 1e-4);
  }
  float body = smoothstep(0.9, 1.7, field);
  float rim = smoothstep(0.55, 1.0, field) - body;
  vec3 col = mix(uC3, mix(uC1, uC2, clamp(field * 0.35, 0.0, 1.0)), body);
  col += uC2 * rim * uGlow * 0.9;
  return vec4(col, 1.0);
}

// 4 — starfield: two parallax layers of twinkling points over a faint haze.
vec4 sceneStars(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float cover = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float dens = (9.0 + fl * 11.0) * uScale;
    vec2 sp = p * dens + vec2(uTime * (0.05 + fl * 0.08), uTime * 0.02);
    vec2 id = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float h = hash(id + fl * 31.7);
    vec2 off = (vec2(hash(id + 1.3), hash(id + 7.7)) - 0.5) * 0.7;
    float d = length(f - off);
    float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + 3.0 * h) + h * 40.0) * uWarp;
    float star = smoothstep(0.16 * (0.35 + 0.65 * h), 0.0, d) * step(0.55, h) * twinkle;
    star *= 1.0 - fl * 0.35;
    col += mix(uC1, uC2, h) * star * (0.7 + 0.8 * uGlow);
    cover += star;
  }
  float haze = fbm2(p * 1.2 * uScale + uTime * 0.01) * 0.35;
  col += uC3 * haze;
  return vec4(col, clamp(cover + haze * 0.8, 0.0, 1.0));
}

// 5 — neon grid: a perspective floor with a scanning glow at the horizon.
vec4 sceneGrid(vec2 uv, vec2 p) {
  float horizon = 0.42;
  float below = horizon - uv.y;
  vec3 col = mix(uC3, uC1 * 0.35, smoothstep(horizon, 1.0, uv.y) * 0.6);
  float cover = 1.0;
  if (below > 0.001) {
    float depth = 1.0 / max(below, 0.002);
    vec2 g = vec2(p.x * depth * 0.5, depth) * uScale;
    g.y -= uTime * 0.5;
    vec2 wob = uWarp * 0.05 * vec2(noise(vec2(g.y * 0.3, uTime * 0.1)), 0.0);
    g += wob;
    vec2 grid = abs(fract(g) - 0.5) / max(fwidth(g), vec2(1e-4));
    float line = 1.0 - smoothstep(0.4, 1.8, min(grid.x, grid.y));
    float fade = smoothstep(0.0, 0.22, below);
    col = mix(uC3, uC1, line * fade);
    col += uC2 * line * fade * uGlow * 0.6;
  }
  // Horizon bloom, the thing that sells the perspective.
  float glow = exp(-abs(uv.y - horizon) * 22.0);
  col += mix(uC1, uC2, 0.5) * glow * (0.4 + 0.6 * uGlow);
  return vec4(col, cover);
}

// 6 — silk: five sine-warped ribbons crossing the frame, airy.
vec4 sceneSilk(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float cover = 0.0;
  float t = uTime * 0.25;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ph = fi * 1.7;
    float y = sin(p.x * 1.5 * uScale + t + ph) * 0.14
            + sin(p.x * 0.7 * uScale - t * 0.6 + ph * 2.0) * 0.10 * uWarp;
    float d = p.y - y + (fi - 2.0) * 0.32;
    // Tight falloff: any wider and the five ribbons merge into one smear.
    float band = exp(-d * d * (110.0 - fi * 12.0));
    vec3 c = mix(mix(uC1, uC2, fi * 0.25), uC3, 0.15 + 0.25 * sin(t + ph));
    col += c * band * (0.7 + 0.6 * uGlow);
    cover += band;
  }
  return vec4(col, clamp(cover, 0.0, 1.0));
}

// 7 — cells: voronoi crystal, the wall between two seeds lit. Fills the frame.
vec4 sceneCells(vec2 uv, vec2 p) {
  vec2 q = p * 2.2 * uScale;
  float t = uTime * 0.15;
  vec2 ip = floor(q);
  vec2 fp = fract(q);
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float h = hash(ip + g);
      vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * vec2(h, hash(ip + g + 3.1))) * (0.35 + 0.65 * uWarp);
      float d = length(g + o - fp);
      if (d < d1) { d2 = d1; d1 = d; id = h; }
      else if (d < d2) { d2 = d; }
    }
  }
  float edge = smoothstep(0.0, 0.13, d2 - d1); // 0 exactly on the wall
  vec3 col = mix(uC1, uC2, id) * (0.55 + 0.5 * d1);
  col = mix(uC3, col, 0.4 + 0.6 * edge);
  col += uC3 * (1.0 - edge) * (0.35 + 0.75 * uGlow);
  return vec4(col, 1.0);
}

// 8 — rain: two parallax layers of falling light streaks.
vec4 sceneRain(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  float cover = 0.0;
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float cols = (5.0 + fl * 4.0) * uScale;
    float x = p.x * cols + uWarp * 0.4 * sin(uv.y * 3.0 + uTime * 0.3);
    vec2 id = vec2(floor(x), fl * 17.0);
    float fx = fract(x) - 0.5;
    float h = hash(id);
    float y = fract(uv.y + uTime * (0.25 + 0.75 * h) * 0.35 + h * 10.0);
    float streak = exp(-y * (9.0 + 18.0 * h));
    float s = streak * exp(-fx * fx * 80.0) * step(0.3, h);
    s *= 1.0 - fl * 0.4;
    col += mix(uC1, uC2, h) * s * (0.7 + 0.7 * uGlow);
    cover += s;
  }
  float haze = fbm2(p * 0.9 + uTime * 0.02) * 0.22;
  col += uC3 * haze;
  return vec4(col, clamp(cover + haze * 0.8, 0.0, 1.0));
}

// 9 — swirl: spiral arms winding out of a lit core. Fills the frame.
vec4 sceneSwirl(vec2 uv, vec2 p) {
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = uTime * 0.2;
  float v = sin(a * 3.0 + r * 6.5 * uScale - t * 2.0);
  v += 0.5 * uWarp * sin(a * 5.0 - r * 4.0 * uScale + t * 1.4);
  float band = clamp(0.5 + 0.4 * v, 0.0, 1.0);
  vec3 col = mix(mix(uC3, uC1, band), uC2, pow(band, 3.0));
  col += uC2 * pow(band, 6.0) * uGlow;
  col += uC1 * exp(-r * r * 2.0) * (0.5 + 0.8 * uGlow);
  return vec4(col, 1.0);
}

// 10 — bokeh: out-of-focus discs drifting over a haze, airy.
vec4 sceneBokeh(vec2 uv, vec2 p) {
  vec2 q = p * 1.6 * uScale + vec2(uTime * 0.05, uTime * 0.02);
  vec2 ip = floor(q);
  vec2 fp = fract(q);
  vec3 col = vec3(0.0);
  float cover = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float h = hash(ip + g);
      if (h < 0.35) continue; // most cells stay empty, or it reads as foam
      float h2 = hash(ip + g + 5.7);
      vec2 o = vec2(h, h2) * 0.7 + 0.15;
      o += uWarp * 0.16 * vec2(sin(uTime * 0.5 + h * 30.0), cos(uTime * 0.4 + h2 * 27.0));
      float d = length(g + o - fp) / (0.16 + 0.26 * h2);
      float disc = smoothstep(1.0, 0.72, d);
      float rim = max(smoothstep(1.0, 0.87, d) - smoothstep(0.92, 0.72, d), 0.0);
      col += mix(uC1, uC2, h2) * (disc * 0.5 + rim * 1.2) * (0.6 + 0.7 * uGlow);
      cover += disc * 0.55 + rim;
    }
  }
  float haze = fbm2(p * 0.8 + uTime * 0.02) * 0.2;
  col += uC3 * haze;
  return vec4(col, clamp(cover + haze * 0.8, 0.0, 1.0));
}

// 11 — mesh: four soft colour blobs drifting through each other. Fills.
vec4 sceneMesh(vec2 uv, vec2 p) {
  float aspect = uRes.x / max(uRes.y, 1.0);
  float t = uTime * 0.18;
  vec3 col = uC3;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.6 + 0.13 * fi) + fi * 2.1) * 1.1 * aspect,
                  cos(t * (0.45 + 0.17 * fi) + fi * 1.3) * 0.6);
    c += uWarp * 0.3 * wander(fi, t);
    float w = exp(-dot(p - c, p - c) * 1.4 * uScale * uScale);
    vec3 cc = i == 0 ? uC1 : (i == 1 ? uC2 : (i == 2 ? mix(uC1, uC2, 0.5) : mix(uC2, uC3, 0.4)));
    col = mix(col, cc, clamp(w * (0.6 + 0.5 * uGlow), 0.0, 1.0));
  }
  // Static per-pixel grain: a four-blob gradient bands badly without it.
  col += (hash(uv * uRes) - 0.5) * 0.02;
  return vec4(col, 1.0);
}

// 12 — caustics: two crossing light webs on a pool floor. Fills the frame.
vec4 sceneCaustics(vec2 uv, vec2 p) {
  vec2 q = p * 1.9 * uScale;
  float t = uTime * 0.22;
  vec2 w = uWarp * 0.7 * vec2(fbm2(q * 0.6 + t), fbm2(q.yx * 0.6 - t * 0.8));
  float a = fbm(q + w + vec2(t * 0.4, 0.0));
  float b = fbm(q * 1.7 - w + vec2(0.0, t * 0.5));
  // Crests, not level sets: each web is where its layer peaks mid-range.
  float wa = pow(max(1.0 - abs(a * 2.6 - 1.3), 0.0), 9.0);
  float wb = pow(max(1.0 - abs(b * 2.8 - 1.4), 0.0), 14.0);
  float net = 0.8 * (wa + wb) + wa * wb * 3.5; // crossings burn out
  vec3 col = mix(uC3, uC1 * 0.45, smoothstep(0.25, 0.85, a));
  col += mix(uC1, uC2, min(net, 1.0)) * net * (0.25 + 0.5 * uGlow);
  return vec4(col, 1.0);
}

// 13 — truchet: quarter-arc wards wired into one maze, a pulse running it.
vec4 sceneTruchet(vec2 uv, vec2 p) {
  float t = uTime * 0.5;
  vec2 q = p * 2.6 * uScale;
  q += uWarp * 0.3 * vec2(fbm2(q * 0.25 + t * 0.1), fbm2(q.yx * 0.25 - t * 0.08));
  vec2 ip = floor(q);
  vec2 fp = fract(q) - 0.5;
  if (hash(ip) < 0.5) fp.x = -fp.x; // the ward's other diagonal
  // Two quarter arcs, one per opposite corner: the join is what wards.
  float d = abs(min(length(fp - 0.5), length(fp + 0.5)) - 0.5);
  float line = 1.0 - smoothstep(0.035, 0.035 + max(fwidth(d), 1e-4) * 2.0, d);
  float halo = exp(-d * 24.0);
  float pulse = pow(0.5 + 0.5 * sin(t * 2.0 - (q.x + q.y * 0.5) * 0.7), 3.0);
  vec3 col = mix(uC1, uC2, pulse) * line * (0.3 + 0.7 * pulse) * (0.6 + 0.7 * uGlow);
  col += uC3 * halo * pulse * (0.3 + 0.7 * uGlow);
  return vec4(col, clamp(line * (0.5 + 0.5 * pulse) + halo * 0.35, 0.0, 1.0));
}

// 14 — moire: three ring sources beating against each other, airy.
vec4 sceneMoire(vec2 uv, vec2 p) {
  float aspect = uRes.x / max(uRes.y, 1.0);
  float t = uTime * 0.3;
  float wob = uWarp * 2.0 * fbm(p * 1.1 + t * 0.3);
  float g = 1.0;
  float core = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // Sources ride the frame width, so a 10:1 bar keeps all three on screen.
    vec2 c = vec2(sin(t * (0.5 + 0.13 * fi) + fi * 2.4) * 0.62 * aspect,
                  cos(t * (0.4 + 0.17 * fi) + fi * 1.1) * 0.55);
    float r = length(p - c);
    // Gratings multiplied, not summed: the beat between them IS the pattern.
    g *= 0.5 + 0.5 * sin(r * (12.0 + 5.0 * fi) * uScale - t * 4.0 + wob);
    core += exp(-r * r * 4.0);
  }
  float fringe = pow(g, 0.5);
  vec3 col = mix(uC1, uC2, fringe) * fringe * (0.8 + 0.8 * uGlow);
  col += uC3 * core * 0.3 * (0.4 + 0.8 * uGlow);
  return vec4(col, clamp(fringe * 1.1 + core * 0.25, 0.0, 1.0));
}

// 15 — dunes: layered ridge silhouettes drifting past each other. Fills.
vec4 sceneDunes(vec2 uv, vec2 p) {
  float t = uTime * 0.08;
  float aa = max(fwidth(uv.y) * 1.5, 0.002);
  vec3 col = mix(uC1 * 0.5, uC3, smoothstep(0.2, 1.0, uv.y));
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = p.x * 1.1 * uScale * (1.0 + fi * 0.7) + t * (1.0 + 0.6 * fi) + fi * 17.0;
    float ridge = 0.78 - fi * 0.18 + (fbm(vec2(x, fi * 9.0)) - 0.5) * (0.14 + 0.2 * uWarp);
    col += uC1 * exp(-abs(uv.y - ridge) * 80.0) * (0.3 + 0.8 * uGlow);
    // Nearer layers are drawn last, so each one occludes the crest behind it.
    col = mix(col, mix(uC2, uC3, 0.1 + fi * 0.24) * (0.85 - fi * 0.12),
              smoothstep(ridge + aa, ridge - aa, uv.y));
  }
  return vec4(col, 1.0);
}

// 16 — bars: an equaliser, every column on its own beat.
vec4 sceneBars(vec2 uv, vec2 p) {
  float x = p.x * 4.0 * uScale;
  float id = floor(x);
  float h = hash(vec2(id, 4.7));
  float lvl = 0.2 + 0.5 * abs(sin(uTime * (0.5 + 1.3 * h) + h * 21.0));
  lvl += uWarp * 0.28 * (noise(vec2(id * 0.6, uTime * 0.6)) - 0.5);
  float slot = smoothstep(0.42, 0.3, abs(fract(x) - 0.5)); // the gutter
  float body = smoothstep(lvl, lvl - 0.03, uv.y) * slot;
  float cap = exp(-abs(uv.y - lvl) * 55.0) * slot;
  vec3 col = mix(uC1, uC2, clamp(uv.y / max(lvl, 0.05), 0.0, 1.0)) * body * 0.9;
  col += uC3 * cap * (0.5 + 0.9 * uGlow);
  return vec4(col, clamp(body * 0.85 + cap, 0.0, 1.0));
}

// 17 — hex: a honeycomb lattice with a lit wave crossing it, airy.
vec4 sceneHex(vec2 uv, vec2 p) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 q = p * 4.5 * uScale;
  q += uWarp * 0.5 * vec2(fbm2(q * 0.12 + uTime * 0.08), fbm2(q.yx * 0.12 - uTime * 0.06));
  // Two lattices offset by half a cell; the nearer centre wins = a hex grid.
  vec4 hc = floor(vec4(q, q - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(q - hc.xy * s, q - (hc.zw + 0.5) * s);
  vec2 loc = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  vec2 ap = abs(loc);
  float hd = max(ap.x * 0.5 + ap.y * 0.866, ap.x); // hex wall sits at 0.5
  vec2 cen = q - loc;
  float ph = hash(cen);
  float lit = pow(0.5 + 0.5 * sin(uTime * 1.2 - cen.x * 0.55 - cen.y * 0.3 + ph * 1.1), 3.0);
  float body = smoothstep(0.5, 0.44, hd);
  float rim = smoothstep(0.5, 0.46, hd) - smoothstep(0.45, 0.40, hd);
  vec3 col = mix(uC1, uC2, ph) * body * lit * (0.7 + 0.7 * uGlow);
  col += uC3 * rim * (0.3 + 0.6 * uGlow);
  return vec4(col, clamp(body * lit * 0.9 + rim * 0.7, 0.0, 1.0));
}

void main() {
  vec2 uv = vUv + uMouse * 0.04;
  // Aspect-corrected, origin-centred — every distance-based preset uses it.
  vec2 p = (uv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0) * 2.0;

  int sc = SCENE_ID;
  vec4 s;
  if (sc == 1) s = sceneNebula(uv, p);
  else if (sc == 2) s = sceneWaves(uv, p);
  else if (sc == 3) s = sceneOrbs(uv, p);
  else if (sc == 4) s = sceneStars(uv, p);
  else if (sc == 5) s = sceneGrid(uv, p);
  else if (sc == 6) s = sceneSilk(uv, p);
  else if (sc == 7) s = sceneCells(uv, p);
  else if (sc == 8) s = sceneRain(uv, p);
  else if (sc == 9) s = sceneSwirl(uv, p);
  else if (sc == 10) s = sceneBokeh(uv, p);
  else if (sc == 11) s = sceneMesh(uv, p);
  else if (sc == 12) s = sceneCaustics(uv, p);
  else if (sc == 13) s = sceneTruchet(uv, p);
  else if (sc == 14) s = sceneMoire(uv, p);
  else if (sc == 15) s = sceneDunes(uv, p);
  else if (sc == 16) s = sceneBars(uv, p);
  else if (sc == 17) s = sceneHex(uv, p);
  else s = sceneAurora(uv, p);

  gl_FragColor = vec4(clamp(s.rgb, 0.0, 1.6), clamp(s.a, 0.0, 1.0) * uOpacity);
}
`;
