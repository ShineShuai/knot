import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

test('the version shown in the app is the one in package.json', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(VERSION, version);
});
