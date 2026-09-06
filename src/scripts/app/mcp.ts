// The MCP ward: a connection card over /api/mcp/<ward> — the server's name
// and tool count, the error when it will not connect, the token field (the
// credential is sealed server-side, never in the layout), the tool list
// folded under a summary, and Reconnect. Rime gets the tools spliced into
// its registry as mcp__<name>__<tool>; nothing here is needed for that.
import type { WardInstance } from '../../lib/wards.ts';
import { el, getJson, postJson, toast } from './dom.ts';
import { RENDERERS, body, note } from './wards.ts';

interface McpTool {
  name: string;
  description: string;
}
// A ward added in edit mode renders before Done saves the layout, and the
// server resolves the ward against the STORED layout ("not an mcp ward").
// The save is the signal (edit.ts fires 'fd:layout-saved'), however long the
// user takes over Done — same idiom as the agent and browser wards.
const unsaved = new Map<string, WardInstance>();
document.addEventListener('fd:layout-saved', () => {
  for (const [id, w] of [...unsaved]) {
    unsaved.delete(id);
    if (body(id)) void renderMcp(w, true);
  }
});

interface Status {
  ok: boolean;
  error?: string;
  tools: McpTool[];
  server?: { name?: string; version?: string };
  hasToken: boolean;
}

async function renderMcp(w: WardInstance, fresh = false): Promise<void> {
  const cfg = (w.config ?? {}) as { name?: string; url?: string; trust?: string };
  if (!cfg.url) {
    note(w.i, 'Set the server URL under Configure.');
    return;
  }
  const { status, data } = await getJson(`/api/mcp/${w.i}${fresh ? '?fresh=1' : ''}`);
  const b = body(w.i);
  if (!b) return;
  if (status === 400 && data?.error === 'not an mcp ward') {
    unsaved.set(w.i, w);
    note(w.i, 'Connects once the layout is saved — press Done.');
    return;
  }
  if (status !== 200) {
    note(w.i, data?.error ?? 'MCP unavailable.');
    return;
  }
  const s = data as Status;
  b.textContent = '';
  const head = el('div', 'flex items-center gap-2 text-xs');
  head.append(
    el('span', `inline-block h-2 w-2 rounded-full shrink-0 ${s.ok ? 'bg-ok' : 'bg-err'}`),
    el('span', 'font-mono', cfg.name ?? 'mcp'),
    el('span', 'text-ink-faint truncate', s.ok ? `${s.tools.length} tools${s.server?.name ? ` · ${s.server.name}${s.server.version ? ` ${s.server.version}` : ''}` : ''}` : 'not connected')
  );
  b.append(head);
  b.append(el('p', 'text-[10px] text-ink-faint truncate', `${cfg.url} · tools are ${cfg.trust ?? 'write'}`));
  if (!s.ok && s.error) b.append(el('p', 'text-[10px] text-err', s.error));

  const tok = el('form', 'mt-1 flex items-center gap-1');
  const input = el('input', 'input text-xs flex-1 min-w-0');
  input.type = 'password';
  input.placeholder = s.hasToken ? 'token set — paste to replace' : 'token (optional)';
  input.autocomplete = 'off';
  const set = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Set');
  set.type = 'submit';
  tok.append(input, set);
  if (s.hasToken) {
    const clear = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', async () => {
      const res = await postJson(`/api/mcp/${w.i}`, {}, 'DELETE');
      if (!res.ok) return toast(res.data?.error ?? 'Could not clear', undefined, true);
      void renderMcp(w, true);
    });
    tok.append(clear);
  }
  tok.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    const res = await postJson(`/api/mcp/${w.i}`, { token: input.value }, 'PUT');
    if (!res.ok) return toast(res.data?.error ?? 'Could not save the token', undefined, true);
    toast('Token saved');
    void renderMcp(w, true);
  });
  b.append(tok);

  if (s.tools.length) {
    const d = el('details', 'mt-1 text-[10px]');
    d.append(el('summary', 'cursor-pointer text-ink-faint', `${s.tools.length} tools`));
    const ul = el('ul', 'mt-1 flex flex-col gap-0.5');
    for (const t of s.tools) {
      const li = el('li', 'truncate');
      li.title = t.description;
      li.append(el('span', 'font-mono', t.name), el('span', 'text-ink-faint', t.description ? ` — ${t.description}` : ''));
      ul.append(li);
    }
    d.append(ul);
    b.append(d);
  }
  const re = el('button', 'link mt-1 text-[10px]', 'Reconnect');
  re.type = 'button';
  re.addEventListener('click', () => void renderMcp(w, true));
  b.append(re);
}

RENDERERS.mcp = { intervalMs: 10 * 60_000, render: (w) => renderMcp(w) };
