import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { brandFile, isSlot } from '../../lib/brand-files.ts';

export const prerender = false;

const TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };

/** Public: the favicon and the splash's art load before anyone logs in. */
export const GET: APIRoute = ({ params, request }) => {
  const slot = params.slot ?? '';
  if (!isSlot(slot)) return new Response('not found', { status: 404 });
  const file = brandFile(slot);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return new Response('not found', { status: 404 });
  }
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const headers = { etag, 'cache-control': 'public, max-age=3600' };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(fs.readFileSync(file), {
    headers: { ...headers, 'content-type': TYPES[path.extname(file).slice(1)] ?? 'application/octet-stream' },
  });
};
