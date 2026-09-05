import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeXml, icsDate, parseCalendars, parseEvents, parseMultistatus, parseReport, tag, unfold } from '../src/lib/icloud.ts';
import { agenda, calendarSources } from '../src/lib/calendar.ts';
import { biggestGap } from '../src/lib/wards.ts';
import { storeLink } from '../src/lib/linked-accounts.ts';
import { createUser } from '../src/lib/users.ts';

// ------------------------------------------------------------ DAV parsing

const PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/</href>
    <propstat>
      <prop><current-user-principal><href>/123456789/principal/</href></current-user-principal></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

const HOME = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/123456789/calendars/</D:href>
    <D:propstat><D:prop><D:displayname>Home</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/123456789/calendars/inbox/</D:href>
    <D:propstat><D:prop><D:displayname>Inbox</D:displayname><D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/123456789/calendars/work/</D:href>
    <D:propstat><D:prop>
      <D:displayname>Work &amp; School</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/123456789/calendars/reminders/</D:href>
    <D:propstat><D:prop>
      <D:displayname>Reminders</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/123456789/calendars/personal/</D:href>
    <D:propstat><D:prop>
      <D:displayname>Personal</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><C:supported-calendar-component-set/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

const ICS_TIMED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:abc-1',
  'DTSTART:20260903T140000Z',
  'DTEND:20260903T150000Z',
  'SUMMARY:Standup\\, weekly',
  'LOCATION:Room 4',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/123456789/calendars/work/abc-1.ics</D:href>
    <D:propstat><D:prop><C:calendar-data>${ICS_TIMED.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/123456789/calendars/work/allday.ics</D:href>
    <D:propstat><D:prop><C:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:allday-1&#13;
DTSTART;VALUE=DATE:20260904&#13;
SUMMARY:Holiday&#13;
END:VEVENT&#13;
END:VCALENDAR</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

test('tag / decodeXml: prefix-agnostic, entities decoded', () => {
  assert.equal(tag('<D:displayname>Work &amp; School</D:displayname>', 'displayname'), 'Work &amp; School');
  assert.equal(tag('<displayname>x</displayname>', 'displayname'), 'x');
  assert.equal(tag('<a:href>/p/</a:href>', 'nope'), null);
  assert.equal(decodeXml('a &amp; b &lt;c&gt; &#13;&#x41;'), 'a & b <c> \rA');
});

test('parseMultistatus: the principal reply', () => {
  const rs = parseMultistatus(PRINCIPAL);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.href, '/');
  assert.equal(tag(tag(rs[0]!.xml, 'current-user-principal')!, 'href'), '/123456789/principal/');
});

test('parseCalendars: event calendars only — the home, inbox and a VTODO list are skipped', () => {
  const cals = parseCalendars(HOME, 'https://p42-caldav.icloud.com/123456789/calendars/');
  assert.deepEqual(cals, [
    { href: 'https://p42-caldav.icloud.com/123456789/calendars/work/', name: 'Work & School' },
    // No component set at all (404 propstat) is not a reason to skip.
    { href: 'https://p42-caldav.icloud.com/123456789/calendars/personal/', name: 'Personal' },
  ]);
});

test('parseReport + parseEvents: a UTC timed event and an all-day event', () => {
  const docs = parseReport(REPORT);
  assert.equal(docs.length, 2);
  const events = docs.flatMap(parseEvents);
  assert.deepEqual(events, [
    { id: 'abc-1', title: 'Standup, weekly', start: '2026-09-03T14:00:00Z', end: '2026-09-03T15:00:00Z', allDay: false, location: 'Room 4' },
    { id: 'allday-1', title: 'Holiday', start: '2026-09-04T00:00:00', end: '2026-09-05T00:00:00', allDay: true, location: '' },
  ]);
});

test('unfold + icsDate: continuation lines, TZID wall clock, DURATION, RECURRENCE-ID, cancelled', () => {
  assert.deepEqual(unfold('SUMMARY:a long\r\n  title\r\nUID:x'), ['SUMMARY:a long title', 'UID:x']);
  assert.deepEqual(icsDate('20260903T090000', 'TZID=America/New_York'), { iso: '2026-09-03T09:00:00', allDay: false });
  assert.deepEqual(icsDate('20260903', 'VALUE=DATE'), { iso: '2026-09-03T00:00:00', allDay: true });
  assert.equal(icsDate('tomorrow', ''), null);

  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:r-1',
    'RECURRENCE-ID:20260903T140000Z',
    'DTSTART;TZID="America/New_York":20260903T100000',
    'DURATION:PT1H30M',
    'SUMMARY:Lecture',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:gone',
    'DTSTART:20260903T160000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Cancelled thing',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:no-start',
    'SUMMARY:broken',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  const events = parseEvents(ics);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 'r-1/20260903T140000Z', title: 'Lecture', start: '2026-09-03T10:00:00', end: '2026-09-03T11:30:00', allDay: false, location: '' });
});

// --------------------------------------------------------------- agenda

test('agenda: nothing set up throws; an iCloud link is a source and its events merge in', async (t) => {
  const userId = createUser('cal@test.io', 'pw');
  assert.deepEqual(calendarSources(userId), []);
  await assert.rejects(agenda(userId), /no calendar linked/);

  storeLink({ userId, provider: 'icloud', label: 'me@icloud.com', refreshToken: 'app-pass', meta: {} });
  assert.deepEqual(calendarSources(userId), ['icloud']);

  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls: { url: string; method: string; depth: string | null }[] = [];
  const reply = (status: number, text: string, headers: Record<string, string> = {}) => ({
    status,
    headers: new Headers(headers),
    text: async () => text,
  });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = String(init.method);
    const depth = (init.headers as Record<string, string>).depth ?? null;
    calls.push({ url: String(url), method, depth });
    assert.match((init.headers as Record<string, string>).authorization, /^Basic /);
    // The root bounces to the pNN host, like iCloud does — the body must survive it.
    if (url === 'https://caldav.icloud.com/') return reply(301, '', { location: 'https://p42-caldav.icloud.com/' });
    if (url === 'https://p42-caldav.icloud.com/') return reply(207, PRINCIPAL);
    if (url === 'https://p42-caldav.icloud.com/123456789/principal/') {
      return reply(207, `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123456789/principal/</href><propstat><prop><C:calendar-home-set><href>/123456789/calendars/</href></C:calendar-home-set></prop></propstat></response></multistatus>`);
    }
    if (url === 'https://p42-caldav.icloud.com/123456789/calendars/') return reply(207, HOME);
    if (method === 'REPORT' && url.endsWith('/calendars/work/')) {
      assert.match(String(init.body), /<c:expand start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"\/>/);
      return reply(207, REPORT);
    }
    if (method === 'REPORT') return reply(207, '<multistatus xmlns="DAV:"></multistatus>');
    throw new Error(`unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;

  const events = await agenda(userId);
  assert.deepEqual(
    events.map((e) => [e.source, e.calendar, e.title, e.start]),
    [
      ['icloud', 'Work & School', 'Standup, weekly', '2026-09-03T14:00:00Z'],
      ['icloud', 'Work & School', 'Holiday', '2026-09-04T00:00:00'],
    ]
  );
  // Discovery: root (redirected), principal, home; then one REPORT per event calendar.
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.depth} ${c.url}`),
    [
      'PROPFIND 0 https://caldav.icloud.com/',
      'PROPFIND 0 https://p42-caldav.icloud.com/',
      'PROPFIND 0 https://p42-caldav.icloud.com/123456789/principal/',
      'PROPFIND 1 https://p42-caldav.icloud.com/123456789/calendars/',
      'REPORT 1 https://p42-caldav.icloud.com/123456789/calendars/work/',
      'REPORT 1 https://p42-caldav.icloud.com/123456789/calendars/personal/',
    ]
  );
});

// ------------------------------------------------------------- free today

test('biggestGap merges overlaps, ignores all-day and clips to the day end', () => {
  const d = (h: number, m = 0) => new Date(2026, 8, 2, h, m).toISOString();
  const now = new Date(2026, 8, 2, 12).getTime();
  const end = new Date(2026, 8, 2, 22).getTime();
  const ev = [
    { start: d(13), end: d(14), allDay: false },
    { start: d(13, 30), end: d(15), allDay: false }, // overlaps: no gap between 14:00 and 13:30
    { start: d(0), end: d(0), allDay: true }, // never busy
    { start: d(23), end: d(23, 30), allDay: false }, // past the day end
  ];
  assert.deepEqual(biggestGap(ev, now, end), { from: new Date(2026, 8, 2, 15).getTime(), to: end });
  assert.equal(biggestGap([ev[2]!], now, end), null);
  assert.deepEqual(biggestGap([{ start: d(11), end: d(23), allDay: false }], now, end), { from: now, to: now });
  // an empty end (a Notion row without one) drops out instead of poisoning the set
  assert.deepEqual(biggestGap([{ start: d(13), end: '', allDay: false }, { start: d(16), end: d(17), allDay: false }], now, end), { from: new Date(2026, 8, 2, 17).getTime(), to: end });
});
