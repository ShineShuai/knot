import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEnvelope } from '../src/chat/envelope.js';
import { searchLog } from '../src/chat/search.js';
import { exportJson, exportText } from '../src/ui/export.js';
import { setLanguage } from '../src/ui/i18n.js';
import { toB64u } from '../src/util/bytes.js';
import { until } from './fakes.js';
import { pairRooms, stopRooms } from './room-kit.js';

test.afterEach(() => { stopRooms(); setLanguage('en'); });

test('search: any word order, no case or accents, sees edits and file names', async () => {
  const [a, b] = await pairRooms();
  await a.sendText('Meet at the Café at noon');
  const lunch = await a.sendText('lunch menu is ready');
  await a.editMessage(lunch.id, 'dinner menu is ready');
  await b.shareFile(new File(['x'], 'Holiday Photos.zip'));
  const gone = await a.sendText('delete me, café');
  await a.deleteMessage(gone.id);
  await until(() => a.log.list().some((e) => e.kind === 'file'));
  const find = (q) => searchLog(a, q).map((e) => e.kind === 'file' ? e.body.name : a.log.textOf(e));
  assert.deepEqual(find('cafe'), ['Meet at the Café at noon']);
  assert.deepEqual(find('NOON  café'), ['Meet at the Café at noon']);
  assert.deepEqual(find('menu'), ['dinner menu is ready']);
  assert.deepEqual(find('lunch'), [], 'the edited-away text is not found');
  assert.deepEqual(find('photos'), ['Holiday Photos.zip']);
  assert.deepEqual(find('   '), []);
  assert.deepEqual(find('zebra'), []);
  assert.equal(searchLog(a, 'e', 2).length, 2, 'the limit keeps the newest');
});

test('the text export reads like a chat: edits, quotes, reactions, notices, files', async () => {
  const [a, b] = await pairRooms();
  const hello = await a.sendText('hello\nsecond line');
  await until(() => b.log.get(hello.id));
  await b.sendText('hi Ada', b.log.get(hello.id));
  await a.editMessage(hello.id, 'hello!\nsecond line');
  await b.react(hello.id, '👍');
  await a.react(hello.id, '👍');
  const doomed = await a.sendText('oops');
  await a.deleteMessage(doomed.id);
  await a.shareFile(new File([new Uint8Array(2048)], 'notes.txt'));
  await until(() => a.log.where((e) => e.kind === 'react').length === 2);
  const text = exportText(a, Date.UTC(2026, 9, 28, 12, 0));
  const lines = text.split('\n');
  assert.equal(lines[0], 'Ada');
  assert.match(lines[1], /^Exported 2026-10-28 \d\d:\d\d by Ada$/);
  assert.ok(lines.some((l) => /^\[[\d-]+ [\d:]+\] Ada \(edited\): hello!$/.test(l)));
  assert.ok(lines.includes('    second line'), 'continuation lines are indented');
  assert.ok(lines.some((l) => /^\[.*\] Bob: hi Ada$/.test(l)));
  assert.ok(lines.includes('    > Ada: hello second line'));
  assert.ok(lines.includes('    👍 Ada, Bob') || lines.includes('    👍 Bob, Ada'));
  assert.ok(lines.some((l) => /^\[.*\] \* You deleted a message$/.test(l)));
  assert.ok(lines.some((l) => /^\[.*\] Ada: \[file\] notes\.txt \(2\.0 KB\)$/.test(l)), text);
  assert.ok(!text.includes('oops'), 'deleted content is gone');
  setLanguage('de');
  assert.match(exportText(a, 0).split('\n')[1], /^Exportiert am 1970-01-01 \d\d:\d\d von Ada$/);
});

test('the JSON export is the signed envelopes, and leaks no secret', async () => {
  const [a, b] = await pairRooms();
  const msg = await a.sendText('hello');
  await until(() => b.log.get(msg.id));
  await b.react(msg.id, '👍');
  await until(() => a.log.where((e) => e.kind === 'react').length === 1);
  const data = JSON.parse(exportJson(a, Date.UTC(2026, 9, 28)));
  assert.equal(data.format, 'knot-history');
  assert.equal(data.room.id, a.id);
  assert.equal(data.exportedAt, '2026-10-28T00:00:00.000Z');
  assert.equal(data.messages.length, 2);
  for (const env of data.messages) assert.equal(await verifyEnvelope(env, a.id), true);
  assert.ok(!JSON.stringify(data).includes(toB64u(a.secret)));
});
