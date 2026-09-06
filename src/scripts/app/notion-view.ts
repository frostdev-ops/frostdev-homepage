import { icon } from './icon.ts';
// The Notion DISPLAY layer: how a property value, a rich-text run list and a
// block look on a ward — chips in Notion's own colours, "Sep 2" dates, links,
// bullets, callouts, images. Every Notion surface (table cells, page
// properties, the task list's chips, calendar cards) draws through here; the
// editors in notion.ts take over on click and hand back to propView after.
// Pure DOM over the codec's shapes — no fetch, no state.

import type { PropValue, RichTextItem } from '../../lib/notion-props.ts';
import type { NBlock } from '../../lib/notion-blocks.ts';
import { blockLabel } from '../../lib/notion-blocks.ts';
import { el } from './dom.ts';

export interface OptionSpec {
  options?: { name: string; color?: string }[];
}

/** Notion colour name → the data-nc hue + whether it is the _background form. */
function tint(node: HTMLElement, color?: string): void {
  if (!color || color === 'default') return;
  const bg = color.endsWith('_background');
  node.dataset.nc = bg ? color.slice(0, -'_background'.length) : color;
  if (bg) node.dataset.bg = '';
}

export function chip(text: string, color?: string, title?: string): HTMLElement {
  const c = el('span', 'nchip', text);
  if (color) c.dataset.nc = color;
  if (title) c.title = title;
  return c;
}

function link(href: string, text: string, cls = ''): HTMLAnchorElement {
  const a = el('a', `${cls} hover:underline`.trim(), text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

/** Formatted runs, or the plain text when nothing is styled. */
export function richText(runs: RichTextItem[] | undefined, plain: string, cls = ''): HTMLElement {
  const root = el('span', `nrt ${cls}`.trim());
  if (!runs?.length) {
    root.textContent = plain;
    return root;
  }
  for (const r of runs) {
    const a = r.annotations ?? {};
    let node: HTMLElement = el('span', '', r.plain_text ?? '');
    if (a.code) node = wrap('code', node);
    if (a.bold) node = wrap('b', node);
    if (a.italic) node = wrap('i', node);
    if (a.strikethrough) node = wrap('s', node);
    if (a.underline) node = wrap('u', node);
    tint(node, a.color);
    if (r.href) {
      const anchor = link(r.href, '', 'underline decoration-line-strong');
      anchor.append(node);
      node = anchor;
    }
    root.append(node);
  }
  return root;
}

function wrap(tag: 'b' | 'i' | 's' | 'u' | 'code', inner: HTMLElement): HTMLElement {
  const outer = el(tag, tag === 'code' ? 'rounded bg-surface-2 px-0.5 font-mono text-[0.9em]' : '');
  outer.append(inner);
  return outer;
}

const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();

/** "Sep 2" · "Sep 2, 2027" · "Sep 2, 11:59 PM" · "Sep 2 → Sep 5". */
export function fmtDate(v: { start?: string; end?: string | null } | undefined): string {
  if (!v?.start) return '';
  const one = (s: string) => {
    const d = new Date(s.includes('T') ? s : `${s}T00:00:00`);
    if (Number.isNaN(d.getTime())) return s;
    const day = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear(d) ? {} : { year: 'numeric' }) });
    return s.includes('T') ? `${day}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : day;
  };
  return v.end && v.end !== v.start ? `${one(v.start)} → ${one(v.end)}` : one(v.start);
}

/** The read-only look of one property value — what Notion shows in a cell. */
export function propView(pv: PropValue, spec?: OptionSpec): HTMLElement {
  const empty = () => el('span', 'nv-empty');
  switch (pv.type) {
    case 'title':
    case 'rich_text':
      return pv.text ? richText(pv.runs, pv.text, `text-xs ${pv.type === 'title' ? 'font-medium' : ''}`) : empty();
    case 'select':
    case 'status':
      return pv.text ? chip(pv.text, pv.color) : empty();
    case 'multi_select': {
      const names = Array.isArray(pv.value) ? (pv.value as string[]) : [];
      if (!names.length) return empty();
      const byName = new Map((spec?.options ?? []).map((o) => [o.name, o.color]));
      const row = el('span', 'inline-flex flex-wrap gap-1');
      names.forEach((n, i) => row.append(chip(n, pv.colors?.[i] ?? byName.get(n))));
      return row;
    }
    case 'checkbox': {
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = pv.value === true;
      cb.disabled = true;
      return cb;
    }
    case 'date':
      return pv.text ? el('span', 'text-xs tabular-nums', fmtDate(pv.value as { start?: string; end?: string })) : empty();
    case 'number':
      return pv.text ? el('span', 'text-xs tabular-nums', pv.text) : empty();
    case 'url':
      return pv.text ? link(pv.text, pv.text.replace(/^https?:\/\/(www\.)?/, ''), 'block truncate text-xs') : empty();
    case 'email':
      return pv.text ? link(`mailto:${pv.text}`, pv.text, 'block truncate text-xs') : empty();
    case 'phone_number':
      return pv.text ? link(`tel:${pv.text}`, pv.text, 'block truncate text-xs') : empty();
    case 'people': {
      const ppl = (Array.isArray(pv.value) ? pv.value : []) as { name: string }[];
      if (!ppl.length) return empty();
      const row = el('span', 'inline-flex flex-wrap gap-1');
      for (const p of ppl) row.append(chip(p.name || '?'));
      return row;
    }
    case 'files': {
      const files = (Array.isArray(pv.value) ? pv.value : []) as { name: string; url: string }[];
      if (!files.length) return empty();
      const row = el('span', 'inline-flex flex-wrap gap-1');
      for (const f of files) {
        const c = chip(f.name || f.url);
        if (f.url) {
          const a = link(f.url, '');
          a.append(c);
          row.append(a);
        } else row.append(c);
      }
      return row;
    }
    case 'relation':
      return pv.text ? chip(pv.text) : empty();
    default:
      // formula, rollup, created/edited time+by, unique_id, verification, unknown
      return pv.text ? el('span', 'text-xs text-ink-muted', pv.text) : empty();
  }
}

/** The PropValue a successful write leaves behind, so the display can update
 *  without a round trip. Colours come from the schema's options. */
export function withValue(pv: PropValue, spec: OptionSpec | undefined, value: unknown): PropValue {
  const byName = new Map((spec?.options ?? []).map((o) => [o.name, o.color]));
  const out: PropValue = { ...pv, value };
  delete out.runs;
  switch (pv.type) {
    case 'select':
    case 'status':
      out.text = String(value ?? '');
      out.color = byName.get(out.text);
      break;
    case 'multi_select': {
      const names = Array.isArray(value) ? (value as string[]) : [];
      out.text = names.join(', ');
      out.colors = names.map((n) => byName.get(n) ?? 'default');
      out.color = out.colors[0];
      break;
    }
    case 'date': {
      const d = (value ?? {}) as { start?: string; end?: string };
      out.text = d.start ? (d.end ? `${d.start} → ${d.end}` : d.start) : '';
      break;
    }
    case 'checkbox':
      out.text = value ? '✓' : '—';
      break;
    case 'people':
    case 'relation':
    case 'files': {
      const arr = Array.isArray(value) ? (value as { name?: string; url?: string }[]) : [];
      out.text = pv.type === 'relation' ? (arr.length ? `${arr.length} linked` : '') : arr.map((x) => x.name || x.url || '').filter(Boolean).join(', ');
      break;
    }
    default:
      out.text = value == null ? '' : String(value);
  }
  return out;
}

// -------------------------------------------------------------------- blocks

const HEAD: Record<string, string> = {
  heading_1: 'mt-1.5 text-sm font-semibold',
  heading_2: 'mt-1 text-[13px] font-semibold',
  heading_3: 'mt-0.5 text-xs font-semibold',
};

/** The read-only look of one block. `n` is the running number of a numbered
 *  list item; the page renderer counts siblings. Every type Notion returns
 *  gets a shape here; the editors in notion.ts wrap the text ones. */
export function blockView(b: NBlock, n = 1): HTMLElement {
  const text = (cls = 'text-xs') => richText(b.runs, b.text, `min-w-0 flex-1 whitespace-pre-wrap break-words ${cls}`);
  const marker = (m: string, body: HTMLElement) => {
    const row = el('div', 'nblk flex items-start gap-1.5');
    row.append(el('span', 'w-3 shrink-0 select-none text-right text-xs text-ink-muted', m), body);
    return row;
  };
  let node: HTMLElement;
  switch (b.type) {
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      node = text(HEAD[b.type]);
      break;
    case 'bulleted_list_item':
      node = marker('•', text());
      break;
    case 'numbered_list_item':
      node = marker(`${n}.`, text());
      break;
    case 'to_do': {
      const cb = el('input', 'mt-0.5 shrink-0') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = !!b.checked;
      cb.disabled = true;
      node = el('div', 'nblk flex items-start gap-1.5');
      node.append(cb, text(b.checked ? 'text-xs text-ink-muted line-through' : 'text-xs'));
      break;
    }
    case 'toggle':
      node = marker(b.hasChildren ? '▾' : '▸', text());
      break;
    case 'quote':
      node = text('border-l-2 border-line-strong pl-2 text-xs');
      break;
    case 'callout': {
      node = el('div', 'nblk flex items-start gap-1.5 rounded-md bg-surface-2 px-2 py-1.5');
      if (b.icon) node.append(el('span', 'shrink-0 text-sm leading-none', b.icon));
      node.append(text());
      break;
    }
    case 'code': {
      node = el('pre', 'nblk overflow-x-auto rounded-md bg-surface-2 px-2 py-1.5 font-mono text-[10px] leading-snug whitespace-pre', b.text);
      if (b.language) node.title = b.language;
      break;
    }
    case 'divider':
      node = el('hr', 'my-1.5 border-line');
      break;
    case 'image': {
      node = el('figure', 'nblk my-1');
      const img = el('img', 'max-h-48 rounded-md') as HTMLImageElement;
      img.src = b.url ?? '';
      img.alt = b.text;
      img.loading = 'lazy';
      node.append(img);
      if (b.text) node.append(el('figcaption', 'mt-0.5 text-[10px] text-ink-faint', b.text));
      break;
    }
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const label = b.text || b.url || blockLabel(b.type);
      node = b.url ? link(b.url, label, 'nblk block truncate text-xs') : el('span', 'text-xs text-ink-muted', label);
      node.title = `${blockLabel(b.type)} · ${b.url ?? ''}`;
      break;
    }
    case 'child_page':
    case 'child_database': {
      node = link(`https://www.notion.so/${b.id.replace(/-/g, '')}`, `${b.icon ? `${b.icon} ` : ''}${b.text || '(untitled)'}`, 'nblk block truncate text-xs');
      if (!b.icon) node.prepend(icon(b.type === 'child_page' ? 'page' : 'database'), document.createTextNode(' '));
      break;
    }
    case 'table_row': {
      node = el('div', 'nblk grid gap-x-2 border-b border-line/40 py-0.5 text-xs');
      const cells = b.cells ?? [b.text];
      node.style.gridTemplateColumns = `repeat(${cells.length}, minmax(0, 1fr))`;
      for (const c of cells) node.append(el('span', 'truncate', c));
      break;
    }
    case 'equation':
      node = el('span', 'nblk font-mono text-xs', b.text);
      break;
    default:
      node = b.text ? text() : el('span', 'text-[10px] text-ink-faint', blockLabel(b.type));
  }
  if (b.type !== 'divider') tint(node, b.color);
  return node;
}
