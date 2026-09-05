// The chat wards (Discord, …): one renderer for every type in COMMS_TYPES
// over /api/comms/<ward> — the bot's status line, a channel picker, the
// stored feed and a composer. The credentials live in the ward's ⚙ Configure
// dialog (edit.ts sends them BESIDE the layout, never inside it). Live updates arrive as the engine's 'refresh' event for the
// type; nothing here polls fast.
import { COMMS_TYPES } from '../../lib/comms/types.ts';
import { rowsOf, type WardInstance } from '../../lib/wards.ts';
import { el, getJson, hm, postJson, toast } from './dom.ts';
import { icon } from './icon.ts';
import { RENDERERS, body, note } from './wards.ts';

interface Status {
  type: string;
  hasToken: boolean;
  hasAppToken: boolean;
  status: 'no-token' | 'connecting' | 'ready' | 'error' | 'closed';
  error?: string;
  note?: string;
  self?: { id: string; name: string; extra?: Record<string, string> };
  channel: string;
  guild: string;
  needs: string;
  tokenOptional: boolean;
  reconnect?: string;
}
interface Msg {
  id: string;
  channel: string;
  channelName?: string;
  from: { id: string; name: string };
  text: string;
  at: number;
  attachments?: { url: string; name: string }[];
  mine?: boolean;
}
interface Chan {
  id: string;
  name: string;
  kind?: string;
}

// A ward added in edit mode renders before Done saves the layout, and the
// server resolves the ward against the STORED layout — same idiom as mcp.ts.
const unsaved = new Map<string, WardInstance>();
document.addEventListener('fd:layout-saved', () => {
  for (const [id, w] of [...unsaved]) {
    unsaved.delete(id);
    if (body(id)) void renderChat(w);
  }
});

/** The channel each ward is showing (default: its configured channel). */
const picked = new Map<string, string>();

/** Attachment links are drawn only for the providers' own CDNs — anything
 *  else a message carries stays plain text. Never an <img>. */
const LINK_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'files.slack.com', 'api.telegram.org']);
function safeLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && LINK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

const api = (w: WardInstance, q = '') => `/api/comms/${w.i}${q}`;
const CHATTY_KINDS = new Set(['text', 'announcement', 'thread', 'forum', 'media', 'private', 'group', 'dm', 'room', 'meeting']);

function head(s: Status): HTMLElement {
  const h = el('div', 'flex items-center gap-2 text-xs');
  const dot = s.status === 'ready' ? 'bg-ok' : s.status === 'error' ? 'bg-err' : 'bg-ink-faint';
  h.append(el('span', `inline-block h-2 w-2 shrink-0 rounded-full ${dot}`));
  h.append(el('span', 'truncate', s.self?.name ?? (s.hasToken ? 'connecting…' : 'no bot yet')));
  h.append(el('span', 'text-ink-faint', s.status === 'ready' ? 'online' : s.status === 'no-token' ? '' : s.status));
  const invite = s.self?.extra?.invite ?? s.self?.extra?.link;
  if (invite) {
    const a = el('a', 'link ml-auto text-[10px]', s.self?.extra?.invite ? 'Invite to a server' : 'Open');
    a.href = invite;
    a.target = '_blank';
    a.rel = 'noopener';
    h.append(a);
  }
  return h;
}

function row(m: Msg): HTMLElement {
  const r = el('div', 'min-w-0');
  const meta = el('div', 'flex gap-1 text-[10px] text-ink-faint');
  meta.append(el('span', 'font-medium text-ink', m.mine ? 'bot' : m.from.name), el('span', '', hm(m.at)));
  r.append(meta);
  if (m.text) r.append(el('div', 'whitespace-pre-wrap break-words', m.text));
  for (const a of m.attachments ?? []) {
    if (safeLink(a.url)) {
      const link = el('a', 'link block truncate text-[10px]', `📎 ${a.name}`);
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener';
      r.append(link);
    } else r.append(el('span', 'block truncate text-[10px] text-ink-faint', `📎 ${a.name}`));
  }
  return r;
}

function composer(w: WardInstance, channel: string): HTMLElement {
  const form = el('form', 'flex items-center gap-1');
  const input = el('input', 'input min-h-0 flex-1 px-2 py-1 text-xs');
  input.placeholder = channel ? 'Message as the bot…' : 'Pick a channel first';
  input.disabled = !channel;
  input.autocomplete = 'off';
  const send = el('button', 'btn min-h-0 px-2 py-1 text-xs');
  send.type = 'submit';
  send.append(icon('send', undefined, 'Send'));
  form.append(input, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !channel) return;
    send.disabled = true;
    const res = await postJson(api(w), { channel, text });
    send.disabled = false;
    if (!res.ok) return toast(res.data?.error ?? 'Could not send', undefined, true);
    input.value = '';
    void renderChat(w);
  });
  return form;
}

async function renderChat(w: WardInstance): Promise<void> {
  const { status, data } = await getJson(api(w));
  const b = body(w.i);
  if (!b) return;
  if (status === 400 && data?.error === 'not a chat ward') {
    unsaved.set(w.i, w);
    note(w.i, 'Connects once the layout is saved — press Done.');
    return;
  }
  if (status !== 200) {
    note(w.i, data?.error ?? 'Chat unavailable.');
    return;
  }
  const s = data as Status;
  b.textContent = '';
  const root = el('div', 'flex h-full min-h-0 flex-col gap-1');
  b.append(root);
  root.append(head(s));
  if (!s.hasToken && !s.tokenOptional) {
    root.append(el('p', 'wd-note text-xs text-ink-faint', `Paste the ${s.type === 'twilio' ? 'auth' : s.type === 'push' ? 'application' : s.type === 'matrix' ? 'access' : 'bot'} token under ⚙ Configure — it is sealed server-side, never shown again.`));
    return;
  }
  if (s.error) root.append(el('p', 'text-[10px] text-err', s.error));
  if (s.note) root.append(el('p', 'text-[10px] text-warn', s.note));
  if (s.needs) {
    root.append(el('p', 'wd-note text-xs text-ink-faint', s.needs));
    if (s.reconnect) {
      const a = el('a', 'wd-note btn text-xs', 'Reconnect Microsoft with Teams access');
      a.setAttribute('href', s.reconnect);
      root.append(a);
    }
    return;
  }

  if (s.type === 'push') {
    // Outbound only: what was sent, and a line to send more.
    const list = el('div', 'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto text-xs');
    root.append(list);
    const res = await getJson(api(w, `?view=messages&limit=${rowsOf(w) * 6}`));
    const msgs: Msg[] = res.status === 200 ? (res.data.messages as Msg[]) : [];
    if (!msgs.length) list.append(el('p', 'text-ink-faint', 'Nothing sent yet.'));
    for (const m of [...msgs].reverse()) list.append(row(m));
    root.append(composer(w, s.channel));
    return;
  }

  const ch = await getJson(api(w, '?view=channels'));
  const channels: Chan[] = ch.status === 200 ? (ch.data.channels as Chan[]) : [];
  if (ch.status !== 200) root.append(el('p', 'text-[10px] text-err', ch.data?.error ?? 'Could not list channels.'));
  const chatty = channels.filter((c) => !c.kind || CHATTY_KINDS.has(c.kind));
  const current = picked.get(w.i) || s.channel || chatty[0]?.id || '';
  const sel = el('select', 'input min-h-0 px-2 py-1 text-xs');
  sel.setAttribute('aria-label', 'Channel');
  for (const c of chatty) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.kind === 'thread' ? '↳ ' : '#'}${c.name}`;
    sel.append(o);
  }
  if (current && !chatty.some((c) => c.id === current)) {
    const o = document.createElement('option');
    o.value = current;
    o.textContent = `#${current}`;
    sel.append(o);
  }
  sel.value = current;
  sel.addEventListener('change', () => {
    picked.set(w.i, sel.value);
    void renderChat(w);
  });
  root.append(sel);

  const list = el('div', 'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto text-xs');
  root.append(list);
  if (current) {
    const res = await getJson(api(w, `?view=messages&channel=${encodeURIComponent(current)}&limit=${rowsOf(w) * 8}`));
    const msgs: Msg[] = res.status === 200 ? (res.data.messages as Msg[]) : [];
    if (!msgs.length) list.append(el('p', 'text-ink-faint', res.status === 200 ? (s.type === 'telegram' ? 'Nothing yet — messages appear as they arrive.' : 'Nothing here yet.') : (res.data?.error ?? 'Could not load messages.')));
    if (s.type === 'slack' && !s.hasAppToken) list.append(el('p', 'text-[10px] text-ink-faint', 'No app token: nothing arrives live — refresh to see new messages.'));
    for (const m of [...msgs].reverse()) list.append(row(m));
    queueMicrotask(() => {
      list.scrollTop = list.scrollHeight;
    });
  }
  root.append(composer(w, current));
}

for (const t of COMMS_TYPES) RENDERERS[t] = { intervalMs: 5 * 60_000, render: (w) => renderChat(w) };
