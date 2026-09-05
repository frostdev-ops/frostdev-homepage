import type { APIRoute } from 'astro';
import { notionRoute } from '../../../lib/notion-route.ts';
import { notionUploadFile } from '../../../lib/notion.ts';

export const prerender = false;

const MAX_BYTES = 20 * 1024 * 1024; // Notion's single-part ceiling

/** multipart/form-data with one `file`. Returns the id you attach to a files
 *  property or a media block. */
export const POST: APIRoute = ({ request, locals }) =>
  notionRoute(locals.user!.userId, 'notion upload', async () => {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) throw Object.assign(new Error('a file is required'), { status: 400 });
    if (file.size > MAX_BYTES) throw Object.assign(new Error(`file is over ${MAX_BYTES / 1024 / 1024} MB`), { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await notionUploadFile(
      locals.user!.userId,
      file.name || 'upload',
      file.type || 'application/octet-stream',
      bytes
    );
    return { id, name: file.name, size: file.size };
  });
