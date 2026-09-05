// The monitored-service list lives in targets.json beside this file — yours,
// not the repo's (gitignored; targets.example.json is the shape). The app
// runs ON the box it monitors: localhost probes and pm2/docker/systemctl reads
// are local; public vhosts are probed through the full proxy chain, which is
// the point. Changes ship with a deploy.
import raw from './targets.json' with { type: 'json' };

export type Target =
  | { id: string; label: string; group: string; kind: 'http'; url: string; method?: 'HEAD' | 'GET'; expect?: number[] }
  | { id: string; label: string; group: string; kind: 'tcp'; host: string; port: number }
  | { id: string; label: string; group: string; kind: 'pm2'; name: string }
  | { id: string; label: string; group: string; kind: 'docker'; container: string }
  | { id: string; label: string; group: string; kind: 'systemd'; unit: string };

export const TARGETS: Target[] = raw.targets as Target[];
/** In first-seen order — the dots wall's columns and the default layout's wards. */
export const GROUPS: readonly string[] = [...new Set(TARGETS.map((t) => t.group))];
/** Display titles per group; a group without one shows its id. */
export const GROUP_TITLES: Record<string, string> = { ...((raw as { groups?: Record<string, string> }).groups ?? {}) };
