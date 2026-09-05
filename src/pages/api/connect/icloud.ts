import type { APIRoute } from 'astro';
import { storeIcloud } from '../../../lib/icloud.ts';
import { invalidate } from '../../../lib/cache.ts';

export const prerender = false;

// iCloud has no OAuth to redirect through — the account form IS the connect
// flow (see mailbox.ts). storeIcloud validates the credentials against
// CalDAV before anything is stored; an empty password keeps the stored one.
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const userId = locals.user!.userId;
  const appleId = String(form.get('appleId') ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleId))
    return redirect('/account?err=' + encodeURIComponent('Enter your Apple ID email.') + '#icloud', 303);

  try {
    await storeIcloud(userId, appleId, String(form.get('password') ?? ''));
    // New credentials or a new account: the cached discovery and agenda are stale.
    invalidate(`icloud:${userId}:`);
    return redirect('/account?connected=iCloud%20Calendar#icloud', 303);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'could not connect iCloud';
    return redirect(`/account?err=${encodeURIComponent(msg)}#icloud`, 303);
  }
};
