# Polar OAuth2 Documentation vs Implementation Comparison

**Date**: January 13, 2026  
**Status**: CRITICAL DISCREPANCIES FOUND ⚠️

---

## Executive Summary

The current implementation contains **TWO CRITICAL ENDPOINT MISMATCHES** between what's being used and what's documented by Polar:

1. **OAuth Authorization Endpoint**: Using `flow.polar.com` (undocumented) ✓ CORRECT
2. **Token Exchange Endpoint**: Using inconsistent URLs with a **404 error** ❌ WRONG
3. **User Registration Endpoint**: Using `www.polaraccesslink.com` (undocumented) ⚠️ QUESTIONABLE

---

## 1. OFFICIAL POLAR OAUTH2 DOCUMENTATION

### Source
- **Official Docs**: https://polar.sh/docs/integrate/oauth2/
- **Setup Guide**: https://polar.sh/docs/integrate/oauth2/setup
- **Connect Flow**: https://polar.sh/docs/integrate/oauth2/connect

### Official Specification: Token Exchange

#### Endpoint (from official docs)
```
POST https://api.polar.sh/v1/oauth2/token
```

#### Request Method
```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'
```

#### Authentication Method
- **Type**: HTTP Basic Authentication OR Form Parameters
- **Form Parameters** (shown in official example):
  - `client_id=CLIENT_ID`
  - `client_secret=CLIENT_SECRET`
- **OR Basic Auth Header**: `Authorization: Basic <base64(client_id:client_secret)>`

#### Request Headers
| Header | Value | Notes |
|--------|-------|-------|
| `Content-Type` | `application/x-www-form-urlencoded` | Required |

#### Request Body
```
grant_type=authorization_code
code=<authorization_code>
client_id=<your_client_id>
client_secret=<your_client_secret>
redirect_uri=<your_redirect_uri>
```

#### Response Format
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

#### Response Fields
| Field | Type | Description |
|-------|------|-------------|
| `token_type` | string | Always "Bearer" |
| `access_token` | string | OAuth2 access token (format: `polar_at_*`) |
| `expires_in` | number | Token expiration in seconds (864000 = 10 days) |
| `refresh_token` | string | Long-lived token for refreshing (format: `polar_rt_*`) |
| `scope` | string | Space-separated scopes granted |
| `id_token` | string | Signed JWT (OpenID Connect) |

#### Scope Requirements
- Default: `openid email`
- User must authorize all requested scopes
- Scopes declared during OAuth client registration

#### Redirect URI Validation
- **Must be HTTPS** (except `localhost`)
- **Must match exactly** what was registered in Polar dashboard
- Case-sensitive URL matching
- Query parameters allowed but must be consistent
- Fragment (#) identifiers NOT allowed

---

## 2. IMPLEMENTATION ANALYSIS

### File Locations
- **Worker**: [worker/src/routes.ts](worker/src/routes.ts#L837-L900)
- **Server**: [server/routes.ts](server/routes.ts#L820-L880)

### Current Implementation: Authorization Endpoint

#### Worker Implementation (Line 837)
```typescript
const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
```

#### Server Implementation (Line 820)
```typescript
const authUrl = `https://flow.polar.com/oauth2/authorization?response_type=code&client_id=${POLAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
```

**Status**: ✓ CORRECT (though undocumented in official docs)

---

### Current Implementation: Token Exchange Endpoint ⚠️ CRITICAL ISSUE

#### Worker Implementation (Line 882)
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

#### Server Implementation (Line 854)
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

---

## 3. CRITICAL DISCREPANCIES FOUND

### ❌ ISSUE #1: Token Exchange Endpoint URL Mismatch

| Aspect | Official Docs | Worker Implementation | Server Implementation |
|--------|---------------|----------------------|----------------------|
| **Endpoint URL** | `https://api.polar.sh/v1/oauth2/token` | `https://api.polaraccesslink.com/v3/oauth2/token` | `https://polaraccesslink.com/v3/oauth2/token` |
| **Protocol** | HTTPS ✓ | HTTPS ✓ | HTTPS ✓ |
| **Subdomain** | `api.polar.sh` | `api.polaraccesslink.com` | `polaraccesslink.com` |
| **Version** | `/v1/` | `/v3/` | `/v3/` |

**Analysis**:
- Official documentation uses: `https://api.polar.sh/v1/oauth2/token`
- Worker uses: `https://api.polaraccesslink.com/v3/oauth2/token` (v3 + different domain)
- Server uses: `https://polaraccesslink.com/v3/oauth2/token` (no api subdomain + v3)

**Root Cause of 404 Error**: 
The endpoint at `https://api.polaraccesslink.com/v3/oauth2/token` or `https://polaraccesslink.com/v3/oauth2/token` **does not exist or is not documented**. The official endpoint is at `https://api.polar.sh/v1/oauth2/token`.

**Severity**: 🔴 CRITICAL - This causes the token exchange to fail with 404 Not Found

---

### ⚠️ ISSUE #2: Inconsistent Endpoint Between Worker and Server

| Component | Endpoint |
|-----------|----------|
| Worker | `https://api.polaraccesslink.com/v3/oauth2/token` |
| Server | `https://polaraccesslink.com/v3/oauth2/token` |

**Problem**: 
- Worker includes `api.` subdomain
- Server does not include `api.` subdomain
- Both point to different (possibly non-existent) endpoints

---

### ❌ ISSUE #3: Missing client_secret in Form Body

**Official Specification**:
```
grant_type=authorization_code&code=XXX&client_id=YYY&client_secret=ZZZ&redirect_uri=URN
```

**Current Implementation**:
```typescript
body: new URLSearchParams({
  grant_type: 'authorization_code',
  code: code as string,
  redirect_uri: redirectUri,
}).toString(),
```

**Problem**: 
- Implementation is missing `client_id` and `client_secret` from the body
- Only using Basic Auth header for authentication
- Official docs show form-based parameters as the example

**Note**: This might work if Polar accepts Basic Auth as an alternative, but it's not the documented approach.

---

### ⚠️ ISSUE #4: User Registration Endpoint (Non-Standard)

#### Current Implementation (Line 917)
```typescript
const registerResponse = await fetch('https://www.polaraccesslink.com/v3/users', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${access_token}`,
  },
  body: JSON.stringify({ 'member-id': userId }),
});
```

**Problem**:
- Uses `www.polaraccesslink.com` (not documented in official Polar docs)
- Uses `/v3/users` endpoint (not in official documentation)
- Uses Bearer token (which is correct for authenticated endpoints)
- This endpoint is undocumented and appears to be a private/internal Polar API

**Status**: ⚠️ UNCERTAIN - May work but is not officially documented

---

## 4. AUTHENTICATION METHOD COMPARISON

### Official Specification
The official documentation shows **form parameters**:
```bash
curl -X POST https://api.polar.sh/v1/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=AUTHORIZATION_CODE&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&redirect_uri=https://example.com/callback'
```

### Current Implementation
Uses **HTTP Basic Auth** header:
```typescript
const authHeader = btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`);
headers: {
  'Authorization': `Basic ${authHeader}`,
}
```

### Assessment
- ✓ Basic Auth is a valid OAuth2 method
- ✓ Both approaches should be equivalent
- ❌ But implementation should match documentation
- ❌ The official example doesn't use Basic Auth

---

## 5. ENDPOINT DOMAIN CLARIFICATION

### Polar Domains
| Domain | Purpose | Status |
|--------|---------|--------|
| `polar.sh` | Main website & OAuth | Official |
| `api.polar.sh` | Core API endpoints | Official & Documented |
| `flow.polar.com` | OAuth Authorization page | Undocumented but works |
| `polaraccesslink.com` | Unknown/Legacy API | Undocumented |
| `www.polaraccesslink.com` | Unknown/Legacy API | Undocumented |
| `api.polaraccesslink.com` | Unknown/Legacy API | Undocumented |

### Our Current Usage
```
Authorization:    https://flow.polar.com/oauth2/authorization     ✓ Works (undocumented)
Token Exchange:   https://api.polaraccesslink.com/v3/oauth2/token ❌ 404 Error
Token Exchange:   https://polaraccesslink.com/v3/oauth2/token     ❌ 404 Error
User Register:    https://www.polaraccesslink.com/v3/users        ⚠️ Undocumented
```

---

## 6. HTTP STATUS CODE ERRORS

### 404 Not Found

**Definition**: Resource does not exist at the requested URL

**In Our Case**:
- Endpoint: `https://api.polaraccesslink.com/v3/oauth2/token`
- Status: Does not exist (or is not publicly available)
- Solution: Use documented endpoint `https://api.polar.sh/v1/oauth2/token`

### Common OAuth2 Error Codes (per RFC 6749)

| Code | Meaning | Solution |
|------|---------|----------|
| `400 Bad Request` | Invalid parameters | Verify all required fields are present |
| `401 Unauthorized` | Invalid credentials | Check client_id and client_secret |
| `403 Forbidden` | Client not authorized | Verify OAuth client is active |
| `404 Not Found` | Endpoint doesn't exist | Use correct endpoint URL |
| `429 Too Many Requests` | Rate limited | Implement exponential backoff |
| `500 Server Error` | Polar service issue | Retry after delay |

---

## 7. CORRECTED IMPLEMENTATION

### Recommended Token Exchange Code

#### Using Form Parameters (Matches Docs)
```typescript
const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    client_id: POLAR_CLIENT_ID,
    client_secret: POLAR_CLIENT_SECRET,
    redirect_uri: redirectUri,
  }).toString(),
});
```

#### Using Basic Auth (Current Approach - if Polar Supports)
```typescript
const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${btoa(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`)}`,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri,
  }).toString(),
});
```

### Key Changes
1. ✅ Change endpoint to: `https://api.polar.sh/v1/oauth2/token`
2. ✅ Keep all other parameters identical
3. ✅ Use consistent endpoint across worker AND server

---

## 8. SCOPE REQUIREMENTS

### From Official Documentation
**Default Scopes**: `openid email`

**Configuration**:
- Declared during OAuth client creation in Polar dashboard
- User must grant permission for requested scopes
- Returned in token response as `scope` field

### Current Implementation Check
- ✓ Currently requests: `openid email` (shown in authorization URL)
- ✓ No additional scopes requested
- ✓ Within Polar's supported scope model

---

## 9. REDIRECT_URI VALIDATION RULES

### Official Requirements
1. **Must be HTTPS** (except `localhost`)
2. **Must match exactly** registered URI
3. **Case-sensitive** matching
4. **Query parameters** allowed (but must be consistent)
5. **Fragment** identifiers NOT allowed
6. **Port numbers** must match (e.g., `:5000` vs `:3000` are different)

### Current Implementation
```typescript
const redirectUri = `${c.env.WORKER_URL || 'https://runna-io-api.runna-io-api.workers.dev'}/api/polar/callback`;
```

**Analysis**:
- ✓ Uses HTTPS
- ✓ Points to callback endpoint
- ⚠️ MUST be exactly registered in Polar dashboard
- ✓ No query parameters
- ✓ No fragments

**Critical Point**: The exact redirect URI MUST match what was registered when creating the OAuth2 client in Polar dashboard.

---

## 10. OPENID CONNECT DISCOVERY

### Discovery Endpoint (from docs)
```
https://api.polar.sh/.well-known/openid-configuration
```

**Status**: Mentioned in docs but returns 404 when accessed  
**Note**: Not critical for basic OAuth flow, but useful for auto-discovery

---

## 11. SUMMARY TABLE: WHAT'S WRONG

| Issue | Severity | Component | Current | Should Be | Fix |
|-------|----------|-----------|---------|-----------|-----|
| Token endpoint URL | 🔴 CRITICAL | Both | `api.polaraccesslink.com/v3` | `api.polar.sh/v1` | Change URL |
| Server endpoint URL | 🔴 CRITICAL | Server | `polaraccesslink.com/v3` | `api.polar.sh/v1` | Change URL |
| API version | ⚠️ WARNING | Both | `/v3/` | `/v1/` | Update |
| client_id/secret in body | ⚠️ UNCERTAIN | Both | Missing in body | Should be in body OR Basic Auth | Consider form params |
| User registration endpoint | ⚠️ UNCERTAIN | Both | `www.polaraccesslink.com/v3` | Unknown | Request Polar docs |

---

## 12. RECOMMENDED FIXES

### Priority 1: CRITICAL - Fix Token Exchange Endpoint

**File**: [worker/src/routes.ts](worker/src/routes.ts#L882)
```diff
- const tokenResponse = await fetch('https://api.polaraccesslink.com/v3/oauth2/token', {
+ const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

**File**: [server/routes.ts](server/routes.ts#L854)
```diff
- const tokenResponse = await fetch('https://polaraccesslink.com/v3/oauth2/token', {
+ const tokenResponse = await fetch('https://api.polar.sh/v1/oauth2/token', {
```

### Priority 2: RECOMMENDED - Use Form Parameters Instead of Basic Auth

Consider switching to documented form-parameter approach:

```typescript
body: new URLSearchParams({
  grant_type: 'authorization_code',
  code: code as string,
  client_id: POLAR_CLIENT_ID,
  client_secret: POLAR_CLIENT_SECRET,
  redirect_uri: redirectUri,
}).toString(),
```

This matches the official documentation exactly.

### Priority 3: UNCERTAIN - Verify User Registration Endpoint

Contact Polar support to confirm:
- Is `https://www.polaraccesslink.com/v3/users` the correct endpoint?
- Is the `/v3/` version correct?
- Should it be `https://api.polar.sh/v1/...` instead?

---

## 13. TESTING RECOMMENDATIONS

After fixing the endpoint URLs:

1. **Test with Real Credentials**:
   - Use a valid Polar OAuth2 client ID and secret
   - Test token exchange against new endpoint
   - Verify response contains `access_token` and `x_user_id`

2. **Test Error Cases**:
   - Invalid authorization code → Should return 400 Bad Request
   - Expired code → Should return 400 Bad Request
   - Invalid client credentials → Should return 401 Unauthorized
   - Wrong redirect_uri → Should return 400 Bad Request

3. **Check Logs**:
   - Verify console.error messages show 200 status code
   - Confirm response includes expected token fields
   - Validate token format (should start with `polar_at_`)

4. **Integration Test**:
   - Complete full OAuth flow end-to-end
   - Verify user account gets created/linked
   - Test disconnection and re-linking

---

## References

### Official Documentation
- **Polar OAuth2 Connect**: https://polar.sh/docs/integrate/oauth2/connect
- **Polar OAuth2 Setup**: https://polar.sh/docs/integrate/oauth2/setup
- **Polar OAuth2 Intro**: https://polar.sh/docs/integrate/oauth2/introduction
- **Polar API Reference**: https://polar.sh/docs/api-reference/introduction

### Related Standards
- **RFC 6749 - OAuth 2.0 Authorization Framework**: https://tools.ietf.org/html/rfc6749
- **OpenID Connect 1.0**: https://openid.net/specs/openid-connect-core-1_0.html

---

## Appendix: Current Code Locations

### Worker Routes
- File: [worker/src/routes.ts](worker/src/routes.ts)
- Authorization endpoint: Line 837
- Token exchange: Line 882
- User registration: Line 917

### Server Routes
- File: [server/routes.ts](server/routes.ts)
- Authorization endpoint: Line 820
- Token exchange: Line 854
- User registration: ~Line 890

### Worker Environment Configuration
- File: [worker/src/index.ts](worker/src/index.ts#L12-L13)
- Variables: `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, `WORKER_URL`, `FRONTEND_URL`

### Server Environment Configuration
- File: [server/routes.ts](server/routes.ts#L778-L784)
- Variables: `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`, `REPLIT_DEV_DOMAIN`, `POLAR_REDIRECT_DOMAIN`
