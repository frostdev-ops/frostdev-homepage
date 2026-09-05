import './_setup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealToken, openToken } from '../src/lib/crypto.ts';

test('sealToken/openToken roundtrip', () => {
  const plain = 'refresh-token-abc-123-ünïcode';
  const sealed = sealToken(plain);
  assert.match(sealed, /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(openToken(sealed), plain);
});

test('sealing twice yields different ciphertexts (fresh iv)', () => {
  assert.notEqual(sealToken('same'), sealToken('same'));
});

test('tampered ciphertext throws', () => {
  const sealed = sealToken('secret');
  const [iv, ct, tag] = sealed.split('.');
  const flipped = (ct![0] === 'A' ? 'B' : 'A') + ct!.slice(1);
  assert.throws(() => openToken(`${iv}.${flipped}.${tag}`));
});

test('tampered auth tag throws', () => {
  const sealed = sealToken('secret');
  const [iv, ct, tag] = sealed.split('.');
  const flipped = (tag![0] === 'A' ? 'B' : 'A') + tag!.slice(1);
  assert.throws(() => openToken(`${iv}.${ct}.${flipped}`));
});

test('malformed sealed string throws', () => {
  assert.throws(() => openToken('not-a-sealed-token'), /malformed/);
  assert.throws(() => openToken('..'), /malformed/);
  assert.throws(() => openToken(''), /malformed/);
});
