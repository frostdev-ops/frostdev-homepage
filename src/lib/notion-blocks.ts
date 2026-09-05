// Notion block codec. Pure, like notion-props.ts: `readBlock` flattens an API
// block into the flat shape a ward renders and edits, `writeBlock` turns that
// shape back into a block body for append/update. Every block type Notion
// returns reads; the writable ones are listed in WRITABLE.

import { plainText, styledRuns, toRichText, type RichTextItem } from './notion-props.ts';

/** Types a ward can create and edit as plain text. Order = the "add" menu. */
export const WRITABLE = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
  'divider',
  'bookmark',
  'embed',
] as const;
export type WritableBlock = (typeof WRITABLE)[number];

const WRITABLE_SET = new Set<string>(WRITABLE);
export const isWritable = (t: string): t is WritableBlock => WRITABLE_SET.has(t);

/** Types whose body is `{ rich_text: [...] }` — the plain-text family. */
const TEXTY = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
]);

/** Types whose body is `{ url }`. */
const URLY = new Set(['bookmark', 'embed', 'link_preview']);

/** Types whose body is a file: external/file/file_upload + caption. */
const FILEY = new Set(['image', 'video', 'audio', 'file', 'pdf']);

export interface NBlock {
  id: string;
  type: string;
  /** Plain text of the block, '' for structural types. */
  text: string;
  /** The formatted runs, only when some run is styled or linked. */
  runs?: RichTextItem[];
  /** table_row: one plain string per cell (`text` joins them with ' | '). */
  cells?: string[];
  /** to_do only. */
  checked?: boolean;
  /** code only. */
  language?: string;
  /** bookmark/embed/image/video/file/pdf — the resource. */
  url?: string;
  /** callout emoji, child_page/child_database icon. */
  icon?: string;
  /** Notion block colour ('default', 'blue_background', …). */
  color?: string;
  hasChildren: boolean;
  /** False for types this codec can display but not round-trip. */
  editable: boolean;
  created: string;
  edited: string;
}

interface RawBlock {
  id?: string;
  type?: string;
  has_children?: boolean;
  created_time?: string;
  last_edited_time?: string;
  [k: string]: unknown;
}

type Body = {
  rich_text?: RichTextItem[];
  caption?: RichTextItem[];
  checked?: boolean;
  language?: string;
  url?: string;
  title?: string;
  expression?: string;
  icon?: { type?: string; emoji?: string };
  color?: string;
  external?: { url?: string };
  file?: { url?: string };
  cells?: RichTextItem[][];
};

export function readBlock(raw: RawBlock): NBlock {
  const type = raw.type ?? 'unsupported';
  const body = (raw[type] ?? {}) as Body;
  const out: NBlock = {
    id: String(raw.id ?? ''),
    type,
    text: '',
    hasChildren: !!raw.has_children,
    editable: isWritable(type),
    created: String(raw.created_time ?? ''),
    edited: String(raw.last_edited_time ?? ''),
  };
  if (body.color && body.color !== 'default') out.color = body.color;
  if (body.icon?.emoji) out.icon = body.icon.emoji;

  if (TEXTY.has(type)) {
    out.text = plainText(body.rich_text);
    const runs = styledRuns(body.rich_text);
    if (runs) out.runs = runs;
  } else if (URLY.has(type)) {
    out.url = body.url ?? '';
    out.text = plainText(body.caption) || out.url;
  } else if (FILEY.has(type)) {
    out.url = body.external?.url ?? body.file?.url ?? '';
    out.text = plainText(body.caption);
  } else if (type === 'child_page' || type === 'child_database') out.text = body.title ?? '';
  else if (type === 'equation') out.text = body.expression ?? '';
  else if (type === 'table_row') {
    out.cells = (body.cells ?? []).map((c) => plainText(c));
    out.text = out.cells.join(' | ');
  }
  else if (type === 'divider' || type === 'breadcrumb' || type === 'table_of_contents') out.text = '';
  else out.text = plainText(body.rich_text); // synced_block, column, table, future types

  if (type === 'to_do') out.checked = !!body.checked;
  if (type === 'code') out.language = body.language ?? 'plain text';
  return out;
}

export interface BlockDraft {
  type: string;
  text?: string;
  checked?: boolean;
  language?: string;
  url?: string;
  icon?: string;
  color?: string;
}

/** A block body for POST /blocks/{id}/children or PATCH /blocks/{id}.
 *  Throws for types this codec will not create — the caller surfaces it. */
export function writeBlock(d: BlockDraft): Record<string, unknown> {
  const type = d.type;
  if (!isWritable(type)) throw new Error(`block type "${type}" cannot be created or edited here`);
  const text = String(d.text ?? '');
  if (type === 'divider') return { type, divider: {} };
  if (URLY.has(type)) {
    const url = String(d.url ?? text).slice(0, 2000);
    if (!/^https?:\/\//i.test(url)) throw new Error('a bookmark or embed needs an http(s) URL');
    return { type, [type]: { url, ...(d.text && d.url ? { caption: toRichText(d.text) } : {}) } };
  }
  const body: Record<string, unknown> = { rich_text: toRichText(text) };
  if (type === 'to_do') body.checked = !!d.checked;
  if (type === 'code') body.language = String(d.language || 'plain text').slice(0, 40);
  if (type === 'callout' && d.icon) body.icon = { type: 'emoji', emoji: d.icon.slice(0, 8) };
  if (d.color && type !== 'code') body.color = String(d.color).slice(0, 40);
  return { type, [type]: body };
}

/** The PATCH body for an EXISTING block: same shape, minus the `type` key
 *  (Notion infers it, and sending a different one is an error). */
export function updateBlockBody(d: BlockDraft): Record<string, unknown> {
  const full = writeBlock(d);
  delete full.type;
  return full;
}

/** Human label for the add-block menu and the type chip. */
export function blockLabel(type: string): string {
  return (
    {
      paragraph: 'Text',
      heading_1: 'Heading 1',
      heading_2: 'Heading 2',
      heading_3: 'Heading 3',
      bulleted_list_item: 'Bulleted item',
      numbered_list_item: 'Numbered item',
      to_do: 'To-do',
      toggle: 'Toggle',
      quote: 'Quote',
      callout: 'Callout',
      code: 'Code',
      divider: 'Divider',
      bookmark: 'Bookmark',
      embed: 'Embed',
    }[type] ?? type.replace(/_/g, ' ')
  );
}
