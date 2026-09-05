import type { APIRoute } from 'astro';
import { getLink, getMeta, patchMeta, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { notionDatabases, notionRecent, notionTaskSchema, parseNotionId } from '../../../lib/notion.ts';
import { invalidate } from '../../../lib/cache.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  const link = getLink(userId, 'notion');
  if (!link) return Response.json({ error: 'not-linked' }, { status: 404 });
  // ?db= — one database's columns, for the task-ward property picker. Also
  // re-caches the discovered title/done/date columns, so re-opening ⚙ is how
  // you make the ward notice a column you added in Notion.
  const dbId = parseNotionId(url.searchParams.get('db') ?? '');
  const dsId = parseNotionId(url.searchParams.get('ds') ?? '') ?? undefined;
  try {
    if (dbId) return Response.json(await notionTaskSchema(userId, dbId, dsId), { headers: { 'cache-control': 'no-store' } });
    const [databases, pages] = await Promise.all([notionDatabases(userId), notionRecent(userId)]);
    const meta = getMeta(link);
    return Response.json({
      databases,
      pages,
      tasksDbId: meta.tasks_db_id ?? null,
      capturePageId: meta.capture_page_id ?? null,
      calendarDbId: meta.calendar_db_id ?? null,
    });
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[notion config]', err);
    return Response.json({ error: 'notion failed' }, { status: 502 });
  }
};

// Form POST from /account. Accepts raw ids or pasted notion.so URLs.
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const userId = locals.user!.userId;
  if (!getLink(userId, 'notion')) return redirect('/account?err=notion-not-linked', 303);
  const form = await request.formData();
  const patch: Record<string, unknown> = {};

  const tasksDb = String(form.get('tasksDbId') ?? '').trim();
  if (tasksDb) {
    const id = parseNotionId(tasksDb);
    if (!id) return redirect('/account?err=bad-notion-id', 303);
    patch.tasks_db_id = id;
    patch.task_props = undefined; // re-detect column names for the new database
  }
  const capture = String(form.get('capturePageId') ?? '').trim();
  if (capture) {
    const id = parseNotionId(capture);
    if (!id) return redirect('/account?err=bad-notion-id', 303);
    patch.capture_page_id = id;
  }
  // The Agenda ward's Notion source. 'none' unsets it; a dropped key is how
  // patchMeta deletes (undefined never survives JSON.stringify).
  const calendarDb = String(form.get('calendarDbId') ?? '').trim();
  if (calendarDb === 'none') {
    patch.calendar_db_id = undefined;
    invalidate(`ncal:${userId}:`);
  } else if (calendarDb) {
    const id = parseNotionId(calendarDb);
    if (!id) return redirect('/account?err=bad-notion-id', 303);
    patch.calendar_db_id = id;
    invalidate(`ncal:${userId}:`);
  }

  if (Object.keys(patch).length) patchMeta(userId, 'notion', patch);
  return redirect('/account?ok=notion-config', 303);
};
