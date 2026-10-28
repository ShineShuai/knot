import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, dictionaries, setLanguage, t } from '../src/ui/i18n.js';

test.afterEach(() => setLanguage('en'));

const keys = (dict) => Object.keys(dict).sort();
const slots = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

test('every language has every text, with the same {placeholders}', () => {
  assert.deepEqual(keys(LANGUAGES), keys(dictionaries));
  for (const [code, dict] of Object.entries(dictionaries)) {
    assert.deepEqual(keys(dict), keys(dictionaries.en), `${code}: missing or extra keys`);
    for (const key of Object.keys(dict)) {
      assert.equal(slots(dict[key]), slots(dictionaries.en[key]), `${code}.${key}: placeholders`);
    }
  }
});

test('setLanguage switches the texts; auto follows the browser; unknown falls back to English', () => {
  assert.equal(setLanguage('de'), 'de');
  assert.equal(t('send'), dictionaries.de.send);
  assert.equal(t('callInCall', { names: 'Ada' }), 'Im Anruf: Ada');
  assert.equal(setLanguage('zh'), 'zh');
  assert.equal(t('send'), dictionaries.zh.send);
  assert.equal(setLanguage('xx'), 'en');
  assert.equal(t('send'), dictionaries.en.send);
  const browser = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'de-AT' }, configurable: true });
  assert.equal(setLanguage('auto'), 'de');
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'fr-FR' }, configurable: true });
  assert.equal(setLanguage('auto'), 'en');
  Object.defineProperty(globalThis, 'navigator', browser);
});
