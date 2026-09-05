import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { asAccount, linkedMailAccounts, mailUnreadCount, type Account } from '../../../lib/mail.ts';

export const prerender = false;

/** Unread counts per account (60s cached per provider underneath). A failed
 *  provider is omitted, not fatal; nothing linked is a 404; every one dead
 *  with an expired grant is the reconnect response. */
export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  const raw = url.searchParams.get('account');
  const accounts: Account[] = raw === 'all' ? linkedMailAccounts(userId) : [asAccount(raw)].filter((a) => getLink(userId, a));
  if (!accounts.length) return Response.json({ error: 'not-linked' }, { status: 404 });
  const res = await Promise.allSettled(accounts.map((a) => mailUnreadCount(userId, a)));
  const counts: Partial<Record<Account, number>> = {};
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') counts[accounts[i]!] = r.value;
  });
  if (!Object.keys(counts).length) {
    const reconnect = reconnectResponse((res[0] as PromiseRejectedResult).reason);
    if (reconnect) return reconnect;
    return Response.json({ error: 'mail failed' }, { status: 502 });
  }
  return Response.json(counts, { headers: { 'cache-control': 'no-store' } });
};
