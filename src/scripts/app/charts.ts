// Chart wards: a data-source registry feeding TanStack Charts through the
// vanilla DOM host. Every @tanstack/charts touchpoint lives in this file.
// Adding a data source = one SOURCES entry here + one CHART_SOURCES entry in
// src/lib/wards.ts (which validates it server-side).

import { areaY, barY, defineChart, lineY } from '@tanstack/charts';
import { mountChart } from '@tanstack/charts/dom';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { tooltip } from '@tanstack/charts/tooltip';
import { wardTitle, type ChartConfig, type WardInstance } from '../../lib/wards.ts';
import { RENDERERS, body, getJson, note } from './wards.ts';

// x is epoch ms: this version's scale factories are numeric-only (a Date
// domain throws), so time formatting happens in tick/tooltip formatters.
interface Row {
  x: number;
  y: number;
}

interface DataSource {
  yLabel: (cfg: ChartConfig) => string;
  fetch: (cfg: ChartConfig) => Promise<Row[] | null>;
}

async function historyRows(
  service: string,
  hours: number,
  map: (r: { t: string; ok: number | null; ms: number | null }) => number | null
): Promise<Row[] | null> {
  const { status, data } = await getJson(`/api/status/history?service=${encodeURIComponent(service)}&hours=${hours}`);
  if (status !== 200 || !Array.isArray(data)) return null;
  const rows: Row[] = [];
  for (const r of data) {
    const y = map(r);
    // checked_at is UTC without a Z suffix — append it or Date parses local.
    if (y !== null) rows.push({ x: Date.parse(r.t.replace(' ', 'T') + 'Z'), y });
  }
  return rows;
}

const SOURCES: Record<ChartConfig['source'], DataSource> = {
  status: {
    yLabel: (cfg) => (cfg.metric === 'uptime' ? 'up %' : 'ms'),
    fetch: (cfg) =>
      historyRows(cfg.service!, cfg.hours, (r) => (cfg.metric === 'uptime' ? (r.ok === null ? null : r.ok * 100) : r.ms)),
  },
  host: {
    yLabel: () => '%',
    fetch: (cfg) => historyRows(`host:${cfg.service}`, cfg.hours, (r) => r.ms),
  },
  weather: {
    yLabel: (cfg) => (cfg.metric === 'precip' ? 'precip %' : '°F'),
    fetch: async (cfg) => {
      const { status, data } = await getJson('/api/weather');
      if (status !== 200 || !Array.isArray(data?.hourly)) return null;
      return (data.hourly as { t: string; tempF: number; precipPct: number }[]).map((h) => ({
        x: Date.parse(h.t),
        y: cfg.metric === 'precip' ? h.precipPct : h.tempF,
      }));
    },
  },
};

interface Mounted {
  update: (options: never) => void;
  destroy: () => void;
}
const hosts = new Map<string, Mounted>();

function markFor(chart: ChartConfig['chart'], rows: Row[]) {
  const channels = { x: 'x', y: 'y' } as const;
  if (chart === 'area') return areaY(rows, channels);
  if (chart === 'bars') return barY(rows, channels);
  return lineY(rows, channels);
}

function buildOptions(w: WardInstance, cfg: ChartConfig, rows: Row[], height: number) {
  // Tick granularity follows the actual data span, not the requested window.
  const spanMs = rows[rows.length - 1]!.x - rows[0]!.x;
  const fmtTick = (ms: number) => {
    const d = new Date(ms);
    if (spanMs <= 3 * 3_600_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (spanMs <= 26 * 3_600_000) return d.toLocaleTimeString([], { hour: 'numeric' });
    return d.toLocaleDateString([], { weekday: 'short' });
  };
  const unit = SOURCES[cfg.source].yLabel(cfg);
  const definition = defineChart({
    marks: [markFor(cfg.chart, rows)],
    scales: {
      x: { scale: scaleLinear, axis: { ticks: { format: fmtTick, count: 5 } } },
      y: { scale: scaleLinear, nice: true, grid: true, axis: { label: unit } },
    },
    tooltip: {
      use: tooltip,
      format: (p: { datum?: Row }) =>
        p.datum
          ? `${new Date(p.datum.x).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${Math.round(p.datum.y * 10) / 10} ${unit}`
          : '',
    },
  } as never);
  return { definition, height: Math.max(height, 120), ariaLabel: `${wardTitle(w)} chart` } as never;
}

async function renderChart(w: WardInstance): Promise<void> {
  const b = body(w.i);
  if (!b) return;
  const cfg = w.config as unknown as ChartConfig | undefined;
  const source = cfg && SOURCES[cfg.source];
  if (!cfg || !source) {
    note(w.i, 'Chart not configured.');
    return;
  }
  const rows = await source.fetch(cfg).catch(() => null);
  if (!rows || rows.length < 2) {
    hosts.get(w.i)?.destroy();
    hosts.delete(w.i);
    note(w.i, rows ? 'Not enough data yet.' : 'Chart data unavailable.');
    return;
  }
  const options = buildOptions(w, cfg, rows, b.clientHeight);
  const existing = hosts.get(w.i);
  if (existing && b.querySelector('svg')) {
    existing.update(options);
    return;
  }
  existing?.destroy();
  b.textContent = '';
  b.classList.remove('overflow-y-auto');
  hosts.set(w.i, mountChart(b, options) as Mounted);
}

RENDERERS.chart = {
  // One cadence for all sources; the fetch is cheap and update() diffs.
  intervalMs: 60_000,
  render: renderChart,
};
