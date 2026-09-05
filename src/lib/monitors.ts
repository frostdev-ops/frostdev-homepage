import type Database from 'better-sqlite3';
import { getDb } from './db.ts';
import { KINDS, setTargets, type Target } from './targets.ts';

// The monitor registry's storage. Every write reloads lib/targets.ts, which is
// what the engine, the validators and the pages read. Admins edit it on
// /admin/monitors or with `rimeward monitors`; `importTargets` takes the shape
// the old targets.json had.

const ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX = { label: 60, title: 40, url: 500, host: 253 };

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

export interface MonitorInput {
  id?: string;
  label?: string;
  /** An existing group id or title, or a new group's title. */
  group?: string;
  kind?: string;
  url?: string;
  method?: string;
  expect?: unknown;
  host?: string;
  port?: unknown;
  name?: string;
  container?: string;
  unit?: string;
}

interface Row {
  id: string;
  label: string;
  grp: string;
  kind: Target['kind'];
  spec: string;
}

const rowToTarget = (r: Row): Target => ({ id: r.id, label: r.label, group: r.grp, kind: r.kind, ...JSON.parse(r.spec) }) as Target;

function read(handle: Database.Database): { targets: Target[]; titles: Record<string, string> } {
  const groups = handle.prepare('SELECT id, title FROM monitor_groups ORDER BY position, rowid').all() as { id: string; title: string }[];
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const rows = handle.prepare('SELECT id, label, grp, kind, spec FROM monitors ORDER BY position, rowid').all() as Row[];
  // Group order first, then each group's own order — the dots wall's columns.
  rows.sort((a, b) => (order.get(a.grp) ?? 999) - (order.get(b.grp) ?? 999));
  return { targets: rows.map(rowToTarget), titles: Object.fromEntries(groups.map((g) => [g.id, g.title])) };
}

/** Called by db.ts the moment the database is open (after migrations). */
export function loadMonitors(handle: Database.Database): void {
  const { targets, titles } = read(handle);
  setTargets(targets, titles);
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The spec for a kind, validated; throws with the field named. */
function spec(kind: Target['kind'], input: MonitorInput): Record<string, unknown> {
  switch (kind) {
    case 'http': {
      const url = str(input.url, MAX.url);
      if (!/^https?:\/\/[^\s/?#]+/.test(url)) throw new Error('url: must start with http:// or https://');
      const out: Record<string, unknown> = { url };
      if (input.method === 'HEAD' || input.method === 'GET') out.method = input.method;
      if (input.expect !== undefined && input.expect !== '' && input.expect !== null) {
        const list = (Array.isArray(input.expect) ? input.expect : String(input.expect).split(',')).map((n) => Number(String(n).trim()));
        if (!list.length || list.length > 10 || !list.every((n) => Number.isInteger(n) && n >= 100 && n <= 599)) throw new Error('expect: status codes 100–599, comma-separated');
        out.expect = list;
      }
      return out;
    }
    case 'tcp': {
      const host = str(input.host, MAX.host);
      if (!/^[a-z0-9.:-]+$/i.test(host)) throw new Error('host: a hostname or address');
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port: 1–65535');
      return { host, port };
    }
    case 'pm2': {
      const name = str(input.name, 100);
      if (!/^[\w.@:-]+$/.test(name)) throw new Error('name: the pm2 process name');
      return { name };
    }
    case 'docker': {
      const container = str(input.container, 128);
      if (!/^[\w.-]+$/.test(container)) throw new Error('container: the container name');
      return { container };
    }
    case 'systemd': {
      const unit = str(input.unit, 150);
      if (!/^[\w.@:-]+$/.test(unit)) throw new Error('unit: the systemd unit name');
      return { unit };
    }
  }
}

/** An existing group by id or title, else a new one titled as typed. */
function resolveGroup(handle: Database.Database, text: string): string {
  const wanted = str(text, MAX.title);
  if (!wanted) throw new Error('group: required');
  const groups = handle.prepare('SELECT id, title FROM monitor_groups').all() as { id: string; title: string }[];
  const hit = groups.find((g) => g.id === wanted || g.title.toLowerCase() === wanted.toLowerCase());
  if (hit) return hit.id;
  const id = slug(wanted);
  if (!ID_RE.test(id)) throw new Error('group: needs a letter or a digit');
  const position = (handle.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM monitor_groups').get() as { n: number }).n;
  handle.prepare('INSERT INTO monitor_groups (id, title, position) VALUES (?, ?, ?)').run(id, wanted, position);
  return id;
}

/** Create or replace one monitor. The id is the slug of the label unless given. */
export function upsertMonitor(input: MonitorInput): Target {
  const handle = getDb();
  const label = str(input.label, MAX.label);
  if (!label) throw new Error('label: required');
  const id = input.id ? str(input.id, 32) : slug(label);
  if (!ID_RE.test(id)) throw new Error('id: letters, digits and dashes, up to 32');
  const kind = input.kind as Target['kind'];
  if (!KINDS.includes(kind)) throw new Error(`kind: one of ${KINDS.join(', ')}`);
  const s = spec(kind, input);
  const target = handle.transaction(() => {
    const grp = resolveGroup(handle, input.group ?? '');
    const existing = handle.prepare('SELECT position FROM monitors WHERE id = ?').get(id) as { position: number } | undefined;
    const position = existing?.position ?? (handle.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM monitors').get() as { n: number }).n;
    handle
      .prepare(
        `INSERT INTO monitors (id, label, grp, kind, spec, position) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, grp = excluded.grp, kind = excluded.kind, spec = excluded.spec`
      )
      .run(id, label, grp, kind, JSON.stringify(s), position);
    return { id, label, group: grp, kind, ...s } as Target;
  })();
  loadMonitors(handle);
  return target;
}

/** Remove one monitor; a group with nothing left in it goes too. */
export function deleteMonitor(id: string): boolean {
  const handle = getDb();
  const gone = handle.transaction(() => {
    const info = handle.prepare('DELETE FROM monitors WHERE id = ?').run(id);
    handle.prepare('DELETE FROM monitor_groups WHERE id NOT IN (SELECT DISTINCT grp FROM monitors)').run();
    return info.changes > 0;
  })();
  loadMonitors(handle);
  return gone;
}

/** The old targets.json shape: `{ groups: { id: title }, targets: [...] }`. Returns how many landed. */
export function importTargets(json: { groups?: Record<string, string>; targets?: unknown[] }): number {
  const handle = getDb();
  let n = 0;
  handle.transaction(() => {
    for (const [id, title] of Object.entries(json.groups ?? {})) {
      if (!ID_RE.test(id)) continue;
      const position = (handle.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM monitor_groups').get() as { n: number }).n;
      handle.prepare('INSERT INTO monitor_groups (id, title, position) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title').run(id, str(title, MAX.title) || id, position);
    }
  })();
  for (const raw of json.targets ?? []) {
    const t = raw as Record<string, unknown>;
    upsertMonitor({ ...(t as MonitorInput), group: String(t.group ?? ''), expect: t.expect });
    n++;
  }
  return n;
}
