// MIME message of an email: headers (RFC 2047 for accents), multipart/alternative with plain text
// and HTML. Kept apart from smtp.ts (which needs Cloudflare's sockets) so it can be tested in Node.

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
  /** Plain-text version (multipart/alternative): spam filters distrust HTML-only email */
  text?: string;
  replyTo?: string;
  /** Extra headers (List-Unsubscribe…), ASCII values */
  headers?: Record<string, string>;
}

const encoder = new TextEncoder();

function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 2047 encoded header value, so accents and emoji survive. Each encoded word holds at most
 * 45 bytes (60 base64 characters) and the words go on folded lines, as the RFC requires.
 */
function encodeHeader(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && text.length <= 70) return text;
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (encoder.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${base64Utf8(word)}?=`).join('\r\n ');
}

/** Display name as an RFC 5322 quoted string (e.g. "KM2"; a bare dot or other specials would need it). */
function quoteDisplayName(name: string): string {
  if (!/^[\x20-\x7e]*$/.test(name)) return encodeHeader(name);
  return `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

const base64Lines = (text: string) => base64Utf8(text).replace(/.{1,76}/g, (line) => `${line}\r\n`);

export function buildMessage(msg: SmtpMessage): string {
  // No Message-ID: Gmail adds its own before signing (one made up here would claim its domain)
  const headers = [
    `From: ${quoteDisplayName(msg.fromName)} <${msg.fromEmail}>`,
    `To: ${msg.to}`,
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    ...Object.entries(msg.headers ?? {})
      .filter(([name, value]) => /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(value))
      .map(([name, value]) => `${name}: ${value}`),
  ];
  if (!msg.text) {
    return [...headers, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(msg.html)].join('\r\n');
  }
  const boundary = `runna-${crypto.randomUUID().replace(/-/g, '')}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(msg.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

