// Finds Playwright for the end-to-end tests, so nobody has to set PLAYWRIGHT_MODULE by hand.
// Order: PLAYWRIGHT_MODULE (a folder named "playwright"), a normal `require('playwright')`
// from this project or above, the global npm folder, the cache of `npx playwright ...`.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const globalRoot = () => execSync(
  'npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
).trim();

/** Where to look, best first. Every piece comes from `env` so a test can fake it. */
export function candidates({
  env = process.env, root = globalRoot, home = homedir(), list = readdirSync, exists = existsSync,
} = {}) {
  const found = [];
  if (env.PLAYWRIGHT_MODULE) found.push(env.PLAYWRIGHT_MODULE);
  found.push('playwright');
  try { found.push(join(root(), 'playwright')); } catch { /* no npm: skip */ }
  const npx = join(home, '.npm', '_npx');
  if (exists(npx)) {
    for (const dir of list(npx)) found.push(join(npx, dir, 'node_modules', 'playwright'));
  }
  return found;
}

/** The Playwright module, or an Error that says how to get one. */
export function loadPlaywright({
  env = process.env, load = createRequire(import.meta.url), ...where
} = {}) {
  const tried = [];
  for (const spec of candidates({ env, ...where })) {
    try {
      const playwright = load(spec);
      if (playwright.chromium) return playwright;
    } catch { /* not here */ }
    tried.push(spec);
  }
  const given = env.PLAYWRIGHT_MODULE
    ? `PLAYWRIGHT_MODULE=${env.PLAYWRIGHT_MODULE} is not a Playwright folder. ` : '';
  throw new Error(`${given}Playwright was not found. Install it once:\n`
    + '    npm install --no-save playwright && npx playwright install chromium firefox webkit\n'
    + 'or set PLAYWRIGHT_MODULE to the "playwright" folder of an installation, for example\n'
    + `    PLAYWRIGHT_MODULE=$(npm root -g)/playwright\nTried:\n  ${tried.join('\n  ')}`);
}
