import type { APIRoute } from 'astro';
import { jsonBody, needId, needStr, notionRoute } from '../../../lib/notion-route.ts';
import {
  notionCreateSource,
  notionDataSources,
  notionDated,
  notionQuery,
  notionRows,
  notionSourceId,
  notionSourceSchema,
  notionUpdateSource,
  pickDateProp,
  taskWardRef,
} from '../../../lib/notion.ts';
import { buildFilter, type FilterSpec } from '../../../lib/notion-filter.ts';

export const prerender = false;

/** A data source: its columns, and optionally its rows.
 *  ?db= resolves a database id to its lists first (everything the app stored
 *  before the 2026-03-11 upgrade is a database id). ?ward= resolves a database
 *  ward's stored config instead — the same resolution /api/checklist uses,
 *  account-level tasks db fallback included; no db yet → { needsConfig }. */
export const GET: APIRoute = ({ url, locals }) =>
  notionRoute(locals.user!.userId, 'notion source', async () => {
    const userId = locals.user!.userId;
    const ward = url.searchParams.get('ward');
    let db = url.searchParams.get('db');
    let ds = url.searchParams.get('ds');
    if (ward) {
      const ref = taskWardRef(userId, ward);
      if (!ref) return { needsConfig: true };
      db = ref.db;
      ds = ref.ds ?? null;
    }
    const sourceId = ds ? needId(ds, 'data source id') : await notionSourceId(userId, needId(db, 'database id'));
    const [schema, sources] = await Promise.all([
      notionSourceSchema(userId, sourceId),
      db ? notionDataSources(userId, needId(db, 'database id')).catch(() => []) : Promise.resolve([]),
    ]);
    if (url.searchParams.get('rows') !== '1') return { schema, sources };
    // A calendar window: ?from=&to= (YYYY-MM-DD, at most 62 days) on ?date=,
    // or the schema's own date column — its own cache entry per window.
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from && to) {
      const want = url.searchParams.get('date') ?? '';
      const date = schema.types[want]?.type === 'date' ? want : pickDateProp(schema)?.name;
      if (!date) throw Object.assign(new Error(`"${schema.title || 'this database'}" has no date column`), { status: 400 });
      if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 62 * 86_400_000) throw Object.assign(new Error('window too wide'), { status: 400 });
      return { schema, sources, date, rows: await notionDated(userId, sourceId, date, from, to) };
    }
    // The shared cached read; a filtered view is the client's job, exactly as
    // it is for the task wards (see CLAUDE.md).
    return { schema, sources, rows: await notionRows(userId, sourceId) };
  });

interface PostBody {
  ds?: string;
  db?: string;
  /** Create another list inside a database. */
  newList?: string;
  /** An ad-hoc filtered/sorted read that must NOT touch the shared cache. */
  filter?: FilterSpec[];
  sort?: { property?: string; direction?: string };
  max?: number;
}

export const POST: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion source query', async () => {
    const userId = locals.user!.userId;
    const body = await jsonBody<PostBody>(request);
    if (body.newList) {
      return notionCreateSource(userId, needId(body.db, 'database id'), needStr(body.newList, 'a list name', 200));
    }
    const sourceId = body.ds ? needId(body.ds, 'data source id') : await notionSourceId(userId, needId(body.db, 'database id'));
    const schema = await notionSourceSchema(userId, sourceId);
    const filter = buildFilter(schema.types, Array.isArray(body.filter) ? body.filter : []);
    const direction = body.sort?.direction === 'descending' ? 'descending' : 'ascending';
    const sortProp = typeof body.sort?.property === 'string' && schema.types[body.sort.property] ? body.sort.property : undefined;
    return {
      schema,
      rows: await notionQuery(userId, sourceId, {
        ...(filter ? { filter } : {}),
        ...(sortProp ? { sorts: [{ property: sortProp, direction }] } : {}),
        max: Math.min(Math.max(Number(body.max) || 50, 1), 100),
      }),
    };
  });

/** Rename a list, or add/remove/retype its columns. */
export const PATCH: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion source update', async () => {
    const body = await jsonBody<{ ds?: string; title?: string; properties?: Record<string, unknown>; inTrash?: boolean }>(request);
    const sourceId = needId(body.ds, 'data source id');
    if (body.title === undefined && !body.properties && body.inTrash === undefined) {
      throw Object.assign(new Error('nothing to change'), { status: 400 });
    }
    await notionUpdateSource(locals.user!.userId, sourceId, {
      ...(body.title !== undefined ? { title: String(body.title).slice(0, 200) } : {}),
      ...(body.properties ? { properties: body.properties } : {}),
      ...(body.inTrash !== undefined ? { inTrash: !!body.inTrash } : {}),
    });
    return { ok: true };
  });
