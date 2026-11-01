// tools/release-gate.mjs: when a tag may go to production. git and gh are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGate, SOAK_DAYS } from '../tools/release-gate.mjs';

const SHA = 'f'.repeat(40);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

/** A healthy release by default; `over` changes one thing at a time. */
function world(over = {}) {
  const w = {
    tags: { 'v0.4.0': SHA },
    version: '0.4.0',
    branches: ['origin/HEAD -> origin/main', 'origin/main'],
    ciRuns: [{ id: 1 }],
    deployments: [{ id: 10, created_at: daysAgo(8) }],
    statuses: { 10: [{ state: 'success' }] },
    issues: [],
    ...over,
  };
  return {
    git: (...args) => {
      if (args[0] === 'rev-parse') {
        const tag = /^refs\/tags\/(.+)\^\{commit\}$/.exec(args[1])[1];
        if (!w.tags[tag]) throw new Error('unknown revision');
        return `${w.tags[tag]}\n`;
      }
      if (args[0] === 'branch') return w.branches.map((b) => `  ${b}`).join('\n');
      throw new Error(`unexpected git ${args}`);
    },
    version: () => w.version,
    gh: (path) => {
      if (path.startsWith('actions/workflows/ci.yml/runs')) {
        assert.ok(path.includes(`head_sha=${SHA}`));
        return { workflow_runs: w.ciRuns };
      }
      if (path.startsWith('deployments?')) {
        assert.ok(path.includes('environment=github-pages'));
        return w.deployments;
      }
      const status = /^deployments\/(\d+)\/statuses/.exec(path);
      if (status) return w.statuses[status[1]] ?? [];
      if (path.startsWith('issues?')) return w.issues;
      throw new Error(`unexpected gh ${path}`);
    },
  };
}
const gate = (over, args = {}) => checkGate({ tag: 'v0.4.0', now: NOW, ...args }, world(over));

test('a soaked, green release on main goes through, and its commit is reported', async () => {
  const r = await gate();
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.sha, SHA);
});

test('the soak is a week by default', async () => {
  assert.equal(SOAK_DAYS, 7);
  const young = await gate({ deployments: [{ id: 10, created_at: daysAgo(6.5) }] });
  assert.equal(young.ok, false);
  assert.match(young.problems.join(), /not soaked: it has been on beta for 6\.5 of 7 days/);
  const edge = await gate({ deployments: [{ id: 10, created_at: daysAgo(7) }] });
  assert.equal(edge.ok, true);
});

test('the soak counts from the first successful beta deploy', async () => {
  const r = await gate({
    deployments: [
      { id: 12, created_at: daysAgo(1) },
      { id: 11, created_at: daysAgo(9) }, // never made it
      { id: 10, created_at: daysAgo(8) },
    ],
    statuses: {
      10: [{ state: 'success' }], 11: [{ state: 'failure' }], 12: [{ state: 'success' }],
    },
  });
  assert.equal(r.ok, true);
});

test('a commit that never reached beta has not soaked', async () => {
  const r = await gate({ deployments: [] });
  assert.match(r.problems.join(), /never deployed to beta/);
});

test('--force skips the soak and nothing else', async () => {
  const young = await gate(
    { deployments: [{ id: 10, created_at: daysAgo(1) }] },
    { force: true },
  );
  assert.equal(young.ok, true);
  assert.match(young.notes.join(), /soak skipped/);
  const never = await gate({ deployments: [] }, { force: true });
  assert.equal(never.ok, true);
  const red = await gate({ ciRuns: [], deployments: [] }, { force: true });
  assert.equal(red.ok, false);
  assert.match(red.problems.join(), /ci workflow has not passed/);
});

test('the tag must be the version of package.json at that commit', async () => {
  const r = await gate({ version: '0.4.1' });
  assert.match(r.problems.join(), /tag v0\.4\.0 is not v0\.4\.1/);
});

test('a tag that is not a release tag, or does not exist, is refused at once', async () => {
  for (const tag of ['0.4.0', 'v0.4', 'v0.4.0-rc1', 'main', '', undefined]) {
    const r = await checkGate({ tag, now: NOW }, world());
    assert.equal(r.ok, false, String(tag));
    assert.match(r.problems[0], /not a release tag/);
  }
  const missing = await checkGate({ tag: 'v9.9.9', now: NOW }, world());
  assert.match(missing.problems[0], /does not exist/);
});

test('the commit must be on main or a release branch', async () => {
  const stray = await gate({ branches: ['origin/feature/x'] });
  assert.match(stray.problems.join(), /neither main nor a release\/\* branch/);
  const hotfix = await gate({ branches: ['origin/release/0.4'] });
  assert.equal(hotfix.ok, true);
});

test('ci must have passed on exactly this commit', async () => {
  const r = await gate({ ciRuns: [] });
  assert.match(r.problems.join(), /ci workflow has not passed on fffffff/);
});

test('an open beta-blocker issue stops a release (a labelled PR does not)', async () => {
  const r = await gate({
    issues: [
      { number: 7, title: 'calls drop on Safari' },
      { number: 8, title: 'a pull request', pull_request: {} },
    ],
  });
  assert.deepEqual(r.problems, ['open beta-blocker: #7 calls drop on Safari']);
  const forced = await gate({ issues: [{ number: 7, title: 'x' }] }, { force: true });
  assert.equal(forced.ok, false, 'force does not override a blocker');
});

test('every problem is listed, not only the first', async () => {
  const r = await gate({
    version: '0.5.0', ciRuns: [], deployments: [], issues: [{ number: 1, title: 't' }],
  });
  assert.equal(r.problems.length, 4);
});
