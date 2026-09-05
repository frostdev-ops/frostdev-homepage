import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
} from '../src/lib/auth.ts';
import { createUser } from '../src/lib/users.ts';
import { getDb } from '../src/lib/db.ts';

test('hashPassword/verifyPassword roundtrip', () => {
  const stored = hashPassword('hunter2!');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword('hunter2!', stored), true);
});

test('wrong password is false', () => {
  assert.equal(verifyPassword('wrong', hashPassword('right')), false);
});

test('malformed stored hash is false, never throws', () => {
  assert.equal(verifyPassword('pw', ''), false);
  assert.equal(verifyPassword('pw', 'garbage'), false);
  assert.equal(verifyPassword('pw', 'bcrypt$1$2$3$abc$def'), false);
  assert.equal(verifyPassword('pw', 'scrypt$16384$8$1$notb64$$'), false);
});

test('createSession/getSession roundtrip', () => {
  const userId = createUser('session@test.io', 'pw', 'admin');
  const { id, expiresAt } = createSession(userId);
  assert.match(expiresAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const sess = getSession(id);
  assert.ok(sess);
  assert.equal(sess.userId, userId);
  assert.equal(sess.email, 'session@test.io');
  assert.equal(sess.role, 'admin');
});

test('getSession with no id is null', () => {
  assert.equal(getSession(undefined), null);
  assert.equal(getSession('no-such-session'), null);
});

test('destroySession kills the session', () => {
  const userId = createUser('destroy@test.io', 'pw');
  const { id } = createSession(userId);
  destroySession(id);
  assert.equal(getSession(id), null);
});

test('expired session returns null and gets swept', () => {
  const userId = createUser('expired@test.io', 'pw');
  getDb()
    .prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 day'))`)
    .run('expired-session-id', userId);
  assert.equal(getSession('expired-session-id'), null);
  // The miss sweeps dead rows.
  const row = getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('expired-session-id');
  assert.equal(row, undefined);
});
