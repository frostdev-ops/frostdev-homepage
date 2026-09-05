// Notion property codec. Pure — no db, no fetch — so it ships to the client
// and tests without a token. ONE pair of functions covers every property type
// Notion has: `readProp` flattens an API property value for display/editing,
// `writeProp` builds the PATCH body for one. Nothing above this file may
// branch on property type; add a type here and every ward, tool and logic
// action gets it.

export interface RichTextItem {
  plain_text?: string;
  href?: string | null;
  text?: { content?: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; underline?: boolean; code?: boolean; color?: string };
}

export function plainText(rt?: RichTextItem[] | null): string {
  return (rt ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');
}

const STYLED = ['bold', 'italic', 'strikethrough', 'underline', 'code'] as const;
/** True when a run carries any formatting Notion would draw. */
export function isStyled(r: RichTextItem): boolean {
  const a = r.annotations ?? {};
  return !!r.href || !!r.text?.link || STYLED.some((k) => a[k]) || (!!a.color && a.color !== 'default');
}

/** The runs, when at least one is styled or linked — else undefined, so plain
 *  text ships as text alone. A ward draws `runs` when present, `text` otherwise. */
export function styledRuns(rt?: RichTextItem[] | null): RichTextItem[] | undefined {
  if (!rt?.some(isStyled)) return undefined;
  return rt.map((r) => ({
    plain_text: r.plain_text ?? r.text?.content ?? '',
    ...(r.href || r.text?.link?.url ? { href: r.href ?? r.text?.link?.url } : {}),
    ...(isStyled(r) ? { annotations: r.annotations } : {}),
  }));
}

/** ponytail: writes flatten to ONE unstyled text run — editing a property that
 *  held bold/links loses them. Carry the runs through the editor if that bites. */
export function toRichText(s: string, max = 2000): RichTextItem[] {
  const content = s.slice(0, max);
  return content ? [{ type: 'text', text: { content } } as RichTextItem] : [];
}

/** Property types the API computes; PATCHing one is an error, not a no-op. */
export const READ_ONLY_PROPS = new Set([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'button',
  'verification',
  'last_visited_time',
  'place',
]);

/** How a ward should render an editor for the type. */
export type PropEditor = 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multi_select' | 'people' | 'relation' | 'files' | 'none';

export function editorFor(type: string): PropEditor {
  if (READ_ONLY_PROPS.has(type)) return 'none';
  switch (type) {
    case 'title':
    case 'rich_text':
    case 'url':
    case 'email':
    case 'phone_number':
      return 'text';
    case 'number':
      return 'number';
    case 'checkbox':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'select':
    case 'status':
      return 'select';
    case 'multi_select':
      return 'multi_select';
    case 'people':
      return 'people';
    case 'relation':
      return 'relation';
    case 'files':
      return 'files';
    default:
      return 'none'; // an unknown/future type displays but never writes
  }
}

export interface PropValue {
  type: string;
  /** Always present: the one-line display form. '' means empty. */
  text: string;
  /** Notion's own option colour name, when the value carries one. */
  color?: string;
  /** multi_select: one colour per `value` entry. */
  colors?: string[];
  /** title/rich_text: the formatted runs, only when some run is styled or linked. */
  runs?: RichTextItem[];
  /** The structured value an editor binds to. Shape depends on `type`:
   *  text→string, number→number|null, checkbox→boolean, date→{start,end},
   *  select/status→string, multi_select→string[], people/relation→{id,name}[],
   *  files→{name,url}[]. Read-only types put their display string here. */
  value: unknown;
  /** False when the API will reject a write for this type. */
  editable: boolean;
}

interface RawProp {
  id?: string;
  type?: string;
  title?: RichTextItem[];
  rich_text?: RichTextItem[];
  number?: number | null;
  select?: { name?: string; color?: string } | null;
  status?: { name?: string; color?: string } | null;
  multi_select?: { name: string; color?: string }[];
  date?: { start?: string; end?: string | null; time_zone?: string | null } | null;
  people?: { id?: string; name?: string }[];
  files?: { name?: string; external?: { url?: string }; file?: { url?: string } }[];
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  relation?: { id: string }[];
  has_more?: boolean;
  formula?: { type?: string; string?: string | null; number?: number | null; boolean?: boolean | null; date?: { start?: string } | null };
  rollup?: { type?: string; number?: number | null; date?: { start?: string } | null; array?: RawProp[]; function?: string };
  created_time?: string;
  last_edited_time?: string;
  last_visited_time?: string;
  created_by?: { id?: string; name?: string };
  last_edited_by?: { id?: string; name?: string };
  unique_id?: { prefix?: string | null; number?: number };
  verification?: { state?: string };
  button?: unknown;
}

const dateText = (d: RawProp['date']): string => (d?.start ? (d.end ? `${d.start} → ${d.end}` : d.start) : '');

export function readProp(p: RawProp | undefined | null, name = ''): PropValue {
  const type = p?.type ?? 'unknown';
  const editable = !!p && !READ_ONLY_PROPS.has(type) && editorFor(type) !== 'none';
  const out = (text: string, value: unknown, color?: string): PropValue => ({ type, text, value, editable, ...(color ? { color } : {}) });
  switch (type) {
    case 'title':
    case 'rich_text': {
      const rt = type === 'title' ? p!.title : p!.rich_text;
      const runs = styledRuns(rt);
      return { ...out(plainText(rt), plainText(rt)), ...(runs ? { runs } : {}) };
    }
    case 'number':
      return out(p!.number == null ? '' : String(p!.number), p!.number ?? null);
    case 'select':
      return out(p!.select?.name ?? '', p!.select?.name ?? '', p!.select?.color);
    case 'status':
      return out(p!.status?.name ?? '', p!.status?.name ?? '', p!.status?.color);
    case 'multi_select': {
      const opts = p!.multi_select ?? [];
      const v = out(opts.map((o) => o.name).join(', '), opts.map((o) => o.name), opts[0]?.color);
      return opts.length ? { ...v, colors: opts.map((o) => o.color ?? 'default') } : v;
    }
    case 'date':
      return out(dateText(p!.date), { start: p!.date?.start ?? '', end: p!.date?.end ?? '' });
    case 'people': {
      const ppl = (p!.people ?? []).map((x) => ({ id: x.id ?? '', name: x.name ?? '' }));
      return out(ppl.map((x) => x.name).filter(Boolean).join(', '), ppl);
    }
    case 'files': {
      const files = (p!.files ?? []).map((f) => ({ name: f.name ?? '', url: f.external?.url ?? f.file?.url ?? '' }));
      return out(files.map((f) => f.name || f.url).join(', '), files);
    }
    case 'checkbox':
      return out(p!.checkbox ? '✓' : '—', !!p!.checkbox);
    case 'url':
      return out(p!.url ?? '', p!.url ?? '');
    case 'email':
      return out(p!.email ?? '', p!.email ?? '');
    case 'phone_number':
      return out(p!.phone_number ?? '', p!.phone_number ?? '');
    case 'relation': {
      const rel = (p!.relation ?? []).map((r) => ({ id: r.id, name: '' }));
      // Relations come back as bare ids; a ward resolves titles only if it wants them.
      return out(rel.length ? `${rel.length} linked${p!.has_more ? '+' : ''}` : '', rel);
    }
    case 'formula': {
      const f = p!.formula ?? {};
      const t = f.string ?? (f.number == null ? undefined : String(f.number)) ?? f.date?.start ?? (f.boolean == null ? '' : f.boolean ? '✓' : '—');
      return out(String(t ?? ''), String(t ?? ''));
    }
    case 'rollup': {
      const r = p!.rollup ?? {};
      if (r.type === 'array') {
        const parts = (r.array ?? []).map((x) => readProp(x).text).filter(Boolean);
        return out(parts.join(', '), parts.join(', '));
      }
      const t = r.number == null ? (r.date?.start ?? '') : String(r.number);
      return out(t, t);
    }
    case 'unique_id': {
      const u = p!.unique_id;
      const t = u?.number == null ? '' : `${u.prefix ? `${u.prefix}-` : ''}${u.number}`;
      return out(t, t);
    }
    case 'created_time':
      return out(p!.created_time ?? '', p!.created_time ?? '');
    case 'last_edited_time':
      return out(p!.last_edited_time ?? '', p!.last_edited_time ?? '');
    case 'last_visited_time':
      return out(p!.last_visited_time ?? '', p!.last_visited_time ?? '');
    case 'created_by':
      return out(p!.created_by?.name ?? '', p!.created_by?.name ?? '');
    case 'last_edited_by':
      return out(p!.last_edited_by?.name ?? '', p!.last_edited_by?.name ?? '');
    case 'verification':
      return out(p!.verification?.state ?? '', p!.verification?.state ?? '');
    default:
      return out('', null, undefined); // button, place, future types
  }
}

/** Flatten a whole page's properties. `name` keys survive; order is Notion's. */
export function readProps(props: Record<string, RawProp> | undefined): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [name, p] of Object.entries(props ?? {})) out[name] = readProp(p, name);
  return out;
}

const str = (v: unknown, max = 2000) => String(v ?? '').slice(0, max);
const nonEmpty = <T>(arr: T[]) => arr;

/** The PATCH body for ONE property. Throws for types the API cannot write —
 *  a visible error beats a request Notion silently ignores. */
export function writeProp(type: string, value: unknown): Record<string, unknown> {
  if (READ_ONLY_PROPS.has(type)) throw new Error(`"${type}" is computed by Notion and cannot be written`);
  switch (type) {
    case 'title':
      return { title: toRichText(str(value)) };
    case 'rich_text':
      return { rich_text: toRichText(str(value)) };
    case 'number': {
      if (value === '' || value === null || value === undefined) return { number: null };
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('not a number');
      return { number: n };
    }
    case 'select':
      return { select: str(value, 100) ? { name: str(value, 100) } : null };
    case 'status': {
      // A status property has no "empty" — Notion rejects null here.
      const name = str(value, 100);
      if (!name) throw new Error('a status cannot be cleared');
      return { status: { name } };
    }
    case 'multi_select': {
      const names = (Array.isArray(value) ? value : str(value).split(',')).map((v) => str(v, 100).trim()).filter(Boolean);
      return { multi_select: nonEmpty(names.slice(0, 100).map((name) => ({ name }))) };
    }
    case 'date': {
      const v = (typeof value === 'object' && value !== null ? value : { start: value }) as { start?: unknown; end?: unknown; time_zone?: unknown };
      const start = str(v.start, 40);
      if (!start) return { date: null };
      const end = str(v.end, 40);
      return { date: { start, ...(end ? { end } : {}), ...(v.time_zone ? { time_zone: str(v.time_zone, 60) } : {}) } };
    }
    case 'people': {
      const ids = (Array.isArray(value) ? value : []).map((x) => (typeof x === 'string' ? x : str((x as { id?: string })?.id, 60))).filter(Boolean);
      return { people: ids.slice(0, 100).map((id) => ({ object: 'user', id })) };
    }
    case 'relation': {
      const ids = (Array.isArray(value) ? value : []).map((x) => (typeof x === 'string' ? x : str((x as { id?: string })?.id, 60))).filter(Boolean);
      return { relation: ids.slice(0, 100).map((id) => ({ id })) };
    }
    case 'files': {
      const files = (Array.isArray(value) ? value : []).slice(0, 100).map((f) => {
        const o = f as { name?: string; url?: string; file_upload_id?: string };
        if (o.file_upload_id) return { type: 'file_upload', name: str(o.name, 100) || 'file', file_upload: { id: str(o.file_upload_id, 60) } };
        return { type: 'external', name: str(o.name, 100) || str(o.url, 100), external: { url: str(o.url, 2000) } };
      });
      return { files };
    }
    case 'checkbox':
      return { checkbox: value === true || value === 'true' || value === 'on' || value === 1 };
    case 'url':
      return { url: str(value, 2000) || null };
    case 'email':
      return { email: str(value, 200) || null };
    case 'phone_number':
      return { phone_number: str(value, 100) || null };
    default:
      throw new Error(`property type "${type}" cannot be edited here`);
  }
}

/** A whole properties PATCH from {name: value}, given the data source schema.
 *  Unknown names and read-only columns are DROPPED, not fatal — a ward's stale
 *  field list must not block the edits that are still valid. */
export function writeProps(
  schema: Record<string, { type: string }>,
  patch: Record<string, unknown>
): { properties: Record<string, unknown>; skipped: string[] } {
  const properties: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(patch)) {
    const type = schema[name]?.type;
    if (!type || READ_ONLY_PROPS.has(type)) {
      skipped.push(name);
      continue;
    }
    try {
      properties[name] = writeProp(type, value);
    } catch {
      skipped.push(name);
    }
  }
  return { properties, skipped };
}
