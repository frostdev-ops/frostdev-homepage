import { getDb } from '../db.ts';
import { getAttachment, attachmentDataUrl } from './attachments.ts';
import { appendTurn } from './history.ts';
import type { AgentProvider, AgentProviderId } from './provider.ts';

// The agent's memory, per (user, ward). Two views of one conversation:
//   agent_messages — what the ward renders
//   agent_items    — the raw wire conversation replayed to the provider,
//                    verbatim (codex reasoning items must ride along)
//
// A conversation is PINNED to the provider it started on; when the ward's
// config names a different one, the thread is retired and a fresh one starts —
// the two dialects' stored items are mutually unreadable.

// ~4 chars/token. The fixed part of a turn (instructions + tool schemas) is
// ~60k tokens on its own, and every codex model takes 272k+ of input — the old
// 150k-char threshold folded a thread after ~37k tokens of it, several times
// per long task. OpenRouter models start at 128k, so they keep the tight pair.
const BUDGET: Record<AgentProviderId, { compactAt: number; context: number }> = {
  codex: { compactAt: 400_000, context: 480_000 },
  openrouter: { compactAt: 150_000, context: 200_000 },
};
/** The thread's char budget for this provider: `compactAt` folds the older
 *  part, `context` is the hard replay cut. What the ward's indicator is against. */
export const contextBudget = (provider: AgentProviderId) => BUDGET[provider] ?? BUDGET.openrouter;
const COMPACT_FRACTION = 0.6;
const IMAGE_TURNS = 2; // images are re-sent every round; only recent ones ride along

export interface ConvRow {
  id: number;
  user_id: number;
  ward: string;
  provider: AgentProviderId;
  active: number;
  pending_confirm_id: string | null;
}

export interface AgentStep {
  /** The provider's call id, and the tool round it ran in: every step of one
   *  round ran in parallel, and the client draws them as one batch. Absent on
   *  steps older than batching, and on a confirm resolved out of band. */
  id?: string;
  round?: number;
  tool: string;
  kind: string;
  args: Record<string, unknown>;
  reason?: string;
  result?: unknown;
  error?: string;
  ms?: number;
}

/** What produced a turn. 'chat' = the user typed it; the others ran unattended. */
export type TurnSource = 'chat' | 'automation' | 'wake' | 'agent';

export interface TranscriptMsg {
  role: 'user' | 'assistant';
  text: string;
  steps?: AgentStep[];
  source: TurnSource;
  at: string;
}

export function getConversation(id: number): ConvRow | null {
  return (getDb().prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id) as ConvRow | undefined) ?? null;
}

/** The active thread for a ward, if one exists. Read-only: unlike
 *  activeConversation it never creates a row. */
export function activeConversationRow(userId: number, ward: string): ConvRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM agent_conversations WHERE user_id = ? AND ward = ? AND active = 1')
      .get(userId, ward) as ConvRow | undefined) ?? null
  );
}

/** The active thread for a ward — created (or retired-and-recreated on a
 *  provider change) as needed. */
export function activeConversation(userId: number, ward: string, provider: AgentProviderId): ConvRow {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM agent_conversations WHERE user_id = ? AND ward = ? AND active = 1')
    .get(userId, ward) as ConvRow | undefined;
  if (row && row.provider === provider) return row;
  if (row) db.prepare('UPDATE agent_conversations SET active = 0 WHERE id = ?').run(row.id);
  const id = Number(
    db
      .prepare('INSERT INTO agent_conversations (user_id, ward, provider) VALUES (?, ?, ?)')
      .run(userId, ward, provider).lastInsertRowid
  );
  return getConversation(id)!;
}

/** "Clear" retires the thread — nothing is destroyed. */
export function retireConversation(userId: number, ward: string): void {
  getDb().prepare('UPDATE agent_conversations SET active = 0 WHERE user_id = ? AND ward = ?').run(userId, ward);
}

export function setPendingConfirm(conversationId: number, confirmId: string | null): void {
  getDb().prepare('UPDATE agent_conversations SET pending_confirm_id = ? WHERE id = ?').run(confirmId, conversationId);
}

function touch(conversationId: number): void {
  getDb().prepare(`UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?`).run(conversationId);
}

// ---------------------------------------------------------------- messages

export function addMessage(
  conv: ConvRow,
  msg: { role: 'user' | 'assistant'; text: string; steps?: AgentStep[]; source?: TurnSource }
): void {
  getDb()
    .prepare('INSERT INTO agent_messages (conversation_id, role, text, steps_json, source) VALUES (?, ?, ?, ?, ?)')
    .run(conv.id, msg.role, msg.text, msg.steps?.length ? JSON.stringify(msg.steps) : null, msg.source ?? 'chat');
  // Disk mirror so the bash sandbox can rg its own past (/history mount).
  appendTurn(conv.user_id, conv.id, msg.role, msg.text, { steps: msg.steps });
  touch(conv.id);
}

export function transcript(conversationId: number, limit = 60): TranscriptMsg[] {
  const rows = getDb()
    .prepare('SELECT * FROM (SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
    .all(conversationId, limit) as {
    role: 'user' | 'assistant';
    text: string;
    steps_json: string | null;
    source: TurnSource | null;
    at: string;
  }[];
  return rows.map((r) => {
    let steps: AgentStep[] | undefined;
    try {
      steps = r.steps_json ? JSON.parse(r.steps_json) : undefined;
    } catch {
      /* malformed steps must not cost the user their history */
    }
    return { role: r.role, text: r.text, steps, source: r.source ?? 'chat', at: r.at };
  });
}

// ---------------------------------------------------------------- raw items

/** Both dialects mark a user turn this way (codex adds type:'message'). */
const isUserMsg = (it: any): boolean =>
  it?.role === 'user' && (it.type === 'message' || it.type === undefined);

/** A tool RESULT in either dialect. The compaction boundary must never land on
 *  one: its call would go into the summary, the output would stay in the tail
 *  as an orphan, and repairItems would then delete the orphan — leaving the
 *  result in neither half. */
const isToolOutput = (it: any): boolean =>
  it?.type === 'function_call_output' || (it?.role === 'tool' && !!it.toolCallId);

/** Image bytes live in the attachment store, not in five copies of the thread.
 *  Image parts carry a file_id (codex dialect) / fileId (openrouter) that the
 *  providers strip before sending — it exists for exactly this bookkeeping. */
function dehydrate(item: unknown): unknown {
  const it = item as { type?: string; role?: string; content?: unknown };
  if (!Array.isArray(it?.content)) return item;
  return {
    ...it,
    content: it.content.map((c: any) => {
      if (c?.type === 'input_image' && typeof c.image_url === 'string' && c.image_url.startsWith('data:') && c.file_id) {
        return { type: 'input_image', image_url: `attachment:${c.file_id}`, file_id: c.file_id };
      }
      if (c?.type === 'image_url' && typeof c.imageUrl?.url === 'string' && c.imageUrl.url.startsWith('data:') && c.fileId) {
        return { type: 'image_url', imageUrl: { url: `attachment:${c.fileId}` }, fileId: c.fileId };
      }
      return c;
    }),
  };
}

function rehydrate(userId: number, item: unknown, withImages: boolean): unknown {
  const it = item as { type?: string; role?: string; content?: unknown };
  if (!Array.isArray(it?.content)) return item;
  const content: unknown[] = [];
  for (const c of it.content as any[]) {
    const codexRef = c?.type === 'input_image' && typeof c.image_url === 'string' && c.image_url.startsWith('attachment:');
    const orRef = c?.type === 'image_url' && typeof c.imageUrl?.url === 'string' && c.imageUrl.url.startsWith('attachment:');
    if (!codexRef && !orRef) {
      content.push(c);
      continue;
    }
    const id = Number(codexRef ? c.image_url.slice('attachment:'.length) : c.imageUrl.url.slice('attachment:'.length));
    const f = getAttachment(userId, id);
    const url = withImages && f ? attachmentDataUrl(f) : null;
    // A dropped image leaves a note — the model should know something was
    // attached rather than see a turn that makes no sense.
    if (url) content.push(codexRef ? { type: 'input_image', image_url: url, file_id: id } : { type: 'image_url', imageUrl: { url }, fileId: id });
    else {
      const text = `[image ${f?.name ?? 'attachment'} was attached earlier in this conversation]`;
      content.push(codexRef ? { type: 'input_text', text } : { type: 'text', text });
    }
  }
  return { ...it, content };
}

export function appendItems(conversationId: number, items: unknown[]): void {
  const db = getDb();
  const ins = db.prepare('INSERT INTO agent_items (conversation_id, json, chars) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const raw of items) {
      const json = JSON.stringify(dehydrate(raw));
      ins.run(conversationId, json, json.length);
    }
  })();
  touch(conversationId);
}

/**
 * The conversation to replay: newest-first up to the budget, cut on a user
 * message so no tool result is orphaned from its call, images rehydrated for
 * the last IMAGE_TURNS turns only, then the provider's pair repair — applied
 * LAST so its inserts can't shift the image-budget indices. `keepOpen` names
 * call_ids that are unanswered on purpose (a parked confirm).
 */
export function loadItems(conv: ConvRow, provider: AgentProvider, keepOpen: Set<string>): unknown[] {
  const rows = getDb()
    .prepare('SELECT id, json, chars FROM agent_items WHERE conversation_id = ? ORDER BY id')
    .all(conv.id) as { id: number; json: string; chars: number }[];

  let total = 0;
  let cut = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    total += rows[i]!.chars;
    if (total > contextBudget(conv.provider).context) {
      cut = i + 1;
      break;
    }
  }
  const parsed = rows.slice(cut).map((r) => {
    try {
      return JSON.parse(r.json);
    } catch {
      return null;
    }
  });
  let start = 0;
  if (cut > 0) {
    const idx = parsed.findIndex(isUserMsg);
    start = idx >= 0 ? idx : parsed.length;
  }

  const kept = parsed.slice(start).filter(Boolean);
  const userTurns: number[] = [];
  kept.forEach((it, i) => {
    if (isUserMsg(it)) userTurns.push(i);
  });
  const imagesFrom = userTurns.length > IMAGE_TURNS ? userTurns[userTurns.length - IMAGE_TURNS]! : 0;
  return provider.repairItems(
    kept.map((it, i) => rehydrate(conv.user_id, it, i >= imagesFrom)),
    keepOpen
  );
}

// ---------------------------------------------------------------- compaction
//
// Truncation loses the beginning of a long session — the part that says what
// was decided. The oldest stretch is summarised by the same provider and
// replaced with one item; the verbatim transcript stays under /history where
// the bash tool can rg it.

/** `force` is the /compact command: same fold, thresholds skipped. It still
 *  needs enough items to have an older half worth folding. `focus` is that
 *  command's optional hint about what the brief must not lose. */
const overBudget = (provider: AgentProviderId, items: number, chars: number): boolean =>
  chars >= contextBudget(provider).compactAt && items >= 8;

/** Would the next turn compact this thread? So a turn can say so before it does. */
export function needsCompaction(conv: ConvRow): boolean {
  const s = conversationSize(conv.id);
  return overBudget(conv.provider, s.items, s.chars);
}

export async function compactIfNeeded(
  conv: ConvRow,
  provider: AgentProvider,
  model: string,
  force = false,
  focus = ''
): Promise<boolean> {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, json, chars FROM agent_items WHERE conversation_id = ? ORDER BY id')
    .all(conv.id) as { id: number; json: string; chars: number }[];
  const total = rows.reduce((n, r) => n + r.chars, 0);
  if (force ? rows.length < 4 : !overBudget(conv.provider, rows.length, total)) return false;

  let acc = 0;
  let end = 0;
  for (let i = 0; i < rows.length; i++) {
    acc += rows[i]!.chars;
    if (acc >= total * COMPACT_FRACTION) {
      end = i;
      break;
    }
  }
  // Extend to a user-message boundary so the surviving tail starts a turn.
  const boundary = rows.findIndex((r, i) => i >= end && isUserMsg(safeParse(r.json)));
  if (boundary > 0) end = boundary;
  // No boundary to be had (a long final tool loop — the usual shape for codex,
  // whose encrypted reasoning blobs push the fraction deep into the last turn).
  // Then at least keep every tool result with the call it answers.
  else while (end < rows.length && isToolOutput(safeParse(rows[end]!.json))) end++;

  // One item can be most of the conversation on its own — a big inlined
  // document, or a single fat reasoning blob. Folding just that one is the
  // whole point of the request, so don't refuse; the shrink check below is what
  // decides whether the fold was worth committing.
  if (end <= 0) end = 1;
  end = Math.min(end, rows.length - 1); // the tail must never be empty

  const older = rows.slice(0, end);
  const olderChars = older.reduce((n, r) => n + r.chars, 0);
  const plain = older
    .map((r) => summarisable(safeParse(r.json)))
    .filter(Boolean)
    .join('\n')
    .slice(0, 120_000);

  const result = await provider.run({
    userId: conv.user_id,
    model,
    instructions:
      'You are compacting the earlier part of a dashboard-assistant conversation so it can be carried forward in less space. ' +
      'Write a dense factual brief, no preamble. Cover: what the user asked for, what was actually changed (wards, ' +
      'automations, mail sent — with ward ids, edge ids and exact values), what was refused or left undone, decisions and ' +
      'corrections, and anything still open. Never invent. Prefer identifiers over adjectives.' +
      // The user's own words about what this thread is for. Additive: it steers
      // what survives in full, it never licenses dropping the rest.
      (focus
        ? `\n\nThe user asked you to pay particular attention to this — keep every detail bearing on it, and stay ` +
          `brief about the rest:\n${focus.slice(0, 500)}`
        : ''),
    items: [provider.userItem(plain)],
    tools: [],
  });

  // A model that answered with nothing (or a refusal that is all whitespace)
  // must not replace real context: SQLite is the only copy of these items.
  if (!result.text.trim()) {
    console.error(`[agent] compaction of conversation ${conv.id} produced no summary — kept the items`);
    return false;
  }

  const summary = provider.userItem(
    `[Earlier in this conversation, compacted. The verbatim transcript is on disk at /history/${conv.id}.md — ` +
      `search it with the bash tool if you need a detail that is not here.]\n\n${result.text}`
  );
  const json = JSON.stringify(summary);
  // Folding has to actually pay for itself. Without this, a conversation whose
  // first item is already a summary re-summarizes that summary every single
  // turn: one wasted model round-trip each time, freeing nothing and degrading
  // the brief with every pass.
  if (json.length >= olderChars) {
    console.log(`[agent] skipped compacting conversation ${conv.id}: the summary is no smaller than the ${older.length} items`);
    return false;
  }

  db.transaction(() => {
    db.prepare('DELETE FROM agent_items WHERE id IN (' + older.map(() => '?').join(',') + ')').run(...older.map((r) => r.id));
    // The oldest row's id, so ordering survives without renumbering.
    db.prepare('INSERT INTO agent_items (id, conversation_id, json, chars) VALUES (?, ?, ?, ?)').run(
      older[0]!.id,
      conv.id,
      json,
      json.length
    );
  })();
  console.log(`[agent] compacted conversation ${conv.id}: ${older.length} items -> 1 summary`);
  return true;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const SUMMARY_PART_CAP = 2000;
const cap = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > SUMMARY_PART_CAP ? `${s.slice(0, SUMMARY_PART_CAP)}…` : s;
};

/**
 * One readable line per item (either dialect), for the summariser.
 *
 * Order matters. The chat dialect stores an assistant message that BOTH speaks
 * and calls tools as one item ({content:'Let me check…', toolCalls:[…]}), which
 * is how most models answer — so a generic `content` branch placed first would
 * report what the agent said and silently lose everything it did. Tool shapes
 * are therefore matched before the plain-text ones, and every part is capped:
 * uncapped tool output let two fat early results eat the whole 120k budget and
 * push the recent, still-relevant part of the region out of the brief.
 */
function summarisable(item: unknown): string {
  const it = item as any;
  if (!it) return '';

  // Tool traffic first, in both dialects.
  if (it.type === 'function_call') return `tool ${it.name}(${cap(it.arguments)})`;
  if (it.type === 'function_call_output') return `result: ${cap(it.output)}`;
  if (it.role === 'tool') return `result: ${cap(it.content)}`;

  const lines: string[] = [];
  if (typeof it.content === 'string' && it.content.trim() && it.role) {
    lines.push(`${it.role}: ${it.content}`);
  } else if (Array.isArray(it.content)) {
    const text = it.content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type?.includes('image') ? '[image]' : ''))
      .filter(Boolean)
      .join(' ');
    if (text) lines.push(`${it.role ?? 'assistant'}: ${text}`);
  }
  if (Array.isArray(it.toolCalls)) {
    for (const tc of it.toolCalls) lines.push(`tool ${tc.function?.name}(${cap(tc.function?.arguments)})`);
  }
  return lines.join('\n');
}

export function conversationSize(conversationId: number): { items: number; chars: number } {
  return getDb()
    .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(chars), 0) AS chars FROM agent_items WHERE conversation_id = ?')
    .get(conversationId) as { items: number; chars: number };
}
