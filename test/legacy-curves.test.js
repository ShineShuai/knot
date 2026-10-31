// LEGACY-CURVES: a reminder that cannot be forgotten. See config.js for what to do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_CURVES_REVIEW_BY } from '../src/config.js';

test('the fallback for browsers without WebCrypto Ed25519 is due for review', () => {
  assert.ok(
    Date.now() < Date.parse(LEGACY_CURVES_REVIEW_BY),
    `Review date ${LEGACY_CURVES_REVIEW_BY} has passed. Does anyone still need the fallback?`
    + ' No: remove it. Yes: move LEGACY_CURVES_REVIEW_BY (src/config.js has the steps).',
  );
});
