import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUser,
  getUser,
  getUserByEmail,
  deleteUser,
  setUserRole,
  setUserPassword,
  hasPassword,
  verifyUserPassword,
  emailInUse,
  userCount,
} from '../src/lib/users.ts';
import { createSession, getSession } from '../src/lib/auth.ts';

// Tests run sequentially in one process against one DB; ordering below is
// deliberate (last-user / last-admin guards depend on global counts).

let adminId: number;
let memberId: number;

test('createUser with password, email lowercased', () => {
  adminId = createUser('  Admin@Test.IO ', 'pw-admin', 'admin');
  const u = getUser(adminId);
  assert.ok(u);
  assert.equal(u.email, 'admin@test.io');
  assert.equal(u.role, 'admin');
  assert.equal(u.has_password, 1);
  assert.equal(hasPassword(adminId), true);
});

test('deleteUser refuses the only user', () => {
  assert.equal(userCount(), 1);
  assert.throws(() => deleteUser(adminId), /only user/);
});

test('setUserRole refuses demoting the only admin', () => {
  assert.throws(() => setUserRole(adminId, 'member'), /only admin/);
});

test('setUserRole throws for unknown user', () => {
  assert.throws(() => setUserRole(99999, 'member'), /no such user/);
});

test('createUser SSO-only (null password)', () => {
  memberId = createUser('member@test.io', null);
  const u = getUser(memberId);
  assert.ok(u);
  assert.equal(u.role, 'member');
  assert.equal(u.has_password, 0);
  assert.equal(hasPassword(memberId), false);
});

test('deleteUser refuses the only admin', () => {
  assert.throws(() => deleteUser(adminId), /only admin/);
});

test('emailInUse is case-insensitive, exceptId excludes self', () => {
  assert.equal(emailInUse('ADMIN@TEST.IO'), true);
  assert.equal(emailInUse('admin@test.io', adminId), false);
  assert.equal(emailInUse('nobody@test.io'), false);
});

test('getUserByEmail is case-insensitive', () => {
  assert.equal(getUserByEmail('MEMBER@test.io')?.id, memberId);
  assert.equal(getUserByEmail('ghost@test.io'), null);
});

test('verifyUserPassword', () => {
  assert.equal(verifyUserPassword(adminId, 'pw-admin'), true);
  assert.equal(verifyUserPassword(adminId, 'wrong'), false);
  assert.equal(verifyUserPassword(memberId, 'anything'), false); // SSO-only
  assert.equal(verifyUserPassword(99999, 'pw'), false); // no such user
});

test('setUserPassword kills other sessions but keeps keepSession', () => {
  const keep = createSession(adminId);
  const other = createSession(adminId);
  const bystander = createSession(memberId);
  setUserPassword(adminId, 'new-pw', keep.id);
  assert.ok(getSession(keep.id), 'keepSession survives');
  assert.equal(getSession(other.id), null, 'other session for same user is killed');
  assert.ok(getSession(bystander.id), 'other users untouched');
  assert.equal(verifyUserPassword(adminId, 'new-pw'), true);
  assert.equal(verifyUserPassword(adminId, 'pw-admin'), false);
});

test('setUserPassword without keepSession kills all sessions', () => {
  const s = createSession(memberId);
  setUserPassword(memberId, 'first-pw');
  assert.equal(getSession(s.id), null);
  assert.equal(hasPassword(memberId), true);
});

test('deleteUser deletes a non-last member', () => {
  const extraId = createUser('extra@test.io', null);
  deleteUser(extraId);
  assert.equal(getUser(extraId), null);
});
