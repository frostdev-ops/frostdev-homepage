// The merged agenda — Google, Outlook, iCloud (CalDAV) and a Notion calendar
// database — shared by the /api/calendar route, the logic engine's calendar
// watchers and conditions, and the agent's list_calendar tool: one 5-min
// cache entry per source for all of them.

import { getLink } from './linked-accounts.ts';
import { googleCalendar, type CalEvent } from './google.ts';
import { outlookCalendar } from './microsoft.ts';
import { icloudCalendar } from './icloud.ts';
import { notionAgenda, notionCalendarDbId } from './notion.ts';

export type { CalEvent };
export type CalendarSource = CalEvent['source'];

/** THE calendar window. Engine callers use the default so everything shares
 *  one cache entry per provider — a different `days` doubles the API traffic. */
export const AGENDA_DAYS = 5;

const FETCH: Record<CalendarSource, (userId: number, days: number) => Promise<CalEvent[]>> = {
  google: googleCalendar,
  microsoft: outlookCalendar,
  icloud: icloudCalendar,
  notion: notionAgenda,
};

/** The sources this user has actually set up: the agenda's inputs, and what
 *  the "not linked" checks count. Notion counts only with a calendar database picked. */
export function calendarSources(userId: number): CalendarSource[] {
  const out: CalendarSource[] = [];
  if (getLink(userId, 'google')) out.push('google');
  if (getLink(userId, 'microsoft')) out.push('microsoft');
  if (getLink(userId, 'icloud')) out.push('icloud');
  if (getLink(userId, 'notion') && notionCalendarDbId(userId)) out.push('notion');
  return out;
}

export async function agenda(userId: number, days = AGENDA_DAYS): Promise<CalEvent[]> {
  const sources = calendarSources(userId);
  // An empty agenda must mean "genuinely nothing scheduled" — never "not
  // linked" or "everything failed": calendar-free-for would otherwise return
  // a confident "free" through your meetings, and the calendar watchers could
  // never surface a Reconnect chip.
  if (sources.length === 0) throw new Error('no calendar linked');
  const results = await Promise.allSettled(sources.map((s) => FETCH[s](userId, days)));
  const ok = results.filter((r): r is PromiseFulfilledResult<CalEvent[]> => r.status === 'fulfilled');
  if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason; // one dead provider tolerated; ALL dead surfaces
  return ok.flatMap((r) => r.value).sort((a, b) => a.start.localeCompare(b.start));
}

/** Google all-day events carry a naive "YYYY-MM-DDT00:00:00" — parsed as
 *  server-local, which is what "all day" means once TZ is set. Microsoft is Z. */
export const eventMs = (iso: string): number => Date.parse(iso);
