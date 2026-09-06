import type { APIRoute } from 'astro';
import { getDb } from '../../../lib/db.ts';
import { isDesktop } from '../../../lib/dev/runtime.ts';
import { getSetting } from '../../../lib/settings.ts';
import { deleteBackground, saveBackground, MAX_UPLOAD_BYTES } from '../../../lib/backgrounds.ts';
import { normalizeTheme, parseTheme } from '../../../lib/theme.ts';

export const prerender = false;

/** The same store serves background photos and the header logo, so the reply
 *  lands back on whichever panel sent the upload. */
const back = (redirect: (path: string, status: 303) => Response, query: string, hash = '#background') =>
  redirect(`/account${query}${hash}`, 303);

/** Save the theme with `patch` merged over whatever is stored. */
function patchTheme(userId: number, stored: string | null, patch: Record<string, unknown>) {
  const cfg = normalizeTheme({ ...(parseTheme(stored) ?? {}), ...patch });
  getDb().prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(cfg), userId);
  return cfg;
}

/** Upload / delete images. Uploading also selects the new one — a two-step
 *  "upload, then remember to pick it" is just a way to lose it. `logo=1` marks
 *  the request as the header brand's rather than the background's. */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const userId = locals.user!.userId;
  const stored = locals.user!.theme ?? null;

  // Checked BEFORE formData(), which buffers the whole body in the pm2 process.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
    return back(redirect, `?err=${encodeURIComponent(`image larger than ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`)}`);
  }
  const form = await request.formData().catch(() => null);
  if (!form) return back(redirect, '?err=bad+upload');
  const hash = form.get('logo') ? '#header' : '#background';

  const selected = form.get('delete');
  if (typeof selected === 'string' && selected) {
    // The shared account form can carry its server-local image filename.
    const remove = isDesktop() && getSetting(`instance:joined:${userId}`)
      ? selected.replace(/^\d+-/, `${userId}-`) : selected;
    deleteBackground(userId, remove);
    // One file, two possible uses: clear whichever knobs pointed at it.
    const cfg = parseTheme(stored);
    const patch: Record<string, unknown> = {};
    if (cfg?.bgImage === remove) patch.bgImage = '';
    if (cfg?.brandLogo === remove) patch.brandLogo = '';
    if (Object.keys(patch).length) patchTheme(userId, stored, patch);
    return back(redirect, '?ok=bg', hash);
  }

  const file = form.get('image');
  if (!(file instanceof File) || file.size === 0) return back(redirect, '?err=pick+an+image+first', hash);
  try {
    const name = await saveBackground(userId, new Uint8Array(await file.arrayBuffer()));
    patchTheme(userId, stored, hash === '#header' ? { brandLogo: name } : { bgImage: name, background: 'image' });
    return back(redirect, '?ok=bg', hash);
  } catch (err) {
    return back(redirect, `?err=${encodeURIComponent(err instanceof Error ? err.message : 'upload failed')}`, hash);
  }
};
