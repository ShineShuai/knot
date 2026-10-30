// Runs the end-to-end tests in every browser that is installed, one after the other.
//   npx playwright install firefox webkit   (once; Chromium is probably there already)
//   PLAYWRIGHT_MODULE=... npm run test:e2e:all
import { spawnSync } from 'node:child_process';
import { BROWSERS } from './browsers.mjs';

const results = BROWSERS.map((name) => {
  console.log(`\n=== ${name} ===`);
  const run = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname], {
    stdio: 'inherit', env: { ...process.env, E2E_BROWSER: name, E2E_SKIP_MISSING: '1' },
  });
  return [name, run.status];
});
console.log(`\n${results.map(([name, status]) => `${name}: ${status === 0 ? 'ok' : 'FAILED'}`)
  .join('   ')}`);
process.exit(results.some(([, status]) => status !== 0) ? 1 : 0);
