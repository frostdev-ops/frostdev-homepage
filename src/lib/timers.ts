// Server-authoritative timer state: a pure DB state machine, one row per
// timer ward instance. Arming setTimeouts and SSE broadcast live in
// logic-engine.ts, which wraps these ops — this module stays cycle-free.

import { getDb } from './db.ts';
import { getDashboard } from './dashboard.ts';
import { timerSteps, type RoutineStep } from './wards.ts';

export interface TimerState {
  ward: string;
  state: 'idle' | 'running' | 'paused';
  durationMs: number;
  /** unix ms, set iff running */
  endsAt: number | null;
  /** set iff paused */
  remainingMs: number | null;
  /** Routine step index: the step running/paused, or — idle — the next one
   *  (≥ steps.length once a routine has finished). Always 0 on a plain timer. */
  step: number;
}

interface TimerRow {
  ward: string;
  duration_ms: number;
  state: 'idle' | 'running' | 'paused';
  ends_at: number | null;
  remaining_ms: number | null;
  step: number;
}

export interface TimerConfig {
  /** Plain-timer duration, seconds. */
  duration: number;
  steps: RoutineStep[];
  loop: boolean;
}

const COLS = 'ward, duration_ms, state, ends_at, remaining_ms, step';

/** ward id → timer config for every timer ward in the layout. */
function timerWards(userId: number): Map<string, TimerConfig> {
  const out = new Map<string, TimerConfig>();
  for (const w of getDashboard(userId)) {
    if (w.type === 'timer') out.set(w.i, { duration: Number(w.config?.duration) || 300, steps: timerSteps(w.config), loop: w.config?.loop === true });
  }
  return out;
}

/** The engine's view of one timer ward's config (undefined = not a timer). */
export function timerConfig(userId: number, ward: string): TimerConfig | undefined {
  return timerWards(userId).get(ward);
}

/** Step `i`'s length in ms, or the plain duration when there is no such step. */
export function durationFor(cfg: TimerConfig, i: number): number {
  const step = cfg.steps[i];
  return (step ? step.min * 60 : cfg.duration) * 1000;
}

function toState(row: TimerRow): TimerState {
  return { ward: row.ward, state: row.state, durationMs: row.duration_ms, endsAt: row.ends_at, remainingMs: row.remaining_ms, step: row.step };
}

/** Every timer ward in the layout, idle default for wards without a row. */
export function getTimers(userId: number): TimerState[] {
  const wards = timerWards(userId);
  const rows = getDb().prepare(`SELECT ${COLS} FROM timers WHERE user_id = ?`).all(userId) as TimerRow[];
  const byWard = new Map(rows.map((r) => [r.ward, r]));
  return [...wards].map(([ward, cfg]) => {
    const row = byWard.get(ward);
    return row ? toState(row) : { ward, state: 'idle' as const, durationMs: durationFor(cfg, 0), endsAt: null, remainingMs: null, step: 0 };
  });
}

export type TimerOp = 'start' | 'pause' | 'reset' | 'skip';
export type TimerOpResult = { ok: TimerState } | { error: 'not-a-timer' | 'bad-transition' };

/** State machine write. start: idle→the current step's duration (or override),
 *  paused→resume. pause: running only. reset: any→idle, step 0. skip: a
 *  running/paused routine step ends now (idle, step + 1) — the same write an
 *  expiry does; the engine treats the result as one. */
export function writeTimerOp(userId: number, ward: string, op: TimerOp, durationMs?: number): TimerOpResult {
  const cfg = timerWards(userId).get(ward);
  if (cfg === undefined) return { error: 'not-a-timer' };
  const db = getDb();
  const row = db.prepare(`SELECT ${COLS} FROM timers WHERE user_id = ? AND ward = ?`).get(userId, ward) as TimerRow | undefined;
  const cur = row?.state ?? 'idle';
  const now = Date.now();

  let next: TimerRow;
  if (op === 'start') {
    if (cur === 'running') return { error: 'bad-transition' };
    // From idle: the stored step, wrapped after a finished routine (and always 0 on a plain timer).
    let step = row?.step ?? 0;
    if (cur !== 'paused' && step >= cfg.steps.length) step = 0;
    const duration = durationMs ?? (cur === 'paused' ? row!.duration_ms : durationFor(cfg, step));
    const ms = cur === 'paused' && durationMs === undefined ? Math.max(row!.remaining_ms ?? 0, 1000) : duration;
    next = { ward, duration_ms: duration, state: 'running', ends_at: now + ms, remaining_ms: null, step };
  } else if (op === 'pause') {
    if (cur !== 'running') return { error: 'bad-transition' };
    next = { ward, duration_ms: row!.duration_ms, state: 'paused', ends_at: null, remaining_ms: Math.max((row!.ends_at ?? now) - now, 0), step: row!.step };
  } else if (op === 'skip') {
    if (cur === 'idle' || cfg.steps.length === 0) return { error: 'bad-transition' };
    next = { ward, duration_ms: row!.duration_ms, state: 'idle', ends_at: null, remaining_ms: null, step: row!.step + 1 };
  } else {
    next = { ward, duration_ms: durationFor(cfg, 0), state: 'idle', ends_at: null, remaining_ms: null, step: 0 };
  }

  db.prepare(
    `INSERT INTO timers (user_id, ward, duration_ms, state, ends_at, remaining_ms, step) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, ward) DO UPDATE SET duration_ms = excluded.duration_ms, state = excluded.state,
       ends_at = excluded.ends_at, remaining_ms = excluded.remaining_ms, step = excluded.step, updated_at = datetime('now')`
  ).run(userId, ward, next.duration_ms, next.state, next.ends_at, next.remaining_ms, next.step);
  return { ok: toState(next) };
}

/** Exactly-once expiry: flips running→idle only if ends_at still matches, so a
 *  raced mutation (restart, reset) makes the stale expiry a no-op. `advance`
 *  moves the routine on to the next step; a stale catch-up passes false so an
 *  hours-old routine idles on the step it was on. */
export function expireTimer(userId: number, ward: string, expectedEndsAt: number, advance = true): TimerState | null {
  const res = getDb()
    .prepare(
      `UPDATE timers SET state = 'idle', ends_at = NULL, remaining_ms = NULL, step = step + ?, updated_at = datetime('now')
       WHERE user_id = ? AND ward = ? AND state = 'running' AND ends_at = ?`
    )
    .run(advance ? 1 : 0, userId, ward, expectedEndsAt);
  if (res.changes !== 1) return null;
  const row = getDb().prepare(`SELECT ${COLS} FROM timers WHERE user_id = ? AND ward = ?`).get(userId, ward) as TimerRow;
  return toState(row);
}

/** All running timers across users — boot arming + restart catch-up. */
export function runningTimers(): { userId: number; ward: string; endsAt: number }[] {
  return (
    getDb().prepare(`SELECT user_id, ward, ends_at FROM timers WHERE state = 'running'`).all() as {
      user_id: number;
      ward: string;
      ends_at: number;
    }[]
  ).map((r) => ({ userId: r.user_id, ward: r.ward, endsAt: r.ends_at }));
}

export function deleteOrphanTimers(userId: number): string[] {
  const wards = timerWards(userId);
  const rows = getDb().prepare('SELECT ward FROM timers WHERE user_id = ?').all(userId) as { ward: string }[];
  const gone = rows.map((r) => r.ward).filter((t) => !wards.has(t));
  if (gone.length) {
    const del = getDb().prepare('DELETE FROM timers WHERE user_id = ? AND ward = ?');
    for (const t of gone) del.run(userId, t);
  }
  return gone;
}
