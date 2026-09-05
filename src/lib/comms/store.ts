import { getDb } from '../db.ts';
import type { ChatMessage } from './types.ts';

// The message store behind every chat ward (migration 014). One table for
// every provider so the ward view, the agent's chat_read and the reaction
// lookup have one read path — Telegram has no history API at all, and a
// reaction event carries no message text. The primary key is the replay
// guard: ingest() reports only the rows that actually inserted, and only
// those fire logic.

const KEEP = 500; // per ward

interface Row {
  id: string;
  channel: string;
  channel_name: string;
  from_id: string;
  from_name: string;
  text: string;
  at: number;
  attachments: string;
  thread_id: string | null;
  reply_to: string | null;
  mine: number;
}

function toMessage(r: Row): ChatMessage {
  const m: ChatMessage = { id: r.id, channel: r.channel, from: { id: r.from_id, name: r.from_name }, text: r.text, at: r.at };
  if (r.channel_name) m.channelName = r.channel_name;
  if (r.attachments !== '[]') {
    try {
      m.attachments = JSON.parse(r.attachments) as ChatMessage['attachments'];
    } catch {}
  }
  if (r.thread_id) m.threadId = r.thread_id;
  if (r.reply_to) m.replyTo = r.reply_to;
  if (r.mine) m.mine = true;
  return m;
}

/** Insert what is new, return exactly those (in the order given), trim the
 *  ward to the last KEEP rows — one transaction per batch. */
export function ingest(userId: number, ward: string, msgs: ChatMessage[]): ChatMessage[] {
  if (!msgs.length) return [];
  const db = getDb();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO comms_messages (user_id, ward, id, channel, channel_name, from_id, from_name, text, at, attachments, thread_id, reply_to, mine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  );
  const trim = db.prepare(
    `DELETE FROM comms_messages WHERE user_id = ? AND ward = ? AND at < COALESCE(
       (SELECT at FROM comms_messages WHERE user_id = ? AND ward = ? ORDER BY at DESC LIMIT 1 OFFSET ?), 0)`
  );
  return db.transaction(() => {
    const out: ChatMessage[] = [];
    for (const m of msgs) {
      const row = ins.get(
        userId, ward, m.id, m.channel, m.channelName ?? '', m.from.id, m.from.name, m.text.slice(0, 8000), Math.round(m.at),
        JSON.stringify((m.attachments ?? []).slice(0, 10)), m.threadId ?? null, m.replyTo ?? null, m.mine ? 1 : 0
      );
      if (row) out.push(m);
    }
    if (out.length) trim.run(userId, ward, userId, ward, KEEP - 1);
    return out;
  })();
}

/** Newest first. channel null = every channel of the ward. */
export function listMessages(userId: number, ward: string, channel: string | null, limit: number): ChatMessage[] {
  const n = Math.min(Math.max(Math.round(limit) || 20, 1), 200);
  const rows = (channel
    ? getDb().prepare('SELECT * FROM comms_messages WHERE user_id = ? AND ward = ? AND channel = ? ORDER BY at DESC LIMIT ?').all(userId, ward, channel, n)
    : getDb().prepare('SELECT * FROM comms_messages WHERE user_id = ? AND ward = ? ORDER BY at DESC LIMIT ?').all(userId, ward, n)) as Row[];
  return rows.map(toMessage);
}

/** Substring search over text and sender, newest first. */
export function searchMessages(userId: number, ward: string, query: string, limit = 20): ChatMessage[] {
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = getDb()
    .prepare(`SELECT * FROM comms_messages WHERE user_id = ? AND ward = ? AND (text LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\') ORDER BY at DESC LIMIT ?`)
    .all(userId, ward, like, like, Math.min(Math.max(limit, 1), 100)) as Row[];
  return rows.map(toMessage);
}

export function getMessage(userId: number, ward: string, id: string): ChatMessage | null {
  const row = getDb().prepare('SELECT * FROM comms_messages WHERE user_id = ? AND ward = ? AND id = ?').get(userId, ward, id) as Row | undefined;
  return row ? toMessage(row) : null;
}

/** The channels this ward has rows for — the picker's fallback when a
 *  provider cannot list them (Telegram), newest activity first. */
export function channelsSeen(userId: number, ward: string): { id: string; name: string }[] {
  return getDb()
    .prepare('SELECT channel AS id, MAX(channel_name) AS name FROM comms_messages WHERE user_id = ? AND ward = ? GROUP BY channel ORDER BY MAX(at) DESC LIMIT 50')
    .all(userId, ward) as { id: string; name: string }[];
}

export function deleteWardMessages(userId: number, ward: string): void {
  getDb().prepare('DELETE FROM comms_messages WHERE user_id = ? AND ward = ?').run(userId, ward);
}
