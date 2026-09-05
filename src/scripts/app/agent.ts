// Agent wards: a chat client over the streamed POST /api/agent/<ward>
// protocol. One per-ward State drives every attached view — the compact ward
// and the shared #agent-dialog — by repainting the whole log from a small
// item model on each event (transcripts are short; simplicity beats DOM
// surgery here).
//
// Model output, tool results and file names are hostile input — createElement
// + textContent only, per the house rule in wards.ts. The markdown renderer
// below builds DOM nodes and never touches innerHTML.

import { ACTIONS } from '../../lib/logic.ts';
import { completeCommand, type CommandSpec } from '../../lib/agent/commands.ts';
import { CATALOG, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body, note } from './wards.ts';
import { el, getJson, postJson, tapToast } from './dom.ts';
import { icon } from './icon.ts';
import { ensureStream, flushPendingLayout, onAgentLive, onAgentPing, reloadHolds } from './logic.ts';

// ------------------------------------------------------------------ markdown
// Covers the subset a chat actually emits: inline code/bold/italic/strike/
// links, fenced code, headings, rules, tables, lists, quotes.

function inline(text: string, into: Node): void {
  // code | bold | italic | strike | link — code first so its content is literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/;
  let rest = text;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) {
      into.appendChild(el('code', 'rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]', tok.slice(1, -1)));
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      const n = el('strong');
      inline(tok.slice(2, -2), n);
      into.appendChild(n);
    } else if (tok.startsWith('~~')) {
      const n = el('s');
      inline(tok.slice(2, -2), n);
      into.appendChild(n);
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      // Only navigable schemes — no javascript:/data:, and no protocol-
      // relative //host smuggled past the leading-slash test.
      const safe = /^(https?:\/\/|mailto:|\/(?!\/))/i.test(href);
      const n = document.createElement(safe ? 'a' : 'span');
      if (safe && n instanceof HTMLAnchorElement) {
        n.href = href;
        n.className = 'text-accent-hi underline underline-offset-2';
        // New tab only for OTHER sites; same-origin links navigate in place.
        // The link regex admits hosts URL() rejects (`https://loot^vps`, stray
        // %, bad ports) — a throw here would take the whole ward down, so an
        // unparseable href is simply treated as foreign.
        let external = false;
        if (href.startsWith('http')) {
          try {
            external = new URL(href, location.href).origin !== location.origin;
          } catch {
            external = true;
          }
        }
        if (external) {
          n.target = '_blank';
          n.rel = 'noopener noreferrer';
        }
      }
      inline(label, n);
      into.appendChild(n);
    } else {
      const n = el('em');
      inline(tok.slice(1, -1), n);
      into.appendChild(n);
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) into.appendChild(document.createTextNode(rest));
}

function markdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = (src || '').replace(/\r/g, '').split('\n');
  let i = 0;
  const para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = el('p', 'whitespace-pre-wrap');
    inline(para.join('\n'), p);
    frag.appendChild(p);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^```/.test(line)) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      const pre = el('pre', 'overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs');
      pre.appendChild(el('code', undefined, buf.join('\n')));
      frag.appendChild(pre);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const n = document.createElement(`h${Math.min(h[1]!.length + 2, 6)}`);
      n.className = 'mt-1 font-bold';
      inline(h[2]!, n);
      frag.appendChild(n);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      frag.appendChild(el('hr', 'border-line'));
      i++;
      continue;
    }

    // table: | a | b |  with a --- separator row
    if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1] ?? '')) {
      flushPara();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const table = el('table', 'w-full text-left text-xs');
      const thead = table.createTHead().insertRow();
      for (const c of cells(line)) {
        const th = el('th', 'border-b border-line px-2 py-1 font-semibold');
        inline(c, th);
        thead.appendChild(th);
      }
      const tbody = table.createTBody();
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const row = tbody.insertRow();
        for (const c of cells(lines[i]!)) {
          const td = row.insertCell();
          td.className = 'border-b border-line/60 px-2 py-1';
          inline(c, td);
        }
        i++;
      }
      const wrap = el('div', 'overflow-x-auto');
      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      const list = el(ordered ? 'ol' : 'ul', ordered ? 'list-decimal space-y-1 pl-5' : 'list-disc space-y-1 pl-5');
      while (i < lines.length) {
        const m = ordered ? lines[i]!.match(/^\s*\d+[.)]\s+(.*)$/) : lines[i]!.match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        const li = el('li');
        inline(m[1]!, li);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = el('blockquote', 'border-l-2 border-line-strong pl-3 text-ink-muted');
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      inline(buf.join('\n'), quote);
      frag.appendChild(quote);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return frag;
}

// --------------------------------------------------------------- step cards

interface Step {
  /** Provider call id + the tool round: every step of one round ran in parallel. */
  id?: string;
  round?: number;
  tool: string;
  kind: 'read' | 'write' | 'confirm';
  args?: Record<string, unknown>;
  reason?: string;
  result?: unknown;
  error?: string;
  ms?: number;
}

const ICON: Record<string, string> = { read: '🔍', write: '✎', confirm: '⏸' };

/** Fallback label if the agent somehow sent no reason. */
function humanise(tool: string): string {
  return String(tool ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** One tool call, as the user reads it: the reason first, in plain words.
 *  Tool name, args and raw result live behind a <details> click. */
function stepCard(step: Step, running = false): HTMLElement {
  const row = el('div', 'rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5 text-xs');

  const head = el('div', 'flex items-start gap-2');
  const icon = el('span', running ? 'spinner mt-0.5 shrink-0' : 'mt-px shrink-0');
  if (!running) {
    icon.textContent = step.error ? '✕' : (ICON[step.kind] ?? '·');
    if (step.error) icon.classList.add('text-err');
  }
  const line = el('span', `min-w-0 flex-1${step.error ? ' text-err' : ''}`, step.reason || humanise(step.tool));
  head.append(icon, line);

  if (!running && step.ms) head.append(el('span', 'shrink-0 text-[10px] text-ink-faint', fmtMs(step.ms)));
  row.append(head);

  // An error is something the user has to know about, so it stays visible.
  if (step.error) {
    row.append(el('div', 'mt-1 pl-5 text-err', step.error));
  } else if (!running && step.result !== undefined) {
    const det = document.createElement('details');
    const sum = el('summary', 'mt-0.5 ml-5 cursor-pointer text-[11px] text-ink-faint select-none hover:text-ink-muted', 'details');
    const pre = el('pre', 'mt-1 ml-5 max-h-64 overflow-auto rounded bg-surface-2 p-2 text-[11px] whitespace-pre-wrap');
    const args = { ...(step.args ?? {}) };
    delete args.reason; // already said, in English, above
    const text =
      `${step.tool}(${Object.keys(args).length ? JSON.stringify(args, null, 1) : ''})\n\n` +
      (typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 1));
    pre.textContent = text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated for display)` : text;
    det.append(sum, pre);
    row.append(det);
  }
  return row;
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** One tool round with several calls: they ran at the same time, so they are
 *  drawn as one block — a header saying so, the cards inside, and the batch's
 *  wall time (the SLOWEST call, not the sum) once every card has landed. */
function batchCard(group: StepItem[]): HTMLElement {
  const wrap = el('div', 'space-y-1 rounded-lg border border-line/70 p-1');
  const head = el('div', 'flex items-center gap-1.5 px-1.5 text-[10px] text-ink-faint');
  head.append(el('span', undefined, `${group.length} at once`));
  const left = group.filter((g) => g.running).length;
  const failed = group.filter((g) => !g.running && g.step.error).length;
  const tail = left
    ? `${group.length - left}/${group.length} done`
    : `${fmtMs(Math.max(...group.map((g) => g.step.ms ?? 0)))}${failed ? ` · ${failed} failed` : ''}`;
  head.append(el('span', `ml-auto${failed && !left ? ' text-err' : ''}`, tail));
  wrap.append(head, ...group.map((g) => stepCard(g.step, g.running)));
  return wrap;
}

// -------------------------------------------------------------------- state

interface Pending {
  confirmId: string;
  summary: string;
}

/** Who asked for the turn this item belongs to. Server-stamped and stored, so
 *  an automation still reads as one after a reload. */
type TurnSource = 'chat' | 'automation' | 'wake' | 'agent';

interface StepItem {
  k: 'step';
  step: Step;
  running?: boolean;
  src?: TurnSource;
  /** Same key = same tool round = ran in parallel; consecutive ones draw as one batch. */
  batch?: string;
}

/** The in-flight cards of one streamed turn, keyed by call id, plus a per-turn
 *  seq so a round number can't collide with the previous turn's. */
interface Run {
  steps: Map<string, StepItem>;
  seq: number;
}
let runSeq = 0;
const newRun = (): Run => ({ steps: new Map(), seq: ++runSeq });
const batchKey = (seq: number | string, round: unknown) => (typeof round === 'number' ? `${seq}:${round}` : undefined);

type Item =
  | { k: 'msg'; role: 'user' | 'assistant'; text: string; src?: TurnSource }
  | StepItem
  | { k: 'thinking'; label?: string }
  | { k: 'note'; text: string; err?: boolean };

/** One attached view of a ward's conversation (the ward, or the dialog). */
interface Ui {
  root: HTMLElement;
  log: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  chips: HTMLElement;
  pendingBox: HTMLElement;
  pendingText: HTMLElement;
}

interface State {
  w: WardInstance;
  items: Item[];
  pending: Pending | null;
  /** A locally-streamed turn is in flight (server `busy` just adds a row). */
  busy: boolean;
  /** A turn is running somewhere else — another tab, another device, or an
   *  automation. Painted from the mirror; the composer waits it out. */
  remote: boolean;
  abort: AbortController | null;
  attachments: { id: string; name: string }[];
  uploading: number;
  uis: Set<Ui>;
}

const states = new Map<string, State>();

function stateFor(w: WardInstance): State {
  let st = states.get(w.i);
  if (!st) {
    st = { w, items: [], pending: null, busy: false, remote: false, abort: null, attachments: [], uploading: 0, uis: new Set() };
    states.set(w.i, st);
  }
  st.w = w; // config changes keep the same id — track the live instance
  return st;
}

function itemsFrom(transcript: any[]): Item[] {
  const items: Item[] = [];
  transcript.forEach((m, mi) => {
    // Older rows predate the column; anything unrecognised reads as chat.
    const src: TurnSource = m.source === 'automation' || m.source === 'wake' || m.source === 'agent' ? m.source : 'chat';
    for (const step of (m.steps ?? []) as Step[]) items.push({ k: 'step', step, src, batch: batchKey(mi, step.round) });
    if (typeof m.text === 'string' && m.text.trim()) items.push({ k: 'msg', role: m.role === 'user' ? 'user' : 'assistant', text: m.text, src });
  });
  return items;
}

function bubble(role: 'user' | 'assistant', text: string): HTMLElement {
  const wrap = el(
    'div',
    role === 'user'
      ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-3 py-2'
      : 'max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-2 px-3 py-2'
  );
  const inner = el('div', 'space-y-2');
  inner.appendChild(markdown(text));
  wrap.append(inner);
  return wrap;
}

// ------------------------------------------------------------- empty state
//
// "Ask the agent anything" told nobody anything, so the first thing typed was
// "test". What replaces it is generated from the live catalogs wherever one
// exists — a hand-written feature list rots the day a ward type or a logic
// action lands.

/** Under ~45 chars each so they wrap sanely in a 2x2 ward. Each one maps to a
 *  tool the agent actually has (status, mail, add_ward, the logic graph,
 *  schedule_wake, resize/set_theme). */
const STARTERS = [
  "What's down right now?",
  'Summarize my unread mail',
  'Add a 25-minute timer ward',
  'What automations do I have?',
  'Every morning at 8, brief me on the day',
  'Make the dashboard more compact',
];

/** Area → what it can do there. The first two rows read the real catalogs; the
 *  rest name the agent's own tools, which live server-side (lib/agent/tools.ts
 *  imports the db) and so can't be enumerated from the client bundle. */
function capabilities(): [string, string][] {
  const wards = Object.values(CATALOG)
    .map((c) => c.title)
    .join(', ');
  const acts = Object.values(ACTIONS)
    .filter((a) => !a.adminOnly)
    .map((a) => a.label)
    .join(', ');
  return [
    ['Dashboard', `add, move, resize, configure and remove wards, and retheme — ${wards}`],
    ['Leylines', `draw leylines between wards, then edit, disable or delete them — ${acts}`],
    ['Reading', 'service status, weather, mail, agenda, Notion, checklists, timers, packets, files you attach'],
    ['Doing', 'send mail (it asks first), capture to Notion, tick checklists, run timers, move packets'],
    ['Power', 'a sandboxed bash shell, web search and fetch, wake-ups it schedules for itself — and any browser ward, a real Chromium it reads and drives alongside you'],
  ];
}

function emptyState(st: State, ui: Ui): HTMLElement {
  const wrap = el('div', 'space-y-2 py-1');
  // Only the dialog has room to introduce itself; a 2x2 ward gets the chips.
  if (ui.root instanceof HTMLDialogElement) {
    wrap.append(
      el(
        'p',
        'text-xs text-ink-muted',
        'This agent runs against this dashboard. It can read what your wards read — service status, weather, mail, ' +
          'agenda, Notion — and change the dashboard itself: add and arrange wards, retheme it, draw leylines. ' +
          'Ask in plain English; anything destructive stops and asks you first. Type /help for conversation commands.'
      )
    );
  }

  const chips = el('div', 'flex flex-wrap gap-1');
  for (const text of STARTERS) {
    const c = el('button', 'rounded-md border border-line bg-surface-2 px-2 py-1 text-left text-[11px] text-ink-muted hover:text-accent-hi', text);
    c.type = 'button';
    c.addEventListener('click', () => {
      ui.input.value = text; // through the composer, so the send path is the same one
      submit(st, ui);
    });
    chips.append(c);
  }
  wrap.append(chips);

  const det = document.createElement('details');
  det.append(el('summary', 'cursor-pointer text-[11px] text-ink-faint select-none hover:text-ink-muted', 'What can it do?'));
  const list = el('div', 'mt-1 space-y-1');
  for (const [area, what] of capabilities()) {
    const row = el('div', 'text-[10px] leading-snug text-ink-faint');
    row.append(el('span', 'text-ink-muted', `${area} — `), document.createTextNode(what));
    list.append(row);
  }
  det.append(list);
  wrap.append(det);
  return wrap;
}

// ----------------------------------------------------------------- the log

const SRC_LABEL: Record<TurnSource, string> = { chat: '', automation: '⚡ automation', wake: '⏰ scheduled', agent: '🤝 another agent' };

function buildLog(st: State, ui: Ui): void {
  const log = ui.log;
  log.replaceChildren();
  if (!st.items.length) {
    // Not note()/.wd-note — that class centers the whole body, composer included.
    log.append(emptyState(st, ui));
  }
  // A turn nobody typed must never read like one, so it carries a marker and
  // an accent rail. The rail repeats per item; the label only when the source
  // changes, or a five-step automation would shout five times.
  let prev: TurnSource = 'chat';
  for (let i = 0; i < st.items.length; i++) {
    const it = st.items[i]!;
    let node: HTMLElement;
    if (it.k === 'msg') node = bubble(it.role, it.text);
    else if (it.k === 'step') {
      // A run of cards from the same tool round is one batch.
      let j = i + 1;
      while (it.batch && j < st.items.length) {
        const n = st.items[j]!;
        if (n.k !== 'step' || n.batch !== it.batch) break;
        j++;
      }
      node = j - i > 1 ? batchCard(st.items.slice(i, j) as StepItem[]) : stepCard(it.step, it.running);
      i = j - 1;
    }
    else if (it.k === 'thinking') node = el('div', 'text-xs text-ink-faint italic', it.label ?? 'thinking…');
    // pre-wrap: /help is a multi-line list.
    else node = el('div', `whitespace-pre-wrap text-center text-[11px] ${it.err ? 'text-err' : 'text-ink-faint'}`, it.text);
    const src = it.k === 'msg' || it.k === 'step' ? (it.src ?? 'chat') : 'chat';
    if (src === 'chat') {
      log.append(node);
    } else {
      const rail = el('div', 'space-y-1.5 border-l-2 border-accent-hi/40 pl-2');
      if (src !== prev) rail.append(el('div', 'text-[10px] text-ink-faint', SRC_LABEL[src]));
      rail.append(node);
      log.append(rail);
    }
    prev = src;
  }
  log.scrollTop = log.scrollHeight;
}

function paintChips(st: State, chips: HTMLElement): void {
  chips.replaceChildren();
  for (const a of st.attachments) {
    const chip = el('span', 'inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs');
    chip.append(el('span', 'truncate', a.name));
    const rm = el('button', 'shrink-0 text-ink-faint hover:text-err');
    rm.type = 'button';
    rm.textContent = '✕';
    rm.setAttribute('aria-label', `Remove ${a.name}`);
    rm.addEventListener('click', () => {
      st.attachments = st.attachments.filter((x) => x !== a);
      paint(st);
    });
    chip.append(rm);
    chips.append(chip);
  }
  if (st.uploading > 0) {
    const chip = el('span', 'inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 py-1 text-xs text-ink-faint');
    chip.append(el('span', 'spinner'), document.createTextNode(`uploading ${st.uploading}…`));
    chips.append(chip);
  }
  const any = chips.childElementCount > 0;
  chips.classList.toggle('hidden', !any);
  chips.classList.toggle('flex', any);
}

/** Repaint every attached view from the item model. Cheap and impossible to
 *  desync — transcripts are short and streams emit tens of frames, not
 *  thousands. */
function paint(st: State): void {
  for (const ui of [...st.uis]) if (!ui.root.isConnected) st.uis.delete(ui);
  for (const ui of st.uis) {
    buildLog(st, ui);
    // A remote turn holds the composer too — the server would 409 anyway, and
    // the thread is shared, so "wait" is the honest state.
    // Mid-turn the composer stays open: a send then steers the running turn.
    ui.send.disabled = st.uploading > 0;
    ui.stop.classList.toggle('hidden', !st.busy && !st.remote); // server-side stop — any client, any turn
    ui.pendingBox.classList.toggle('hidden', !st.pending);
    ui.pendingBox.classList.toggle('flex', !!st.pending);
    ui.pendingText.textContent = st.pending?.summary ?? '';
    paintChips(st, ui.chips);
  }
}

/** Reload the persisted transcript. `settled` marks the call that follows a
 *  turn-finished ping: the chain hasn't released `busy` yet at that instant, so
 *  trusting it there would strand a spinner and a disabled composer. */
async function refetch(st: State, settled = false): Promise<void> {
  const { status, data } = await getJson(`/api/agent/${encodeURIComponent(st.w.i)}`);
  if (status !== 200 || !data) return;
  if (st.busy) return; // a local stream started mid-fetch — it owns the log
  st.items = itemsFrom(data.transcript ?? []);
  st.pending = data.pending ?? null;
  // A turn is running elsewhere (another client, or an automation) — its live
  // frames repaint over this, but the thread is busy either way.
  st.remote = !settled && !!data.busy;
  if (st.remote) st.items.push({ k: 'thinking' });
  paint(st);
}

// --------------------------------------------------------------- turn flow

function endTurn(st: State): void {
  st.busy = false;
  // A stream that ends mid-call must not leave spinners running forever.
  for (const it of st.items) if (it.k === 'step') it.running = false;
  dropThinking(st);
}

function dropThinking(st: State): void {
  st.items = st.items.filter((it) => it.k !== 'thinking');
}

/** What a send that didn't land puts back. */
interface Restore {
  text?: string;
  files?: { id: string; name: string }[];
  /** The confirm decide() hid optimistically — the server still has it parked. */
  pending?: Pending | null;
}

function fail(st: State, msg: string, restore: Restore): void {
  st.items.push({ k: 'note', err: true, text: `⚠️ ${msg}` });
  // Nothing typed, uploaded or parked is lost — the request didn't land.
  if (restore.files?.length) st.attachments = [...restore.files, ...st.attachments];
  if (restore.pending) st.pending = restore.pending;
  paint(st);
  if (restore.text) for (const ui of st.uis) if (!ui.input.value) ui.input.value = restore.text;
}

/** Apply one streamed AgentEvent to the item model. Shared by the local POST
 *  stream and the SSE mirror of headless runs ('user' only ever arrives on the
 *  mirror). Returns false for the types the caller owns (done/error). */
function applyEvent(st: State, run: Run, e: any, src?: TurnSource): boolean {
  switch (e.type) {
    case 'user':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'msg', role: 'user', text: e.text, src });
      return true;
    case 'thinking':
      dropThinking(st);
      st.items.push({ k: 'thinking', ...(typeof e.label === 'string' ? { label: e.label } : {}) });
      return true;
    case 'note':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'note', text: e.text });
      return true;
    case 'says':
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'msg', role: 'assistant', text: e.text, src });
      return true;
    case 'step_start': {
      dropThinking(st); // the spinner on the card carries the signal now
      const it: StepItem = {
        k: 'step',
        step: { id: e.id, round: e.round, tool: e.tool, kind: e.kind, args: e.args, reason: e.reason },
        running: true,
        src,
        batch: batchKey(run.seq, e.round),
      };
      run.steps.set(String(e.id), it);
      st.items.push(it);
      return true;
    }
    case 'step': {
      const it = run.steps.get(String(e.step?.id));
      if (it) {
        it.step = e.step;
        it.running = false;
        run.steps.delete(String(e.step.id));
      } else {
        st.items.push({ k: 'step', step: e.step, src, batch: batchKey(run.seq, e.step?.round) });
      }
      return true;
    }
    case 'pending':
      st.pending = e.pending ?? null;
      return true;
    case 'reply':
      // 'reply' is the final text ('says' are mid-turn interjections);
      // done's reply field repeats it and is ignored by the caller.
      dropThinking(st);
      if (typeof e.text === 'string' && e.text.trim()) st.items.push({ k: 'msg', role: 'assistant', text: e.text, src });
      return true;
  }
  return false;
}

async function post(st: State, payload: Record<string, unknown>, back: Restore = {}): Promise<void> {
  st.busy = true;
  // Hold off any server-side layout reload until this turn is done — the
  // agent's own edits broadcast 'layout' mid-stream.
  reloadHolds.add(st.w.i);
  st.abort = new AbortController();
  // /compact is a model round-trip that answers as plain JSON — no stream
  // frames to paint status from, so the wait is announced here.
  if (typeof payload.message === 'string' && /^\/(compact|summari[sz]e)\b/.test(payload.message.trim()))
    st.items.push({ k: 'thinking', label: 'compacting the older part of this thread…' });
  paint(st);
  const restore: Restore = { text: typeof payload.message === 'string' ? payload.message : '', ...back };
  const running = newRun();

  const dispatch = (e: any): void => {
    if (!applyEvent(st, running, e)) {
      if (e.type === 'done') {
        endTurn(st);
        st.pending = e.pending ?? null;
      } else if (e.type === 'error') {
        endTurn(st);
        // A stream means the server took the request — the confirm is spent,
        // so this one doesn't put the bar back.
        fail(st, String(e.error ?? 'agent error'), { ...restore, pending: null });
        return; // fail() painted
      }
    }
    paint(st);
  };

  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(st.w.i)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: st.abort.signal,
    });

    // Error paths (busy, not-configured) and slash commands answer plain JSON.
    if (!res.headers.get('content-type')?.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      endTurn(st);
      if (res.ok && data?.command) {
        if (data.command === 'clear') {
          // The empty log IS the confirmation, and clearThread's ping would
          // wipe a note here anyway. Other clients follow from that ping.
          st.items = [];
          st.pending = null;
          st.attachments = [];
        } else {
          st.items.push({ k: 'note', text: String(data.text ?? '') });
        }
        paint(st);
        return;
      }
      if (!res.ok) {
        const msg =
          data?.error === 'busy'
            ? 'The agent is mid-turn — try again in a moment.'
            : data?.error === 'not-configured'
              ? 'Provider not configured — see Account → Agent.'
              : (data?.error ?? `Request failed (HTTP ${res.status}).`);
        fail(st, msg, restore);
      } else {
        paint(st);
      }
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          dispatch(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
    endTurn(st);
    paint(st);
  } catch (err) {
    endTurn(st);
    if ((err as Error)?.name === 'AbortError') {
      st.items.push({ k: 'note', text: '⏹ Stopped.' });
      paint(st);
      void refetch(st); // the server may have finished the turn anyway
      return;
    }
    fail(st, err instanceof Error ? err.message : 'network error', restore);
  } finally {
    st.abort = null;
    reloadHolds.delete(st.w.i);
    flushPendingLayout(); // a layout broadcast that landed mid-turn can go now
  }
}

function submit(st: State, ui: Ui): void {
  const text = ui.input.value.trim();
  if (!text || st.uploading > 0) return;
  // Mid-turn (here or elsewhere), a message is a steer: it lands inside the
  // running turn and paints from its 'user' event. Commands stay commands.
  if ((st.busy || st.remote) && !text.startsWith('/')) {
    ui.input.value = '';
    ui.input.style.height = '';
    void steer(st, text);
    return;
  }
  if (st.busy) return; // a command while this client streams — the server answers it, the stream stays
  ui.input.value = '';
  ui.input.style.height = '';
  st.items.push({ k: 'msg', role: 'user', text });
  const sent = st.attachments;
  const file_ids = sent.map((a) => a.id);
  if (sent.length) st.items.push({ k: 'note', text: `📎 ${sent.map((a) => a.name).join(', ')}` });
  st.attachments = [];
  void post(st, file_ids.length ? { message: text, file_ids } : { message: text }, { files: sent });
}

/** Steer the running turn. steered:false = it ended first, so send normally. */
async function steer(st: State, text: string): Promise<void> {
  const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { message: text, mode: 'steer' });
  if (status === 200 && data?.steered) return;
  if (status === 200 && data && !st.busy) {
    st.items.push({ k: 'msg', role: 'user', text });
    void post(st, { message: text });
    return;
  }
  fail(st, data?.error ?? 'could not reach the agent', { text });
}

/** The Stop button: the server ends the turn at its next round boundary. */
async function interrupt(st: State): Promise<void> {
  const { status, data } = await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'interrupt' });
  if (status !== 200) fail(st, data?.error ?? 'could not stop the agent', {});
}

function decide(st: State, action: 'confirm' | 'decline'): void {
  const pending = st.pending;
  if (!pending || st.busy) return;
  st.pending = null; // hide the bar immediately; the stream reports the outcome
  // …but a request that never landed (busy 409) leaves the confirm parked
  // server-side, so the bar has to come back or the retry is unclickable.
  void post(st, { action, confirmId: pending.confirmId }, { pending });
}

async function clearChat(st: State): Promise<void> {
  if (st.busy) return;
  await postJson(`/api/agent/${encodeURIComponent(st.w.i)}`, { action: 'clear' });
  st.items = [];
  st.pending = null;
  st.attachments = [];
  paint(st);
}

async function addFiles(st: State, picked: FileList | File[]): Promise<void> {
  const list = Array.from(picked);
  if (!list.length) return;
  const form = new FormData();
  form.append('ward', st.w.i);
  for (const f of list) form.append('files', f);
  st.uploading += list.length;
  paint(st);
  try {
    const res = await fetch('/api/agent/files', { method: 'POST', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      st.items.push({ k: 'note', err: true, text: `Upload failed${data?.error ? ` — ${data.error}` : ''}.` });
      return;
    }
    // Nothing is dropped quietly: a rejected file says why, by name.
    for (const f of data?.files ?? []) {
      if (f.ok && f.id) st.attachments.push({ id: f.id, name: String(f.name ?? 'file') });
      else st.items.push({ k: 'note', err: true, text: `${f.name ?? 'file'} — ${f.error ?? 'rejected'}` });
    }
  } catch {
    st.items.push({ k: 'note', err: true, text: 'Upload failed — network error.' });
  } finally {
    st.uploading -= list.length;
    paint(st);
  }
}

// ----------------------------------------------------------------- composer

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}

/**
 * The slash-command completion menu, CLI conventions: it appears the moment you
 * type "/" at the start of the box, filters as you keep typing, and
 *   ↑/↓  move      Tab  complete (so you can add arguments)
 *   ⏎    run       Esc  dismiss
 *
 * The command list comes from lib/agent/commands.ts — the same module the
 * server parses with, so the menu can never offer something that does not run.
 */
function wireCommandMenu(ui: Ui, run: () => void): void {
  const anchor = ui.input.parentElement!;
  anchor.style.position = 'relative'; // set here, not as a class — this is the one thing that needs it
  const menu = el('div', 'fd-cmd hidden');
  menu.setAttribute('role', 'listbox');
  anchor.append(menu);

  let items: CommandSpec[] = [];
  let active = 0;
  const isOpen = () => !menu.classList.contains('hidden');

  function close(): void {
    menu.classList.add('hidden');
    ui.input.removeAttribute('aria-activedescendant');
  }

  function paint(): void {
    menu.replaceChildren();
    items.forEach((c, i) => {
      const row = el('button', `fd-cmd-row${i === active ? ' fd-cmd-active' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active));
      row.append(el('span', 'fd-cmd-name', `/${c.name}`));
      if (c.args) row.append(el('span', 'fd-cmd-args', c.args));
      row.append(el('span', 'fd-cmd-desc', c.summary));
      // mousedown, not click: the textarea must not lose focus before we act.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        active = i;
        pick(true);
      });
      menu.append(row);
    });
    menu.scrollTop = 0;
    menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function move(delta: number): void {
    if (!items.length) return;
    active = (active + delta + items.length) % items.length; // wraps, like a shell
    paint();
  }

  /** Tab completes and leaves you typing; Enter runs it. */
  function pick(now: boolean): void {
    const c = items[active];
    if (!c) return;
    ui.input.value = now ? `/${c.name}` : `/${c.name} `;
    close();
    if (now) run();
    else {
      ui.input.focus();
      autoGrow(ui.input);
    }
  }

  function sync(): void {
    const next = completeCommand(ui.input.value);
    if (!next?.length) return close();
    items = next;
    active = 0;
    menu.classList.remove('hidden');
    paint();
  }

  // Registered before the composer's own Enter handler, so it can claim the key.
  ui.input.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      e.stopImmediatePropagation(); // the send handler must not also fire
      pick(e.key === 'Enter');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });
  ui.input.addEventListener('input', sync);
  ui.input.addEventListener('blur', close);
  // Escape on a <dialog> closes it through the `cancel` event, which a keydown
  // preventDefault does not reach — so the menu would take the whole dialog with it.
  ui.input.closest('dialog')?.addEventListener('cancel', (e) => {
    if (isOpen()) {
      e.preventDefault();
      close();
    }
  });
}

/** Wire the shared listeners onto a view's composer. `cur` resolves the state
 *  at event time — the dialog rebinds wards without re-adding listeners. */
function wireComposer(ui: Ui, cur: () => State | undefined): void {
  const file = ui.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const go = () => {
    const st = cur();
    if (st) submit(st, ui);
  };
  // FIRST, so its keydown listener sees Enter/Tab/arrows before the send below.
  wireCommandMenu(ui, go);
  ui.send.addEventListener('click', go);
  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      go();
    }
  });
  ui.input.addEventListener('input', () => autoGrow(ui.input));
  ui.stop.addEventListener('click', () => {
    const st = cur();
    if (st) void interrupt(st);
  });
  file.addEventListener('change', () => {
    const st = cur();
    if (st && file.files?.length) void addFiles(st, file.files);
    file.value = '';
  });
  ui.root.querySelector('[data-ag-attach]')?.addEventListener('click', () => file.click());
  ui.pendingBox.querySelector('[data-ag-confirm]')!.addEventListener('click', () => {
    const st = cur();
    if (st) decide(st, 'confirm');
  });
  ui.pendingBox.querySelector('[data-ag-decline]')!.addEventListener('click', () => {
    const st = cur();
    if (st) decide(st, 'decline');
  });
  // Dropping files on the composer works like picking them.
  ui.root.addEventListener('dragover', (e) => e.preventDefault());
  ui.root.addEventListener('drop', (e) => {
    e.preventDefault();
    const st = cur();
    if (st && e.dataTransfer?.files.length) void addFiles(st, e.dataTransfer.files);
  });
}

// ------------------------------------------------------------ shared dialog

let dialogWard: string | null = null;
let dialogUi: Ui | null = null;
let agentDialog: HTMLDialogElement | null = null;

function ensureDialog(): HTMLDialogElement | null {
  if (agentDialog) return agentDialog;
  const dlg = document.getElementById('agent-dialog') as HTMLDialogElement | null;
  if (!dlg) return null;
  agentDialog = dlg;
  const q = <T extends HTMLElement>(sel: string) => dlg.querySelector<T>(sel)!;
  const ui: Ui = {
    root: dlg,
    log: q('[data-ag-log]'),
    input: q<HTMLTextAreaElement>('[data-ag-input]'),
    send: q<HTMLButtonElement>('[data-ag-send]'),
    stop: q<HTMLButtonElement>('[data-ag-stop]'),
    chips: q('[data-ag-chips]'),
    pendingBox: q('[data-ag-pending]'),
    pendingText: q('[data-ag-pending-text]'),
  };
  dialogUi = ui;
  const cur = () => (dialogWard ? states.get(dialogWard) : undefined);
  wireComposer(ui, cur);
  q('[data-ag-close]').addEventListener('click', () => dlg.close());
  q('[data-ag-clear]').addEventListener('click', () => {
    const st = cur();
    if (st) void clearChat(st);
  });
  dlg.addEventListener('close', () => {
    const st = cur();
    dialogWard = null;
    if (st) {
      st.uis.delete(ui);
      void refetch(st); // the ward view catches up on whatever happened
    }
  });
  return dlg;
}

function openDialog(st: State): void {
  const dlg = ensureDialog();
  if (!dlg || !dialogUi) return;
  if (dialogWard && dialogWard !== st.w.i) states.get(dialogWard)?.uis.delete(dialogUi);
  // The dialog is a singleton: a draft typed for one ward must never be sent
  // into another ward's conversation.
  dialogUi.input.value = '';
  dialogUi.input.style.height = '';
  dialogWard = st.w.i;
  st.uis.add(dialogUi);
  const title = document.querySelector(`[data-wd="${st.w.i}"] [data-wd-title]`)?.textContent ?? 'Rime';
  dlg.querySelector('[data-ag-title]')!.textContent = title;
  dlg.showModal();
  clearUnread(st.w.i); // they're reading it now
  paint(st);
  dialogUi.input.focus();
}

// ------------------------------------------------------- automation notices
//
// A headless turn (a logic rule firing, a wake the agent scheduled) lands in a
// ward nobody is necessarily looking at. The badge is the trace that waits;
// the toast is the interrupt — and the SERVER decides which runs earn one (a
// rule opts out with notify:'silent'), so the client only honors the flag.
// The badge still counts a silenced run: quiet isn't the same as invisible.

interface AgentPing {
  ward?: string;
  source?: TurnSource;
  summary?: string;
  toast?: boolean;
}

const unread = new Map<string, number>();
/** In-flight step cards from a remote (headless) turn, keyed per ward. */
const remoteRuns = new Map<string, Run>();

function paintBadge(ward: string): void {
  const span = document.querySelector<HTMLElement>(`[data-wd="${ward}"] .wd-status`);
  if (span) span.textContent = unread.get(ward) ? `⚡${unread.get(ward)}` : '';
}

function clearUnread(ward: string): void {
  if (!unread.has(ward)) return;
  unread.delete(ward);
  paintBadge(ward);
}

/** Is this ward's conversation actually in front of the user right now? One
 *  rect read at event time answers it — cheaper than an observer that would
 *  have to be created, kept and torn down per ward for a once-a-run question. */
function logVisible(ward: string): boolean {
  if (document.hidden) return false;
  if (dialogWard === ward && agentDialog?.open) return true;
  const b = body(ward);
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

function announce(st: State, p: AgentPing): void {
  const summary = (p.summary ?? '').replace(/\s+/g, ' ').trim();
  const said = summary.length > 70 ? `${summary.slice(0, 69)}…` : summary || 'a turn ran on its own';
  tapToast(`${p.source === 'wake' ? '⏰' : p.source === 'agent' ? '🤝' : '⚡'} Agent: ${said}`, () => openDialog(st));
}

// ------------------------------------------------------------------ renderer

// A ward added in edit mode renders before Done saves the layout, and the
// server resolves the ward against the STORED layout. The save itself is the
// signal (edit.ts fires 'fd:layout-saved') — however long the user takes over
// Done. The timer is only a fallback for a save this tab didn't make.
const unsaved = new Map<string, WardInstance>();
const saveRetries = new Map<string, number>();

document.addEventListener('fd:layout-saved', () => {
  for (const [id, w] of [...unsaved]) {
    if (!body(id)) unsaved.delete(id); // ward went away — stop chasing it
    else void renderAgent(w);
  }
});

async function renderAgent(w: WardInstance): Promise<void> {
  ensureStream();
  const st = stateFor(w);
  const { status, data } = await getJson(`/api/agent/${encodeURIComponent(w.i)}`);
  const b = body(w.i);
  if (!b) return;
  if (status === 400) {
    note(w.i, 'Save the layout first.');
    unsaved.set(w.i, w);
    const tries = (saveRetries.get(w.i) ?? 0) + 1;
    saveRetries.set(w.i, tries);
    if (tries <= 6) setTimeout(() => body(w.i) && void renderAgent(w), 3000);
    return;
  }
  unsaved.delete(w.i);
  saveRetries.delete(w.i);
  if (status !== 200 || !data) {
    note(w.i, 'Agent unavailable.');
    return;
  }
  if (!data.configured) {
    b.textContent = '';
    const a = el('a', 'wd-note btn text-xs', 'Set up in Account');
    a.setAttribute('href', '/account');
    b.append(el('p', 'wd-note text-xs text-ink-faint', `No ${data.provider === 'codex' ? 'Codex' : 'OpenRouter'} credentials yet.`), a);
    return;
  }

  // A rerender mid-stream must not clobber the live turn's log.
  if (!st.busy) {
    st.items = itemsFrom(data.transcript ?? []);
    st.pending = data.pending ?? null;
    st.remote = !!data.busy; // a turn already running when this client loaded
    if (st.remote) st.items.push({ k: 'thinking' });
  }

  // The ward chrome: log + pending bar + composer, body flex-managed.
  b.textContent = '';
  b.classList.add('flex');
  b.classList.remove('overflow-y-auto');
  const wrap = el('div', 'flex h-full w-full flex-col gap-1.5');
  const log = el('div', 'min-h-0 flex-1 overflow-y-auto space-y-1.5');
  log.dataset.log = '';

  const pendingBox = el('div', 'banner banner-warn mb-0 hidden items-center gap-2 px-2 py-1.5 text-xs');
  const pendingText = el('span', 'min-w-0 flex-1');
  const confirmBtn = el('button', 'btn-primary min-h-0 px-2 py-1 text-xs', 'Confirm');
  confirmBtn.type = 'button';
  confirmBtn.setAttribute('data-ag-confirm', '');
  const declineBtn = el('button', 'btn min-h-0 px-2 py-1 text-xs', 'Cancel');
  declineBtn.type = 'button';
  declineBtn.setAttribute('data-ag-decline', '');
  pendingBox.append(pendingText, confirmBtn, declineBtn);

  const chips = el('div', 'hidden flex-wrap gap-1.5');
  const form = el('form', 'flex items-end gap-1');
  const input = el('textarea', 'input min-h-0 flex-1 resize-none px-2 py-1 text-xs');
  input.rows = 1;
  input.placeholder = 'Ask Rime…';
  const mkBtn = (cls: string, iconId: string, title: string) => {
    const btn = el('button', cls);
    btn.append(icon(iconId));
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    return btn;
  };
  const attach = mkBtn('btn min-h-0 shrink-0 px-1.5 py-1 text-xs', 'attach', 'Attach files');
  attach.setAttribute('data-ag-attach', '');
  const file = el('input', 'hidden');
  file.type = 'file';
  file.multiple = true;
  const stop = mkBtn('btn hidden min-h-0 shrink-0 px-1.5 py-1 text-xs', 'stop', 'Stop');
  const send = mkBtn('btn-primary min-h-0 shrink-0 px-2 py-1 text-xs', 'send', 'Send');
  const expand = mkBtn('btn min-h-0 shrink-0 px-1.5 py-1 text-xs', 'resize', 'Expand');
  form.append(input, attach, file, stop, send, expand);
  form.addEventListener('submit', (e) => e.preventDefault());

  wrap.append(log, pendingBox, chips, form);
  b.append(wrap);

  const ui: Ui = { root: wrap, log, input, send, stop, chips, pendingBox, pendingText };
  st.uis.add(ui); // stale ward uis fall out via the isConnected prune in paint()
  wireComposer(ui, () => states.get(w.i));
  expand.addEventListener('click', () => openDialog(stateFor(w)));
  // Touching the ward at all counts as having seen it.
  wrap.addEventListener('pointerdown', () => clearUnread(w.i));
  paint(st);
  paintBadge(w.i); // a grid rebuild blanks the header span; the count outlives it

  // Headless runs (a logic rule, a scheduled wake) broadcast 'agent' over the
  // logic stream. The payload says who asked and whether it earns an interrupt.
  onAgentPing(w.i, (p?: AgentPing) => {
    const live = states.get(w.i);
    if (!live) return;
    const headless = !!p && !!p.source && p.source !== 'chat';
    // A silenced rule still owes the user a trace — quiet isn't invisible.
    if (headless && !logVisible(w.i)) {
      unread.set(w.i, (unread.get(w.i) ?? 0) + 1);
      paintBadge(w.i);
    }
    if (headless && p!.toast) announce(live, p!);
    // The turn is over: the stored transcript is the record now.
    remoteRuns.delete(w.i);
    live.remote = false;
    if (!live.busy) void refetch(live, true);
  });

  // Every turn — chat, automation or wake — mirrors its stream frames as
  // 'agent-live'. This is what makes one thread look the same in every open
  // client at the same moment; the settle ping then reconciles against storage.
  onAgentLive(w.i, (d) => {
    const live = states.get(w.i);
    if (!live || live.busy || !d) return; // this client's own stream owns the log
    let running = remoteRuns.get(w.i);
    if (!running) remoteRuns.set(w.i, (running = newRun()));
    if (d.event?.type === 'end') {
      // The turn died without settling — no ping is coming, so release here.
      remoteRuns.delete(w.i);
      live.remote = false;
      for (const it of live.items) if (it.k === 'step') it.running = false;
      live.items = live.items.filter((it) => it.k !== 'thinking');
      if (d.event.error) live.items.push({ k: 'note', err: true, text: `⚠️ ${d.event.error}` });
      paint(live);
      return;
    }
    live.remote = true;
    const src: TurnSource = d.source === 'wake' || d.source === 'automation' || d.source === 'agent' ? d.source : 'chat';
    if (applyEvent(live, running, d.event, src)) paint(live);
  });
}

// ------------------------------------------------------------------- registry

RENDERERS.agent = { render: (w) => renderAgent(w) }; // event-driven — no poll
