// Flow packets: traveling data units that live on flow wards and move
// ward-to-ward through the logic graph. Every mutation appends a history
// entry — the packet carries its own trail.

import { getDb } from './db.ts';

const MAX_PACKETS_PER_USER = 200;
const MAX_HISTORY = 50;
const MAX_TEXT = 500;
const MAX_NOTE = 200;
const DONE_TTL_DAYS = 7;

export interface PacketHistoryEntry {
  at: string;
  ward: string;
  event: 'created' | 'annotated' | 'passed' | 'moved' | 'completed';
  note?: string;
}

export interface Packet {
  id: number;
  ward: string;
  channel: string;
  text: string;
  status: 'waiting' | 'done';
  history: PacketHistoryEntry[];
  createdAt: string;
}

interface Row {
  id: number;
  ward: string;
  channel: string;
  text: string;
  status: 'waiting' | 'done';
  history_json: string;
  created_at: string;
}

/** SQLite datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC, unmarked) → epoch
 *  ms. A bare Date.parse would read it as LOCAL time — hours off once TZ is set. */
export const sqliteMs = (t: string): number => Date.parse(t.replace(' ', 'T') + 'Z');

/** Any OTHER packet on the same ward with identical text inside the window.
 *  Bounded by the 200-packet cap + 7-day done TTL; idx_packets_user_ward
 *  prefix covers it — no new index. */
export function hasDuplicateText(userId: number, packet: Packet, hours: number): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1 FROM packets WHERE user_id = ? AND ward = ? AND text = ? AND id <> ?
         AND created_at > datetime('now', ?) LIMIT 1`
    )
    .get(userId, packet.ward, packet.text, packet.id, `-${Math.min(Math.max(hours, 1), 168)} hours`);
}

function toPacket(row: Row): Packet {
  let history: PacketHistoryEntry[] = [];
  try {
    const parsed = JSON.parse(row.history_json);
    if (Array.isArray(parsed)) history = parsed;
  } catch {}
  return { id: row.id, ward: row.ward, channel: row.channel, text: row.text, status: row.status, history, createdAt: row.created_at };
}

function appendHistory(userId: number, packet: Packet, entry: Omit<PacketHistoryEntry, 'at'>): Packet {
  const history = [...packet.history, { at: new Date().toISOString(), ...entry }].slice(-MAX_HISTORY);
  getDb()
    .prepare(`UPDATE packets SET history_json = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`)
    .run(JSON.stringify(history), userId, packet.id);
  return { ...packet, history };
}

export function getPacket(userId: number, id: number): Packet | null {
  const row = getDb().prepare('SELECT id, ward, channel, text, status, history_json, created_at FROM packets WHERE user_id = ? AND id = ?').get(userId, id) as Row | undefined;
  return row ? toPacket(row) : null;
}

/** Waiting packets first (newest first within each status), capped at 50. */
export function listPackets(userId: number, ward: string): Packet[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ward, channel, text, status, history_json, created_at FROM packets
       WHERE user_id = ? AND ward = ? ORDER BY (status = 'waiting') DESC, id DESC LIMIT 50`
    )
    .all(userId, ward) as Row[];
  return rows.map(toPacket);
}

/** ALL waiting packets on a ward, oldest first (conveyor order) — no display
 *  cap, or packets past the newest 50 would be silently unpassable. */
export function listWaiting(userId: number, ward: string): Packet[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ward, channel, text, status, history_json, created_at FROM packets
       WHERE user_id = ? AND ward = ? AND status = 'waiting' ORDER BY id ASC`
    )
    .all(userId, ward) as Row[];
  return rows.map(toPacket);
}

export function createPacket(userId: number, ward: string, channel: string, text: string): Packet {
  const db = getDb();
  const clean = text.trim().slice(0, MAX_TEXT);
  const history: PacketHistoryEntry[] = [{ at: new Date().toISOString(), ward, event: 'created' }];
  const res = db
    .prepare(`INSERT INTO packets (user_id, ward, channel, text, history_json) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, ward, channel, clean, JSON.stringify(history));

  // Prune-on-write: expired done packets, then enforce the per-user cap
  // (oldest done evicted first, then oldest waiting).
  db.prepare(`DELETE FROM packets WHERE user_id = ? AND status = 'done' AND updated_at < datetime('now', '-${DONE_TTL_DAYS} days')`).run(userId);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM packets WHERE user_id = ?').get(userId) as { n: number }).n;
  if (count > MAX_PACKETS_PER_USER) {
    db.prepare(
      `DELETE FROM packets WHERE user_id = ? AND id IN (
         SELECT id FROM packets WHERE user_id = ? ORDER BY (status = 'done') DESC, id ASC LIMIT ?)`
    ).run(userId, userId, count - MAX_PACKETS_PER_USER);
  }
  return getPacket(userId, Number(res.lastInsertRowid))!;
}

/** Relocate the same row (trail preserved) to another ward/channel. */
export function movePacket(userId: number, id: number, toWard: string, channel: string): Packet | null {
  const packet = getPacket(userId, id);
  if (!packet || packet.status !== 'waiting') return null;
  getDb()
    .prepare(`UPDATE packets SET ward = ?, channel = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`)
    .run(toWard, channel, userId, id);
  return appendHistory(userId, { ...packet, ward: toWard, channel }, { ward: toWard, event: 'moved', note: `from ${packet.ward}` });
}

/** Re-route a waiting packet on its own ward (the sorter): one `passed` row
 *  carrying the reason, not a `moved: from f1` row. */
export function setChannel(userId: number, id: number, channel: string, note: string): Packet | null {
  const packet = getPacket(userId, id);
  if (!packet || packet.status !== 'waiting') return null;
  getDb().prepare(`UPDATE packets SET channel = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?`).run(channel, userId, id);
  return appendHistory(userId, { ...packet, channel }, { ward: packet.ward, event: 'passed', note: note.slice(0, MAX_NOTE) });
}

export function annotatePacket(userId: number, id: number, note: string): Packet | null {
  const packet = getPacket(userId, id);
  if (!packet) return null;
  return appendHistory(userId, packet, { ward: packet.ward, event: 'annotated', note: note.trim().slice(0, MAX_NOTE) });
}

export function markPassed(userId: number, id: number): Packet | null {
  const packet = getPacket(userId, id);
  if (!packet || packet.status !== 'waiting') return null;
  return appendHistory(userId, packet, { ward: packet.ward, event: 'passed' });
}

export function completePacket(userId: number, id: number): Packet | null {
  const packet = getPacket(userId, id);
  if (!packet || packet.status === 'done') return null;
  getDb().prepare(`UPDATE packets SET status = 'done', updated_at = datetime('now') WHERE user_id = ? AND id = ?`).run(userId, id);
  return appendHistory(userId, { ...packet, status: 'done' }, { ward: packet.ward, event: 'completed' });
}

export function deleteOrphanPackets(userId: number, liveWards: Set<string>): string[] {
  const rows = getDb().prepare('SELECT DISTINCT ward FROM packets WHERE user_id = ?').all(userId) as { ward: string }[];
  const gone = rows.map((r) => r.ward).filter((t) => !liveWards.has(t));
  if (gone.length) {
    const del = getDb().prepare('DELETE FROM packets WHERE user_id = ? AND ward = ?');
    for (const t of gone) del.run(userId, t);
  }
  return gone;
}
