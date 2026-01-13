# POLAR OAUTH2: OFFICIAL SPEC vs YOUR CODE - SIDE-BY-SIDE COMPARISON

## Quick Summary

| Component | Official Spec | Your Code | Status |
|-----------|--------------|-----------|--------|
| **Authorization Endpoint** | `https://flow.polar.com/oauth2/authorization` | `https://flow.polar.com/oauth2/authorization` | ✅ CORRECT |
| **Token Endpoint (Worker)** | `https://api.polar.sh/v1/oauth2/token` | `https://api.polaraccesslink.com/v3/oauth2/token` | ❌ WRONG - 404 |
| **Token Endpoint (Server)** | `https://api.polar.sh/v1/oauth2/token` | `https://polaraccesslink.com/v3/oauth2/token` | ❌ WRONG - 404 |
| **Authentication Method** | Form parameters: `client_id=...&client_secret=...` | HTTP Basic Auth header | ⚠️ WORKS but not documented |
| **Request Content-Type** | `application/x-www-form-urlencoded` | `application/x-www-form-urlencoded` | ✅ CORRECT |
| **User Registration** | Not documented | `https://www.polaraccesslink.com/v3/users` | ⚠️ UNDOCUMENTED |

---

## 1. AUTHORIZATION FLOW - COMPARISON

### STEP 1: Generate Authorization URL

#### Official Specification
```
Method: GET (indirect - sends user to Polar)
Endpoint: https://polar.sh/oauth2/authorize
          (Note: docs show this, but flow.polar.com is actually used)

Parameters:
- response_type: "code" (required)
- client_id: YOUR_CLIENT_ID (required)
- redirect_uri: https://your-app.com/callback (required)
- scope: "openid email" (required)
- state: base64-encoded-value (recommended)
- sub_type: "user" or "organization" (optional, defaults to organization)

Example:
https://polar.sh/oauth2/authorize?
  response_type=code
  &client_id=polar_ci_XXX
  &redirect_uri=https%3A%2F%2Fyour-app.com%2Fcallback
  &scope=openid%20email
  &state=abc123
```

#### Your Code (Worker)
```typescript
// ✅ CORRECT APPROACH
const state = btoa(JSON.stringify({ userId })); // Encode state as base64 JSON
const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;

const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

return c.json({ authUrl });
```

#### Your Code (Server)
```typescript
// ✅ CORRECT APPROACH
const state = Buffer.from(JSON.stringify({ userId })).toString('base64');
const redirectUri = getPolarRedirectUri();

const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

res.json({ authUrl });
```

**Analysis**: ✅ Both implementations are correct, though `flow.polar.com` is undocumented.

---

### STEP 2: User Authorizes & Gets Redirected

#### Official Specification
```
Polar redirects user back to:
GET https://your-app.com/callback?code=AUTH_CODE&state=YOUR_STATE

Query Parameters:
- code: Authorization code (short-lived, one-time use)
- state: The state value you sent (for CSRF protection)

If user denies:
GET https://your-app.com/callback?error=access_denied&state=...
```

#### Your Code
```typescript
// Both worker and server handle this similarly:
const code = c.req.query('code');           // Get code from callback
const state = c.req.query('state');         // Get state for verification
const authError = c.req.query('error');     // Check for errors

// Verify state
let userId: string;
try {
  const decoded = JSON.parse(atob(state as string));  // Decode base64 JSON
  userId = decoded.userId;
} catch (e) {
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
}
```

**Analysis**: ✅ Correct handling of authorization code and state validation.

---

## 2. TOKEN EXCHANGE - SIDE-BY-SIDE COMPARISON

### THE CRITICAL ISSUE

#### Official Specification (from Polar Docs)
```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'

Response:
{
  "token_type": "Bearer",
  "access_token": "polar_at_XXX",
  "expires_in": 864000,
  "refresh_token": "polar_rt_XXX",
  "scope": "openid email",
  "id_token": "ID_TOKEN"
}
```

### Your Code (WORKER) - BROKEN

```typescript
const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);

// ❌ WRONG ENDPOINT
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
  console.error('Polar token exchange failed:', await tokenResponse.text());
  return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
}

const tokenData = await tokenResponse.json();
const { access_token, x_user_id } = tokenData;
```

**Issues**:
1. ❌ `https://api.polaraccesslink.com/v3/oauth2/token` - WRONG domain and version
2. ⚠️ Missing `client_id` and `client_secret` in form body
3. ⚠️ Extracting `x_user_id` - NOT in official response format

---

### Your Code (SERVER) - BROKEN

```typescript
const redirectUri = getPolarRedirectUri();
const authHeader = Buffer.from(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`).toString('base64');

// ❌ WRONG ENDPOINT (different from worker!)
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

const tokenData = await tokenResponse.json();
const { access_token, x_user_id } = tokenData;
```

**Issues**:
1. ❌ `https://polaraccesslink.com/v3/oauth2/token` - WRONG domain, missing `api.`, wrong version
2. ❌ **DIFFERENT from worker** - Server and worker use inconsistent URLs
3. ⚠️ Missing `client_id` and `client_secret` in form body
4. ⚠️ Extracting `x_user_id` - NOT in official response format

---

## 3. REQUEST BODY COMPARISON

### Official Specification (Form Parameters)
```
POST /v1/oauth2/token HTTP/1.1
Host: api.polar.sh
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=abc123def456
&client_id=polar_ci_yourClientId
&client_secret=your_client_secret_here
&redirect_uri=https%3A%2F%2Fyour-app.com%2Fcallback
```

### Your Code (Both Worker & Server)
```typescript
body: new URLSearchParams({
  grant_type: 'authorization_code',
  code: code as string,
  redirect_uri: redirectUri,
  // ⚠️ MISSING: client_id and client_secret
}).toString(),

// ⚠️ INSTEAD, credentials are in header:
headers: {
  'Authorization': `Basic ${btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`)}`,
},
```

**Generates**:
```
POST /v3/oauth2/token HTTP/1.1
Host: api.polaraccesslink.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic cG9sYXJfY2k6c2VjcmV0
                       ↑ This is client_id:client_secret in base64

grant_type=authorization_code
&code=abc123def456
&redirect_uri=https%3A%2F%2F...
```

**Assessment**: 
- ✅ Basic Auth is valid OAuth2
- ❌ But doesn't match documentation
- ❌ Missing credentials from body
- ❌ Wrong endpoint anyway

---

## 4. RESPONSE HANDLING COMPARISON

### Official Specification (Documented Response)
```json
{
  "token_type": "Bearer",
  "access_token": "polar_at_1234567890",
  "expires_in": 864000,
  "refresh_token": "polar_rt_9876543210",
  "scope": "openid email",
  "id_token": "eyJhbGc..."
}
```

### What You're Extracting
```typescript
const { access_token, x_user_id } = tokenData;
```

**The Problem**:
- ✅ `access_token` is in the official response
- ❌ `x_user_id` is **NOT** in the official response
- ⚠️ Where does `x_user_id` come from?
  - Could be in custom header
  - Could be in `id_token` JWT
  - Could be a Polar extension

**Consequence**:
If `x_user_id` is undefined, downstream code fails:
```typescript
const existingAccount = await storage.getPolarAccountByPolarUserId(x_user_id);
// If x_user_id is undefined, this query fails!
```

---

## 5. REDIRECT URI COMPARISON

### Official Specification (Requirements)
```
Redirect URI must:
1. Use HTTPS (except localhost)
2. Match exactly what's registered in OAuth client settings
3. Be case-sensitive
4. Include port number if applicable
5. No fragment identifiers
6. Query parameters allowed (but must be consistent)

Example registered: https://example.com/callback
Valid: https://example.com/callback
INVALID: https://example.com/callback/ (trailing slash)
INVALID: https://example.com:443/callback (different port)
INVALID: HTTP://example.com/callback (uppercase protocol)
INVALID: https://example.com/Callback (different case)
```

### Your Code (Worker)
```typescript
const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;

// Example: https://runna-io-api.runna-io-api.workers.dev/api/polar/callback
```

**Must be registered as**: Exactly `https://runna-io-api.runna-io-api.workers.dev/api/polar/callback`

### Your Code (Server)
```typescript
function getPolarRedirectUri(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || 
                 process.env.POLAR_REDIRECT_DOMAIN || 
                 'localhost:5000';
  const protocol = domain.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${domain}/api/polar/callback`;
}

// Development: http://localhost:5000/api/polar/callback
// Production: https://your-domain.com/api/polar/callback
```

**Assessment**:
- ✅ Properly handles HTTPS vs HTTP
- ✅ Configurable via environment
- ✅ Consistent path
- ⚠️ **MUST match Polar registration exactly**

---

## 6. FULL FLOW COMPARISON - WHAT HAPPENS NOW

### Current Broken Flow (Worker)
```
1. User clicks "Connect Polar"
   ↓
2. GET /api/polar/connect?userId=...
   ↓
3. Generate authUrl: https://flow.polar.com/oauth2/authorization?...
   ↓
4. Return authUrl to frontend
   ↓
5. Browser redirects to Polar
   ↓
6. User authorizes
   ↓
7. Polar redirects to: GET /api/polar/callback?code=...&state=...
   ↓
8. Your code extracts code and state
   ↓
9. POST to: https://api.polaraccesslink.com/v3/oauth2/token  ← ❌ 404 NOT FOUND
   ↓
10. Error: "Polar token exchange failed"
    ↓
11. Redirect to: /profile?polar_error=token_exchange
    ↓
12. User sees error, OAuth fails
```

### Corrected Flow (After Fix)
```
1. User clicks "Connect Polar"
   ↓
2. GET /api/polar/connect?userId=...
   ↓
3. Generate authUrl: https://flow.polar.com/oauth2/authorization?...
   ↓
4. Return authUrl to frontend
   ↓
5. Browser redirects to Polar
   ↓
6. User authorizes
   ↓
7. Polar redirects to: GET /api/polar/callback?code=...&state=...
   ↓
8. Your code extracts code and state
   ↓
9. POST to: https://api.polar.sh/v1/oauth2/token  ← ✅ CORRECT ENDPOINT
   ↓
10. Polar validates and returns: { access_token, ... }
    ↓
11. Extract access_token and x_user_id (if available)
    ↓
12. Register user with Polar: POST /v3/users
    ↓
13. Link account in database
    ↓
14. Redirect to: /profile?polar_success=linked
    ↓
15. User sees success, OAuth complete
```

---

## 7. ERROR CODES REFERENCE

### HTTP Status Codes You Might See

| Code | Meaning | Cause | Solution |
|------|---------|-------|----------|
| **200 OK** | Success | Request accepted | ✅ Everything working |
| **400 Bad Request** | Invalid parameters | Missing/invalid code, client_id, etc. | Check all parameters are present and correct |
| **401 Unauthorized** | Invalid credentials | Wrong client_id or client_secret | Verify credentials in Polar dashboard |
| **403 Forbidden** | Not authorized | Client not allowed for this operation | Check OAuth client is active |
| **404 Not Found** | Endpoint doesn't exist | Using wrong URL (your current issue) | Use `api.polar.sh/v1/oauth2/token` |
| **429 Too Many Requests** | Rate limited | Too many requests in short time | Implement exponential backoff |
| **500 Server Error** | Polar service error | Internal Polar service issue | Retry after delay |

### Your Current Error (404)
```
POST https://api.polaraccesslink.com/v3/oauth2/token

Response:
HTTP/1.1 404 Not Found
```

**Reason**: Endpoint doesn't exist  
**Fix**: Change to `https://api.polar.sh/v1/oauth2/token`

---

## 8. COMPLETE CORRECTED CODE

### Corrected Worker Code (worker/src/routes.ts)

```typescript
app.get('/api/polar/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const authError = c.req.query('error');
    const POLAR_CLIENT_ID = c.env.POLAR_CLIENT_ID;
    const POLAR_CLIENT_SECRET = c.env.POLAR_CLIENT_SECRET;
    const FRONTEND_URL = c.env.FRONTEND_URL || 'https://runna-io.pages.dev';
    
    console.log('Polar callback started');
    
    if (authError) {
      console.log('Auth error detected:', authError);
      return c.redirect(`${FRONTEND_URL}/profile?polar_error=denied`);
    }
    
    if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
      console.error('Missing required params');
      return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid`);
    }

    let userId: string;
    try {
      const decoded = JSON.parse(atob(state as string));
      userId = decoded.userId;
    } catch (e) {
      console.error('State decode error:', e);
      return c.redirect(`${FRONTEND_URL}/profile?polar_error=invalid_state`);
    }

    const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
    
    // ✅ CORRECT ENDPOINT
    console.log('Exchanging code for token...');
    const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // ✅ CORRECT REQUEST BODY WITH CREDENTIALS
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        client_id: POLAR_CLIENT_ID,
        client_secret: POLAR_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Polar token exchange failed:', {
        status: tokenResponse.status,
        body: errorText,
      });
      return c.redirect(`${FRONTEND_URL}/profile?polar_error=token_exchange`);
    }

    const tokenData = await tokenResponse.json();
    const { access_token, x_user_id } = tokenData;

    // ... rest of the code for user registration, etc.
  } catch (error: any) {
    console.error('Polar callback error:', error);
    return c.redirect(`${c.env.FRONTEND_URL || 'https://runna.io'}/profile?polar_error=server`);
  }
});
```

### Corrected Server Code (server/routes.ts)

```typescript
app.get('/api/polar/callback', async (req, res) => {
  try {
    const { code, state, error: authError } = req.query;
    
    if (authError) {
      return res.redirect('/profile?polar_error=denied');
    }
    
    if (!code || !state || !POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET) {
      return res.redirect('/profile?polar_error=invalid');
    }

    let userId: string;
    try {
      const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
      userId = decoded.userId;
    } catch {
      return res.redirect('/profile?polar_error=invalid_state');
    }

    const redirectUri = getPolarRedirectUri();
    
    // ✅ CORRECT ENDPOINT (SAME AS WORKER)
    console.log('Exchanging code for token...');
    const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // ✅ CORRECT REQUEST BODY WITH CREDENTIALS
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        client_id: POLAR_CLIENT_ID,
        client_secret: POLAR_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      console.error('Polar token exchange failed:', await tokenResponse.text());
      return res.redirect('/profile?polar_error=token_exchange');
    }

    const tokenData = await tokenResponse.json();
    const { access_token, x_user_id } = tokenData;

    // ... rest of the code for user registration, etc.
  } catch (error: any) {
    console.error('Polar callback error:', error);
    return res.redirect('/profile?polar_error=server');
  }
});
```

---

## 9. DEPLOYMENT CHECKLIST

Before deploying the fix:

- [ ] Update `worker/src/routes.ts` line 882 with new endpoint
- [ ] Update `server/routes.ts` line 854 with new endpoint
- [ ] Verify both use identical endpoint URL
- [ ] Verify Polar Client ID is set in environment
- [ ] Verify Polar Client Secret is set in environment
- [ ] Verify redirect URI is registered in Polar dashboard
- [ ] Test full OAuth flow in staging
- [ ] Check logs for successful token exchange
- [ ] Deploy to production
- [ ] Verify in production
- [ ] Update any documentation/notes

---

## 10. KEY DIFFERENCES TABLE

```
┌─────────────────────────┬──────────────────────┬──────────────────────┬──────────┐
│ Aspect                  │ Official Spec        │ Current Code         │ Status   │
├─────────────────────────┼──────────────────────┼──────────────────────┼──────────┤
│ Authorization Endpoint  │ flow.polar.com/...   │ flow.polar.com/...   │ ✅ OK    │
│ Token Endpoint          │ api.polar.sh/v1/...  │ polaraccesslink.../.. │ ❌ 404   │
│ Token Endpoint (Server) │ api.polar.sh/v1/...  │ polaraccesslink.../.. │ ❌ 404   │
│ Consistency             │ One endpoint         │ Different URLs       │ ❌ BAD   │
│ Auth Method             │ Form params          │ Basic header         │ ⚠️ WORKS │
│ Credentials in Body     │ client_id, secret    │ Not included         │ ⚠️ WORKS │
│ Response Format         │ Standard OAuth2      │ Adds x_user_id       │ ⚠️ ISSUE │
│ Redirect URI Validation │ Exact match required │ Properly formatted   │ ✅ OK    │
│ State Handling          │ CSRF protection      │ Base64 encoded       │ ✅ OK    │
└─────────────────────────┴──────────────────────┴──────────────────────┴──────────┘
```

---

## FINAL ANSWER

**What's wrong**: You're calling the wrong token endpoint (`polaraccesslink.com` instead of `polar.sh`)  
**Why it fails**: Endpoint returns 404 (doesn't exist)  
**How to fix**: Change 2 URLs to `api.polar.sh/v1/oauth2/token`  
**Files to change**: `worker/src/routes.ts` line 882 and `server/routes.ts` line 854  
**Effort**: 5 minutes  
**Risk**: None - just endpoint URLs  
**Testing**: Run full OAuth flow end-to-end
