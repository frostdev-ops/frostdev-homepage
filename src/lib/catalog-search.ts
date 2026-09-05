// Ranks the add-ward catalog for a query. Half SEMANTIC (what would I call
// it: title + blurb + concepts), half FUNCTIONAL (what does it do: does + the
// trigger/action labels that anchor on the type + its link provider). Local
// lexicon + fuzzy tokens — no embeddings, no network, no dependency. Pure and
// registry-blind: the caller derives the labels with registryDoes() so this
// module never imports logic.ts.
import type { CatalogEntry } from './wards.ts';

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'my', 'me', 'it', 'is', 'with', 'that', 'this', 'what', 'whats', 'show', 'ward', 'tile', 'widget', 'do', 'does']);

/** Light, symmetric stemming: both query and vocabulary go through it. */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 5 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/** Lowercase, apostrophes dropped, split on anything that is not a letter or
 *  digit (space, hyphen, slash, punctuation), stop words out, stems in. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem)
    .filter((t) => !STOP.has(t));
}

/** Restricted Damerau-Levenshtein (an adjacent swap costs one). Tokens are short; full DP is fine. */
function editDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/** Sørensen–Dice over character bigrams, 0..1. Three-letter tokens match
 *  exactly or by prefix only — "set" would otherwise be 0.67 of "reset". */
function dice(a: string, b: string): number {
  if (a.length < 4 || b.length < 4) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n) {
      hit++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hit) / (a.length + b.length - 2);
}

/** exact 1 · prefix either way 0.8 · one typo (both ≥ 4 chars) 0.6 · bigram overlap ≥ 0.6 its value · else 0. */
export function tokenSim(q: string, v: string): number {
  if (q === v) return 1;
  const min = Math.min(q.length, v.length);
  if (min >= 3 && (v.startsWith(q) || q.startsWith(v))) return 0.8;
  const typo = min >= 4 && Math.abs(q.length - v.length) <= 1 && editDistance(q, v) <= 1 ? 0.6 : 0;
  const d = dice(q, v);
  return Math.max(typo, d >= 0.6 ? d : 0);
}

/** Mean over query tokens of the best vocabulary match — mean, not product, so a
 *  two-word query still finds the ward that answers one of them. */
function half(qs: string[], vocab: Iterable<string>): number {
  let sum = 0;
  for (const q of qs) {
    let best = 0;
    for (const v of vocab) {
      best = Math.max(best, tokenSim(q, v));
      if (best === 1) break;
    }
    sum += best;
  }
  return sum / qs.length;
}

export interface CatalogHit {
  type: string;
  score: number;
}

const MIN_SCORE = 0.2;

/** Ranked hits, best first; equal scores keep catalog order (sort is stable).
 *  An empty query is the catalog in its own order with score 0. `derived`
 *  maps type → extra functional phrases (see registryDoes). */
export function searchCatalog(query: string, entries: [string, CatalogEntry][], derived: Record<string, string[]> = {}): CatalogHit[] {
  const qs = tokenize(query);
  if (!qs.length) return entries.map(([type]) => ({ type, score: 0 }));
  const hits: CatalogHit[] = [];
  for (const [type, c] of entries) {
    const semantic = new Set(tokenize([c.title, c.blurb, ...c.concepts].join(' ')));
    const functional = new Set(tokenize([...c.does, ...(derived[type] ?? []), c.link ?? ''].join(' ')));
    const score = 0.5 * half(qs, semantic) + 0.5 * half(qs, functional);
    if (score >= MIN_SCORE) hits.push({ type, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** type → the labels of every spec anchored on it. Feed it
 *  [...Object.values(TRIGGERS), ...Object.values(ACTIONS)] from lib/logic.ts. */
export function registryDoes(specs: Iterable<{ label: string; wardType?: string | string[] }>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of specs) for (const t of [s.wardType ?? []].flat()) (out[t] ??= []).push(s.label);
  return out;
}
// ponytail: per-keystroke retokenizes ~27 entries × ~60 tokens; memoize the sets per entry if the catalog passes a few hundred.
