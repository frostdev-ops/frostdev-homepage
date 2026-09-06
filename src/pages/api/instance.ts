import type { APIRoute } from 'astro';
import { instanceStatus } from '../../lib/dev/instance-routing.ts';
export const GET: APIRoute = async ({ locals }) => Response.json(await instanceStatus(locals.user!.userId), { headers: { 'cache-control': 'no-store' } });
