import type { APIRoute } from 'astro';
import { normalizeMailboxConfig, storeMailbox } from '../../../lib/mailbox.ts';
import { invalidate } from '../../../lib/cache.ts';

export const prerender = false;

// The generic mailbox has no OAuth to redirect through — the account form IS
// the connect flow. The password never comes back out of the server, so an
// empty one means "keep the stored one" (see storeMailbox).
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  const userId = locals.user!.userId;
  const address = String(form.get('address') ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
    return redirect('/account?err=' + encodeURIComponent('Enter the mailbox address.') + '#accounts', 303);

  try {
    // Almost every server logs in with the address itself; only ask for a
    // separate login name when it differs.
    const cfg = normalizeMailboxConfig({ user: address, ...Object.fromEntries(form) });
    if (!cfg.user) cfg.user = address;
    storeMailbox(userId, address, String(form.get('password') ?? ''), cfg);
    // A host or protocol change makes every cached page of the old server's
    // inbox wrong; drop them rather than wait out the 60s TTL.
    invalidate(`mailbox:inbox:${userId}:`);
    invalidate(`mailbox:unread:${userId}`);
    return redirect('/account?connected=Mailbox#accounts', 303);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'could not save that mailbox';
    return redirect(`/account?err=${encodeURIComponent(msg)}#accounts`, 303);
  }
};
