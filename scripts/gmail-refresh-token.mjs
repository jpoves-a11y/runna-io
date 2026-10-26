// Gets the Gmail refresh token the Worker uses to send emails (EMAIL_PROVIDER = "gmail").
// Run it on your computer (it opens Google's consent page in the browser):
//
//   node scripts/gmail-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// The OAuth client must be of type "Desktop app". Log in with the account that will send the
// emails (runna.io.service@gmail.com) and allow "Send email on your behalf". The script then prints
// the refresh token to store with: wrangler secret put GMAIL_REFRESH_TOKEN -c wrangler.worker.toml
import http from 'node:http';
import { exec } from 'node:child_process';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Uso: node scripts/gmail-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Error: ${error || 'sin código'}`);
    console.error('Google no ha devuelto un código:', error);
    server.close();
    return;
  }
  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.refresh_token) {
      throw new Error(JSON.stringify(data));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Listo. Vuelve a la terminal.');
    console.log('\nRefresh token (guárdalo como secreto GMAIL_REFRESH_TOKEN):\n');
    console.log(data.refresh_token);
    console.log('\nwrangler secret put GMAIL_REFRESH_TOKEN -c wrangler.worker.toml');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Error, mira la terminal.');
    console.error('No se pudo obtener el refresh token:', e.message);
  }
  server.close();
});

let redirectUri = '';
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  console.log('Abre esta URL e inicia sesión con la cuenta que enviará los emails:\n');
  console.log(authUrl + '\n');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);
});
