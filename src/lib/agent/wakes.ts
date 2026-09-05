import { getDb } from '../db.ts';

// Scheduled agent wakes: "in 20 minutes, do X." The schedule_wake tool writes
// a row; the logic engine's minute tick calls runDueWakes(), which claims due
// rows atomically and runs the agent headless via core.ts. Minute granularity
// is the point — "later", not a realtime scheduler. Recurring work belongs to
// an 'every' logic edge with the agent.ask action, not to self-rescheduling.

export interface AgentWake {
  id: number;
  user_id: number;
  ward: string;
  conversation_id: number | null;
  instructions: string;
  run_at: number; // unix ms
  status: 'scheduled' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  result: string;
}

const MAX_ACTIVE = 20; // a self-rescheduling runaway stops here, not at infinity
const RUN_DEADLINE_MS = 15 * 60_000;
const STALE_RUNNING_MS = 60 * 60_000;

export function scheduleWake(userId: number, ward: string, instructions: string, inMinutes: number): AgentWake {
  const text = instructions.trim();
  if (!text) throw new Error('say what the wake should do');
  const m = Math.round(Number(inMinutes));
  if (!Number.isFinite(m) || m < 1 || m > 60 * 24 * 90) throw new Error('in_minutes must be between 1 and 129600 (90 days)');
  const db = getDb();
  const active = (
    db.prepare(`SELECT COUNT(*) AS n FROM agent_tasks WHERE user_id = ? AND status IN ('scheduled', 'running')`).get(userId) as { n: number }
  ).n;
  if (active >= MAX_ACTIVE) throw new Error(`too many scheduled wakes already (${MAX_ACTIVE}) — cancel some first`);
  const id = db
    .prepare('INSERT INTO agent_tasks (user_id, ward, instructions, run_at) VALUES (?, ?, ?, ?)')
    .run(userId, ward, text, Date.now() + m * 60_000).lastInsertRowid as number;
  return getWake(id)!;
}

export function getWake(id: number): AgentWake | null {
  return (getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as AgentWake | undefined) ?? null;
}

export function listWakes(userId: number): AgentWake[] {
  return getDb()
    .prepare(`SELECT * FROM agent_tasks WHERE user_id = ? AND status IN ('scheduled', 'running') ORDER BY run_at LIMIT 100`)
    .all(userId) as AgentWake[];
}

export function cancelWake(id: number, userId: number): boolean {
  return (
    getDb()
      .prepare(`UPDATE agent_tasks SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'scheduled'`)
      .run(id, userId).changes > 0
  );
}

/**
 * Claim and run everything due. Called from the logic engine's minute tick;
 * safe from anywhere (the claim is atomic, core's per-ward chain serializes).
 */
export async function runDueWakes(now = Date.now()): Promise<number> {
  const db = getDb();
  // Re-arm deploy casualties: 'running' with no finish for an hour means the
  // process died under the run. One retry (the wake prompt says to check what
  // already happened); a second interruption stops it — a third would be a
  // crash loop re-running writes every hour.
  db.prepare(
    `UPDATE agent_tasks SET status = CASE WHEN attempts >= 2 THEN 'failed' ELSE 'scheduled' END,
            result = CASE WHEN attempts >= 2 THEN 'interrupted twice — not retried; check what it managed first' ELSE result END,
            finished_at = CASE WHEN attempts >= 2 THEN datetime('now') ELSE finished_at END
      WHERE status = 'running' AND started_at < datetime('now', '-60 minutes')`
  ).run();

  const due = db
    .prepare(`SELECT id FROM agent_tasks WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at LIMIT 10`)
    .all(now) as { id: number }[];
  let claimed = 0;
  for (const { id } of due) {
    const got = db
      .prepare(`UPDATE agent_tasks SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ? AND status = 'scheduled'`)
      .run(id).changes;
    if (!got) continue;
    claimed++;
    void runOneWake(id);
  }
  return claimed;
}

async function runOneWake(id: number): Promise<void> {
  const db = getDb();
  const wake = getWake(id);
  if (!wake || wake.status !== 'running') return;
  // Only the run still holding the row may write its outcome — a run abandoned
  // at the deadline must not resurrect a row the sweep re-armed.
  const finish = (status: 'done' | 'failed', result: string) =>
    db
      .prepare(`UPDATE agent_tasks SET status = ?, result = ?, finished_at = datetime('now') WHERE id = ? AND status = 'running'`)
      .run(status, result.slice(0, 4000), id);

  // Late import: core.ts pulls the whole tool surface; a tick sweeping an
  // empty table never needs it.
  const { runHeadlessTurn } = await import('./core.ts');
  const prompt =
    `[Scheduled wake #${wake.id} — you set this yourself; it is now ${new Date().toISOString()}.]\n` +
    `Do this now: ${wake.instructions}\n` +
    `You are running unattended — nobody is watching or able to answer questions.` +
    (wake.attempts > 1
      ? ` A PREVIOUS ATTEMPT WAS INTERRUPTED PART-WAY (attempt ${wake.attempts}). Read back over this conversation and check what you already did before repeating anything — do not send or change the same thing twice.`
      : '') +
    ` End with a short summary of what happened.`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const reply = await runHeadlessTurn(wake.user_id, wake.ward, prompt, {
      kind: 'wake',
      wakeId: wake.id,
      // The turn serializes behind whatever else this ward is doing. Arming
      // the deadline at claim time would fail a wake for someone ELSE's queue
      // wait — and it would then run anyway, its result thrown away against a
      // row that already said 'failed'.
      // ponytail: the deadline marks the row; the turn itself has no
      // AbortSignal and keeps burning until its provider call ends.
      onStart: () => {
        timer = setTimeout(() => {
          expired = true;
          finish('failed', 'still running after 15 minutes — released');
        }, RUN_DEADLINE_MS);
      },
    });
    if (!expired) finish('done', reply);
  } catch (err) {
    if (!expired) finish('failed', err instanceof Error ? err.message : 'wake failed');
  } finally {
    clearTimeout(timer);
  }
}

export { STALE_RUNNING_MS };
