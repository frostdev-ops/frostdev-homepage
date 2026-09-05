// The monitor registry: what the status engine probes, and what a Services
// ward, a launcher's status dot, a chart or a leyline may name. The rows live
// in the monitors table — lib/monitors.ts loads them the moment the database
// opens and after every edit (the admin page, the CLI); the dashboard page
// inlines the same list for the client. Mutated IN PLACE, so every module that
// imported these bindings sees the current registry. Pure: ships to the client.

export type Target =
  | { id: string; label: string; group: string; kind: 'http'; url: string; method?: 'HEAD' | 'GET'; expect?: number[] }
  | { id: string; label: string; group: string; kind: 'tcp'; host: string; port: number }
  | { id: string; label: string; group: string; kind: 'pm2'; name: string }
  | { id: string; label: string; group: string; kind: 'docker'; container: string }
  | { id: string; label: string; group: string; kind: 'systemd'; unit: string };

export const KINDS = ['http', 'tcp', 'pm2', 'docker', 'systemd'] as const;

export const TARGETS: Target[] = [];
/** In first-seen order — the dots wall's columns. */
export const GROUPS: string[] = [];
/** Display titles per group id; a group without one shows its id. */
export const GROUP_TITLES: Record<string, string> = {};

export function setTargets(list: Target[], titles: Record<string, string> = {}): void {
  TARGETS.splice(0, TARGETS.length, ...list);
  GROUPS.splice(0, GROUPS.length, ...new Set(list.map((t) => t.group)));
  for (const k of Object.keys(GROUP_TITLES)) delete GROUP_TITLES[k];
  Object.assign(GROUP_TITLES, titles);
}

/** What a monitor watches, in one line. */
export function describeTarget(t: Target): string {
  switch (t.kind) {
    case 'http':
      return `${t.method ?? 'GET'} ${t.url}${t.expect ? ` → ${t.expect.join('|')}` : ''}`;
    case 'tcp':
      return `${t.host}:${t.port}`;
    case 'pm2':
      return `pm2 ${t.name}`;
    case 'docker':
      return `docker ${t.container}`;
    case 'systemd':
      return `systemd ${t.unit}`;
  }
}

// In the browser the page inlined the registry (AppLayout) before any module ran.
if (typeof document !== 'undefined') {
  try {
    const raw = document.getElementById('fd-monitors')?.textContent;
    if (raw) {
      const j = JSON.parse(raw) as { targets: Target[]; titles: Record<string, string> };
      setTargets(j.targets, j.titles);
    }
  } catch {}
}
