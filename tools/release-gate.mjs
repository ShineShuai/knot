// Decides whether a tag may be deployed to production. Used by .github/workflows/release.yml.
//   node tools/release-gate.mjs --tag v0.4.0 [--force]
// Needs: git (full history and tags), the gh CLI with GH_TOKEN and GITHUB_REPOSITORY. It reads
// the tag from git and need not be checked out, so a rollback to an old tag runs today's gate.
// Every check runs and every failure is listed. `--force` (hotfix, rollback) skips only the
// beta soak; a red build, a wrong tag or an open `beta-blocker` issue still stop a release.
// Writes `sha=<commit>` to $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SOAK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const BETA_ENVIRONMENT = 'github-pages'; // the deployment that ci.yml makes on every green main
const TAG = /^v\d+\.\d+\.\d+$/;

/**
 * `deps`: { git(...args) -> string (throws on failure), gh(path) -> parsed JSON,
 *           version() -> the version in package.json at the checked-out tag }.
 * Returns { ok, sha, problems[], notes[] }.
 */
export async function checkGate(
  { tag, force = false, now = Date.now(), soakDays = SOAK_DAYS },
  deps,
) {
  const problems = [];
  const notes = [];
  if (!TAG.test(tag ?? '')) {
    return { ok: false, sha: null, problems: [`not a release tag: ${tag}`], notes };
  }

  let sha = null;
  try { sha = deps.git('rev-parse', `refs/tags/${tag}^{commit}`).trim(); } catch {
    return { ok: false, sha: null, problems: [`tag ${tag} does not exist`], notes };
  }

  const version = deps.version(sha);
  if (tag !== `v${version}`) problems.push(`tag ${tag} is not v${version} (package.json)`);

  const branches = deps.git('branch', '-r', '--contains', sha).split('\n').map((b) => b.trim());
  if (!branches.some((b) => b === 'origin/main' || b.startsWith('origin/release/'))) {
    problems.push(`${sha.slice(0, 7)} is on neither main nor a release/* branch`);
  }

  const runs = await deps.gh(
    `actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=1`,
  );
  if (!runs.workflow_runs?.length) {
    problems.push(`the ci workflow has not passed on ${sha.slice(0, 7)}`);
  }

  const beta = await betaSince(sha, deps);
  if (beta === null) notes.push('never deployed to beta');
  else notes.push(`on beta since ${new Date(beta).toISOString()}`);
  const soaked = beta !== null && now - beta >= soakDays * DAY_MS;
  if (!soaked) {
    const text = beta === null ? 'it was never deployed to beta'
      : `it has been on beta for ${((now - beta) / DAY_MS).toFixed(1)} of ${soakDays} days`;
    if (force) notes.push(`soak skipped (--force): ${text}`);
    else problems.push(`not soaked: ${text}`);
  }

  const issues = await deps.gh('issues?labels=beta-blocker&state=open&per_page=100');
  const blockers = issues.filter((i) => !i.pull_request);
  for (const i of blockers) problems.push(`open beta-blocker: #${i.number} ${i.title}`);

  return { ok: problems.length === 0, sha, problems, notes };
}

/** When this commit first reached beta successfully (ms), or null. */
async function betaSince(sha, deps) {
  const deployments = await deps.gh(
    `deployments?sha=${sha}&environment=${BETA_ENVIRONMENT}&per_page=100`,
  );
  const times = [];
  for (const d of deployments) {
    const statuses = await deps.gh(`deployments/${d.id}/statuses?per_page=1`); // newest first
    if (statuses[0]?.state === 'success') times.push(Date.parse(d.created_at));
  }
  return times.length ? Math.min(...times) : null;
}

function realDeps(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const run = (cmd, args) => execFileSync(
    cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const git = (...args) => run('git', args);
  return {
    git,
    gh: (path) => JSON.parse(run('gh', ['api', `repos/${repo}/${path}`])),
    version: (sha) => JSON.parse(git('show', `${sha}:package.json`)).version,
  };
}

function parseArgs(argv) {
  const args = { force: false, tag: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--tag') args.tag = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkGate(parseArgs(process.argv.slice(2)), realDeps());
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const problem of result.problems) console.log(`FAIL: ${problem}`);
  if (result.ok) {
    console.log(`release gate passed for ${result.sha}`);
    const out = process.env.GITHUB_OUTPUT;
    if (out) appendFileSync(out, `sha=${result.sha}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}
