// Links in messages: only http(s), no tricks, and the text is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom.js';
import { isEmoji } from '../src/chat/envelope.js';
import { MORE, QUICK } from '../src/ui/emoji.js';
import { linkify, splitLinks } from '../src/ui/linkify.js';

installFakeDom();

const links = (text) => splitLinks(text).filter((p) => p.href).map((p) => p.text);

test('links are found in a sentence, without the punctuation around them', () => {
  assert.deepEqual(links('see https://example.com/a?b=1#c, ok'), ['https://example.com/a?b=1#c']);
  assert.deepEqual(links('is it http://example.com?'), ['http://example.com']);
  assert.deepEqual(links('(https://example.com/x)'), ['https://example.com/x']);
  assert.deepEqual(links('(see https://en.wikipedia.org/wiki/Knot_(band))'),
    ['https://en.wikipedia.org/wiki/Knot_(band)']);
  assert.deepEqual(links('"https://example.com" <https://example.org/p>'),
    ['https://example.com', 'https://example.org/p']);
  assert.deepEqual(links('a http://localhost:8080/x b HTTPS://EXAMPLE.COM c'),
    ['http://localhost:8080/x', 'HTTPS://EXAMPLE.COM']);
  assert.deepEqual(links('第一行\nhttps://example.com/页面'), ['https://example.com/']);
});

test('the pieces always add up to the original text', () => {
  const texts = ['', 'plain', 'a https://x.org b', 'https://x.org.', 'x https://bad,', 'ftp://a.b'];
  for (const text of texts) assert.equal(splitLinks(text).map((p) => p.text).join(''), text);
});

test('only web links: other schemes, credentials, and look-alikes stay text', () => {
  for (const text of [
    'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/f', 'file:///etc/passwd',
    'www.example.com', 'https://', 'https://nodot', 'https://user:pw@example.com/',
    'https://bank.com@evil.test/', 'https://exаmple.com', // Cyrillic "а" inside the host
    `https://example.com/${'a'.repeat(2100)}`,
  ]) assert.deepEqual(links(text), [], text);
});

test('a link element opens in a new tab, without opener or referrer', () => {
  const [plain, a, rest] = linkify('go https://example.com/p now');
  assert.equal(plain, 'go ');
  assert.equal(a.tagName, 'A');
  assert.equal(a.getAttribute('target') ?? a.target, '_blank');
  assert.match(a.getAttribute('rel') ?? a.rel, /noopener/);
  assert.match(a.getAttribute('rel') ?? a.rel, /noreferrer/);
  assert.equal(a.href, 'https://example.com/p');
  assert.equal(a.textContent, 'https://example.com/p');
  assert.equal(rest, ' now');
});

test('every reaction emoji is accepted by receivers, and none is listed twice', () => {
  const all = [...QUICK, ...MORE];
  for (const emoji of all) assert.ok(isEmoji(emoji), emoji);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length >= 60);
});
