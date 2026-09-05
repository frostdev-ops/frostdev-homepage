import type { APIRoute } from 'astro';
import { notionRoute } from '../../../lib/notion-route.ts';
import { notionUsers } from '../../../lib/notion.ts';

export const prerender = false;

/** The workspace's people — what a `people` property editor picks from. */
export const GET: APIRoute = ({ locals }) =>
  notionRoute(locals.user!.userId, 'notion users', async () => ({ users: await notionUsers(locals.user!.userId) }));
