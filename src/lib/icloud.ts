import { getLink, storeLink, ReconnectError } from './linked-accounts.ts';
import { openToken } from './crypto.ts';
import { cached } from './cache.ts';
import type { CalEvent } from './google.ts';

// iCloud Calendar over CalDAV (RFC 4791). Apple has no OAuth that grants
// calendar data — Sign in with Apple is identity only — so this is the Apple
// ID plus an app-specific password, stored the way the generic mailbox is: the
// password sealed into refresh_token_enc, the discovered calendar home in
// meta_json. The host is a constant, so nothing user-typed ever reaches a URL
// and no net-guard is needed. Zero dependencies: the DAV replies are shaped
// well enough for a handful of regexes, and the ICS parser only needs the six
// properties an agenda shows.

export const ICLOUD = 'https://caldav.icloud.com';

interface Creds {
  user: string;
  pass: string;
}

// ------------------------------------------------------------------ wire

/** One DAV request. fetch() drops a PROPFIND/REPORT body when it follows a
 *  redirect, and iCloud bounces every request to its pNN-caldav host, so
 *  redirects are followed by hand with the method and body intact. */
async function dav(creds: Creds, url: string, method: string, depth: string, body: string, hops = 0): Promise<{ text: string; url: string }> {
  // The Basic header IS the Apple ID password: it goes to Apple's hosts and
  // nowhere else, whatever a redirect or a discovered href says.
  if (!/(^|\.)icloud\.com$/i.test(new URL(url).hostname)) throw new Error(`icloud: refusing to send credentials to ${new URL(url).hostname}`);
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`,
      'content-type': 'application/xml; charset=utf-8',
      depth,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) {
    if (hops >= 3) throw new Error('icloud: too many redirects');
    return dav(creds, new URL(loc, url).href, method, depth, body, hops + 1);
  }
  if (res.status === 401 || res.status === 403) throw new ReconnectError('icloud');
  const text = await res.text();
  if (res.status >= 400) throw new Error(`icloud ${method} ${res.status}: ${text.slice(0, 200)}`);
  return { text, url };
}

// ------------------------------------------------------------ XML (DAV)

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()] ?? '';
  });
}

/** Inner text of the first `<x:name>…</x:name>` (any prefix, or none); null when absent. */
export function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1]! : null;
}

/** Is an element `<x:name/>` (or open tag) present? Anchored so `calendar`
 *  never matches `calendar-proxy-read`. */
const hasEl = (xml: string, name: string): boolean => new RegExp(`<(?:\\w+:)?${name}[\\s/>]`).test(xml);

export interface DavResponse {
  href: string;
  xml: string;
}

/** Every `<response>` of a multistatus, with its href decoded. */
export function parseMultistatus(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?response>/g)) {
    const href = tag(m[1]!, 'href');
    if (href !== null) out.push({ href: decodeXml(href.trim()), xml: m[1]! });
  }
  return out;
}

/** The href inside a property like current-user-principal / calendar-home-set. */
function hrefIn(xml: string, prop: string): string | null {
  const inner = tag(xml, prop);
  const href = inner === null ? null : tag(inner, 'href');
  return href ? decodeXml(href.trim()) : null;
}

export interface IcloudCalendar {
  href: string;
  name: string;
}

/** The event calendars in a calendar-home listing: collections that are
 *  calendars (not the home, the schedule inbox/outbox or the notification
 *  collection) and hold VEVENTs (not reminder lists). */
export function parseCalendars(xml: string, base: string): IcloudCalendar[] {
  const out: IcloudCalendar[] = [];
  for (const r of parseMultistatus(xml)) {
    if (!hasEl(tag(r.xml, 'resourcetype') ?? '', 'calendar')) continue;
    const comps = tag(r.xml, 'supported-calendar-component-set');
    // An empty element is the 404 propstat for a server that doesn't say — keep it.
    if (comps && !/VEVENT/.test(comps)) continue;
    out.push({ href: new URL(r.href, base).href, name: decodeXml(tag(r.xml, 'displayname') ?? '').trim() || 'Calendar' });
  }
  return out;
}

/** The ICS documents in a calendar-query REPORT reply. */
export function parseReport(xml: string): string[] {
  return parseMultistatus(xml)
    .map((r) => tag(r.xml, 'calendar-data'))
    .filter((s): s is string => !!s)
    .map(decodeXml);
}

// -------------------------------------------------------------------- ICS

export interface IcsEvent {
  id: string;
  title: string;
  /** ISO. UTC when the server said so, else naive local — see calendar.ts eventMs. */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
}

/** RFC 5545 §3.1: a CRLF followed by a space or tab continues the line. */
export const unfold = (ics: string): string[] => ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

/** `NAME;PARAM=V:value` — the first colon outside double quotes splits it. */
function splitLine(line: string): { name: string; params: string; value: string } | null {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) {
      const head = line.slice(0, i);
      const semi = head.indexOf(';');
      return { name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(), params: semi < 0 ? '' : head.slice(semi + 1), value: line.slice(i + 1) };
    }
  }
  return null;
}

const unescapeText = (v: string): string => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** `20260902T140000Z` → `2026-09-02T14:00:00Z`; `20260902` → `2026-09-02T00:00:00`
 *  (the naive all-day form Google events use); a TZID or floating time keeps
 *  its wall clock and is read as server-local — with `expand` iCloud hands
 *  instances back in UTC, so this is the rare non-recurring outlier. */
export function icsDate(value: string, params: string): { iso: string; allDay: boolean } | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] || /VALUE=DATE(?![-\w])/i.test(params)) return { iso: `${date}T00:00:00`, allDay: true };
  return { iso: `${date}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`, allDay: false };
}

/** `PT1H30M` / `P1D` → ms. Weeks and seconds too; anything else is 0. */
function durationMs(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = (+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86_400_000 + +(m[4] ?? 0) * 3_600_000 + +(m[5] ?? 0) * 60_000 + +(m[6] ?? 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/** Shift a naive-or-UTC ISO string by ms, keeping its form. */
function shiftIso(iso: string, ms: number): string {
  const utc = iso.endsWith('Z');
  const d = new Date(utc ? iso : `${iso}Z`); // treat naive as UTC for the arithmetic only
  const out = new Date(d.getTime() + ms).toISOString().slice(0, 19);
  return utc ? `${out}Z` : out;
}

/** Every VEVENT in an ICS document, expanded instances included (they share a
 *  UID and differ by RECURRENCE-ID). Cancelled events are skipped. */
export function parseEvents(ics: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let ev: Record<string, { params: string; value: string }> | null = null;
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') {
      ev = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (ev) {
        const e = toEvent(ev);
        if (e) out.push(e);
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const p = splitLine(line);
    if (p && !(p.name in ev)) ev[p.name] = { params: p.params, value: p.value };
  }
  return out;
}

function toEvent(p: Record<string, { params: string; value: string }>): IcsEvent | null {
  if (/^CANCELLED$/i.test(p.STATUS?.value.trim() ?? '')) return null;
  const start = p.DTSTART ? icsDate(p.DTSTART.value, p.DTSTART.params) : null;
  if (!start) return null;
  let end = p.DTEND ? icsDate(p.DTEND.value, p.DTEND.params)?.iso : undefined;
  if (!end && p.DURATION) end = shiftIso(start.iso, durationMs(p.DURATION.value));
  if (!end) end = start.allDay ? shiftIso(start.iso, 86_400_000) : start.iso;
  const uid = p.UID?.value.trim() || start.iso;
  const rid = p['RECURRENCE-ID']?.value.trim();
  return {
    id: rid ? `${uid}/${rid}` : uid,
    title: unescapeText(p.SUMMARY?.value ?? '').trim(),
    start: start.iso,
    end,
    allDay: start.allDay,
    location: unescapeText(p.LOCATION?.value ?? '').trim(),
  };
}

// -------------------------------------------------------------- discovery

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`;

interface Home {
  home: string;
  calendars: IcloudCalendar[];
}

/** Root → principal → calendar home → its event calendars. Three round trips
 *  (each redirected once by iCloud), so callers cache the result. */
async function discover(creds: Creds): Promise<Home> {
  const r1 = await dav(creds, `${ICLOUD}/`, 'PROPFIND', '0', PROPFIND_PRINCIPAL);
  const principal = hrefIn(r1.text, 'current-user-principal');
  if (!principal) throw new Error('icloud: no principal in the CalDAV reply');
  const r2 = await dav(creds, new URL(principal, r1.url).href, 'PROPFIND', '0', PROPFIND_HOME);
  const homeHref = hrefIn(r2.text, 'calendar-home-set');
  if (!homeHref) throw new Error('icloud: no calendar home in the CalDAV reply');
  const home = new URL(homeHref, r2.url).href;
  const r3 = await dav(creds, home, 'PROPFIND', '1', PROPFIND_CALENDARS);
  return { home, calendars: parseCalendars(r3.text, home) };
}

// ----------------------------------------------------------------- events

/** RFC 4791 date-time: `20260902T140000Z`. */
const stamp = (d: Date): string => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

/** A calendar-query over [start, end) with `expand`, so recurring events come
 *  back as concrete instances (in UTC) rather than one master + RRULE. */
function reportXml(start: Date, end: Date): string {
  const s = stamp(start);
  const e = stamp(end);
  return (
    `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter>` +
    `</c:calendar-query>`
  );
}

function credsOf(userId: number): Creds {
  const link = getLink(userId, 'icloud');
  if (!link) throw new ReconnectError('icloud');
  try {
    return { user: link.account_label, pass: openToken(link.refresh_token_enc) };
  } catch {
    throw new ReconnectError('icloud');
  }
}

/** Both cache keys sit under `icloud:<uid>:` so one invalidate clears them. */
export function icloudCalendar(userId: number, days: number): Promise<CalEvent[]> {
  return cached(`icloud:${userId}:agenda:${days}`, 5 * 60_000, async () => {
    const creds = credsOf(userId);
    const { calendars } = await cached(`icloud:${userId}:home`, 3600_000, () => discover(creds));
    const now = new Date();
    const body = reportXml(now, new Date(now.getTime() + days * 86_400_000));
    const per = await Promise.all(
      calendars.map(async (cal) => {
        const r = await dav(creds, cal.href, 'REPORT', '1', body);
        return parseReport(r.text)
          .flatMap(parseEvents)
          .map((e): CalEvent => ({ ...e, source: 'icloud', calendar: cal.name }));
      })
    );
    return per.flat().sort((a, b) => a.start.localeCompare(b.start));
  });
}

/** Store (or replace) the iCloud link. Discovery runs FIRST, so a wrong Apple
 *  ID / password fails the form with a sentence instead of a dead link. An
 *  empty password keeps the stored one (the mailbox precedent). */
export async function storeIcloud(userId: number, appleId: string, password: string): Promise<void> {
  const existing = getLink(userId, 'icloud');
  const pass = password || (existing ? openToken(existing.refresh_token_enc) : '');
  if (!pass) throw new Error('an app-specific password is required');
  let found: Home;
  try {
    found = await discover({ user: appleId, pass });
  } catch (err) {
    if (err instanceof ReconnectError) throw new Error('Apple rejected that Apple ID / app-specific password');
    throw err;
  }
  if (!found.calendars.length) throw new Error('iCloud answered, but no event calendars were found on that account');
  storeLink({ userId, provider: 'icloud', label: appleId, refreshToken: pass, meta: { home: found.home } });
}
