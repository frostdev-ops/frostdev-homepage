import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSsoLogin, decodeIdToken, WORKSPACE_DOMAIN } from '../src/lib/google-sso.ts';

const verified = { email: 'a@frostdev.io', email_verified: true, hd: WORKSPACE_DOMAIN };

test('existing user logs in whatever the domain', () => {
  assert.deepEqual(decideSsoLogin({ email: 'x@gmail.com', email_verified: true }, true, 5), { action: 'login' });
  assert.deepEqual(decideSsoLogin(verified, true, 5), { action: 'login' });
});

test('first frostdev.io user ever bootstraps as admin', () => {
  assert.deepEqual(decideSsoLogin(verified, false, 0), { action: 'create', role: 'admin' });
});

test('later frostdev.io users auto-provision as member', () => {
  assert.deepEqual(decideSsoLogin(verified, false, 3), { action: 'create', role: 'member' });
});

test('foreign domain without a row is rejected', () => {
  const d = decideSsoLogin({ email: 'x@gmail.com', email_verified: true }, false, 3);
  assert.equal(d.action, 'reject');
  assert.match((d as { reason: string }).reason, /not invited/);
});

test('unverified email is rejected even for existing users', () => {
  const d = decideSsoLogin({ email: 'a@frostdev.io', email_verified: false, hd: WORKSPACE_DOMAIN }, true, 5);
  assert.equal(d.action, 'reject');
  assert.match((d as { reason: string }).reason, /unverified/);
});

test('missing email is rejected', () => {
  assert.equal(decideSsoLogin({ email_verified: true, hd: WORKSPACE_DOMAIN }, false, 0).action, 'reject');
});

test('decodeIdToken reads a base64url JWT payload', () => {
  const claims = { email: 'a@frostdev.io', email_verified: true, hd: 'frostdev.io', name: 'Ada' };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  assert.deepEqual(decodeIdToken(`eyJhbGciOiJSUzI1NiJ9.${payload}.fakesig`), claims);
});

test('decodeIdToken throws on a token with no payload part', () => {
  assert.throws(() => decodeIdToken('nodots'), /malformed/);
});
