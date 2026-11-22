/**
 * Minimal SMTP client over Cloudflare's TCP sockets, for sending through Gmail with an app
 * password (free, no own domain needed: Gmail signs the messages of its own addresses).
 * Implicit TLS on port 465, AUTH LOGIN, one message per connection (plain text + HTML).
 */
import { connect } from 'cloudflare:sockets';

import { buildMessage, type SmtpMessage } from './mime';

export type { SmtpMessage };

const TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
