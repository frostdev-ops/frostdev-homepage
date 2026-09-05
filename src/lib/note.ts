import { getDb } from './db.ts';
import { getDashboard } from './dashboard.ts';
import { httpUrl, type WardInstance } from './wards.ts';

// The notepad ward's document store. The document is HTML the browser's own
// editor produced (contenteditable), so the trust boundary is here: every save
// is rebuilt through an allowlist — tags from a fixed set, no attributes but a
// vetted href and a text-align, every stray `<` escaped, every tag balanced —
// and a page only ever renders what came back out of this file. The agent's
// write_note goes through the same door.

export const NOTE_HTML_MAX = 512 * 1024;
export const NOTE_INK_MAX = 2 * 1024 * 1024;

export interface NoteDoc {
  html: string;
  /** JSON: Stroke[] (scripts/app/note.ts) — opaque here, only its size and shape are checked. */
  ink: string;
  updated: string | null;
}

/** The note ward itself, or null when `ward` isn't this user's note ward. */
export function noteWard(userId: number, ward: unknown): WardInstance | null {
  if (typeof ward !== 'string') return null;
  return getDashboard(userId).find((w) => w.i === ward && w.type === 'note') ?? null;
}

const escText = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function getNote(userId: number, w: WardInstance): NoteDoc {
  const row = getDb().prepare('SELECT html, ink, updated_at FROM notes WHERE user_id = ? AND ward = ?').get(userId, w.i) as
    | { html: string; ink: string; updated_at: string }
    | undefined;
  if (row) return { html: row.html, ink: row.ink, updated: row.updated_at };
  // A note written before the document store existed keeps its config text as
  // the first draft; the first save materializes the row.
  const seed = typeof w.config?.text === 'string' ? w.config.text : '';
  const html = seed
    .split(/\r?\n/)
    .map((line) => `<p>${escText(line)}</p>`)
    .join('');
  return { html: seed ? html : '', ink: '[]', updated: null };
}

/** Store a patch (either half may be absent). Throws with a `status` for the route. */
export function saveNote(userId: number, w: WardInstance, patch: { html?: string; ink?: string }): string {
  const cur = getNote(userId, w);
  let html = cur.html;
  let ink = cur.ink;
  if (patch.html !== undefined) {
    if (patch.html.length > NOTE_HTML_MAX) throw Object.assign(new Error('the document is too large'), { status: 413 });
    html = sanitizeHtml(patch.html);
  }
  if (patch.ink !== undefined) {
    if (patch.ink.length > NOTE_INK_MAX) throw Object.assign(new Error('too much ink — clear some strokes'), { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(patch.ink);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) throw Object.assign(new Error('bad ink'), { status: 400 });
    ink = patch.ink;
  }
  const row = getDb()
    .prepare(
      `INSERT INTO notes (user_id, ward, html, ink) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, ward) DO UPDATE SET html = excluded.html, ink = excluded.ink, updated_at = datetime('now')
       RETURNING updated_at`
    )
    .get(userId, w.i, html, ink) as { updated_at: string };
  return row.updated_at;
}

/** The document as text — what the agent reads and the model gets as context. */
export function plainText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Plain text (paragraphs on blank lines) → the same HTML the editor would make. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escText(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ------------------------------------------------------------- sanitizer

const ALLOWED = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'a', 'div', 'span',
]);
const VOID = new Set(['br', 'hr']);
// What the HTML tokenizer treats as markup after a `<`: a letter (a tag), `!`
// (a comment / declaration), `/` (an end tag), `?` (a bogus comment). Any other
// `<` is text — "a < b" must survive as text.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->|<[!?/][^>]*>?/g;

function attr(raw: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/** Rebuild `input` from an allowlist. The output is only ever escaped text and
 *  canonical tags this function wrote — nothing from the input reaches it as-is. */
export function sanitizeHtml(input: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(input))) {
    out.push(escText(input.slice(i, m.index)));
    i = m.index + m[0].length;
    const name = m[1]?.toLowerCase();
    if (!name || !ALLOWED.has(name)) continue; // an unknown tag, a comment, junk: dropped
    if (m[0].startsWith('</')) {
      if (VOID.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at < 0) continue; // a close with no open: dropped
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    let attrs = '';
    if (name === 'a') {
      const href = httpUrl(attr(m[2] ?? '', 'href'));
      if (href) attrs = ` href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer"`;
    }
    const align = /text-align\s*:\s*(left|center|right)/i.exec(attr(m[2] ?? '', 'style'));
    if (align) attrs += ` style="text-align:${align[1]!.toLowerCase()}"`;
    out.push(`<${name}${attrs}>`);
    if (!VOID.has(name)) open.push(name);
  }
  out.push(escText(input.slice(i)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}
