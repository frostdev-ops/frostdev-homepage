import type { APIRoute } from 'astro';
import { getDb } from '../../lib/db.ts';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user!;
  const rows = getDb()
    .prepare('SELECT provider, account_label FROM linked_accounts WHERE user_id = ?')
    .all(user.userId) as { provider: string; account_label: string }[];
  const links = Object.fromEntries(rows.map((r) => [r.provider, r.account_label || true]));
  return Response.json({
    id: user.userId,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    links: {
      google: links.google ?? false,
      microsoft: links.microsoft ?? false,
      notion: links.notion ?? false,
      zoho: links.zoho ?? false,
      mailbox: links.mailbox ?? false,
      icloud: links.icloud ?? false,
    },
  });
};
