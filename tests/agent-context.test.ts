import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../src/lib/users.ts';
import { invalidate } from '../src/lib/cache.ts';
import { storeAgentAccount } from '../src/lib/agent/accounts.ts';
import { listCodexModels } from '../src/lib/agent/codex.ts';
import { codexContext, openrouterContext, contextUsage, recordContextUsage, estimateTokens } from '../src/lib/agent/context.ts';
import { needsCompaction } from '../src/lib/agent/conversations.ts';
import { enroll, claimEnrollment } from '../src/lib/dev/devices.ts';
import { ALL } from '../src/pages/api/devices/harness/[...action].ts';

test('model catalogs retain default, effective, output and compaction limits with no name assumptions', () => {
  assert.deepEqual(codexContext({ context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 }),
    { window: 272000, inputLimit: 258400, compactAt: 244800, source: 'catalog' });
  assert.equal(codexContext({ context_window: 128000, auto_compact_token_limit: 100000 })?.compactAt, 100000);
  assert.equal(codexContext({ max_context_window: 1000000 })?.window, 1000000);
  assert.equal(codexContext({ context_window: -1 }), undefined);
  assert.equal(codexContext({ context_window: Infinity }), undefined);
  assert.equal(openrouterContext({ contextLength: null }), undefined);
  assert.deepEqual(openrouterContext({ contextLength: 1000000, topProvider: { contextLength: 128000, maxCompletionTokens: 4000 } }),
    { window: 128000, inputLimit: 124000, compactAt: 115200, source: 'catalog' });
  assert.equal(openrouterContext({ contextLength: 8192 })?.window, 8192, 'small models are not assumed to have 128k');
});

test('usage includes instructions/tools, follows the selected model, and invalidates measurements on history replacement', () => {
  const items: unknown[] = [{ role: 'user', content: 'task' }];
  const instructions = 'instructions '.repeat(1000);
  const tools = [{ name: 'read', description: 'a tool', parameters: {} }];
  const small = codexContext({ context_window: 128000 });
  const large = codexContext({ context_window: 1000000 });
  const initial = contextUsage(9876, 'codex', 'small', items, instructions, tools, small);
  assert.ok(initial.tokens > estimateTokens(items));
  recordContextUsage(9876, 'codex', 'small', items, instructions, tools, { input: 120000, cached: 110000 });
  items.push({ role: 'assistant', content: 'result'.repeat(100) });
  const after = contextUsage(9876, 'codex', 'small', items, instructions, tools, small);
  assert.ok(after.tokens > 120000);
  assert.equal(after.input, 120000);
  assert.equal(needsCompaction(after), true);
  const switched = contextUsage(9876, 'codex', 'large', items, instructions, tools, large);
  assert.equal(switched.input, undefined);
  assert.equal(needsCompaction(switched), false);
  assert.equal(contextUsage(9876, 'codex', 'small', [{ role: 'user', content: 'summary' }], instructions, tools, small).input, undefined);
  const unknown = contextUsage(9876, 'codex', 'unknown', items, instructions, tools);
  assert.equal(unknown.window, null);
  assert.equal(needsCompaction(unknown), false);
  assert.equal(estimateTokens({ encrypted_content: 'x'.repeat(500000) }), estimateTokens({ encrypted_content: 'x' }));
  recordContextUsage(9877, 'codex', 'small', items, instructions, tools, { input: 100000, cached: 0, output: 15000 },
    [{ type: 'reasoning', encrypted_content: 'opaque' }]);
  assert.equal(contextUsage(9877, 'codex', 'small', [...items, { type: 'reasoning', encrypted_content: 'opaque' }], instructions, tools, small).tokens, 115000,
    'reported output/reasoning tokens count without treating encrypted bytes as text');
});

test('Codex metadata survives catalog fetch, hourly refresh and a restart/offline cache fallback', async () => {
  const user = createUser('model-catalog@example.com', null);
  const jwt = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
  storeAgentAccount({ userId: user, provider: 'codex', token: 'test-only', accessToken: jwt });
  const original = globalThis.fetch;
  let calls = 0, window = 128000;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ models: [{ slug: 'future-model', context_window: window, max_context_window: 2000000 }] });
  };
  try {
    assert.equal((await listCodexModels(user))[0]?.context?.window, 128000);
    const pair = claimEnrollment(enroll(user).code, 'Metadata test', 'darwin', 1);
    const response = await ALL({ params: { action: 'models' }, locals: {},
      url: new URL('https://example.com/api/devices/harness/models'),
      request: new Request('https://example.com/api/devices/harness/models', { headers: { authorization: `Bearer ${pair.token}` } }),
    } as unknown as Parameters<typeof ALL>[0]);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].context.window, 128000, 'paired desktop receives the same model capacity');
    await listCodexModels(user);
    assert.equal(calls, 1);
    window = 1000000;
    invalidate(`codex:models:${user}`);
    assert.equal((await listCodexModels(user))[0]?.context?.window, 1000000);
    invalidate(`codex:models:${user}`);
    globalThis.fetch = async () => { throw Error('offline'); };
    const cached = (await listCodexModels(user))[0]?.context;
    assert.equal(cached?.window, 1000000);
    assert.equal(cached?.source, 'cache');
  } finally {
    globalThis.fetch = original;
    invalidate(`codex:models:${user}`);
  }
});
