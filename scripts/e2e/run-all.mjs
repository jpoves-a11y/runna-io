// Runs every end-to-end test against the bundled Worker, each with a fresh SQLite database:
//   npm run test:e2e              (all of them)
//   npm run test:e2e -- season    (only the ones named)
// Builds scripts/e2e/.build/worker.mjs first. Exits with 1 if any test fails.
// suunto-test.mjs is left out: it needs real .fit files (see its header).
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const build = path.join(here, '.build');

const ALL = ['season', 'modes', 'ran-together', 'garmin', 'polar-webhook', 'launch-features', 'activity-profile', 'signup'];
const wanted = process.argv.slice(2);
const tests = wanted.length > 0 ? ALL.filter((t) => wanted.includes(t)) : ALL;
if (wanted.length > 0 && tests.length !== wanted.length) {
  console.error(`Unknown test(s): ${wanted.filter((t) => !ALL.includes(t)).join(', ')}. Known: ${ALL.join(', ')}`);
  process.exit(2);
}

function run(cmd, args, env = {}, quiet = false) {
  const res = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  return res;
}

mkdirSync(build, { recursive: true });
console.log('Building the Worker bundle…');
const bundle = run('npx', ['esbuild', 'worker/src/index.ts', '--bundle', '--format=esm', '--platform=node', '--target=node20',
  `--outfile=${path.join(build, 'worker.mjs')}`, '--alias:@libsql/client/web=@libsql/client',
  '--alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs', '--external:@libsql/client', '--log-level=warning']);
if (bundle.status !== 0) process.exit(1);

const results = [];
for (const test of tests) {
  const db = path.join(build, `ci-${test}.db`);
  rmSync(db, { force: true });
  const env = { DATABASE_URL: `file:${db}`, E2E_DATABASE_URL: `file:${db}` };
  const push = run('npx', ['drizzle-kit', 'push', '--force'], env, true);
  if (push.status !== 0) {
    console.error(push.stdout, push.stderr);
    results.push({ test, ok: false, failed: ['could not create the test database'] });
    continue;
  }
  const started = Date.now();
  const res = run('node', [path.join(here, `${test}-test.mjs`)], env, true);
  const output = `${res.stdout}${res.stderr}`;
  const lines = output.split('\n');
  const passed = lines.filter((l) => l.startsWith('PASS')).length;
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  const ok = res.status === 0 && failed.length === 0;
  results.push({ test, ok, passed, failed, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${ok ? '✓' : '✗'} ${test}: ${passed} passed, ${failed.length} failed (${Math.round((Date.now() - started) / 1000)} s)`);
  if (!ok) {
    // Failed checks, or the end of the output when the test crashed
    console.log(failed.length > 0 ? failed.join('\n') : lines.slice(-40).join('\n'));
  }
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length === 0 ? `\nAll ${results.length} e2e tests passed` : `\n${bad.length} e2e test(s) failed: ${bad.map((r) => r.test).join(', ')}`);
process.exit(bad.length === 0 ? 0 : 1);
