import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  welcomeEmail, signupCodeEmail, passwordResetEmail, verificationCodeEmail, friendRequestEmail,
  friendAcceptedEmail, territoryStolenEmail, reportEmail, testEmail,
} from '../src/emailTemplates';
import { buildMessage } from '../src/mime';
import { unsubscribeToken, isValidUnsubscribeToken } from '../src/email';

const ctx = { baseUrl: 'https://api.example.test', supportEmail: 'soporte@example.test' };
const unsub = 'https://api.example.test/email/unsubscribe?u=u1&t=abc';
const all = [
  welcomeEmail(ctx, 'Ana López', unsub),
  signupCodeEmail(ctx, 'Ana', '123456', 15),
  passwordResetEmail(ctx, 'Ana', '654321', 15),
  verificationCodeEmail(ctx, 'Ana', '111222'),
  friendRequestEmail(ctx, 'Bea', 'bea', unsub),
  friendAcceptedEmail(ctx, 'Bea', 'bea', unsub),
  territoryStolenEmail(ctx, 'Bea', 'bea', 120000, unsub),
  reportEmail(ctx, { reporter: 'Ana', reported: 'Bea', targetType: 'comment', targetId: 'c1', reason: 'Insultos' }),
  testEmail(ctx),
];

test('every email has a subject without emoji, HTML and plain text', () => {
  for (const email of all) {
    assert.ok(email.subject.length > 5);
    assert.doesNotMatch(email.subject, /\p{Extended_Pictographic}/u, email.subject);
    assert.match(email.html, /<!doctype html>/i);
    assert.ok(email.text.length > 40);
    assert.doesNotMatch(email.text, /<[a-z]/i, 'plain text has no tags');
    assert.match(email.text, /El equipo de KM2/);
  }
});

test('HTML declares the dark version and sets text and background together', () => {
  for (const email of all) {
    assert.match(email.html, /<meta name="color-scheme" content="light dark">/);
    assert.match(email.html, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(email.html, /display:\s*grid|linear-gradient/);
    // The card and the page set their own background; the texts their own colour
    assert.match(email.html, /class="card" [^>]*style="[^"]*background:#FFFFFF/);
    assert.match(email.html, /class="txt h1" style="[^"]*color:#111418/);
  }
});

test('the KM2 logo heads every email, on its own black band, with a readable alt text', () => {
  for (const email of all) {
    assert.match(email.html, /bgcolor="#000000"[^>]*>\s*<img src="https:\/\/api\.example\.test\/brand\/km2-logo-email-v1\.png" width="240" height="118" alt="KM2 · Kaemedos" style="[^"]*color:#FFFFFF/);
    assert.equal((email.html.match(/<img /g) ?? []).length, 1, 'one image only');
  }
});

test('codes are in both versions; links are written out in the text', () => {
  const signup = all[1];
  assert.match(signup.subject, /123456/);
  assert.match(signup.html, />123456</);
  assert.match(signup.text, /123456/);
  const welcome = all[0];
  assert.match(welcome.text, /Abrir KM2: https:\/\/api\.example\.test\/open\?tab=map/);
  assert.match(welcome.text, /Darte de baja: https:\/\/api\.example\.test\/email\/unsubscribe/);
  assert.match(welcome.subject, /^Bienvenido a KM2, Ana$/);
});

test('account emails have no unsubscribe link; user text is escaped', () => {
  assert.doesNotMatch(all[1].html, /Darte de baja/);
  assert.doesNotMatch(all[2].html, /Darte de baja/);
  const evil = friendRequestEmail(ctx, '<script>x</script>', 'x', unsub);
  assert.doesNotMatch(evil.html, /<script>x/);
});

test('MIME message: multipart/alternative with plain text first, Reply-To and List-Unsubscribe', () => {
  const email = all[0];
  const raw = buildMessage({
    host: 'h', port: 465, username: 'u', password: 'p', fromEmail: 'from@example.test', fromName: 'KM2',
    to: 'ana@example.test', subject: email.subject, html: email.html, text: email.text, replyTo: 'soporte@example.test',
    headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Bad Header': 'x', 'X-Injected': 'a\r\nBcc: evil' },
  });
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="kaemedos-/);
  assert.ok(raw.indexOf('text/plain') < raw.indexOf('text/html'));
  assert.match(raw, /\r\nReply-To: soporte@example\.test\r\n/);
  assert.match(raw, /\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  assert.doesNotMatch(raw, /Bad Header|Bcc: evil/);
  const boundary = raw.match(/boundary="([^"]+)"/)![1];
  assert.match(raw, new RegExp(`--${boundary}--\\r\\n`));
});

test('unsubscribe links are signed', async () => {
  const token = await unsubscribeToken('secret', 'user-1');
  assert.equal(await isValidUnsubscribeToken('secret', 'user-1', token), true);
  assert.equal(await isValidUnsubscribeToken('secret', 'user-2', token), false);
  assert.equal(await isValidUnsubscribeToken('other', 'user-1', token), false);
  assert.equal(await isValidUnsubscribeToken('', 'user-1', token), false);
});

test('the email logo served by the Worker is a 480 x 236 PNG', async () => {
  const { emailLogoPng } = await import('../src/brandAssets.ts');
  const png = emailLogoPng();
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset);
  assert.equal(view.getUint32(16), 480);
  assert.equal(view.getUint32(20), 236);
});
