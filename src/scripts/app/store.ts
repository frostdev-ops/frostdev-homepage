// The Memory and Skills wards: one list renderer over /api/store/<kind>.
// Every document is a row (name + description) that opens in place to read,
// edit or delete, a New line creates one by hand, and the head line says how
// much of the generated index rides in Rime's prompt. The memory ward adds
// the nightly-reflection switch: one logic edge — at-time-of-day on the ward
// → agent.ask on the user's Rime ward — created and removed by id, so it
// shows in Logic mode like any other wire.
import type { WardInstance } from '../../lib/wards.ts';
import { ago, el, getJson, postJson, tapToast, toast } from './dom.ts';
import { RENDERERS, body, note, readLayout } from './wards.ts';

type Kind = 'memory' | 'skill';

interface DocEntry {
  name: string;
  description: string;
  chars: number;
  updatedAt: number;
  files?: string[];
}

const NOUN: Record<Kind, [one: string, many: string]> = { memory: ['memory', 'memories'], skill: ['skill', 'skills'] };
const EMPTY: Record<Kind, string> = {
  memory: 'Nothing remembered yet. Rime saves facts here as it learns them — or tell it to remember something.',
  skill: 'No skills yet. A skill is a procedure Rime reads when a task matches it — teach it one, or write one below.',
};
const DESC_HINT: Record<Kind, string> = { memory: 'description — what the fact is', skill: 'description — when to use it' };

const REFLECT_AT = '03:00';
const REFLECT_PROMPT =
  "Nightly reflection. Find the conversations that changed in the last day (bash: find /history -mmin -1500 -name '*.md') and read them. " +
  'Turn anything durable — facts about the user, their setup, decisions, standing preferences — into memory files with remember: one fact per file, ' +
  'the same name again when a fact changed, forget for one that is now wrong. Not a diary: skip what happened, keep what stays true. ' +
  'Reply with one line naming what you remembered or forgot, or "nothing new".';
const reflectEdgeId = (ward: string) => `mem-reflect-${ward}`.slice(0, 32);

async function renderStore(w: WardInstance, kind: Kind): Promise<void> {
  const { status, data } = await getJson(`/api/store/${kind}`);
  const b = body(w.i);
  if (!b) return;
  if (status !== 200) {
    note(w.i, `${NOUN[kind][1]} unavailable.`);
    return;
  }
  b.textContent = '';
  const docs = (data?.docs ?? []) as DocEntry[];
  b.append(
    el('p', 'text-[10px] text-ink-faint mb-1', `${docs.length} ${NOUN[kind][docs.length === 1 ? 0 : 1]} · ${data.indexChars}/${data.indexCap} chars of index in Rime's prompt`)
  );
  if (!docs.length) b.append(el('p', 'wd-note text-xs text-ink-faint', EMPTY[kind]));
  const list = el('div', 'flex flex-col');
  for (const d of docs) list.append(row(w, kind, d));
  b.append(list, newRow(w, kind));
  if (kind === 'memory') b.append(await reflectRow(w));
}

/** The in-place editor. `existing` adds the delete button. */
function editor(w: WardInstance, kind: Kind, name: string, initial: { description: string; body: string }, existing: boolean): HTMLElement {
  const box = el('div', 'flex flex-col gap-1 pb-2');
  const desc = el('input', 'input text-xs');
  desc.value = initial.description;
  desc.maxLength = 160;
  desc.placeholder = DESC_HINT[kind];
  const text = el('textarea', 'input text-xs font-mono');
  text.value = initial.body;
  text.rows = 6;
  text.placeholder = kind === 'skill' ? 'The procedure: steps, a checklist, a format…' : 'The fact, in full.';
  const save = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'Save');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const res = await postJson(`/api/store/${kind}/${name}`, { description: desc.value, body: text.value }, 'PUT');
    if (!res.ok) {
      toast(res.data?.error ?? 'Could not save', undefined, true);
      return;
    }
    toast('Saved');
    void renderStore(w, kind);
  });
  const bar = el('div', 'flex gap-1');
  bar.append(save);
  if (existing) {
    const del = el('button', 'btn-danger min-h-0 px-2 py-1 text-xs', kind === 'memory' ? 'Forget' : 'Delete');
    del.type = 'button';
    del.addEventListener('click', () =>
      tapToast(`${kind === 'memory' ? 'Forget' : 'Delete'} “${name}” for good?`, async () => {
        const res = await postJson(`/api/store/${kind}/${name}`, {}, 'DELETE');
        if (!res.ok) {
          toast(res.data?.error ?? 'Could not delete', undefined, true);
          return;
        }
        void renderStore(w, kind);
      })
    );
    bar.append(del);
  }
  box.append(desc, text, bar);
  for (const m of (initial as { mcp?: { name: string; url: string; header?: string }[] }).mcp ?? []) {
    const p = el('p', 'text-[10px] text-ink-faint truncate');
    p.title = m.url;
    p.append(`needs an MCP server ward: `, el('span', 'font-mono', m.name), ` — ${m.url}${m.header ? ` (token header ${m.header})` : ''}`);
    box.append(p);
  }
  return box;
}

function row(w: WardInstance, kind: Kind, d: DocEntry): HTMLElement {
  const wrap = el('div', 'border-t border-ink-faint/20 first:border-0');
  const head = el('button', 'w-full text-left py-1 flex items-baseline gap-2 min-w-0');
  head.type = 'button';
  head.title = `${d.chars} chars · ${ago(Date.now() - d.updatedAt)}`;
  head.append(el('span', 'font-mono text-xs shrink-0', d.name), el('span', 'text-[10px] text-ink-faint truncate', d.description));
  for (const f of d.files ?? []) head.append(el('span', 'font-mono text-[9px] text-ink-faint shrink-0 opacity-70', f));
  wrap.append(head);
  let open: HTMLElement | null = null;
  head.addEventListener('click', async () => {
    if (open) {
      open.remove();
      open = null;
      return;
    }
    const { status, data } = await getJson(`/api/store/${kind}/${d.name}`);
    if (status !== 200) {
      toast(data?.error ?? 'Could not read it', undefined, true);
      return;
    }
    open = editor(w, kind, d.name, data, true);
    wrap.append(open);
    open.querySelector('textarea')?.focus();
  });
  return wrap;
}

/** "New: [name] +" — a name, then the editor for it. */
function newRow(w: WardInstance, kind: Kind): HTMLElement {
  const wrap = el('div', 'mt-1 border-t border-ink-faint/20 pt-1');
  const line = el('form', 'flex items-center gap-1');
  const name = el('input', 'input text-xs font-mono flex-1 min-w-0');
  name.placeholder = `new ${NOUN[kind][0]} name (a-z, 0-9, -)`;
  name.pattern = '[a-z0-9][a-z0-9-]{0,47}';
  const add = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'New');
  add.type = 'submit';
  line.append(name, add);
  wrap.append(line);
  let open: HTMLElement | null = null;
  line.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) return;
    open?.remove();
    open = editor(w, kind, n, { description: '', body: '' }, false);
    wrap.append(open);
    open.querySelector('input')?.focus();
  });
  if (kind === 'skill') {
    // A ward folder from a URL: the folder, or its SKILL.md — tool.js and
    // mcp.json beside it come along. The name defaults to the folder's.
    const imp = el('form', 'mt-1 flex items-center gap-1');
    const url = el('input', 'input text-xs flex-1 min-w-0');
    url.type = 'url';
    url.placeholder = 'or import a folder URL (…/my-skill/ or …/SKILL.md)';
    const go = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Import');
    go.type = 'submit';
    imp.append(url, go);
    imp.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = url.value.trim();
      if (!u) return;
      const folder = u.replace(/\/SKILL\.md$/i, '').replace(/\/+$/, '').split('/').pop() ?? '';
      const n = name.value.trim() || folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      if (!n) return toast('Give the skill a name first', undefined, true);
      go.disabled = true;
      const res = await postJson(`/api/store/skill/${n}`, { url: u });
      go.disabled = false;
      if (!res.ok) return toast(res.data?.error ?? 'Could not import', undefined, true);
      toast(`Imported ${n}${res.data.files?.length ? ` with ${res.data.files.join(', ')}` : ''}`);
      void renderStore(w, kind);
    });
    wrap.append(imp);
  }
  return wrap;
}

async function reflectRow(w: WardInstance): Promise<HTMLElement> {
  const wrap = el('label', 'mt-2 flex items-center gap-2 text-[10px] text-ink-faint');
  const agent = readLayout().find((x) => x.type === 'agent');
  if (!agent) {
    wrap.textContent = 'Add a Rime ward to turn on nightly reflection.';
    return wrap;
  }
  const { data } = await getJson('/api/logic');
  const edges = (data?.graph?.edges ?? []) as { id: string }[];
  const id = reflectEdgeId(w.i);
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = edges.some((e) => e.id === id);
  cb.addEventListener('change', async () => {
    const on = cb.checked;
    const next = edges.filter((e) => e.id !== id);
    if (on) {
      next.push({
        id,
        source: { ward: w.i, trigger: 'at-time-of-day', params: { at: REFLECT_AT } },
        conditions: [],
        action: { type: 'agent.ask', ward: agent.i, params: { prompt: REFLECT_PROMPT } },
        enabled: true,
      } as unknown as { id: string });
    }
    const res = await postJson('/api/logic', { graph: { edges: next } }, 'PUT');
    if (!res.ok) {
      cb.checked = !on;
      toast(res.data?.error ?? 'Could not save the rule', undefined, true);
      return;
    }
    edges.splice(0, edges.length, ...next);
    toast(on ? `Rime reflects nightly at ${REFLECT_AT}` : 'Nightly reflection off');
  });
  wrap.append(cb, `Nightly reflection at ${REFLECT_AT} — Rime reads the day's threads into memory`);
  return wrap;
}

RENDERERS.memory = { intervalMs: 5 * 60_000, render: (w) => renderStore(w, 'memory') };
RENDERERS.skill = { intervalMs: 5 * 60_000, render: (w) => renderStore(w, 'skill') };
