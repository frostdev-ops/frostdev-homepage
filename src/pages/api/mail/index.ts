import type { APIRoute } from 'astro';
import { getLink, reconnectResponse } from '../../../lib/linked-accounts.ts';
import { asAccount, canModifyMail, linkedMailAccounts, mailInbox, mailInboxMerged } from '../../../lib/mail.ts';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const userId = locals.user!.userId;
  const raw = url.searchParams.get('account');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 8) || 8, 1), 25);

  // 'all' is checked BEFORE asAccount, which coerces unknowns to google.
  if (raw === 'all') {
    const accounts = linkedMailAccounts(userId);
    if (!accounts.length) return Response.json({ error: 'not-linked' }, { status: 404 });
    try {
      const messages = await mailInboxMerged(userId, accounts, limit);
      const addresses = Object.fromEntries(accounts.map((a) => [a, getLink(userId, a)!.account_label]));
      const first = getLink(userId, accounts[0]!)!;
      return Response.json(
        { account: accounts[0], address: first.account_label, addresses, canModify: canModifyMail(first), messages },
        { headers: { 'cache-control': 'no-store' } }
      );
    } catch (err) {
      const reconnect = reconnectResponse(err);
      if (reconnect) return reconnect;
      console.error('[mail]', err);
      return Response.json({ error: 'mail failed' }, { status: 502 });
    }
  }

  const account = asAccount(raw);
  const link = getLink(userId, account);
  if (!link) return Response.json({ error: 'not-linked' }, { status: 404 });

  try {
    const messages = await mailInbox(userId, account, limit);
    return Response.json(
      { account, address: link.account_label, canModify: canModifyMail(link), messages },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (err) {
    const reconnect = reconnectResponse(err);
    if (reconnect) return reconnect;
    console.error('[mail]', err);
    return Response.json({ error: 'mail failed' }, { status: 502 });
  }
};
