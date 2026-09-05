import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, repoDir } from './db.ts';

// Brand slots. An instance overrides one by dropping a file into data/brand/
// (`rimeward brand install <slot> <file>`); with no file the built-in Rimeward
// art under assets/ serves. Node-only (the CLI and the /brand route import it);
// the Astro components live in brand.ts.

export const SLOTS = {
  wordmark: ['svg', 'webp', 'png'],
  emblem: ['svg', 'webp', 'png'],
  mark: ['svg', 'webp', 'png'],
  favicon: ['png'],
  'apple-touch-icon': ['png'],
  'icon-512': ['png'],
} as const;
export type Slot = keyof typeof SLOTS;

const BUILTIN: Record<Slot, string> = {
  wordmark: 'rimeward-lockup.svg',
  emblem: 'rimeward-mark.svg',
  mark: 'rimeward-mark.svg',
  favicon: 'rimeward-favicon.png',
  'apple-touch-icon': 'rimeward-apple-touch-icon.png',
  'icon-512': 'rimeward-icon-512.png',
};

export const BRAND_DIR = path.join(DATA_DIR, 'brand');

export const isSlot = (s: string): s is Slot => Object.hasOwn(SLOTS, s);

/** The instance's own file for a slot, if any. */
export function brandOverride(slot: Slot): string | null {
  for (const ext of SLOTS[slot]) {
    const file = path.join(BRAND_DIR, `${slot}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** What /brand/<slot> serves: the override, else the built-in. */
export function brandFile(slot: Slot): string {
  return brandOverride(slot) ?? path.join(repoDir('assets'), BUILTIN[slot]);
}
