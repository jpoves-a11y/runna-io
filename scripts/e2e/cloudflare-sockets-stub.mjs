// Stand-in for the Workers runtime module "cloudflare:sockets" when the Worker runs in Node
// (local API and CI). Only the Gmail SMTP email provider uses it; the local API sends no emails.
export function connect() {
  throw new Error('cloudflare:sockets is only available on Cloudflare Workers');
}
