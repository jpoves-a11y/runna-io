# 🔴 CRITICAL: Polar OAuth2 Endpoint Mismatch - Quick Reference

## THE PROBLEM

You're getting **404 errors on token exchange** because you're using the **WRONG ENDPOINTS** for Polar's OAuth2 token exchange.

### Current (BROKEN) Implementation:
```
✓ Authorization:    https://flow.polar.com/oauth2/authorization
❌ Token Exchange:   https://api.polaraccesslink.com/v3/oauth2/token        (WORKER)
❌ Token Exchange:   https://polaraccesslink.com/v3/oauth2/token           (SERVER)
```

### Official (CORRECT) Specification:
```
✓ Authorization:    https://flow.polar.com/oauth2/authorization            (undocumented, works)
✅ Token Exchange:   https://api.polar.sh/v1/oauth2/token                  (OFFICIAL)
```

---

## WHAT'S WRONG

| Issue | Why It Matters | Fix |
|-------|---------------|-----|
| Using `polaraccesslink.com` instead of `polar.sh` | These endpoints don't exist/aren't documented → 404 errors | Change domain to `api.polar.sh` |
| Using `/v3/` instead of `/v1/` | API version mismatch | Change to `/v1/` |
| Worker and Server use different URLs | Creates inconsistent behavior | Make both use `api.polar.sh/v1/oauth2/token` |

---

## THE FIX

### Worker File: `worker/src/routes.ts` (Line 882)

**BEFORE:**
```typescript
const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {
```

**AFTER:**
```typescript
const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

---

### Server File: `server/routes.ts` (Line 854)

**BEFORE:**
```typescript
const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
```

**AFTER:**
```typescript
const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

---

## DETAILED COMPARISON

### Official Documentation Says:
```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'
```

### Your Current Code (Worker):
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
```

### Your Current Code (Server):
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
```

### What Needs to Change:
| Aspect | Official | Worker Now | Server Now | Should Be |
|--------|----------|-----------|-----------|-----------|
| **URL** | `api.polar.sh/v1/oauth2/token` | `api.polaraccesslink.com/v3/oauth2/token` ❌ | `polaraccesslink.com/v3/oauth2/token` ❌ | `api.polar.sh/v1/oauth2/token` ✅ |
| **Method** | POST ✅ | POST ✅ | POST ✅ | POST ✅ |
| **Content-Type** | `application/x-www-form-urlencoded` ✅ | Same ✅ | Same ✅ | Same ✅ |
| **Auth Method** | Form params | Basic header | Basic header | Form params OR Basic header |
| **Parameters** | In form body with `client_id` & `client_secret` | Missing from body | Missing from body | Should include both approaches |

---

## ROOT CAUSE ANALYSIS

### Why Is This Happening?

1. **polaraccesslink.com** appears to be an outdated or private domain
2. **The correct public API** is at `api.polar.sh` (v1)
3. Your code may have been based on:
   - Old/deprecated Polar documentation
   - Private/internal API endpoints
   - Copy-pasted from incorrect sources
4. **Both worker and server have this bug** - suggests copy-paste from same source

### Why The 404 Error?

```
GET/POST https://api.polaraccesslink.com/v3/oauth2/token
                 ↑ This domain + endpoint combination doesn't exist in production
                 
HTTP/1.1 404 Not Found
```

The server at `api.polaraccesslink.com` either:
- Doesn't have the `/v3/oauth2/token` endpoint
- Isn't responding to requests
- Is a deprecated/private API

---

## ADDITIONAL ISSUES FOUND

### Issue #2: Missing Client Credentials in Body (Minor)

**Official approach**: Include `client_id` and `client_secret` in the form body
```
grant_type=authorization_code&code=XXX&client_id=YYY&client_secret=ZZZ&redirect_uri=URN
```

**Your approach**: Only in Basic Auth header
```typescript
body: new URLSearchParams({
  grant_type: 'authorization_code',
  code: code as string,
  redirect_uri: redirectUri,
}).toString(),
```

**Assessment**: Might work if Polar accepts both methods, but doesn't match docs.

### Issue #3: User Registration Endpoint Undocumented

Your code uses: `https://www.polaraccesslink.com/v3/users`

This endpoint is **not documented in official Polar API docs**. It may be:
- A private/internal API
- Working by accident
- Scheduled for deprecation

**Recommendation**: Contact Polar support to confirm the correct endpoint.

---

## TESTING AFTER FIX

After updating the endpoints, test with:

```bash
# 1. Start the OAuth flow
curl "http://localhost:5000/api/polar/connect?userId=test-user-123"

# 2. Should return authorization URL at correct Polar endpoint:
# https://flow.polar.com/oauth2/authorization?...

# 3. After user authorizes, callback will attempt token exchange
# Should now use: https://api.polar.sh/v1/oauth2/token
# Should return: 200 OK with tokens (not 404)

# 4. Check logs for:
# ✅ "Exchanging code for token..."
# ✅ "Polar token exchange succeeded"
# ❌ NOT "Polar token exchange failed: 404"
```

---

## REFERENCE DOCUMENTATION

**Polar Official OAuth2 Documentation**:
- Main: https://polar.sh/docs/integrate/oauth2/
- Setup: https://polar.sh/docs/integrate/oauth2/setup
- Connect: https://polar.sh/docs/integrate/oauth2/connect
- API Ref: https://polar.sh/docs/api-reference/introduction

**Key Points from Official Docs**:
- Token endpoint: `https://api.polar.sh/v1/oauth2/token`
- Bearer token format: `polar_at_*` for access tokens
- Expires in: 864000 seconds (10 days)
- Refresh tokens: `polar_rt_*` format
- Scopes: `openid email` by default

---

## FILES TO UPDATE

### 1. Worker Routes
**File**: `worker/src/routes.ts`  
**Line**: 882  
**Change**: Update token endpoint URL

### 2. Server Routes
**File**: `server/routes.ts`  
**Line**: 854  
**Change**: Update token endpoint URL

### 3. (Optional) Environment Config
**Worker File**: `worker/src/index.ts`  
**Server File**: `server/routes.ts`  
**Note**: No changes needed, just ensure credentials are set

---

## ESTIMATED IMPACT

### Breaking Change: No
- Just changing endpoint URLs
- Same request/response format
- Same credentials required

### Deployment Impact: Minimal
- Simple URL string replacement
- No database changes
- No dependency updates
- No configuration changes

### Testing Required: Yes
- Test OAuth flow end-to-end
- Verify token exchange succeeds
- Confirm user account linking works

---

## NEXT STEPS

1. ✅ **Understand the issue** (you are here)
2. 📝 **Update endpoint URLs** in both worker and server
3. 🧪 **Test the OAuth flow**
4. 📊 **Monitor logs** for successful token exchange
5. 🚀 **Deploy** to production

---

## QUESTIONS TO INVESTIGATE

1. **Where did the `polaraccesslink.com` endpoints come from?**
   - Check git history: `git log --follow -p -- worker/src/routes.ts | grep -A5 -B5 polaraccesslink`
   - Check PR comments and issues

2. **Is there a version 3 API somewhere?**
   - Contact Polar support
   - Check Polar GitHub repo
   - Look for migration guides

3. **Is there a v3 user registration endpoint?**
   - The `www.polaraccesslink.com/v3/users` endpoint is also undocumented
   - May need to investigate if there's a v1 equivalent on `api.polar.sh`

4. **Why use Basic Auth instead of form parameters?**
   - Either approach should work
   - But docs show form parameters as the example
   - Consider matching documented approach for future-proofing

---

## SUMMARY

| Component | Status | Issue | Fix |
|-----------|--------|-------|-----|
| **Auth Endpoint** | ✅ WORKS | Using `flow.polar.com` (undocumented) | NONE - it works |
| **Token Endpoint** | ❌ BROKEN | Using wrong domain/version (404) | Change to `api.polar.sh/v1/oauth2/token` |
| **Auth Method** | ⚠️ WORKS | Using Basic instead of form params | Optional - consider matching docs |
| **User Register** | ⚠️ UNDOCUMENTED | Using `www.polaraccesslink.com/v3/users` | Verify with Polar support |

**Bottom Line**: Fix the token endpoint URLs and the OAuth flow will work. It's a 1-2 line fix in each file.
