import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipboardFiles, droppedFiles, nameClipboardFile, stageFiles,
} from '../src/ui/attach.js';

const clip = (files, types, plain = '') => (
  { files, types, getData: (type) => (type === 'text/plain' ? plain : '') }
);
const shot = () => new File(['x'], 'image.png', { type: 'image/png' });

test('a pasted screenshot gets a recognisable name', () => {
  const at = new Date(2026, 9, 26, 14, 5, 9);
  assert.equal(nameClipboardFile(shot(), at).name, 'pasted-20261026-140509.png');
  assert.equal(nameClipboardFile(new File([''], 'image.jpeg', { type: 'image/jpeg' }), at).name,
    'pasted-20261026-140509.jpg');
  assert.equal(nameClipboardFile(new File([''], '', { type: 'image/avif' }), at).name,
    'pasted-20261026-140509.avif');
  assert.equal(nameClipboardFile(new File([''], '', { type: '' }), at).name,
    'pasted-20261026-140509.bin');
  const named = new File(['x'], 'report.pdf', { type: 'application/pdf' });
  assert.equal(nameClipboardFile(named, at), named); // real names are kept
  assert.equal(nameClipboardFile(shot(), at).type, 'image/png');
});

test('clipboardFiles: screenshots, copied images and copied files are taken', () => {
  const [one] = clipboardFiles(clip([shot()], ['Files']));
  assert.match(one.name, /^pasted-\d{8}-\d{6}\.png$/);
  const finder = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
  const copied = clipboardFiles(clip([finder], ['text/plain', 'Files'], 'report.pdf'));
  assert.equal(copied[0].name, 'report.pdf'); // the file name as text does not hide the file
  const web = clipboardFiles(clip([shot()], ['text/html', 'Files'], ''));
  assert.equal(web.length, 1); // "Copy image" in a browser
});

test('clipboardFiles leaves rich text and empty clipboards alone', () => {
  const office = clip([shot()], ['text/plain', 'text/html', 'Files'], 'A1\tB1');
  assert.deepEqual(clipboardFiles(office), []);
  assert.deepEqual(clipboardFiles(clip([], ['text/plain'], 'hello')), []);
  assert.deepEqual(clipboardFiles(null), []);
});

test('droppedFiles skips folders and reports them', () => {
  const file = new File(['x'], 'a.txt');
  const item = (entryIsDir, f) => (
    { kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: entryIsDir }) }
  );
  const got = droppedFiles({ items: [item(false, file), item(true, null), { kind: 'string' }] });
  assert.deepEqual(got, { files: [file], folders: 1 });
  const old = droppedFiles({ files: [file] }); // no items API
  assert.deepEqual(old, { files: [file], folders: 0 });
});

test('stageFiles keeps what fits and reports what was refused', () => {
  const f = (name, size) => ({ name, size });
  const [a, b, c, big] = [f('a', 1), f('b', 2), f('c', 3), f('big', 99)];
  const first = stageFiles([], [a, b], { max: 3, maxBytes: 10 });
  assert.deepEqual(first, { list: [a, b], tooBig: [], tooMany: false });
  const more = stageFiles([a, b], [c, big, f('d', 1)], { max: 3, maxBytes: 10 });
  assert.deepEqual(more.list, [a, b, c]);
  assert.deepEqual(more.tooBig, [big]);
  assert.equal(more.tooMany, true);
  const staged = [a];
  stageFiles(staged, [b], { max: 3 });
  assert.deepEqual(staged, [a]); // the input is not modified
});
