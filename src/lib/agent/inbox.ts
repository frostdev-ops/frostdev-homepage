import { getDb } from '../db.ts';
import { getDashboard } from '../dashboard.ts';

// The agent-to-agent pipeline: a durable per-ward queue with receipts. A
// message is a row; delivery is one headless turn on the target ward (mode
// 'queue'), an injection into the turn already running there ('steer'), or a
// stop of that turn followed by a turn of its own ('interrupt'). The row's
// status is the receipt. Wakes (wakes.ts) are the same shape with a clock
// instead of a sender; this is the same shape with a sender instead of a clock.

export type InboxMode = 'queue' | 'steer' | 'interrupt';
export const INBOX_MODES: readonly InboxMode[] = ['queue', 'steer', 'interrupt'];

export interface InboxRow {
  id: number;
  user_id: number;
  ward: string;
  sender: string;
  mode: InboxMode;
  text: string;
  reply_to: number | null;
  wait: number;
  status: 'queued' | 'delivered' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  result: string;
  created_at: string;
  delivered_at: string | null;
  finished_at: string | null;
}

const TEXT_MAX = 8000;
const RESULT_MAX = 4000;
const MAX_OPEN = 50; // per user — a runaway pair of agents stops here
export const WAIT_DEADLINE_MS = 10 * 60_000;

// ponytail: waiters live in memory — a restart drops them, and the row is the
// record the asker reads back (check_message) once its own turn is re-run.
const waiters = new Map<number, { resolve: (reply: string) => void; reject: (err: Error) => void }>();
const pumping = new Set<string>();

// ---------------------------------------------------------------- rows

export function getMessage(userId: number, id: number): InboxRow | null {
  return (getDb().prepare('SELECT * FROM agent_inbox WHERE id = ? AND user_id = ?').get(id, userId) as InboxRow | undefined) ?? null;
}

/** The recent traffic of one ward, both directions. */
export function listInbox(userId: number, ward: string, limit = 20): InboxRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_inbox WHERE user_id = ? AND (ward = ? OR sender = ?) ORDER BY id DESC LIMIT ?')
    .all(userId, ward, ward, Math.min(Math.max(1, limit), 100)) as InboxRow[];
}

function finish(id: number, status: 'done' | 'failed', result: string): void {
  const db = getDb();
  const changed = db
    .prepare(`UPDATE agent_inbox SET status = ?, result = ?, finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'delivered')`)
    .run(status, result.slice(0, RESULT_MAX), id).changes;
  if (!changed) return; // the sweep already re-armed or failed it — that run owns the row
  const w = waiters.get(id);
  waiters.delete(id);
  if (w) status === 'done' ? w.resolve(result) : w.reject(new Error(result));
  // The reply-back hop of an unwaited ask: the answer becomes a message to the
  // asker. Never for a reply itself, or two agents ping-pong until the cap.
  const row = getDb().prepare('SELECT * FROM agent_inbox WHERE id = ?').get(id) as InboxRow;
  if (status === 'done' && !row.wait && row.reply_to === null && result.trim()) {
    void sendMessage(row.user_id, { to: row.sender, from: row.ward, text: result, replyTo: row.id }).catch((err) =>
      console.error('[inbox] reply-back failed:', err)
    );
  }
}

/** Resolves with the reply when the row finishes (or at once if it already
 *  has); rejects on failure or at the deadline — the delivery itself keeps
 *  going and lands in the row. */
export function waitFor(id: number, ms = WAIT_DEADLINE_MS): Promise<string> {
  const row = getDb().prepare('SELECT status, result FROM agent_inbox WHERE id = ?').get(id) as { status: string; result: string } | undefined;
  if (!row) return Promise.reject(new Error(`no message #${id}`));
  if (row.status === 'done') return Promise.resolve(row.result);
  if (row.status === 'failed' || row.status === 'cancelled') return Promise.reject(new Error(row.result || row.status));
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`message #${id} is still being worked on after ${Math.round(ms / 60_000)} minutes — check_message(${id}) later for the answer`));
    }, ms);
    waiters.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

// ---------------------------------------------------------------- send

export interface Outgoing {
  to: string;
  from: string;
  text: string;
  mode?: InboxMode;
  wait?: boolean;
  replyTo?: number;
  /** Wards whose sync ask is waiting up the call — rides to the delivered turn for its own cycle guard. */
  via?: string[];
}

/** Queue a message and start delivering it. Validation is the trust boundary
 *  for the tool AND the reply-back hop. */
export async function sendMessage(userId: number, m: Outgoing): Promise<InboxRow> {
  const text = m.text.trim();
  if (!text) throw new Error('say something');
  if (text.length > TEXT_MAX) throw new Error(`message too long (${text.length} > ${TEXT_MAX} chars)`);
  if (m.to === m.from) throw new Error('that is you — answer directly');
  const mode: InboxMode = INBOX_MODES.includes(m.mode as InboxMode) ? (m.mode as InboxMode) : 'queue';
  const { agentWardConfig, takeHeadlessSlot } = await import('./core.ts');
  const { agentConfigured } = await import('./provider.ts');
  const cfg = agentWardConfig(userId, m.to);
  if (!cfg) throw new Error(`no agent ward "${m.to}" — list_agents shows the ones that exist`);
  if (!agentConfigured(userId, cfg.provider)) throw new Error(`${cfg.provider} is not configured on "${m.to}"`);
  const db = getDb();
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM agent_inbox WHERE user_id = ? AND status IN ('queued', 'delivered')`).get(userId) as { n: number }).n;
  if (open >= MAX_OPEN) throw new Error(`too many messages in flight already (${MAX_OPEN}) — let some finish first`);
  // The per-ward headless cap is the loop brake, taken at send so the sender
  // hears "rate limited" now rather than reading it off a failed receipt.
  takeHeadlessSlot(userId, m.to);
  const id = db
    .prepare('INSERT INTO agent_inbox (user_id, ward, sender, mode, text, reply_to, wait) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, m.to, m.from, mode, text, m.replyTo ?? null, m.wait ? 1 : 0).lastInsertRowid as number;
  void pump(userId, m.to, m.via).catch((err) => console.error('[inbox] pump failed:', err));
  return getMessage(userId, id)!;
}

// ---------------------------------------------------------------- deliver

/** Drain one ward's queue in order. Idempotent per ward: a second call while
 *  one is draining returns at once — the drain loop picks the new row up. */
export async function pump(userId: number, ward: string, via?: string[]): Promise<void> {
  const key = `${userId}:${ward}`;
  if (pumping.has(key)) return;
  pumping.add(key);
  try {
    for (;;) {
      const row = claim(userId, ward);
      if (!row) break;
      await deliver(row, via);
    }
  } finally {
    pumping.delete(key);
  }
}

function claim(userId: number, ward: string): InboxRow | null {
  const db = getDb();
  const next = db.prepare(`SELECT id FROM agent_inbox WHERE user_id = ? AND ward = ? AND status = 'queued' ORDER BY id LIMIT 1`).get(userId, ward) as
    | { id: number }
    | undefined;
  if (!next) return null;
  const got = db.prepare(`UPDATE agent_inbox SET status = 'delivered', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).run(next.id).changes;
  return got ? getMessage(userId, next.id) : null;
}

async function deliver(row: InboxRow, via?: string[]): Promise<void> {
  const core = await import('./core.ts');
  const reply = row.reply_to !== null;
  if (!getDashboard(row.user_id).some((w) => w.i === row.ward && w.type === 'agent')) {
    finish(row.id, 'failed', `agent ward "${row.ward}" is gone from the layout`);
    return;
  }
  if (row.mode === 'steer' && core.wardBusy(row.user_id, row.ward)) {
    // Into the running turn; that turn finishes the row when it ends.
    getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now') WHERE id = ?`).run(row.id);
    core.steerTurn(row.user_id, row.ward, { id: row.id, text: row.text, from: row.sender, reply, done: (r) => finish(row.id, 'done', r) });
    return;
  }
  if (row.mode === 'interrupt') core.interruptTurn(row.user_id, row.ward, `agent "${core.peerTitle(row.user_id, row.sender)}"`);
  try {
    const answer = await core.runHeadlessTurn(row.user_id, row.ward, row.text, {
      kind: 'agent',
      from: row.sender,
      reply,
      via,
      onStart: () => getDb().prepare(`UPDATE agent_inbox SET delivered_at = datetime('now') WHERE id = ?`).run(row.id),
    });
    finish(row.id, 'done', answer);
  } catch (err) {
    finish(row.id, 'failed', err instanceof Error ? err.message : 'delivery failed');
  }
}

// ---------------------------------------------------------------- sweep

/**
 * Re-arm what a dead process left 'delivered' and drain every queue with rows
 * waiting. `boot` re-arms every delivered row (nothing can be in flight at
 * boot); the tick only re-arms rows an hour stale, the same rule as wakes. One
 * retry, then the row fails — a third run would repeat writes every hour.
 */
export async function sweepInbox(boot = false): Promise<number> {
  const db = getDb();
  db.prepare(
    `UPDATE agent_inbox SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'queued' END,
            result = CASE WHEN attempts >= 2 THEN 'interrupted twice — not retried; ask again' ELSE result END,
            finished_at = CASE WHEN attempts >= 2 THEN datetime('now') ELSE finished_at END
      WHERE status = 'delivered' AND (? OR COALESCE(delivered_at, created_at) < datetime('now', '-60 minutes'))`
  ).run(boot ? 1 : 0);
  const wards = db.prepare(`SELECT DISTINCT user_id, ward FROM agent_inbox WHERE status = 'queued'`).all() as { user_id: number; ward: string }[];
  for (const w of wards) void pump(w.user_id, w.ward).catch((err) => console.error('[inbox] pump failed:', err));
  return wards.length;
}

// ---------------------------------------------------------------- the tool's entry

/** ask_agent: send, and either wait for the receipt to close or hand back the
 *  id. The cycle guard is here: a waited ask to a ward that is itself waiting
 *  on this turn would hold both chains forever. */
export async function askAgent(
  ctx: { userId: number; ward: string; via?: string[] },
  target: string,
  message: string,
  opts: { wait?: boolean; mode?: InboxMode } = {}
): Promise<{ message_id: number; from: string; reply: string } | { message_id: number; queued: true; note: string }> {
  const wait = opts.wait !== false;
  if (target === ctx.ward) throw new Error('that is you — answer directly');
  const via = [...(ctx.via ?? []), ctx.ward];
  if (wait && via.includes(target)) {
    throw new Error(`"${target}" is waiting on YOUR answer right now — put what you have to say in your reply, or send it with wait:false`);
  }
  const row = await sendMessage(ctx.userId, { to: target, from: ctx.ward, text: message, mode: opts.mode, wait, via });
  if (!wait) {
    return { message_id: row.id, queued: true, note: `"${target}" will answer in a later turn of yours; check_message(${row.id}) shows the receipt` };
  }
  return { message_id: row.id, from: target, reply: await waitFor(row.id) };
}
