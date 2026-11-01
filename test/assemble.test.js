// tools/assemble.sh: the site that goes to GitHub Pages (beta) and Cloudflare (prod).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../tools/assemble.sh', import.meta.url).pathname;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const skip = process.platform === 'win32' && 'needs bash';
const scratch = mkdtempSync(join(tmpdir(), 'knot-assemble-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function assemble(channel, sha = SHA) {
  const out = join(scratch, `site-${counter++}`);
  execFileSync('bash', [SCRIPT, out, sha, channel], { stdio: 'pipe' });
  return out;
}
const files = (dir) => new Map(readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => {
    const path = join(e.parentPath, e.name);
    return [path.slice(dir.length + 1), readFileSync(path)];
  }));
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

test('beta: stamped with the commit and the channel, for GitHub Pages', { skip }, () => {
  const out = assemble('beta');
  assert.match(read(out, 'index.html'), new RegExp(`<meta name="build" content="${SHA}">`));
  assert.match(read(out, 'index.html'), /<meta name="channel" content="beta">/);
  assert.deepEqual(JSON.parse(read(out, 'build.json')), { build: SHA });
  assert.ok(files(out).has('.nojekyll'));
  assert.ok(!files(out).has('_headers'), 'GitHub Pages cannot use it');
  const manifest = JSON.parse(read(out, 'manifest.webmanifest'));
  assert.equal(manifest.short_name, 'knot β', 'told apart from prod on a home screen');
  assert.match(manifest.name, /^knot β/);
});

test('prod: stamped, with the Cloudflare headers, and the plain manifest', { skip }, () => {
  const out = assemble('prod');
  assert.match(read(out, 'index.html'), /<meta name="channel" content="prod">/);
  assert.match(read(out, 'index.html'), new RegExp(`<meta name="build" content="${SHA}">`));
  assert.deepEqual(JSON.parse(read(out, 'build.json')), { build: SHA });
  assert.equal(read(out, '_headers'), readFileSync(
    new URL('../deploy/cloudflare/_headers', import.meta.url), 'utf8',
  ));
  assert.ok(!files(out).has('.nojekyll'));
  assert.equal(read(out, 'manifest.webmanifest'), readFileSync(
    new URL('../manifest.webmanifest', import.meta.url), 'utf8',
  ));
});

test('the same commit and channel always give the same bytes', { skip }, () => {
  for (const channel of ['beta', 'prod']) {
    assert.deepEqual(files(assemble(channel)), files(assemble(channel)), channel);
  }
});

test('beta and prod differ only in what the channel decides', { skip }, () => {
  const [beta, prod] = [files(assemble('beta')), files(assemble('prod'))];
  const names = new Set([...beta.keys(), ...prod.keys()]);
  const differing = [...names].filter(
    (n) => !beta.has(n) || !prod.has(n) || !beta.get(n).equals(prod.get(n)),
  );
  assert.deepEqual(
    differing.sort(),
    ['.nojekyll', '_headers', 'index.html', 'manifest.webmanifest'],
  );
});

test('only what the browser needs is shipped', { skip }, () => {
  const top = new Set([...files(assemble('prod')).keys()].map((n) => n.split('/')[0]));
  assert.deepEqual(
    [...top].sort(),
    ['_headers', 'build.json', 'css', 'icons', 'index.html', 'lab', 'manifest.webmanifest',
      'src', 'sw.js'],
  );
});

test('a bad commit id, channel or existing output directory is refused', { skip }, () => {
  const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  const out = join(scratch, 'refused');
  assert.equal(run(out, 'not-a-sha', 'beta').status, 2);
  assert.equal(run(out, SHA, 'staging').status, 2);
  assert.equal(run(out).status, 2);
  mkdirSync(out);
  const exists = run(out, SHA, 'beta');
  assert.equal(exists.status, 1);
  assert.match(exists.stderr, /exists/);
});
