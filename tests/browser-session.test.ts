import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { closeSession, killByProfile, open, peek, runCmds } from '../src/lib/browser/session.ts';
import { TOOLS } from '../src/lib/agent/tools.ts';

// The one end-to-end check: a real headless Chromium through session.ts, the
// human's input path (runCmds) and the agent's (browser_snapshot → aria-ref →
// browser_act) on one page. Skips where no chromium is installed.

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  return (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
}

test('orphan cleanup terminates only processes using the selected profile root', async () => {
  const root = path.join(process.env.HOMEPAGE_DATA_DIR!, 'browser profiles');
  const children = [root, `${root}-other`].map((dir) => spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${path.join(dir, 'ward')}`],
    { stdio: 'ignore' }));
  try {
    await Promise.all(children.map((child) => once(child, 'spawn')));
    const stopped = once(children[0]!, 'exit', { signal: AbortSignal.timeout(15_000) });
    killByProfile(root + path.sep);
    await stopped;
    assert.equal(children[1]!.exitCode, null);
    assert.equal(children[1]!.signalCode, null);
    process.kill(children[1]!.pid!, 0);
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
});

test('one session, two drivers', async (t) => {
  const uid = seedUser('bw@test');
  saveDashboard(uid, [{ i: 'bw1', type: 'browser', size: '3x2', config: { backend: 'local' } }]);
  let s;
  try {
    s = await open(uid, 'bw1', { backend: 'local' });
  } catch (err) {
    if (existsSync(process.env.BROWSER_EXECUTABLE ?? chromium.executablePath())) throw err;
    t.skip(`no chromium here: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return;
  }
  try {
    await s.page.setContent(
      `<h1>Sandbox</h1><input aria-label="Name"><button onclick="document.querySelector('h1').textContent='clicked ' + document.querySelector('input').value">Go</button>`
    );
    const ctx = { userId: uid, ward: 'agent', conv: 1 };

    // Agent: snapshot → ref → act.
    const snap = (await TOOLS.browser_snapshot!.run({}, ctx)) as { snapshot: string };
    const button = /button "Go" \[ref=(e\d+)\]/.exec(snap.snapshot);
    const input = /textbox "Name" \[ref=(e\d+)\]/.exec(snap.snapshot);
    assert.ok(button && input, `snapshot lacks refs:\n${snap.snapshot}`);
    await TOOLS.browser_act!.run({ action: 'fill', ref: input![1], text: 'rime' }, ctx);
    await TOOLS.browser_act!.run({ action: 'click', ref: button![1] }, ctx);
    assert.equal(await s.page.textContent('h1'), 'clicked rime');

    // Human: focus the field by clicking it, type, press a key.
    const box = (await s.page.locator('input').boundingBox())!;
    const x = box.x + 5;
    const y = box.y + box.height / 2;
    await runCmds(s, [
      { t: 'down', x, y, button: 0 },
      { t: 'up', x, y, button: 0 },
      { t: 'key', type: 'down', key: 'Meta' }, // a Mac's ⌘A: the server maps it to the remote OS's select-all
      { t: 'key', type: 'down', key: 'a' },
      { t: 'key', type: 'up', key: 'a' },
      { t: 'key', type: 'up', key: 'Meta' },
      { t: 'text', text: 'human' },
      { t: 'key', type: 'down', key: 'NoSuchKey' }, // dropped, never fatal
      { t: 'resize', w: 100, h: 5000 }, // clamped
    ]);
    assert.equal(await s.page.inputValue('input'), 'human');
    assert.deepEqual(s.viewport, { width: 320, height: 1200 });
    await assert.rejects(runCmds(s, [{ t: 'goto', url: 'file:///etc/passwd' }]), /http\(s\)/);

    // Tools refuse a ward that is not the user's browser ward.
    await assert.rejects(() => TOOLS.browser_snapshot!.run({ ward: 'nope' }, ctx) as Promise<unknown>, /not a browser ward/);
  } finally {
    await closeSession(s);
  }
  assert.equal(peek(uid, 'bw1'), undefined);
});
