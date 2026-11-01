// The deploy files agree with each other: workflows, scripts, Cloudflare config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BETA_ENVIRONMENT } from '../tools/release-gate.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');
const wrangler = JSON.parse(read('deploy/cloudflare/wrangler.json'));

test('every script and local action the workflows use exists', () => {
  const ref = /(?:\.\/|\s)(tools\/[\w.-]+\.(?:sh|mjs)|\.github\/actions\/[\w-]+|deploy\/[\w./-]+)/g;
  const used = new Set([...(ci + release).matchAll(ref)].map((m) => m[1]));
  assert.ok(used.size >= 5, [...used].join());
  for (const path of used) assert.ok(existsSync(resolve(root, path)), path);
});

test('beta is stamped by assemble.sh, in the environment the release gate looks at', () => {
  assert.match(ci, /tools\/assemble\.sh _site "\$GITHUB_SHA" beta/);
  assert.match(ci, new RegExp(`environment:\\s+name: ${BETA_ENVIRONMENT}\\b`));
});

test('prod is stamped by assemble.sh, behind the production environment and the gate', () => {
  assert.match(release, /tools\/assemble\.sh _site "\$SHA" prod/);
  assert.match(release, /environment:\s+name: production/);
  assert.match(release, /needs: verify/);
  assert.match(release, /node tools\/release-gate\.mjs --tag "\$TAG"/);
  assert.match(release, /tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]/);
});

test('only the deploy job gets the Cloudflare token; wrangler is pinned', () => {
  const tokenUses = release.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? [];
  assert.equal(tokenUses.length, 1);
  assert.match(release, /wranglerVersion: '\d+\.\d+\.\d+'/);
  assert.match(release, /permissions:\n {2}contents: read/, 'read-only by default');
});

test('wrangler serves the folder assemble.sh makes, on a custom domain', () => {
  const served = resolve(root, 'deploy/cloudflare', wrangler.assets.directory);
  assert.equal(served, resolve(root, '_site'));
  assert.equal(wrangler.main, undefined, 'assets only: no script');
  assert.equal(wrangler.routes.length, 1);
  assert.equal(wrangler.routes[0].custom_domain, true);
  assert.match(wrangler.routes[0].pattern, /^[a-z0-9.-]+\.[a-z]+$/);
  assert.match(wrangler.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('the Cloudflare headers cover what a meta tag cannot, and revalidate everything', () => {
  const headers = read('deploy/cloudflare/_headers');
  for (const want of [
    "Content-Security-Policy: frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
    'Strict-Transport-Security:',
    'Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)',
    'Cache-Control: no-cache',
  ]) assert.ok(headers.includes(want), want);
  assert.ok(headers.startsWith('/*\n'), 'one rule for every path');
  assert.match(release, /content-security-policy: frame-ancestors 'none'/i, 'and smoke checks it');
});

test('index.html carries the anchors the stamps replace, unstamped', () => {
  const html = read('index.html');
  assert.ok(html.includes('<meta name="build" content="">'));
  assert.ok(html.includes('<meta name="channel" content="dev">'));
});
