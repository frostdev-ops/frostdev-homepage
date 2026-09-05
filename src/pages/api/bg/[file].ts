import type { APIRoute } from 'astro';
import fs from 'node:fs';
import { backgroundPath } from '../../../lib/backgrounds.ts';

export const prerender = false;

/** Serve one of the signed-in user's uploaded backgrounds. The name encodes
 *  the owner and the content hash, so it validates ownership AND is immutable. */
export const GET: APIRoute = ({ params, locals }) => {
  const file = backgroundPath(locals.user!.userId, String(params.file ?? ''));
  if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: {
      'content-type': 'image/webp',
      // Content-addressed name → the bytes behind it can never change.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
};
