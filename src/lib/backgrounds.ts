// Uploaded dashboard backgrounds. Photos are re-encoded to webp on the way in
// (sharp — already in the tree as Astro's image backend), capped to 2560px,
// and named by the hash of the ENCODED bytes: content-addressed, so the same
// photo uploaded twice is one file, and every name is safe in a CSS url().
// Metadata (including EXIF GPS) does not survive the re-encode.
//
// No table: the store IS the listing (readdir filtered by the user-id prefix),
// and users.theme holds the one name that is in use.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from './db.ts';
import { BG_NAME_RE } from './theme.ts';

export const BG_DIR = path.join(DATA_DIR, 'backgrounds');

/** Bigger than any sane wallpaper; the route rejects on content-length first. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Per user, so one account cannot fill the VPS disk. */
export const MAX_PER_USER = 16;
const MAX_EDGE = 2560;

const ownedBy = (userId: number, name: string) =>
  BG_NAME_RE.test(name) && name.startsWith(`${userId}-`);

/** Absolute path, or null when the name is not this user's or not a name. */
export function backgroundPath(userId: number, name: string): string | null {
  return ownedBy(userId, name) ? path.join(BG_DIR, name) : null;
}

/** This user's stored backgrounds, newest first. */
export function listBackgrounds(userId: number): string[] {
  if (!fs.existsSync(BG_DIR)) return [];
  return fs
    .readdirSync(BG_DIR)
    .filter((n) => ownedBy(userId, n))
    .map((name) => ({ name, at: fs.statSync(path.join(BG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map((f) => f.name);
}

/**
 * Re-encode and store one upload. Returns the stored name. Throws with a
 * sentence the user can act on — the caller shows it, nothing is dropped
 * silently.
 */
export async function saveBackground(userId: number, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`that image is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  }
  if (listBackgrounds(userId).length >= MAX_PER_USER) {
    throw new Error(`you already have ${MAX_PER_USER} backgrounds — delete one first`);
  }

  let out: Buffer;
  try {
    out = await sharp(Buffer.from(bytes), { animated: true })
      // .rotate() with no argument bakes in EXIF orientation before resizing.
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new Error('that file is not an image this server can read');
  }

  const name = `${userId}-${createHash('sha256').update(out).digest('hex').slice(0, 16)}.webp`;
  fs.mkdirSync(BG_DIR, { recursive: true });
  fs.writeFileSync(path.join(BG_DIR, name), out);
  return name;
}

/** Delete one of this user's backgrounds. Silent when it is already gone. */
export function deleteBackground(userId: number, name: string): void {
  const file = backgroundPath(userId, name);
  if (file) fs.rmSync(file, { force: true });
}
