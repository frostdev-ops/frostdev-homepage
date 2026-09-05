import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.ts';

// The conversation, mirrored to plain files so the agent can search its own
// past with rg instead of relying on what fits in a context window. SQLite is
// the record; these directories are the searchable copy. Per-user — every
// dashboard user gets their own agent and must never see another's:
//
//   agent/<user-id>/history/<conversation-id>.md   every turn, appended
//   agent/<user-id>/docs/<file-id>-<name>.txt      every document's text
//   agent/<user-id>/work/                          the agent's own scratch
//
// Directories are created on call, not at module scope — users appear at runtime.

export function historyDir(userId: number): string {
  const dir = path.join(DATA_DIR, 'agent', String(userId), 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function docsDir(userId: number): string {
  const dir = path.join(DATA_DIR, 'agent', String(userId), 'docs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function workDir(userId: number): string {
  const dir = path.join(DATA_DIR, 'agent', String(userId), 'work');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The agent's own long-term notes: /work/AGENTS.md, read into every turn's
 *  instructions. Per USER, not per ward — this is the one thing that carries
 *  across wards and conversations, where /history only carries per-thread.
 *  The agent maintains it itself with the bash tool. Truncated, never trusted
 *  as instructions past what the system prompt already grants it. */
export const NOTES_FILE = 'AGENTS.md';
export const NOTES_CAP = 8000;

/** Seeded on first read, so every user starts with the shape to fill in rather
 *  than a blank file. Deliberately short: the WHOLE file rides in every turn's
 *  prompt, so a long preamble here is rent paid forever. The maintenance rules
 *  live in the system prompt, not in here — the agent rewrites this file and
 *  would eventually prune its own instructions away. */
const NOTES_TEMPLATE = `# Rime's notes

Long-term memory. Facts that stay true — not a log of what happened.
Rewrite and prune; never just append.

## The user

## Setup and preferences

## Decisions and standing rules
`;

/** The notes, seeding the template the first time. Empty only if the agent
 *  emptied it on purpose — an existing file is never re-seeded. */
export function ensureNotes(userId: number): string {
  const file = path.join(workDir(userId), NOTES_FILE);
  try {
    return fs.readFileSync(file, 'utf8').slice(0, NOTES_CAP).trim();
  } catch {
    try {
      fs.writeFileSync(file, NOTES_TEMPLATE, { flag: 'wx' });
    } catch {
      return ''; // lost a race, or the store is read-only: the turn still runs
    }
    return NOTES_TEMPLATE.trim();
  }
}

/** Filesystem-safe, still recognisable. */
export function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'file';
}

export function appendTurn(
  userId: number,
  conversationId: number,
  role: 'user' | 'assistant',
  text: string,
  extra?: { steps?: { tool: string; args?: unknown; error?: string }[]; files?: { id: number; name: string }[] }
): void {
  try {
    const when = new Date().toISOString();
    const lines = [`\n## ${role} — ${when}\n`];
    if (extra?.files?.length) {
      lines.push(`attachments: ${extra.files.map((f) => `${f.name} (file_id ${f.id})`).join(', ')}\n`);
    }
    if (extra?.steps?.length) {
      lines.push(
        ...extra.steps.map(
          (s) => `- tool ${s.tool}(${JSON.stringify(s.args ?? {})})${s.error ? ` -> ERROR ${s.error}` : ''}`
        ),
        ''
      );
    }
    lines.push(text || '(no text)', '');
    fs.appendFileSync(path.join(historyDir(userId), `${conversationId}.md`), lines.join('\n'));
  } catch (err) {
    // The searchable copy is a convenience; SQLite already has the record.
    console.error('[history] could not append turn:', err);
  }
}

/** Document text, one file per attachment, named so rg output is readable. */
export function writeDocText(userId: number, fileId: number, name: string, text: string): void {
  try {
    fs.writeFileSync(path.join(docsDir(userId), `${fileId}-${safeName(name)}.txt`), text, { mode: 0o600 });
  } catch (err) {
    console.error('[history] could not write document text:', err);
  }
}
