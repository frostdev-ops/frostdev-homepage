import { reducedMotion } from './dom.ts';
// Wire layer for the logic editor: one page-coordinate SVG (paths) + one HTML
// layer (pills), driven by a single rAF loop that springs every wire endpoint
// toward its live anchor each frame. Wards are read via getBoundingClientRect,
// which reflects mid-flight FLIP transforms — wires chase reality, so drags,
// reorders, resizes and SSE repaints never need to notify us. The loop stays
// hot for the whole wiring session (wires only exist in the mode; a few rect
// reads + spring math per frame, DOM writes skipped when settled) and stops
// once wires/drafts/pulses/ghosts are all gone.
//
// Owns only nodes it creates (#wire-layer, #wire-labels) — never ward DOM.

const SVG_NS = 'http://www.w3.org/2000/svg';
const K = 170; // spring stiffness
const D = 26; // damping
const KB = 90; // bend spring — slacker than the endpoints, so wires swim
const DB = 16;
const PULL_R = 260; // cursor field: nearest wire inside this is drawn in
const PULL_MAX = 84; // how far a wire's middle travels toward the cursor
const FLOAT_R = 300; // everything else inside this drifts out of the way
const FLOAT_MAX = 22;
const PULSE_MS = 650;
const GHOST_MS = 1800;

export interface WireSpec {
  id: string;
  /** Pill text (icons + glyphs, already composed by the caller). */
  label: string;
  error: boolean;
  disabled: boolean;
  src: HTMLElement;
  dst: HTMLElement;
}

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Anchor {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

interface WireState {
  spec: WireSpec;
  g: SVGGElement;
  hit: SVGPathElement;
  base: SVGPathElement;
  flow: SVGPathElement;
  pill: HTMLElement;
  a: Pt | null; // null until first frame → snap into place
  b: Pt | null;
  bend: Pt; // mid-curve offset under the cursor's pull/push
  pillX: number;
  pillY: number;
}

let svg: SVGSVGElement | null = null;
let labels: HTMLElement | null = null;
const wires = new Map<string, WireState>();
interface DraftWire {
  src: HTMLElement;
  a: Pt | null;
  b: Pt | null;
  target: { x: number; y: number };
  paths: { g: SVGGElement; hit: SVGPathElement; base: SVGPathElement; flow: SVGPathElement };
}
let draft: DraftWire | null = null;
let draftDying: { d: DraftWire; t0: number } | null = null;
const pulses: { wire: WireState; t0: number; dot: SVGCircleElement }[] = [];
const ghosts: { state: WireState; t0: number }[] = [];
let clickCb: (id: string, x: number, y: number) => void = () => {};
let ptr: { x: number; y: number } | null = null; // page coords of the cursor
let hover: Node | null = null;
let raf = 0;
let last = 0;
let sizedW = 0;
let sizedH = 0;


export function mountLayer(): void {
  if (svg) return;
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'wire-layer';
  labels = document.createElement('div');
  labels.id = 'wire-labels';
  document.body.append(svg, labels);
  bootFocus();
}

/** The cursor is a current in the water: the frame loop reads these two and
 *  draws the nearest wire toward the pointer while the rest drift aside.
 *  Touch has no hover, so only mouse/pen open the field. */
function bootFocus(): void {
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      ptr = { x: e.clientX + scrollX, y: e.clientY + scrollY };
      hover = e.target as Node;
    },
    { passive: true },
  );
  // Pointer off the page: let everything settle back rather than hold a bend.
  document.addEventListener('pointerleave', () => {
    ptr = null;
    hover = null;
  });
}

/** Pointer interactivity (wire/pill clicks) — on only in wiring mode. */
export function setLive(on: boolean): void {
  svg?.classList.toggle('live', on);
  labels?.classList.toggle('live', on);
}

export function onWireClick(cb: (id: string, x: number, y: number) => void): void {
  clickCb = cb;
}

function mkPaths(): { g: SVGGElement; hit: SVGPathElement; base: SVGPathElement; flow: SVGPathElement } {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'wire');
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.setAttribute('class', 'wire-hit');
  const base = document.createElementNS(SVG_NS, 'path');
  base.setAttribute('class', 'wire-base');
  const flow = document.createElementNS(SVG_NS, 'path');
  flow.setAttribute('class', 'wire-flow');
  g.append(hit, base, flow);
  return { g, hit, base, flow };
}

function mkWire(spec: WireSpec): WireState {
  const { g, hit, base, flow } = mkPaths();
  g.dataset.edge = spec.id;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'wire-pill';
  const state: WireState = { spec, g, hit, base, flow, pill, a: null, b: null, bend: mkPt(0, 0), pillX: -1, pillY: -1 };
  applySpec(state, spec);
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    clickCb(state.spec.id, e.clientX, e.clientY);
  };
  hit.addEventListener('click', open);
  pill.addEventListener('click', open);
  svg!.append(g);
  labels!.append(pill);
  return state;
}

function applySpec(state: WireState, spec: WireSpec): void {
  state.spec = spec;
  state.pill.textContent = spec.label;
  if (spec.error) {
    const dot = document.createElement('span');
    dot.dataset.err = '1';
    state.pill.append(dot);
  }
  state.g.classList.toggle('wire-off', spec.disabled);
  state.pill.classList.toggle('wire-off', spec.disabled);
}

function removeWire(state: WireState): void {
  state.g.remove();
  state.pill.remove();
}

/** Reconcile the wire set by id. `seed` lets a wire born from a drag start at
 *  the draft's last position instead of popping in at its anchors. */
export function setWires(specs: WireSpec[], seed?: { id: string; a: Pt; b: Pt }): void {
  mountLayer();
  const seen = new Set<string>();
  for (const spec of specs) {
    seen.add(spec.id);
    const existing = wires.get(spec.id);
    if (existing) {
      applySpec(existing, spec);
    } else {
      const state = mkWire(spec);
      if (seed && seed.id === spec.id) {
        state.a = { ...seed.a };
        state.b = { ...seed.b };
      }
      wires.set(spec.id, state);
    }
  }
  for (const [id, state] of wires) {
    if (!seen.has(id)) {
      removeWire(state);
      wires.delete(id);
    }
  }
  ensureLoop();
}

export function clearWires(): void {
  setWires([]);
}

// -------------------------------------------------------------------- draft

export function draftStart(src: HTMLElement): void {
  mountLayer();
  draftDiscard(true);
  const paths = mkPaths();
  paths.g.classList.add('wire-draft');
  svg!.append(paths.g);
  const r = pageRect(src);
  draft = { src, a: null, b: null, target: { x: r.cx, y: r.cy }, paths };
  ensureLoop();
}

/** Page coordinates. */
export function draftTo(x: number, y: number): void {
  if (draft) draft.target = { x, y };
}

/** The draft's current endpoints, for seeding the real wire. */
export function draftEnd(): { a: Pt; b: Pt } | null {
  if (!draft?.a || !draft.b) {
    draftDiscard(true);
    return null;
  }
  const out = { a: { ...draft.a }, b: { ...draft.b } };
  draftDiscard(true);
  return out;
}

export function draftDiscard(instant = false): void {
  if (!draft) return;
  const dying = draft;
  draft = null;
  if (instant || reducedMotion() || !dying.b) {
    dying.paths.g.remove();
    return;
  }
  // Spring back to the port and fade.
  const r = pageRect(dying.src);
  dying.target = { x: r.cx, y: r.cy };
  draftDying = { d: dying, t0: performance.now() };
  ensureLoop();
}

// ----------------------------------------------------------- pulses / ghosts

export function pulse(id: string): void {
  const wire = wires.get(id);
  if (!wire || reducedMotion()) return;
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'wire-pulse');
  dot.setAttribute('r', '3.5');
  svg!.append(dot);
  pulses.push({ wire, t0: performance.now(), dot });
  ensureLoop();
}

/** A fired edge outside wiring mode: ghost the wire in over the dashboard,
 *  run the pulse along it, fade out, remove. */
export function ghost(spec: WireSpec): void {
  if (reducedMotion()) return;
  mountLayer();
  if (wires.has(spec.id)) {
    pulse(spec.id);
    return;
  }
  const state = mkWire({ ...spec, id: `ghost-${spec.id}-${Math.random().toString(36).slice(2, 6)}` });
  state.g.classList.add('wire-ghost');
  state.pill.classList.add('wire-ghost');
  ghosts.push({ state, t0: performance.now() });
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'wire-pulse');
  dot.setAttribute('r', '3.5');
  svg!.append(dot);
  pulses.push({ wire: state, t0: performance.now() + 250, dot });
  ensureLoop();
}

// ----------------------------------------------------------------- geometry

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

function pageRect(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  const left = r.left + scrollX;
  const top = r.top + scrollY;
  return { left, top, right: left + r.width, bottom: top + r.height, cx: left + r.width / 2, cy: top + r.height / 2, w: r.width, h: r.height };
}

type Side = 'l' | 'r' | 't' | 'b';

function sideFor(from: Rect, to: Rect): Side {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'r' : 'l') : dy >= 0 ? 'b' : 't';
}

function anchorAt(rect: Rect, side: Side, frac: number): Anchor {
  switch (side) {
    case 'l':
      return { x: rect.left, y: rect.top + rect.h * frac, nx: -1, ny: 0 };
    case 'r':
      return { x: rect.right, y: rect.top + rect.h * frac, nx: 1, ny: 0 };
    case 't':
      return { x: rect.left + rect.w * frac, y: rect.top, nx: 0, ny: -1 };
    case 'b':
      return { x: rect.left + rect.w * frac, y: rect.bottom, nx: 0, ny: 1 };
  }
}

/** Both control points share one offset, which moves the curve's t=0.5 point
 *  by 0.75 of it — hence BOW below, so a requested pull lands where asked. */
const BOW = 4 / 3;

function ctrl(a: Pt, an: Anchor, b: Pt, bn: Anchor, ox = 0, oy = 0) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const L = Math.min(Math.max(0.4 * dist, 24), 160);
  return {
    c1x: a.x + an.nx * L + ox * BOW,
    c1y: a.y + an.ny * L + oy * BOW,
    c2x: b.x + bn.nx * L + ox * BOW,
    c2y: b.y + bn.ny * L + oy * BOW,
  };
}

function dFor(a: Pt, an: Anchor, b: Pt, bn: Anchor, ox = 0, oy = 0): string {
  const c = ctrl(a, an, b, bn, ox, oy);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c.c1x.toFixed(1)} ${c.c1y.toFixed(1)}, ${c.c2x.toFixed(1)} ${c.c2y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/** The curve's midpoint, analytically — no getPointAtLength round-trip. */
function midOf(a: Pt, an: Anchor, b: Pt, bn: Anchor, ox = 0, oy = 0): { x: number; y: number } {
  const c = ctrl(a, an, b, bn, ox, oy);
  return { x: (a.x + 3 * c.c1x + 3 * c.c2x + b.x) / 8, y: (a.y + 3 * c.c1y + 3 * c.c2y + b.y) / 8 };
}

/** Semi-implicit Euler toward the target; returns whether it moved. */
function step(p: Pt, tx: number, ty: number, dt: number, snap: boolean, k = K, d = D): boolean {
  if (snap) {
    const moved = Math.abs(p.x - tx) > 0.25 || Math.abs(p.y - ty) > 0.25;
    p.x = tx;
    p.y = ty;
    p.vx = p.vy = 0;
    return moved;
  }
  p.vx += (tx - p.x) * k * dt;
  p.vy += (ty - p.y) * k * dt;
  const damp = Math.exp(-d * dt);
  p.vx *= damp;
  p.vy *= damp;
  const ox = p.x;
  const oy = p.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  return Math.abs(p.x - ox) > 0.25 || Math.abs(p.y - oy) > 0.25 || Math.abs(tx - p.x) > 0.25 || Math.abs(ty - p.y) > 0.25;
}

const mkPt = (x: number, y: number): Pt => ({ x, y, vx: 0, vy: 0 });

// --------------------------------------------------------------------- loop

function ensureLoop(): void {
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}

function sizeLayer(): void {
  const w = document.documentElement.scrollWidth;
  const h = document.documentElement.scrollHeight;
  if (w !== sizedW || h !== sizedH) {
    sizedW = w;
    sizedH = h;
    svg!.setAttribute('width', String(w));
    svg!.setAttribute('height', String(h));
  }
}

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  sizeLayer();
  const snap = reducedMotion();
  const rects = new Map<HTMLElement, Rect>();
  const rectOf = (el: HTMLElement): Rect => {
    let r = rects.get(el);
    if (!r) rects.set(el, (r = pageRect(el)));
    return r;
  };

  // Anchor targets with per-(element, side) fan-out.
  const live = [...wires.values()].filter((w) => w.spec.src.isConnected && w.spec.dst.isConnected);
  for (const g of ghosts) live.push(g.state);
  interface EndTarget {
    wire: WireState;
    end: 'a' | 'b';
    rect: Rect;
    side: Side;
    angle: number;
  }
  const groups = new Map<string, EndTarget[]>();
  const keyOf = (el: HTMLElement, side: Side) => {
    let r = rects.get(el)!;
    return `${r.left},${r.top},${side}`;
  };
  const targets: EndTarget[] = [];
  for (const wire of live) {
    if (wire.g.classList.contains('wire-hidden')) continue;
    const sr = rectOf(wire.spec.src);
    const dr = rectOf(wire.spec.dst);
    const sSide = sideFor(sr, dr);
    const dSide = sideFor(dr, sr);
    const mk = (end: 'a' | 'b', rect: Rect, side: Side, other: Rect): void => {
      const t: EndTarget = { wire, end, rect, side, angle: Math.atan2(other.cy - rect.cy, other.cx - rect.cx) };
      targets.push(t);
      const key = keyOf(end === 'a' ? wire.spec.src : wire.spec.dst, side);
      const group = groups.get(key);
      if (group) group.push(t);
      else groups.set(key, [t]);
    };
    mk('a', sr, sSide, dr);
    mk('b', dr, dSide, sr);
  }
  const anchors = new Map<EndTarget, Anchor>();
  for (const group of groups.values()) {
    group.sort((x, y) => x.angle - y.angle);
    group.forEach((t, i) => anchors.set(t, anchorAt(t.rect, t.side, (i + 1) / (group.length + 1))));
  }

  const wireDots = new Map<WireState, { a: Anchor; b: Anchor }>();
  for (const t of targets) {
    const cur = wireDots.get(t.wire) ?? ({} as { a: Anchor; b: Anchor });
    (cur as Record<string, Anchor>)[t.end] = anchors.get(t)!;
    wireDots.set(t.wire, cur);
  }
  // Endpoints first: the resting curve is what the cursor's field acts on.
  const shaped: { wire: WireState; aa: Anchor; ba: Anchor; mid: { x: number; y: number }; moved: boolean }[] = [];
  for (const [wire, { a: aa, b: ba }] of wireDots) {
    if (!aa || !ba) continue;
    if (!wire.a) wire.a = mkPt(aa.x, aa.y);
    if (!wire.b) wire.b = mkPt(ba.x, ba.y);
    const movedA = step(wire.a, aa.x, aa.y, dt, snap);
    const movedB = step(wire.b, ba.x, ba.y, dt, snap);
    shaped.push({ wire, aa, ba, mid: midOf(wire.a, aa, wire.b, ba), moved: movedA || movedB });
  }

  // The cursor draws the wire it is nearest (and anything it hovers) toward
  // itself; every other wire inside the field drifts out of the way. Nothing
  // fades — proximity is told by motion.
  const p = !snap && svg!.classList.contains('live') && !draft ? ptr : null;
  let near: WireState | null = null;
  if (p) {
    let best = PULL_R;
    for (const s of shaped) {
      const d = Math.hypot(p.x - s.mid.x, p.y - s.mid.y);
      if (d < best) {
        best = d;
        near = s.wire;
      }
    }
  }
  for (const { wire, aa, ba, mid, moved } of shaped) {
    const held =
      !!p && !!hover && (wire.spec.src.contains(hover) || wire.spec.dst.contains(hover) || wire.pill.contains(hover) || wire.hit === hover);
    const lit = wire === near || held;
    wire.g.classList.toggle('wire-lit', lit);
    wire.pill.classList.toggle('wire-lit', lit);
    let tx = 0;
    let ty = 0;
    if (p) {
      const dx = p.x - mid.x;
      const dy = p.y - mid.y;
      const d = Math.hypot(dx, dy) || 1;
      if (lit) {
        // Straight to the cursor when close, a bow toward it when not. A
        // hovered-but-not-nearest wire leans in less, so they never stack.
        const reach = Math.min(d, wire === near ? PULL_MAX : PULL_MAX * 0.35);
        tx = (dx / d) * reach;
        ty = (dy / d) * reach;
      } else if (d < FLOAT_R) {
        const f = (1 - d / FLOAT_R) ** 2;
        tx = (-dx / d) * FLOAT_MAX * f;
        ty = (-dy / d) * FLOAT_MAX * f;
      }
    }
    const bent = step(wire.bend, tx, ty, dt, snap, KB, DB);
    if (moved || bent || wire.pillX < 0) {
      const d = dFor(wire.a!, aa, wire.b!, ba, wire.bend.x, wire.bend.y);
      wire.hit.setAttribute('d', d);
      wire.base.setAttribute('d', d);
      wire.flow.setAttribute('d', d);
      const m = midOf(wire.a!, aa, wire.b!, ba, wire.bend.x, wire.bend.y);
      if (Math.abs(m.x - wire.pillX) > 0.25 || Math.abs(m.y - wire.pillY) > 0.25) {
        wire.pillX = m.x;
        wire.pillY = m.y;
        wire.pill.style.transform = `translate(${m.x}px, ${m.y}px) translate(-50%, -50%)`;
      }
    }
  }

  // Draft wire: src anchor faces the pointer; free end springs to the pointer.
  if (draft) {
    const sr = rectOf(draft.src);
    const fake: Rect = { left: draft.target.x, top: draft.target.y, right: draft.target.x, bottom: draft.target.y, cx: draft.target.x, cy: draft.target.y, w: 0, h: 0 };
    const an = anchorAt(sr, sideFor(sr, fake), 0.5);
    const bn: Anchor = { x: draft.target.x, y: draft.target.y, nx: -an.nx, ny: -an.ny };
    if (!draft.a) draft.a = mkPt(an.x, an.y);
    if (!draft.b) draft.b = mkPt(an.x, an.y);
    step(draft.a, an.x, an.y, dt, true); // source end sticks to the port
    step(draft.b, bn.x, bn.y, dt, snap); // free end lags the pointer — the pulled cord
    const d = dFor(draft.a, an, draft.b, bn);
    draft.paths.base.setAttribute('d', d);
    draft.paths.flow.setAttribute('d', d);
  }
  if (draftDying) {
    const t = (now - draftDying.t0) / 220;
    const dying = draftDying.d;
    if (t >= 1) {
      dying.paths.g.remove();
      draftDying = null;
    } else {
      const sr = rectOf(dying.src);
      const an = anchorAt(sr, 'r', 0.5);
      const bn: Anchor = { x: an.x, y: an.y, nx: -1, ny: 0 };
      step(dying.b!, an.x, an.y, dt, false);
      const d = dFor(dying.a!, an, dying.b!, bn);
      dying.paths.base.setAttribute('d', d);
      dying.paths.flow.setAttribute('d', d);
      dying.paths.g.style.opacity = String(1 - t);
    }
  }

  // Pulses ride the settled path.
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i]!;
    const t = (now - p.t0) / PULSE_MS;
    if (t < 0) continue;
    if (t >= 1 || !p.wire.g.isConnected) {
      p.dot.remove();
      pulses.splice(i, 1);
      continue;
    }
    try {
      const len = p.wire.base.getTotalLength();
      const eased = 1 - (1 - t) * (1 - t); // ease-out
      const pt = p.wire.base.getPointAtLength(len * eased);
      p.dot.setAttribute('cx', String(pt.x));
      p.dot.setAttribute('cy', String(pt.y));
    } catch {}
  }

  // Ghost lifecycle: fade in, hold (pulse runs), fade out, remove.
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i]!;
    const t = now - g.t0;
    if (t >= GHOST_MS || !g.state.spec.src.isConnected || !g.state.spec.dst.isConnected) {
      removeWire(g.state);
      ghosts.splice(i, 1);
      continue;
    }
    const opacity = t < 200 ? t / 200 : t > GHOST_MS - 500 ? (GHOST_MS - t) / 500 : 1;
    g.state.g.style.opacity = String(opacity * 0.75);
    g.state.pill.style.opacity = String(opacity * 0.9);
  }

  raf = wires.size > 0 || draft || draftDying || pulses.length > 0 || ghosts.length > 0 ? requestAnimationFrame(frame) : 0;
}

window.addEventListener('resize', () => {
  if (wires.size > 0) ensureLoop();
});
