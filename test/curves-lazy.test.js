// LEGACY-CURVES: modern browsers must not fetch TweetNaCl. Runs in a process of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forceSoftCurves, hasNative, nacl } from '../src/crypto/curves.js';
import '../src/crypto/box.js';
import '../src/crypto/identity.js';

test('TweetNaCl is loaded only once WebCrypto has said no', async () => {
  assert.equal(nacl, undefined, 'importing the crypto modules loads nothing');
  const native = await hasNative('Ed25519') && await hasNative('X25519');
  if (native) assert.equal(nacl, undefined, 'a browser with WebCrypto never fetches it');
  forceSoftCurves(true);
  assert.equal(await hasNative('Ed25519'), false);
  assert.equal(typeof nacl.sign.detached.verify, 'function');
  forceSoftCurves(!native);
});
