// The Database ward's calendar view: a Sunday-first month grid (Notion's own),
// one date column (`config.date`, else the schema's Date/When/Start/Due), every
// row a card spanning the days its value covers, with the chosen columns as
// chips under the title. Reads a date window through
// /api/notion/source?from&to (its own cache entry — never the shared rows read).

import type { WardInstance } from '../../lib/wards.ts';
import { calendarChips, dateSpan, monthCells } from '../../lib/wards.ts';
import type { PropValue } from '../../lib/notion-props.ts';
import { body, handled, note } from './wards.ts';
import { busy, el, getJson, reducedMotion } from './dom.ts';
import { icon } from './icon.ts';
import { propView, type OptionSpec } from './notion-view.ts';
import { pickDbNote } from './logic.ts';

interface Row {
  id: string;
  url: string;
  icon: string;
  props: Record<string, PropValue>;
}
interface Schema {
  title?: string;
  props: ({ name: string; type: string } & OptionSpec)[];
}

/** Which month each ward is showing, 'YYYY-MM'; absent = this month. */
const shown = new Map<string, string>();
/** Which way the last nav went, for the slide; cleared once drawn. */
const slid = new Map<string, -1 | 1>();
/** Week row height the user dragged to, px, per ward.
 *  ponytail: localStorage — move to the ward's config when it should follow the account. */
const heightKey = (ward: string) => `fd-ncal-h:${ward}`;
const savedHeight = (ward: string): number => {
  try {
    return Number(localStorage.getItem(heightKey(ward))) || 0;
  } catch {
    return 0;
  }
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function renderNotionCalendar(w: WardInstance): Promise<void> {
  const pre = body(w.i);
  if (!pre || busy(pre)) return;
  const cfg = (w.config ?? {}) as Record<string, unknown>;
  const ym = shown.get(w.i) ?? today().slice(0, 7);
  const [year, month0] = [Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1];
  const cells = monthCells(year, month0);
  const qs = new URLSearchParams({ ward: w.i, rows: '1', from: cells[0]!, to: cells[41]! });
  if (typeof cfg.date === 'string') qs.set('date', cfg.date);
  const { status, data } = await getJson(`/api/notion/source?${qs}`);
  if (handled(w.i, 'notion', status)) return;
  const b = body(w.i);
  if (!b || busy(b)) return;
  if (data?.needsConfig) return pickDbNote(w, b);
  if (status !== 200) return note(w.i, String(data?.error ?? 'Notion unavailable.').slice(0, 140));

  const schema = (data?.schema ?? { props: [] }) as Schema;
  const specs = new Map(schema.props.map((p) => [p.name, p]));
  const titleName = schema.props.find((p) => p.type === 'title')?.name ?? '';
  const dateName = String(data?.date ?? '');
  const chipNames = calendarChips(schema.props, Array.isArray(cfg.props) ? (cfg.props as string[]) : undefined, titleName, dateName);
  const rows = (data?.rows ?? []) as Row[];
  const spans = rows.flatMap((r) => {
    const span = dateSpan(r.props[dateName]?.value as { start?: string; end?: string } | undefined);
    return span && span[1] >= cells[0]! && span[0] <= cells[41]! ? [{ r, a: span[0], b: span[1] }] : [];
  });

  b.textContent = '';
  const root = el('div', 'ncal');
  // ---- header: month, ‹ today ›
  const head = el('div', 'ncal-head');
  head.append(el('span', 'ncal-title', new Date(year, month0, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })));
  const nav = el('span', 'ncal-nav');
  const go = (label: string, target: string | null, dir: -1 | 1, glyph?: HTMLElement) => {
    const btn = el('button', 'btn min-h-0 px-1.5 py-0.5 text-[10px]');
    btn.type = 'button';
    btn.title = label;
    btn.append(glyph ?? label);
    btn.addEventListener('click', () => {
      if (target) shown.set(w.i, target);
      else shown.delete(w.i);
      slid.set(w.i, dir);
      void renderNotionCalendar(w);
    });
    return btn;
  };
  const shift = (n: number) => {
    const d = new Date(year, month0 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  nav.append(go('Previous month', shift(-1), -1, icon('left')), go('Today', null, ym < today().slice(0, 7) ? 1 : -1), go('Next month', shift(1), 1, icon('right')));
  head.append(nav);
  root.append(head);
  // ---- weekday row
  const dow = el('div', 'ncal-dow');
  for (const d of DOW) dow.append(el('span', '', d));
  root.append(dow);
  // ---- weeks: day numbers on row 1, cards in lanes below, spanning columns
  const weeks = el('div', 'ncal-weeks');
  const saved = savedHeight(w.i);
  if (saved) weeks.style.setProperty('--ncal-wk', `${saved}px`);
  const now = today();
  const lastWeek = spans.some((s) => s.b >= cells[35]!) || cells[35]!.slice(0, 7) === ym ? 6 : 5;
  for (let wk = 0; wk < lastWeek; wk++) {
    const days = cells.slice(wk * 7, wk * 7 + 7);
    const week = el('div', 'ncal-week');
    days.forEach((day, i) => {
      const cell = el('span', 'ncal-day');
      cell.style.gridColumn = String(i + 1);
      if (day.slice(0, 7) !== ym) cell.dataset.other = '';
      if (day === now) cell.dataset.today = '';
      const n = Number(day.slice(8));
      cell.append(el('span', '', n === 1 ? new Date(`${day}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) : String(n)));
      week.append(cell);
    });
    const lanes: string[] = []; // last day taken per lane
    const inWeek = spans.filter((s) => s.b >= days[0]! && s.a <= days[6]!).sort((x, y) => x.a.localeCompare(y.a) || y.b.localeCompare(x.b));
    for (const s of inWeek) {
      const from = s.a < days[0]! ? 0 : days.indexOf(s.a);
      const to = s.b > days[6]! ? 6 : days.indexOf(s.b);
      let lane = lanes.findIndex((end) => end < days[from]!);
      if (lane < 0) lane = lanes.push('') - 1;
      lanes[lane] = days[to]!;
      const card = el('div', 'ncal-ev');
      card.style.gridColumn = `${from + 1} / ${to + 2}`;
      card.style.gridRow = String(lane + 2);
      if (s.a < days[0]!) card.dataset.contL = '';
      if (s.b > days[6]!) card.dataset.contR = '';
      const title = el('a', 'ncal-ev-title', `${s.r.icon ? `${s.r.icon} ` : ''}${s.r.props[titleName]?.text || '(untitled)'}`);
      if (s.r.url) {
        title.href = s.r.url;
        title.target = '_blank';
        title.rel = 'noreferrer';
      }
      title.title = title.textContent ?? '';
      card.append(title);
      for (const name of chipNames) {
        const pv = s.r.props[name];
        if (!pv?.text) continue;
        const v = propView(pv, specs.get(name));
        v.title = `${name}: ${pv.text}`;
        card.append(v);
      }
      week.append(card);
    }
    week.append(grip(weeks, w.i));
    weeks.append(week);
  }
  root.append(weeks);
  b.append(root);
  const dir = slid.get(w.i);
  slid.delete(w.i);
  if (dir && !reducedMotion()) weeks.animate([{ opacity: 0, transform: `translateX(${dir * 12}px)` }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
}

/** The drag strip under a week: every week shares one min-height, so dragging
 *  any of them resizes the days; the height persists per ward. */
function grip(weeks: HTMLElement, ward: string): HTMLElement {
  const g = el('span', 'ncal-grip');
  g.title = 'Drag to resize the weeks';
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const week = g.parentElement!;
    const startH = week.getBoundingClientRect().height;
    const startY = e.clientY;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = Math.max(40, Math.round(startH + ev.clientY - startY));
      weeks.style.setProperty('--ncal-wk', `${h}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      try {
        localStorage.setItem(heightKey(ward), String(h));
      } catch {
        /* private mode */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  return g;
}
