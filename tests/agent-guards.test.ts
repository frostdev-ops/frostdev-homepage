import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getDb } from '../src/lib/db.ts';
import { saveDashboard } from '../src/lib/dashboard.ts';
import { validateLayout } from '../src/lib/wards.ts';
import { getSetting } from '../src/lib/settings.ts';
import { fitOutput, runShell, vettedFetch } from '../src/lib/agent/shell.ts';
import { storeAttachment, listAttachments, getAttachment } from '../src/lib/agent/attachments.ts';
import { activeConversation } from '../src/lib/agent/conversations.ts';
import { storeAgentAccount } from '../src/lib/agent/accounts.ts';
import { clearThread, parkConfirm, runHeadlessTurn } from '../src/lib/agent/core.ts';

// The guards that stand between the agent and the rest of the machine. No
// outbound network here: the SSRF cases resolve through /etc/hosts only.

function seedUser(email: string): number {
  getDb().prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'admin')`).run(email);
  const id = (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
  saveDashboard(id, validateLayout([{ i: 'ag1', type: 'agent', size: '2x2', config: { provider: 'codex' } }])!);
  return id;
}

test('vettedFetch refuses this machine — by name and by literal', async () => {
  // A real listener, so a failure here means the guard let it through rather
  // than the connection merely being refused.
  const server = http.createServer((_req, res) => res.end('SHOULD NEVER BE READ'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(() => vettedFetch(`http://127.0.0.1:${port}/`, {}), /private address/);
    await assert.rejects(() => vettedFetch(`http://localhost:${port}/`, {}), /private address/);
    // Link-local (cloud metadata) and RFC1918 too.
    await assert.rejects(() => vettedFetch('http://169.254.169.254/latest/meta-data/', {}), /private address/);
    await assert.rejects(() => vettedFetch('http://10.0.0.1/', {}), /private address/);
    // Non-http schemes never reach the resolver.
    await assert.rejects(() => vettedFetch('file:///etc/passwd', {}), /not allowed/);
  } finally {
    server.close();
  }
});

test('attachments are user-scoped by both id and conversation', async () => {
  const u1 = seedUser('guard-a@x.dev');
  const u2 = seedUser('guard-b@x.dev');
  const conv = activeConversation(u1, 'ag1', 'codex');
  const f = await storeAttachment({
    userId: u1,
    name: 'notes.md',
    mime: 'text/markdown',
    bytes: new TextEncoder().encode('# private'),
    conversationId: conv.id,
  });
  assert.equal(getAttachment(u1, f.id)?.id, f.id);
  assert.equal(getAttachment(u2, f.id), null, 'another user cannot fetch it by id');
  assert.equal(listAttachments(u1, conv.id).length, 1);
  // Knowing (or guessing) the conversation id is not a capability either.
  assert.equal(listAttachments(u2, conv.id).length, 0);
});

test('clearing a thread collects its parked confirm row', () => {
  const u = seedUser('guard-clear@x.dev');
  const conv = activeConversation(u, 'ag1', 'codex');
  const pending = parkConfirm(conv, { call_id: 'c1', name: 'send_mail', args: { to: ['a@b.c'], body: 'hi' } });
  assert.ok(getSetting(`agent_confirm:${pending.confirmId}`), 'parked');
  clearThread(u, 'ag1');
  assert.equal(getSetting(`agent_confirm:${pending.confirmId}`), null, 'the KV row went with the thread');
});

test('an unattended run refuses to decide a confirm the user is still holding', async () => {
  const u = seedUser('guard-headless@x.dev');
  // Configured, so the run gets past the credentials gate and reaches the
  // confirm guard — which must return before any provider call.
  storeAgentAccount({ userId: u, provider: 'codex', token: 'refresh-token', label: 'test@x.dev' });
  const conv = activeConversation(u, 'ag1', 'codex');
  const pending = parkConfirm(conv, { call_id: 'c1', name: 'send_mail', args: { to: ['a@b.c'], body: 'hi' } });
  const reply = await runHeadlessTurn(u, 'ag1', 'do the thing', { kind: 'ask' });
  assert.match(reply, /skipped/);
  // Still parked, still decidable by the human.
  assert.ok(getSetting(`agent_confirm:${pending.confirmId}`), 'the live confirm survived the automation');
});

// The sandbox allowed 40k of output while the tool result cap is 12k: every
// big command came back as "result too large" and the model saw none of it.
test('shell output fits the tool result cap as JSON, and says it was cut', async () => {
  const uid = seedUser('shell-fit@test.io');
  const big = await runShell(uid, 'seq 1 20000');
  assert.equal(big.exitCode, 0, big.stderr);
  assert.ok(big.truncated);
  assert.ok(JSON.stringify(big).length < 12_000, `${JSON.stringify(big).length} chars`);
  assert.match(big.stdout, /^1\n2\n3\n/);
  // Quotes escape to two chars each — the cut is by serialized size, not raw.
  const quoted = await runShell(uid, `yes 'a"b"c"d"e"f"g"h"' | head -n 3000`);
  assert.ok(JSON.stringify(quoted).length < 12_000, `${JSON.stringify(quoted).length} chars`);
  const small = await runShell(uid, 'echo fits');
  assert.equal(small.truncated, false);
});

test('the shell survives its second command — the sandbox singleton must not conflict', async () => {
  // DefenseInDepthBox compares options by reference across Bash instances; a
  // per-call callback made every shell command after the first fail before running.
  const uid = seedUser('shell-twice@test.io');
  const first = await runShell(uid, 'echo one');
  assert.equal(first.exitCode, 0, first.stderr);
  const second = await runShell(uid, 'printf "# notes\\n" > /work/AGENTS.md && cat /work/AGENTS.md');
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(second.stdout.trim(), '# notes');
});

test("shell output bounds escaped stderr without looping", () => {
  const output = fitOutput("", "\u0000".repeat(4000));
  assert.ok(output.truncated);
  assert.ok(JSON.stringify(output).length < 12000);
});
