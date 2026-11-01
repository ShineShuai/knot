import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInfo, versionDetail, versionLabel } from '../src/build.js';

const page = (meta) => ({
  querySelector: (sel) => {
    const name = /meta\[name="(\w+)"\]/.exec(sel)?.[1];
    return name in meta ? { content: meta[name] } : null;
  },
});
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

test('an unstamped page (development, tests) is the dev channel with no build', () => {
  assert.deepEqual(buildInfo(null), { channel: 'dev', build: '' });
  assert.deepEqual(buildInfo(page({ build: '', channel: 'dev' })), { channel: 'dev', build: '' });
  assert.deepEqual(buildInfo({}), { channel: 'dev', build: '' }, 'a document without queries');
});

test('the channel and the build are read from the page', () => {
  assert.deepEqual(
    buildInfo(page({ build: SHA, channel: 'beta' })),
    { channel: 'beta', build: SHA },
  );
});

test('the room list shows the plain version on prod and in development, more on beta', () => {
  assert.equal(versionLabel('0.4.0', { channel: 'dev', build: '' }), 'v0.4.0');
  assert.equal(versionLabel('0.4.0', { channel: 'prod', build: SHA }), 'v0.4.0');
  assert.equal(versionLabel('0.4.0', { channel: 'beta', build: SHA }), 'v0.4.0 · beta · abcdef0');
  assert.equal(versionLabel('0.4.0', { channel: 'beta', build: '' }), 'v0.4.0 · beta');
});

test('a bug report always names the channel and the build', () => {
  assert.equal(versionDetail('0.4.0', { channel: 'prod', build: SHA }), '0.4.0 prod abcdef0');
  assert.equal(versionDetail('0.4.0', { channel: 'dev', build: '' }), '0.4.0 dev');
});
