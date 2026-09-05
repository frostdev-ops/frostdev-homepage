import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSsoLogin as decide, decodeIdToken, WORKSPACE_DOMAIN as ENV_DOMAIN } from '../src/lib/google-sso.ts';

// The test process sets no SSO_WORKSPACE_DOMAIN; every case names the domain explicitly.
const WORKSPACE_DOMAIN = 'example.com';
const decideSsoLogin = (claims: Parameters<typeof decide>[0], existing: boolean, total: number) =>
  decide(claims, existing, total, WORKSPACE_DOMAIN);
const verified = { email: 'a@example.com', email_verified: true, hd: WORKSPACE_DOMAIN };

test('no workspace domain configured: nobody auto-provisions, invites still log in', () => {
  assert.equal(ENV_DOMAIN, null);
  assert.equal(decide(verified, false, 0).action, 'reject');
  assert.deepEqual(decide(verified, true, 1), { action: 'login' });
});

test('existing user logs in whatever the domain', () => {
  assert.deepEqual(decideSsoLogin({ email: 'x@gmail.com', email_verified: true }, true, 5), { action: 'login' });
  assert.deepEqual(decideSsoLogin(verified, true, 5), { action: 'login' });
});

test('first workspace user ever bootstraps as admin', () => {
  assert.deepEqual(decideSsoLogin(verified, false, 0), { action: 'create', role: 'admin' });
});

test('later workspace users auto-provision as member', () => {
  assert.deepEqual(decideSsoLogin(verified, false, 3), { action: 'create', role: 'member' });
});

test('foreign domain without a row is rejected', () => {
  const d = decideSsoLogin({ email: 'x@gmail.com', email_verified: true }, false, 3);
  assert.equal(d.action, 'reject');
  assert.match((d as { reason: string }).reason, /not invited/);
});

test('unverified email is rejected even for existing users', () => {
  const d = decideSsoLogin({ email: 'a@example.com', email_verified: false, hd: WORKSPACE_DOMAIN }, true, 5);
  assert.equal(d.action, 'reject');
  assert.match((d as { reason: string }).reason, /unverified/);
});

test('missing email is rejected', () => {
  assert.equal(decideSsoLogin({ email_verified: true, hd: WORKSPACE_DOMAIN }, false, 0).action, 'reject');
});

test('decodeIdToken reads a base64url JWT payload', () => {
  const claims = { email: 'a@example.com', email_verified: true, hd: 'example.com', name: 'Ada' };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  assert.deepEqual(decodeIdToken(`eyJhbGciOiJSUzI1NiJ9.${payload}.fakesig`), claims);
});

test('decodeIdToken throws on a token with no payload part', () => {
  assert.throws(() => decodeIdToken('nodots'), /malformed/);
});
