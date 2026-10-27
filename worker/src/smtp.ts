/**
 * Minimal SMTP client over Cloudflare's TCP sockets, for sending through Gmail with an app
 * password (free, no own domain needed: Gmail signs the messages of its own addresses).
 * Implicit TLS on port 465, AUTH LOGIN, one HTML message per connection.
 */
import { connect } from 'cloudflare:sockets';

export interface SmtpMessage {
  host: string;
  port: number;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
}

const TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RFC 2047 encoded header value, so accents and emoji survive. */
function encodeHeader(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64Utf8(text)}?=`;
}

function buildMessage(msg: SmtpMessage): string {
  const body = base64Utf8(msg.html).replace(/.{1,76}/g, (line) => `${line}\r\n`);
  const domain = msg.fromEmail.split('@')[1] || 'localhost';
  return [
    `From: ${encodeHeader(msg.fromName)} <${msg.fromEmail}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Sends one message; throws with the server's reply when any step fails. */
export async function sendSmtp(msg: SmtpMessage): Promise<void> {
  const socket = connect({ hostname: msg.host, port: msg.port }, { secureTransport: 'on', allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let buffered = '';

  // Reads one reply (multi-line replies end with a "NNN " line) and checks its code
  const reply = async (expected: number): Promise<string> => {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const lines = buffered.split('\r\n');
      const last = lines.findIndex((line) => /^\d{3} /.test(line));
      if (last >= 0) {
        const text = lines.slice(0, last + 1).join('\n');
        buffered = lines.slice(last + 1).join('\r\n');
        if (Number(text.slice(text.lastIndexOf('\n') + 1, text.lastIndexOf('\n') + 4)) !== expected) {
          throw new Error(`SMTP: ${text.replace(/\n/g, ' ').slice(0, 300)}`);
        }
        return text;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('SMTP: timeout waiting for the server');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SMTP: timeout waiting for the server')), remaining)),
      ]);
      if (chunk.done) throw new Error('SMTP: connection closed by the server');
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  const command = async (line: string, expected: number) => {
    await writer.write(encoder.encode(`${line}\r\n`));
    return reply(expected);
  };

  try {
    await reply(220);
    await command('EHLO runna-io', 250);
    await command('AUTH LOGIN', 334);
    await command(btoa(msg.username), 334);
    await command(btoa(msg.password), 235);
    await command(`MAIL FROM:<${msg.fromEmail}>`, 250);
    await command(`RCPT TO:<${msg.to}>`, 250);
    await command('DATA', 354);
    // Dot-stuffing isn't needed: the base64 body never starts a line with "."
    await command(`${buildMessage(msg)}\r\n.`, 250);
    await command('QUIT', 221).catch(() => undefined);
  } finally {
    try { await socket.close(); } catch { /* already closed */ }
  }
}
