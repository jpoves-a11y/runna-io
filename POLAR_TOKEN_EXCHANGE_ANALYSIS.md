# Polar Token Exchange Implementation - Detailed Analysis

## Overview
The Runna.io application implements Polar OAuth2 integration with token exchange via HTTP Basic Authentication. This document provides a complete analysis of the token exchange flow.

---

## 1. THE EXACT TOKEN EXCHANGE REQUEST

### Endpoint: `/api/polar/callback` (GET)
- **Location**: [worker/src/routes.ts](worker/src/routes.ts#L841)
- **Alternative**: [server/routes.ts](server/routes.ts#L829)

### Token Exchange Request Details

```typescript
// Line 867-880 in worker/src/routes.ts

const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);

const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${authHeader}`,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri,
  }).toString(),
});
```

### Server Implementation (Nearly Identical)
[server/routes.ts](server/routes.ts#L854-L868)
```typescript
const redirectUri = getPolarRedirectUri();
const authHeader = Buffer.from(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`).toString('base64');

const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${authHeader}`,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri,
  }).toString(),
});
```

---

## 2. REQUEST HEADERS AND BODY

### Headers
| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `application/x-www-form-urlencoded` | Standard OAuth2 form encoding |
| `Authorization` | `Basic <base64-encoded-credentials>` | HTTP Basic Auth |

### Headers Details

**Authorization Header Encoding:**
- **Worker (browser-compatible)**: `btoa('${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}')`
- **Server (Node.js)**: `Buffer.from('${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}').toString('base64')`
- **Result**: Base64-encoded string in format `Basic {base64_value}`

Example:
```
If POLAR_CLIENT_ID = "12345" and POLAR_CLIENT_SECRET = "secret-xyz"
Then: Basic MTIzNDU6c2VjcmV0LXh5eg==
```

### Request Body
Form-encoded parameters sent via URLSearchParams:

```
grant_type=authorization_code
code=<authorization_code_from_callback>
redirect_uri=<callback_uri>
```

### Body Example
```
grant_type=authorization_code&code=abc123def456&redirect_uri=https%3A%2F%2Frunna-io-api.runna-io-api.workers.dev%2Fapi%2Fpolar%2Fcallback
```

---

## 3. AUTHENTICATION METHOD

### Type: HTTP Basic Authentication (OAuth2 Confidential Client)

**How It Works:**
1. Combine credentials: `CLIENT_ID:CLIENT_SECRET`
2. Base64 encode the combined string
3. Prepend "Basic " to the encoded string
4. Send in Authorization header

**Endpoint**: `https://polaraccesslink.com/v3/oauth2/token`

**Method**: POST

**Authentication Flow:**
```
1. User authorizes app on Polar (flow.polar.com/oauth2/authorization)
2. Polar redirects to callback with authorization code
3. App exchanges code for access token using Basic Auth
4. Polar validates credentials and returns tokens
```

---

## 4. VARIABLES AND CREDENTIALS REQUIRED

### Environment Variables (Worker)
[worker/src/index.ts](worker/src/index.ts#L12-L13)

```typescript
export interface Env {
  DATABASE_URL: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_WEBHOOK_VERIFY_TOKEN: string;
  STRAVA_REDIRECT_URI?: string;
  POLAR_CLIENT_ID?: string;        // Required for Polar OAuth
  POLAR_CLIENT_SECRET?: string;    // Required for Polar OAuth
  WORKER_URL?: string;              // Optional, defaults to hardcoded URL
  FRONTEND_URL?: string;            // Redirect destination after success
}
```

### Environment Variables (Server/Node.js)
[server/routes.ts](server/routes.ts#L778-L784)

```typescript
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;

// Dynamic redirect URI construction
function getPolarRedirectUri(): string {
  // Priority: 1) REPLIT_DEV_DOMAIN, 2) POLAR_REDIRECT_DOMAIN, 3) localhost:5000
  const domain = process.env.REPLIT_DEV_DOMAIN || 
                 process.env.POLAR_REDIRECT_DOMAIN || 
                 'localhost:5000';
  const protocol = domain.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${domain}/api/polar/callback`;
}
```

### Variable Retrieval in Callback
[worker/src/routes.ts](worker/src/routes.ts#L846-L847)

```typescript
const POLAR_CLIENT_ID = c.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = c.env.POLAR_CLIENT_SECRET;
const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna.io';
```

### Validation
[worker/src/routes.ts](worker/src/routes.ts#L854-L855)

```typescript
if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid`);
}
```

---

## 5. WHERE CREDENTIALS SHOULD COME FROM

### For Cloudflare Workers Deployment

1. **Set Secrets via Wrangler CLI:**
   ```bash
   wrangler secret put POLAR_CLIENT_ID
   # (paste your Client ID)
   
   wrangler secret put POLAR_CLIENT_SECRET
   # (paste your Client Secret)
   ```

2. **Environment Variables in `wrangler.toml`** (for non-secret values):
   ```toml
   [env.production]
   vars = { 
     WORKER_URL = "https://runna-io-api.YOUR-ACCOUNT.workers.dev",
     FRONTEND_URL = "https://runna.io"
   }
   ```

### For Local/Server Development

1. **Create `.env` file:**
   ```
   POLAR_CLIENT_ID=your_client_id_here
   POLAR_CLIENT_SECRET=your_client_secret_here
   POLAR_REDIRECT_DOMAIN=localhost:5000
   REPLIT_DEV_DOMAIN=your-replit-domain.repl.co (optional)
   DATABASE_URL=your_database_url
   ```

2. **Load via `dotenv` package** (should be configured in your server setup)

### Credential Sources

**Polar Credentials come from:**
- Polar Developer Dashboard (flow.polar.com or www.polaraccesslink.com)
- Registration as an OAuth2 application
- Client ID and Client Secret provided by Polar upon registration

---

## 6. ERROR HANDLING AND ERROR CATCHING

### Primary Error Handler
[worker/src/routes.ts](worker/src/routes.ts#L879-L883)

```typescript
if (!tokenResponse.ok) {
  console.error('Polar token exchange failed:', await tokenResponse.text());
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
}
```

### Server Error Handler
[server/routes.ts](server/routes.ts#L858-L862)

```typescript
if (!tokenResponse.ok) {
  console.error('Polar token exchange failed:', await tokenResponse.text());
  return res.redirect('/profile?polar_error=token_exchange');
}
```

### Response Status Checks
- **Success**: `tokenResponse.ok === true` (status 200-299)
- **Failure**: Any non-2xx status code triggers error handling
- **Logged**: Full response text from Polar is logged to console
- **User Feedback**: Redirect with error parameter: `?polar_error=token_exchange`

### Additional Error Handling Points

#### 1. Missing Required Parameters
[worker/src/routes.ts](worker/src/routes.ts#L854-L855)
```typescript
if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid`);
}
```

#### 2. Invalid State Decoding
[worker/src/routes.ts](worker/src/routes.ts#L857-L862)
```typescript
let userId: string;
try {
  const decoded = JSON.parse(atob(state as string));
  userId = decoded.userId;
} catch {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
}
```

#### 3. Auth Error from Polar
[worker/src/routes.ts](worker/src/routes.ts#L849-L851)
```typescript
const authError = c.req.query('error');
if (authError) {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=denied`);
}
```

#### 4. Polar User Registration Failure
[worker/src/routes.ts](worker/src/routes.ts#L890-L898)
```typescript
try {
  const registerResponse = await fetch('https://www.polaraccesslink.com/v3/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`,
    },
    body: JSON.stringify({ 'member-id': userId }),
  });

  if (!registerResponse.ok && registerResponse.status !== 409) {
    console.error('Polar user registration failed:', await registerResponse.text());
    return c.redirect(`${FRONTEND_URL}/profile?polar_error=registration`);
  }
} catch (e) {
  console.error('Polar registration error:', e);
}
```

#### 5. Duplicate Account Detection
[worker/src/routes.ts](worker/src/routes.ts#L885-L888)
```typescript
const existingAccount = await storage.getPolarAccountByPolarUserId(x_user_id);
if (existingAccount && existingAccount.userId !== userId) {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=already_linked`);
}
```

#### 6. Catch-All Exception Handler
[worker/src/routes.ts](worker/src/routes.ts#L932-L935)
```typescript
} catch (error: any) {
  console.error('Polar callback error:', error);
  return c.redirect(`${c.env.FRONTEND_URL || 'https://runna.io'}/profile?polar_error=server`);
}
```

### Error Redirect Parameters
| Error Type | Parameter | Meaning |
|------------|-----------|---------|
| Authorization Denied | `?polar_error=denied` | User denied permission |
| Missing Parameters | `?polar_error=invalid` | Code, state, or credentials missing |
| Invalid State | `?polar_error=invalid_state` | Cannot decode state parameter |
| Token Exchange Failed | `?polar_error=token_exchange` | Polar token endpoint returned error |
| Registration Failed | `?polar_error=registration` | Polar user registration failed |
| Already Linked | `?polar_error=already_linked` | Account already linked to another user |
| Server Error | `?polar_error=server` | Unexpected exception in callback |

---

## 7. CORS CONFIGURATION

### Worker CORS Setup
[worker/src/index.ts](worker/src/index.ts#L20-L35)

```typescript
app.use('*', cors({
  origin: (origin) => {
    // Whitelist of allowed origins
    const allowedOrigins = [
      'https://runna-io.pages.dev',
      'http://localhost:5000',
      'http://localhost:3000',
    ];
    
    // Allow preview deployments on runna-io.pages.dev
    if (origin && (allowedOrigins.includes(origin) || origin.endsWith('.runna-io.pages.dev'))) {
      return origin;
    }
    
    // Default to first allowed origin
    return allowedOrigins[0];
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
```

### CORS Implications for Token Exchange

**GET /api/polar/callback:**
- Browser redirects (not CORS-protected)
- Works across origins via HTTP redirect
- No preflight needed

**POST requests to Polar APIs:**
- Made from server-side (Worker), not browser
- No CORS restrictions apply
- Basic Auth header used (no CORS headers needed)

### Allowed Methods for API Calls
- `GET` - Status checks, initiating OAuth
- `POST` - Token exchange, disconnection
- `PATCH` - Updates
- `DELETE` - Account deletion
- `OPTIONS` - Preflight

### Allowed Headers
- `Content-Type: application/x-www-form-urlencoded` (form data)
- `Content-Type: application/json` (JSON payloads)
- `Authorization: Basic ...` (Basic Auth)
- `Authorization: Bearer ...` (Bearer tokens)

---

## 8. BASIC AUTH LOGGING AND DEBUGGING

### Log Locations

#### 1. Token Exchange Failure
[worker/src/routes.ts](worker/src/routes.ts#L880)
```typescript
console.error('Polar token exchange failed:', await tokenResponse.text());
```
- **Triggered**: When Polar returns non-2xx status
- **Logged**: Full response text from Polar
- **Purpose**: Debugging auth failures

#### 2. Registration Error
[worker/src/routes.ts](worker/src/routes.ts#L894)
```typescript
console.error('Polar user registration failed:', await registerResponse.text());
```
- **Triggered**: When user registration fails
- **Logged**: Registration response details

#### 3. Registration Network Error
[worker/src/routes.ts](worker/src/routes.ts#L901)
```typescript
console.error('Polar registration error:', e);
```
- **Triggered**: Catch block for registration request
- **Non-blocking**: Continues despite error

#### 4. Callback General Error
[worker/src/routes.ts](worker/src/routes.ts#L933)
```typescript
console.error('Polar callback error:', error);
```
- **Triggered**: Any uncaught exception in callback handler
- **Logged**: Full error object

### Where to Find Logs

**Cloudflare Workers:**
- Wrangler CLI: `wrangler tail` command
- Cloudflare Dashboard: Workers → Logs tab
- Real-time stream of console output

**Local Development:**
- Node.js console/terminal output
- Should show all `console.error()` calls

### Basic Auth Debugging

**What's NOT logged:**
- The actual credentials (CLIENT_ID:CLIENT_SECRET) are never logged
- The Authorization header is NOT logged
- Base64-encoded credentials are NOT logged

**What IS logged when things fail:**
- The HTTP status code from Polar
- The response body from Polar (error message)
- Any exceptions during the request

**To Debug Missing/Invalid Credentials:**
1. Check Cloudflare/Wrangler logs for "invalid" errors
2. Verify `POLAR_CLIENT_ID` and `POLAR_CLIENT_SECRET` are set:
   ```bash
   wrangler secret list
   ```
3. Verify credentials match Polar developer dashboard
4. Check URL is exactly: `https://polaraccesslink.com/v3/oauth2/token`

---

## 9. RESPONSE HANDLING

### Successful Token Response
[worker/src/routes.ts](worker/src/routes.ts#L884-L886)

```typescript
const tokenData: any = await tokenResponse.json();
const { access_token, x_user_id } = tokenData;
```

**Expected Response Fields:**
- `access_token`: Bearer token for API calls
- `x_user_id`: Numeric user ID from Polar (used for duplicate detection)
- Additional fields: `refresh_token`, `expires_in`, `token_type` (if applicable)

### Token Storage
[worker/src/routes.ts](worker/src/routes.ts#L912-L920)

```typescript
const polarAccountData = {
  userId,              // App user ID
  polarUserId: x_user_id,   // Polar numeric ID
  accessToken: access_token, // Bearer token
  memberId: userId,    // Alias for userId
  registeredAt: new Date(),
  lastSyncAt: null,
};
```

### Persistence
[worker/src/routes.ts](worker/src/routes.ts#L922-L925)

```typescript
if (existingAccount) {
  await storage.updatePolarAccount(userId, polarAccountData);
} else {
  await storage.createPolarAccount(polarAccountData);
}
```

---

## 10. COMPARISON: WORKER vs SERVER IMPLEMENTATION

### Similarities
✅ Both use HTTP Basic Auth with base64-encoded credentials  
✅ Both make POST to `https://polaraccesslink.com/v3/oauth2/token`  
✅ Both use identical request body parameters  
✅ Both extract `access_token` and `x_user_id` from response  
✅ Both perform user registration and duplicate detection  
✅ Both store credentials in database  

### Differences

| Aspect | Worker | Server |
|--------|--------|--------|
| Base64 Encoding | `btoa()` (browser API) | `Buffer.from().toString('base64')` (Node.js) |
| Redirect URI | Hardcoded default or `c.env.WORKER_URL` | Dynamic via `getPolarRedirectUri()` function |
| Error Response | `c.redirect()` | `res.redirect()` |
| JSON parsing | `.json()` (auto) | `.json()` (auto) |
| Framework | Hono | Express |
| Environment | Cloudflare Workers | Node.js server |

### Code Parity
Both implementations are functionally identical with only syntax differences for their respective frameworks.

---

## 11. COMPLETE FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ User Initiates Polar Connection                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  GET /api/polar/connect?userId=xxx                              │
│  ↓                                                               │
│  Generate state: btoa(JSON.stringify({userId, ts}))             │
│  ↓                                                               │
│  Redirect to: https://flow.polar.com/oauth2/authorization?      │
│    client_id=POLAR_CLIENT_ID&                                   │
│    redirect_uri=/api/polar/callback&                            │
│    response_type=code&                                          │
│    state=encoded_state                                          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ User Authorizes on Polar                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│ Polar redirects to:                                             │
│ GET /api/polar/callback?code=AUTH_CODE&state=ENCODED_STATE     │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Token Exchange (THE KEY STEP)                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│ POST https://polaraccesslink.com/v3/oauth2/token                │
│ Headers:                                                        │
│   Content-Type: application/x-www-form-urlencoded             │
│   Authorization: Basic <base64(CLIENT_ID:CLIENT_SECRET)>       │
│                                                                   │
│ Body:                                                           │
│   grant_type=authorization_code&                               │
│   code=AUTH_CODE&                                              │
│   redirect_uri=/api/polar/callback                             │
│                                                                   │
│ Response (if success, 200 OK):                                  │
│ {                                                               │
│   "access_token": "bearer_token_here",                          │
│   "x_user_id": 12345,                                           │
│   "token_type": "bearer",                                       │
│   "expires_in": 3600                                            │
│ }                                                               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Register User with Polar AccessLink                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│ POST https://www.polaraccesslink.com/v3/users                   │
│ Headers:                                                        │
│   Content-Type: application/json                               │
│   Authorization: Bearer <access_token>                          │
│                                                                   │
│ Body: { "member-id": userId }                                   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Store Credentials & Redirect                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│ Save to Database:                                               │
│ {                                                               │
│   userId: "app-user-id",                                        │
│   polarUserId: x_user_id,                                       │
│   accessToken: "bearer_token",                                  │
│   memberId: userId,                                             │
│   registeredAt: NOW,                                            │
│   lastSyncAt: null                                              │
│ }                                                               │
│                                                                   │
│ Redirect to: /profile?polar_connected=true                      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 12. SUMMARY TABLE

| Aspect | Value |
|--------|-------|
| **Token Endpoint** | `https://polaraccesslink.com/v3/oauth2/token` |
| **HTTP Method** | POST |
| **Authentication** | HTTP Basic Auth (base64-encoded credentials) |
| **Content-Type** | `application/x-www-form-urlencoded` |
| **Required Credentials** | `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` |
| **Request Body** | `grant_type`, `code`, `redirect_uri` |
| **Response Fields** | `access_token`, `x_user_id` |
| **Success Response** | HTTP 200-299 |
| **Error Logging** | console.error() with response text |
| **Error Redirect** | `/profile?polar_error=<error_type>` |
| **CORS** | Not applicable (server-to-server) |
| **Database Storage** | `polarAccounts` table |
| **Implementations** | 2 (Worker + Server) |

---

## 13. QUICK REFERENCE: Key Code Locations

| Purpose | File | Lines |
|---------|------|-------|
| Token Exchange Request | [worker/src/routes.ts](worker/src/routes.ts#L867-L880) | 867-880 |
| Server Implementation | [server/routes.ts](server/routes.ts#L854-L862) | 854-862 |
| Error Handling | [worker/src/routes.ts](worker/src/routes.ts#L879-L883) | 879-883 |
| User Registration | [worker/src/routes.ts](worker/src/routes.ts#L890-L901) | 890-901 |
| Token Storage | [worker/src/routes.ts](worker/src/routes.ts#L912-L925) | 912-925 |
| Environment Variables | [worker/src/index.ts](worker/src/index.ts#L12-L13) | 12-13 |
| CORS Configuration | [worker/src/index.ts](worker/src/index.ts#L20-L35) | 20-35 |
| Callback Handler | [worker/src/routes.ts](worker/src/routes.ts#L841-L935) | 841-935 |
| Connect Endpoint | [worker/src/routes.ts](worker/src/routes.ts#L824-L839) | 824-839 |

