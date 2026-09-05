import type { APIRoute } from 'astro';
import { deleteMonitor, upsertMonitor } from '../../../lib/monitors.ts';

export const prerender = false;

/** The admin page's forms (admin-gated by the middleware's /api/admin prefix):
 *  `action=save` creates or replaces a monitor, `action=delete` removes one. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? '').trim();
  try {
    if (field('action') === 'delete') {
      deleteMonitor(field('id'));
      return redirect('/admin/monitors?ok=deleted', 303);
    }
    const t = upsertMonitor({
      id: field('id') || undefined,
      label: field('label'),
      group: field('new-group') || field('group'),
      kind: field('kind'),
      url: field('url'),
      method: field('method'),
      expect: field('expect'),
      host: field('host'),
      port: field('port'),
      name: field('name'),
      container: field('container'),
      unit: field('unit'),
    });
    return redirect(`/admin/monitors?ok=${encodeURIComponent(t.id)}`, 303);
  } catch (err) {
    return redirect(`/admin/monitors?err=${encodeURIComponent((err as Error).message)}`, 303);
  }
};
