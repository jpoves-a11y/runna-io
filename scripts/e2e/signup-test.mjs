// End-to-end test of sign-up with email confirmation (POST /api/auth/register/start, /resend,
// /confirm) against the bundled Worker, with SendGrid mocked in-process: the test reads the code
// from the email the Worker sends.
//
//   npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
//     --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
//   rm -f scripts/e2e/.build/signup.db
//   DATABASE_URL=file:scripts/e2e/.build/signup.db npx drizzle-kit push --force
//   node scripts/e2e/signup-test.mjs
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.E2E_DATABASE_URL || `file:${path.join(here, '.build', 'signup.db')}`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  if (!condition) failures++;
}

// ---------- Mocked SendGrid ----------

/** Emails "sent" by the Worker: { to, subject, html } */
const sent = [];
const otherCalls = [];
/** When false, SendGrid refuses every email (address that doesn't exist, provider down...) */
let sendgridAccepts = true;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host === 'api.sendgrid.com') {
    if (!sendgridAccepts) return new Response('{"errors":[{"message":"refused"}]}', { status: 400 });
    const body = JSON.parse(init.body);
    sent.push({ to: body.personalizations[0].to[0].email, subject: body.subject, html: body.content[0].value });
    return new Response(null, { status: 202 });
  }
  otherCalls.push(url.href);
  throw new Error(`unexpected network call: ${url.href}`);
};

const worker = (await import('./.build/worker.mjs')).default;
const db = createClient({ url: databaseUrl });
const pending = [];
const env = {
  DATABASE_URL: databaseUrl,
  ENVIRONMENT: 'test',
  UPSTASH_CRON_SECRET: 'e2e-cron-secret',
  WORKER_URL: 'https://api.example.test',
  EMAIL_PROVIDER: 'sendgrid',
  SENDGRID_API_KEY: 'sendgrid-test-key',
  SENDGRID_FROM: 'no-reply@example.test',
  TERRITORY_QUEUE: { send: async () => {} },
};
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };

let ip = '203.0.113.1';
async function call(method, route, { token, body } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`http://127.0.0.1:8787${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return { status: res.status, data };
}

const lastCode = (to) => {
  const email = [...sent].reverse().find((e) => e.to === to);
  return email?.subject.match(/(\d{6})/)?.[1];
};
const one = async (sqlText, args = []) => (await db.execute({ sql: sqlText, args })).rows[0];

const stamp = Date.now() % 100000;
const username = `new${stamp}`;
const email = `New${stamp}@Example.test`;
const lower = email.toLowerCase();
const form = { name: 'Nueva Corredora', username, email, password: 'secret123', color: '#4DAF4A' };

// ---------- Form checks ----------

const badEmail = await call('POST', '/api/auth/register/start', { body: { ...form, email: 'not-an-email' } });
check('invalid email is rejected', badEmail.status === 400, badEmail);
const shortPassword = await call('POST', '/api/auth/register/start', { body: { ...form, password: '123' } });
check('short password is rejected', shortPassword.status === 400, shortPassword);
const spacedUsername = await call('POST', '/api/auth/register/start', { body: { ...form, username: 'a b c' } });
check('username with spaces is rejected', spacedUsername.status === 400, spacedUsername);

const legacy = await call('POST', '/api/users', { body: form });
check('old POST /api/users no longer creates accounts', legacy.status === 426 && !(await one('select id from users where lower(email) = ?', [lower])), legacy);

// ---------- Email that can't be delivered ----------

sendgridAccepts = false;
const refused = await call('POST', '/api/auth/register/start', { body: form });
check('undeliverable email: 503 and nothing kept', refused.status === 503 && !(await one('select email from pending_signups where email = ?', [lower])), refused);
sendgridAccepts = true;

// ---------- Step 1: the code is emailed, no account yet ----------

const start = await call('POST', '/api/auth/register/start', { body: form });
check('start emails a code', start.status === 200 && start.data.email === lower && !!lastCode(lower), start);
check('no account before the code is confirmed', !(await one('select id from users where lower(email) = ?', [lower])));
const login = await call('POST', '/api/auth/login', { body: { username, password: form.password } });
check('cannot sign in before confirming', login.status === 401, login);
const stored = await one('select code_hash, password_hash from pending_signups where email = ?', [lower]);
check('code and password are stored hashed', stored && !String(stored.code_hash).includes(lastCode(lower)) && String(stored.password_hash).startsWith('pbkdf2$'), stored);

// ---------- Resend: the old code stops working ----------

const firstCode = lastCode(lower);
const resend = await call('POST', '/api/auth/register/resend', { body: { email } });
const secondCode = lastCode(lower);
check('resend emails a new code', resend.status === 200 && sent.filter((e) => e.to === lower).length === 2, resend);
if (firstCode !== secondCode) {
  const old = await call('POST', '/api/auth/register/confirm', { body: { email, code: firstCode } });
  check('the previous code no longer works', old.status === 400, old);
}

// ---------- Wrong codes ----------

const wrong = await call('POST', '/api/auth/register/confirm', { body: { email, code: secondCode === '000000' ? '111111' : '000000' } });
check('wrong code says how many attempts are left', wrong.status === 400 && /intento/.test(wrong.data.error), wrong);

// ---------- Step 2: the right code creates the account and signs in ----------

const confirm = await call('POST', '/api/auth/register/confirm', { body: { email: lower, code: secondCode } });
check('confirm creates the account and returns a session', confirm.status === 200 && !!confirm.data.token && confirm.data.username === username, confirm);
check('the account email is verified', confirm.data.emailVerified === true, confirm.data);
check('the account email is stored lowercased', confirm.data.email === lower, confirm.data);
check('pending sign-up is removed', !(await one('select email from pending_signups where email = ?', [lower])));
check('welcome email sent', sent.some((e) => e.to === lower && /Bienvenido/.test(e.subject)), sent.map((e) => e.subject));
const me = await call('GET', `/api/current-user/${confirm.data.id}`, { token: confirm.data.token });
check('the session works', me.status === 200 && me.data.id === confirm.data.id, me);
const loginAfter = await call('POST', '/api/auth/login', { body: { username: email, password: form.password } });
check('can sign in with the chosen password', loginAfter.status === 200, loginAfter);
const replay = await call('POST', '/api/auth/register/confirm', { body: { email, code: secondCode } });
check('the code cannot be used twice', replay.status === 400, replay);

// ---------- Duplicates ----------

const sameEmail = await call('POST', '/api/auth/register/start', { body: { ...form, username: `other${stamp}`, email: email.toUpperCase() } });
check('same email (any letter case) is refused', sameEmail.status === 409 && /email/.test(sameEmail.data.error), sameEmail);
const sameUsername = await call('POST', '/api/auth/register/start', { body: { ...form, username: username.toUpperCase(), email: `other${stamp}@example.test` } });
check('same username (any letter case) is refused', sameUsername.status === 409 && /usuario/.test(sameUsername.data.error), sameUsername);

// Two sign-ups racing for one username: the second confirmation is refused
ip = '203.0.113.2';
const a = { ...form, username: `race${stamp}`, email: `racea${stamp}@example.test` };
const b = { ...form, username: `race${stamp}`, email: `raceb${stamp}@example.test` };
await call('POST', '/api/auth/register/start', { body: a });
await call('POST', '/api/auth/register/start', { body: b });
const confirmA = await call('POST', '/api/auth/register/confirm', { body: { email: a.email, code: lastCode(a.email) } });
const confirmB = await call('POST', '/api/auth/register/confirm', { body: { email: b.email, code: lastCode(b.email) } });
check('first of two racing sign-ups wins the username', confirmA.status === 200 && confirmB.status === 409, { confirmA, confirmB });

// ---------- Too many wrong codes ----------

ip = '203.0.113.3';
const c = { ...form, username: `guess${stamp}`, email: `guess${stamp}@example.test` };
await call('POST', '/api/auth/register/start', { body: c });
const right = lastCode(c.email);
const wrongCode = right === '000000' ? '111111' : '000000';
for (let i = 0; i < 5; i++) await call('POST', '/api/auth/register/confirm', { body: { email: c.email, code: wrongCode } });
const afterGuesses = await call('POST', '/api/auth/register/confirm', { body: { email: c.email, code: right } });
check('after 5 wrong codes the right one no longer works', afterGuesses.status === 400, afterGuesses);

// ---------- Email rate limit ----------

ip = '203.0.113.4';
const d = { ...form, username: `spam${stamp}`, email: `spam${stamp}@example.test` };
const answers = [];
for (let i = 0; i < 5; i++) answers.push((await call('POST', '/api/auth/register/start', { body: d })).status);
check('a 5th code to the same email within the hour is refused', answers.slice(0, 4).every((s) => s === 200) && answers[4] === 429, answers);

check('no unexpected network calls', otherCalls.length === 0, otherCalls);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
