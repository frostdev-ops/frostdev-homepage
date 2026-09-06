import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { addProject } from '../src/lib/dev/projects.ts';
import { workDb } from '../src/lib/dev/runtime.ts';
import { startSession, shutdownTerminals } from '../src/lib/dev/terminals.ts';

test('shutdown drains batched output through xterm before saving and killing the PTY', async t => {
  process.env.RIMEWARD_DESKTOP = '1';
  process.env.RIMEWARD_NATIVE_TOKEN = 'test-only';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rimeward-shutdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let output!: (data: string) => void, exited!: (event: { exitCode: number }) => void;
  let killed = 0;
  const pty = createRequire(import.meta.url)('node-pty');
  t.mock.method(pty, 'spawn', () => ({
    onData: (fn: typeof output) => { output = fn; },
    onExit: (fn: typeof exited) => { exited = fn; },
    kill: () => { killed++; exited({ exitCode: 0 }); },
    pause() {}, resume() {},
  }));
  const project = addProject(1, root);
  const session = await startSession(1, { project: project.id, kind: 'shell' });
  output('PENDING_SHUTDOWN_OUTPUT');
  const stopping = shutdownTerminals();
  assert.equal(shutdownTerminals(), stopping, 'duplicate shutdown signals share the drain');
  await stopping;
  const saved = workDb().prepare('SELECT snapshot, sequence FROM terminal_sessions WHERE id=?').get(session.id) as { snapshot: string; sequence: number };
  assert.match(saved.snapshot, /PENDING_SHUTDOWN_OUTPUT/);
  assert.equal(saved.sequence, 1);
  assert.equal(killed, 1);
});
