# Polar OAuth2 Implementation Analysis - Detailed Code Review

## Executive Summary

**Critical Findings:**
- 🔴 **Token exchange endpoint is 404'ing** - using `api.polaraccesslink.com/v3/oauth2/token` instead of official `api.polar.sh/v1/oauth2/token`
- 🔴 **Inconsistent between worker and server** - different domain names (with/without `api.`)
- ⚠️ **User registration endpoint undocumented** - using `www.polaraccesslink.com/v3/users`
- ⚠️ **Authentication method doesn't match docs** - using Basic Auth instead of form parameters

---

## Section 1: Authorization Endpoint Analysis

### Endpoint Being Used
```
https://flow.polar.com/oauth2/authorization
```

### Official Documentation Status
- ✅ **Works in practice** (confirmed working)
- ⚠️ **NOT mentioned in official Polar docs** (searched all available documentation)
- ✅ **Standard OAuth2 authorization endpoint path**

### Implementation Details

#### Worker Code (worker/src/routes.ts:837)
```typescript
app.get("/api/polar/connect", async (c) => {
  try {
    const userId = c.req.query('userId');
    const POLAR_CLIENT_ID = c.env.POLAR_CLIENT_ID;
    
    if (!userId || !POLAR_CLIENT_ID) {
      return c.json({ error: "Missing userId or POLAR_CLIENT_ID" }, 400);
    }

    const state = btoa(JSON.stringify({ userId }));
    const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
    
    const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    
    console.log('Generated authUrl:', authUrl);
    return c.json({ authUrl });
  } catch (error: any) {
    console.error('Polar connect error:', error);
    return c.json({ error: error.message }, 500);
  }
});
```

#### Server Code (server/routes.ts:820)
```typescript
app.post("/api/polar/connect", async (req, res) => {
  try {
    const { userId } = req.body;
    const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
    
    if (!userId || !POLAR_CLIENT_ID) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Generate state for CSRF protection
    const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
    const redirectUri = getPolarRedirectUri();
    const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    
    res.json({ authUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

### Assessment
- ✅ **Correct flow** - follows OAuth2 authorization code flow
- ✅ **Proper state handling** - encoded as base64 JSON
- ✅ **CSRF protection** - state parameter included
- ✅ **URL encoding** - redirect_uri properly encoded
- ⚠️ **Undocumented domain** - `flow.polar.com` not in official docs (but works)

### Recommendation
**KEEP AS-IS** - This endpoint works correctly even though undocumented.

---

## Section 2: Token Exchange Endpoint Analysis - THE MAIN PROBLEM

### Endpoint Comparison

| Source | Endpoint |
|--------|----------|
| **Official Polar Docs** | `https://api.polar.sh/v1/oauth2/token` |
| **Worker Implementation** | `https://api.polaraccesslink.com/v3/oauth2/token` |
| **Server Implementation** | `https://polaraccesslink.com/v3/oauth2/token` |

### Why This Is Wrong

#### 1. Domain Mismatch
```
Official:     api.polar.sh          ← This is the real Polar API domain
Worker:       api.polaraccesslink.com ← Different domain, doesn't exist
Server:       polaraccesslink.com      ← Different domain, missing subdomain
```

#### 2. API Version Mismatch
```
Official:     /v1/
Current:      /v3/
```

#### 3. Inconsistency Between Worker and Server
```
Worker:   https://api.polaraccesslink.com/v3/oauth2/token
Server:   https://polaraccesslink.com/v3/oauth2/token
          ↑ Different! (with/without 'api.' subdomain)
```

### Worker Implementation (worker/src/routes.ts:882)

**BROKEN CODE:**
```typescript
const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {
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

if (!tokenResponse.ok) {
  const errorText = await tokenResponse.text();
  console.error('Polar token exchange failed:', errorText);
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
}
```

**Issues:**
1. ❌ Wrong endpoint: `api.polaraccesslink.com` instead of `api.polar.sh`
2. ❌ Wrong version: `/v3/` instead of `/v1/`
3. ⚠️ Missing credentials in form body (only in Basic Auth header)

### Server Implementation (server/routes.ts:854)

**BROKEN CODE:**
```typescript
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

if (!tokenResponse.ok) {
  console.error('Polar token exchange failed:', await tokenResponse.text());
  return res.redirect('/profile?polar_error=token_exchange');
}
```

**Issues:**
1. ❌ Wrong endpoint: `polaraccesslink.com` instead of `api.polar.sh`
2. ❌ Missing subdomain: no `api.` prefix
3. ❌ Wrong version: `/v3/` instead of `/v1/`
4. ⚠️ Missing credentials in form body (only in Basic Auth header)

### The Error You're Seeing

```
Status: 404 Not Found
Message: "Polar token exchange failed"
Reason: Endpoint doesn't exist or isn't responding
```

This happens because:
```
POST https://api.polaraccesslink.com/v3/oauth2/token
      ↑ This URL doesn't exist in the real Polar API
      
The server either:
- Doesn't have this endpoint
- Is deprecated
- Is a private/internal API
```

### The Official Documentation Shows

```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'
```

Key differences:
1. ✅ Correct domain: `api.polar.sh`
2. ✅ Correct version: `/v1/`
3. ✅ Credentials in form body: `client_id=...&client_secret=...`
4. ✅ All parameters in URL-encoded form body

---

## Section 3: Authentication Method Analysis

### Official Approach (From Polar Docs)

```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'
```

**Method**: Form parameters in body
- ✅ Simpler to understand
- ✅ Documented approach
- ✅ Widely used

### Current Implementation Approach

```typescript
const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);

const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {
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

**Method**: HTTP Basic Authentication
- ⚠️ Not the documented approach
- ⚠️ Missing `client_id` and `client_secret` from body
- ✅ Valid OAuth2 mechanism
- ✅ More secure (credentials not in form body)

### Assessment

Both approaches are valid in OAuth2, but:
1. **Polar documentation shows form parameters** - this is what you should match
2. **Your code uses Basic Auth** - may work, but doesn't match docs
3. **Mixing approaches causes confusion** - form body has some params but not credentials

### OAuth2 Standard (RFC 6749)

From RFC 6749 Section 4.1.3 (Access Token Request):

> Client authentication is performed as per Section 2.3. If the client type is confidential, the client MUST authenticate with the authorization server as described in Section 3.2.1.

The RFC supports BOTH:
1. Form parameters: `client_id=` and `client_secret=` in body
2. HTTP Basic Auth: `Authorization: Basic <base64(id:secret)>`

But **Polar docs specifically show form parameters**, so that's what you should use.

---

## Section 4: User Registration Endpoint Analysis

### Current Implementation

**Worker Code** (worker/src/routes.ts:917):
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

### Issues

1. ❌ **Endpoint is undocumented**: `https://www.polaraccesslink.com/v3/users`
   - Not found in official Polar documentation
   - Uses `www.` subdomain (not `api.`)
   - Uses `/v3/` version

2. ⚠️ **Purpose is unclear**: What does registering a user do?
   - Is it required for data access?
   - Is it for linking accounts?
   - Does Polar require it?

3. ⚠️ **Error handling assumes 409**: Conflict status code
   - Expects 409 for duplicate accounts
   - Continues even if 409 is returned
   - Suggests this endpoint may fail gracefully

4. ❌ **Different domain than token endpoint**: Uses `www.polaraccesslink.com` instead of `api.polar.sh`

### Assessment

This endpoint is **not documented in any official Polar documentation**. It may be:
- A private/internal API
- Legacy endpoint being phased out
- Used for a specific Polar feature
- Maintained by accident

### Recommendation

**Need to contact Polar support** to verify:
1. Is this endpoint still supported?
2. What's the correct v1 endpoint?
3. Is it required or optional?
4. Should it be on `api.polar.sh` instead?

---

## Section 5: Error Handling Analysis

### Error Scenarios

#### Scenario 1: Token Exchange Fails (Current State)

```typescript
if (!tokenResponse.ok) {
  const errorText = await tokenResponse.text();
  console.error('Polar token exchange failed:', errorText);
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
}
```

**Current Behavior with 404**:
1. Fetch succeeds (no JavaScript error)
2. `tokenResponse.ok` is `false` (status is 404)
3. Error is logged to console
4. User is redirected with `?polar_error=token_exchange`
5. Frontend shows generic error message

**Problem**: User doesn't know if it's:
- Invalid credentials (401)
- Wrong endpoint (404)
- Polar service down (500)
- Misconfigured (400)

### Improved Error Handling

```typescript
if (!tokenResponse.ok) {
  const errorText = await tokenResponse.text();
  const status = tokenResponse.status;
  
  // Log detailed error information
  console.error('Polar token exchange failed:', {
    status,
    statusText: tokenResponse.statusText,
    body: errorText,
    endpoint: 'https://api.polar.sh/v1/oauth2/token',
    requestBody: {
      grant_type: 'authorization_code',
      code: code ? '***' : 'MISSING',
      redirect_uri: redirectUri,
    },
    credentials: {
      client_id: POLAR_CLIENT_ID ? '***' : 'MISSING',
      client_secret: POLAR_CLIENT_SECRET ? '***' : 'MISSING',
    },
  });

  // More specific error handling
  let errorType = 'token_exchange';
  if (status === 401) {
    errorType = 'invalid_credentials';
    console.error('Invalid Polar credentials');
  } else if (status === 400) {
    errorType = 'invalid_request';
    console.error('Invalid request parameters');
  } else if (status === 404) {
    errorType = 'not_found';
    console.error('Token endpoint not found - check endpoint URL');
  }

  return c.redirect(`${FRONTEND_URL}/profile?polar_error=${errorType}`);
}
```

---

## Section 6: State Parameter Analysis

### Current Implementation

**Worker Code:**
```typescript
const state = btoa(JSON.stringify({ userId }));
```

**Server Code:**
```typescript
const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
```

### Security Analysis

1. ✅ **CSRF Protection**: State parameter prevents CSRF attacks
2. ✅ **Base64 encoding**: Properly encoded for URL safety
3. ✅ **User context**: Stores userId for post-authentication
4. ⚠️ **No expiration**: State doesn't have timestamp
5. ⚠️ **No signature**: State could be forged
6. ⚠️ **No random component**: Predictable state value

### State Verification

**Worker Code:**
```typescript
let userId: string;
try {
  const decoded = JSON.parse(atob(state as string));
  userId = decoded.userId;
  console.log('State decoded - userId:', userId);
} catch (e) {
  console.error('State decode error:', e);
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
}
```

**Assessment**: ✅ Correctly validates and decodes state

### Recommendations

For better security, consider:

1. **Add random nonce**:
   ```typescript
   const nonce = crypto.randomUUID();
   const state = btoa(JSON.stringify({ userId, nonce }));
   ```

2. **Store state temporarily** (e.g., in session/cache):
   ```typescript
   // Store state with expiration
   await sessionCache.set(`oauth_state_${nonce}`, { 
     userId, 
     expiresAt: Date.now() + 600000 
   });
   ```

3. **Validate on callback**:
   ```typescript
   const stateData = await sessionCache.get(`oauth_state_${nonce}`);
   if (!stateData || stateData.expiresAt < Date.now()) {
     return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
   }
   ```

But for MVP, current implementation is acceptable.

---

## Section 7: Redirect URI Validation

### Current Implementation

**Worker Code:**
```typescript
const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
```

**Server Code:**
```typescript
function getPolarRedirectUri(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || 
                 process.env.POLAR_REDIRECT_DOMAIN || 
                 'localhost:5000';
  const protocol = domain.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${domain}/api/polar/callback`;
}
```

### Assessment

1. ✅ **HTTPS for production** - Uses HTTPS for non-localhost
2. ✅ **localhost exception** - Allows HTTP for local development
3. ✅ **Consistent path** - Always `/api/polar/callback`
4. ⚠️ **Domain flexibility** - Can be configured via environment
5. ⚠️ **Must match exactly** - Polar checks exact URL match

### Critical Requirement

**This redirect URI MUST be registered in your Polar OAuth2 client settings.**

From official Polar documentation:
> "for security reasons, you need to declare your application URL where the users will be redirected after granting access to their data."

If the redirect URI doesn't match exactly what's registered in Polar, you'll get an error.

**Verification Steps**:
1. Go to Polar Settings (flow.polar.com or dashboard)
2. Find your OAuth2 client
3. Check the registered redirect URIs
4. Ensure it matches what your code is using
5. No trailing slashes, no query parameters differences, exact match

---

## Section 8: Credentials Management

### Current Approach

**Worker** (worker/src/index.ts):
```typescript
export interface Env {
  DATABASE_URL: string;
  POLAR_CLIENT_ID?: string;
  POLAR_CLIENT_SECRET?: string;
  WORKER_URL?: string;
  FRONTEND_URL?: string;
}
```

**Server** (server/routes.ts):
```typescript
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
```

### Assessment

1. ✅ **Environment variables** - Credentials not hardcoded
2. ✅ **Separate storage** - Not mixed with other config
3. ⚠️ **No validation** - Doesn't check if credentials exist
4. ⚠️ **Optional in types** - Marked as `?` (optional)
5. ⚠️ **Could be undefined** - Should validate at startup

### Recommendations

Add validation at startup:

```typescript
// Worker - add to bootstrap
function validateEnv(env: Env) {
  const required = ['POLAR_CLIENT_ID', 'POLAR_CLIENT_SECRET'];
  for (const key of required) {
    if (!env[key as keyof Env]) {
      console.warn(`Missing required environment variable: ${key}`);
    }
  }
}

// Server - add to server startup
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;

if (!POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
  console.warn('Warning: Polar credentials not configured. OAuth will not work.');
}
```

---

## Section 9: Response Handling

### Token Response Expected Format (From Polar Docs)

```json
{
  "token_type": "Bearer",
  "access_token": "polar_at_XXX",
  "expires_in": 864000,
  "refresh_token": "polar_rt_XXX",
  "scope": "openid email",
  "id_token": "ID_TOKEN"
}
```

### Current Implementation

**Worker Code** (worker/src/routes.ts:900+):
```typescript
const tokenData = await tokenResponse.json();
const { access_token, x_user_id } = tokenData;
```

**Server Code** (server/routes.ts:865+):
```typescript
const tokenData = await tokenResponse.json();
const { access_token, x_user_id } = tokenData;
```

### Issues

1. ⚠️ **Extracting `x_user_id`** - This field is **not in official response**
   - Official docs show: `token_type`, `access_token`, `expires_in`, `refresh_token`, `scope`, `id_token`
   - No mention of `x_user_id` field
   - Could be custom Polar field or error

2. ⚠️ **Not validating response** - Doesn't check for required fields
3. ⚠️ **Not storing expiration** - `expires_in` is not used
4. ⚠️ **Not storing refresh_token** - Long-lived token ignored

### Where Does `x_user_id` Come From?

Searching the code for `x_user_id`:
```
- It's extracted from token response (undocumented)
- It's used to identify Polar users
- It's stored in the database
- It's used for all subsequent Polar API calls
```

**Possibility**: This might be:
- A custom header in the response
- A field in the `id_token` JWT
- A Polar-specific extension not documented

### Risk

If `x_user_id` is required but not being returned, you'll get errors like:
```
const existingAccount = await storage.getPolarAccountByPolarUserId(x_user_id);
// x_user_id is undefined → Database query fails
```

### Recommendations

```typescript
// Add validation and better error handling
const tokenData = await tokenResponse.json();
const { access_token, x_user_id, expires_in } = tokenData;

if (!access_token) {
  console.error('Missing access_token in response:', tokenData);
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_token_response`);
}

if (!x_user_id) {
  console.error('Missing x_user_id in response:', tokenData);
  console.error('Response keys:', Object.keys(tokenData));
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=missing_user_id`);
}

// Store expiration for token refresh
const tokenExpiration = new Date(Date.now() + (expires_in || 864000) * 1000);
```

---

## Section 10: Complete Recommended Fix

### Priority 1: CRITICAL - Fix Token Exchange URL

**File**: `worker/src/routes.ts` (Line 882)
```diff
- const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {
+ const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

**File**: `server/routes.ts` (Line 854)
```diff
- const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
+ const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

### Priority 2: RECOMMENDED - Add Form Parameters

**File**: `worker/src/routes.ts` (Line 888-894)
```diff
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
+   client_id: POLAR_CLIENT_ID,
+   client_secret: POLAR_CLIENT_SECRET,
    redirect_uri: redirectUri,
  }).toString(),
  ```

Then remove the `Authorization` header:
```diff
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
-   'Authorization': `Basic ${authHeader}`,
  },
```

### Priority 3: VERIFY - User Registration Endpoint

Contact Polar support to confirm:
- Correct endpoint URL
- Correct API version
- If it's still required

---

## Section 11: Testing Checklist

After implementing fixes:

- [ ] **Authorization endpoint works**
  - GET `/api/polar/connect?userId=test-user`
  - Returns `authUrl` pointing to `flow.polar.com`

- [ ] **Authorization redirects correctly**
  - Follow the `authUrl`
  - Polar shows authorization dialog
  - Allow access
  - Redirected to callback with `code` and `state`

- [ ] **Token exchange succeeds**
  - Callback receives authorization code
  - Decodes state to get userId
  - Calls `/api/polar/callback?code=...&state=...`
  - Token exchange to `api.polar.sh/v1/oauth2/token` succeeds
  - Gets response with `access_token`

- [ ] **User registration succeeds**
  - After token exchange, attempts user registration
  - Either succeeds or returns 409 (accepted)
  - No errors in console

- [ ] **Database updates correctly**
  - User's Polar account linked to database
  - Can query exercises and activities
  - Disconnection works

- [ ] **Error handling works**
  - User denies access → Error message shown
  - Invalid code → Error message shown
  - Credentials missing → Error message shown
  - Token exchange fails → Error message shown

---

## Summary Table

| Issue | Severity | Component | Current | Correct | Fix Complexity |
|-------|----------|-----------|---------|---------|-----------------|
| Token endpoint domain | 🔴 CRITICAL | Both | `polaraccesslink.com` | `api.polar.sh` | 1 line each |
| Token endpoint version | 🔴 CRITICAL | Both | `/v3/` | `/v1/` | 1 line each |
| Worker/Server consistency | 🔴 CRITICAL | Both | Different URLs | Same URL | 1 line server |
| Auth header vs form params | ⚠️ MEDIUM | Both | Basic Auth only | Include in form | 3-4 lines each |
| Response field validation | ⚠️ MEDIUM | Both | No validation | Validate `x_user_id` | 5-10 lines each |
| User registration endpoint | ⚠️ LOW | Both | Undocumented | Need Polar support | TBD |
| Error logging | ✅ LOW | Both | Basic | Could be improved | 10-15 lines |

---

## Final Recommendation

**Immediate Action**: Fix the token exchange endpoint URLs (Priority 1)

This is a simple 1-line fix in each file and will resolve the 404 errors you're experiencing. Everything else can be improved incrementally.

```typescript
// Before (BROKEN)
const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {

// After (FIXED)
const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

Then test to ensure the OAuth flow works end-to-end.
