# COROS API Application Guide for Runna.io

**Date:** March 3, 2026  
**Status:** Ready to Apply  
**Application URL:** https://coros.com/api

---

## 📋 Pre-Application Checklist

- [x] Support page created at `/support`
- [x] Privacy policy updated with COROS
- [x] Logo resize script created (`generate_coros_logos.py`)
- [x] Health check endpoint available (`/api/health`)
- [x] Database schema prepared
- [x] API routes implemented (placeholder)
- [x] Storage methods created

---

## 🚀 Application Form Answers

### Basic Information

| Field | Value |
|-------|-------|
| **Application Name** | Runna.io |
| **Company/Developer** | Javier Poves Ruiz |
| **Contact Email** | runna.io.service@gmail.com |
| **Website URL** | https://runna-io.pages.dev |
| **Platform Type** | Web Application (PWA) |

### Integration Details

**Application Description:**
```
Runna.io is a competitive territory-conquest running app. Users sync their running 
activities with GPS data to conquer geographic areas on a map and compete with friends. 
We need to sync running/walking activities including GPS tracks, distance, and duration 
from COROS watches.
```

**Intended Use of Data:**
```
Runna.io syncs GPS workout data from COROS watches to enable competitive territory-based 
gameplay. Specifically:

1. GPS Route Processing: We convert activity polylines into geographical routes displayed 
   on an interactive map
2. Territory Conquest: Routes are buffered by 50 meters to create territory polygons. 
   Users "conquer" these areas
3. Social Competition: Users can "steal" territory from friends when their routes overlap 
   existing territories
4. Statistics & Rankings: We calculate total distance, area conquered, and display 
   leaderboards

Data retention:
- GPS tracks: Stored permanently as routes for territory calculation
- Activity metadata: Distance, duration, activity type stored for statistics
- User control: Users can delete individual activities and disconnect their COROS account 
  anytime

Security: All data is encrypted in transit (HTTPS) and stored in Turso SQLite database 
with access controls.
```

### Technical Configuration

| Field | Value |
|-------|-------|
| **OAuth Callback URL** | `https://runna-io-api.runna-io-api.workers.dev/api/coros/callback` |
| **Webhook Endpoint** | `https://runna-io-api.runna-io-api.workers.dev/api/coros/webhook` |
| **Service Status URL** | `https://runna-io-api.runna-io-api.workers.dev/api/health` |
| **Privacy Policy** | https://runna-io.pages.dev/privacy |
| **Terms of Service** | https://runna-io.pages.dev/terms |
| **Support Page** | https://runna-io.pages.dev/support |

### Data Requirements

**Data Needed:**
- Running/walking/trail running activities with GPS tracks
- Distance (meters)
- Duration (seconds)
- Start time
- Activity type

**Structured Workouts:** No (only activity sync, no workout/plan push to COROS)

**Bluetooth/ANT+:** N/A (API-only integration)

### Application Type

- **Personal or Public Use:** Public use
- **Commercial or Non-commercial:** Non-commercial use
- **Testing Units Needed:** No (API-only integration)
- **Existing Integrations:** Strava, Polar Flow

---

## 📦 Logo Preparation

### Step 1: Generate Logos

Run the logo generation script:

```bash
python generate_coros_logos.py
```

This creates:
- ✅ `runna_logo_144x144.png` (required)
- ✅ `runna_logo_102x102.png` (required)
- 📦 `runna_logo_120x120.png` (optional - for structured workouts)
- 📦 `runna_logo_300x300.png` (optional - for training plans)

### Step 2: Email Logos to COROS

**To:** api@coros.com  
**Subject:** Runna.io - API Images  
**Attachments:** At minimum, attach `runna_logo_144x144.png` and `runna_logo_102x102.png`

---

## 🔧 Post-Approval Setup

### Once COROS Approves Your Application

You will receive:
- `COROS_CLIENT_ID`
- `COROS_CLIENT_SECRET`
- API Reference Guide

### Step 1: Add Environment Variables

In Cloudflare Workers dashboard:

```bash
wrangler secret put COROS_CLIENT_ID
wrangler secret put COROS_CLIENT_SECRET
```

### Step 2: Run Database Migration

```bash
# Apply COROS tables migration
wrangler d1 execute runna-io-db --file=migrations/coros_integration.sql
```

### Step 3: Update API Implementation

Review the COROS API Reference Guide and update these files:

**`worker/src/routes.ts`** - Update TODO comments:
- Line ~5180: OAuth authorization URL
- Line ~5230: Token exchange endpoint
- Line ~5245: Token response field names
- Line ~5320: Webhook data format and processing

**Test the OAuth flow:**
1. Visit `/profile` in the app
2. Click "Connect with COROS"
3. Authorize in COROS web
4. Verify callback redirects successfully

### Step 4: Notify COROS Before Launch

**1 week before going live**, email COROS at api@coros.com:

```
Subject: Runna.io - Integration Launch Notice

Hi COROS Team,

This is to notify you that Runna.io's COROS integration will go live on [DATE].

Integration details:
- Webhook endpoint: https://runna-io-api.runna-io-api.workers.dev/api/coros/webhook
- Health check: https://runna-io-api.runna-io-api.workers.dev/api/health
- Login portal: https://runna-io.pages.dev/support

Please update your partnerships page accordingly.

Best regards,
Javier Poves Ruiz
runna.io.service@gmail.com
```

---

## 📚 Implementation Status

### ✅ Completed

| Component | File | Status |
|-----------|------|--------|
| Support Page | `client/src/pages/SupportPage.tsx` | ✅ Created |
| Support Route | `client/src/App.tsx` | ✅ Added |
| Health Endpoint | `worker/src/routes.ts:1336` | ✅ Implemented |
| Logo Script | `generate_coros_logos.py` | ✅ Created |
| Privacy Policy | `PRIVACY_POLICY.md` | ✅ Updated |
| Privacy Page | `client/src/pages/PrivacyPage.tsx` | ✅ Updated |
| Database Schema | `shared/schema.ts` | ✅ Added tables |
| Migration File | `migrations/coros_integration.sql` | ✅ Created |
| API Routes | `worker/src/routes.ts:5178-5400` | ✅ Scaffolded |
| Storage Methods | `worker/src/storage.ts:1438-1553` | ✅ Implemented |

### ⏳ Pending (After API Approval)

- [ ] Update OAuth URLs with actual COROS endpoints
- [ ] Update token exchange format
- [ ] Implement webhook data parsing
- [ ] Test OAuth flow end-to-end
- [ ] Apply database migration
- [ ] Add COROS connect button to ProfilePage.tsx
- [ ] Test webhook reception and processing

---

## 🔍 API Routes Reference

All routes are in `worker/src/routes.ts`:

| Method | Endpoint | Purpose | Line |
|--------|----------|---------|------|
| GET | `/api/health` | Service status check | 1336 |
| GET | `/api/coros/status/:userId` | Check connection status | 5178 |
| GET | `/api/coros/connect` | Initiate OAuth flow | 5202 |
| GET | `/api/coros/callback` | OAuth callback handler | 5221 |
| POST | `/api/coros/disconnect` | Revoke connection | 5281 |
| POST | `/api/coros/webhook` | Receive workout data | 5303 |
| GET | `/api/coros/activities/:userId` | List synced activities | 5323 |
| DELETE | `/api/coros/activities/:userId/:activityId` | Delete activity | 5335 |
| POST | `/api/coros/process/:userId` | Process pending workouts | 5359 |

---

## 🧪 Testing Checklist (Post-Approval)

### OAuth Flow
- [ ] Connect button appears in profile
- [ ] OAuth redirect to COROS works
- [ ] Callback processes successfully
- [ ] Account appears in database
- [ ] Status endpoint shows connected

### Webhook Reception
- [ ] Webhook receives POST data
- [ ] Workout data is parsed correctly
- [ ] Activity record created in DB
- [ ] Processing creates route/territory

### Activity Management
- [ ] Activities list in profile
- [ ] Delete activity works
- [ ] Territory removed on delete

---

## 📞 Support & Resources

| Resource | Link |
|----------|------|
| COROS API Portal | https://coros.com/api |
| Support Email | api@coros.com |
| Runna Support Page | https://runna-io.pages.dev/support |
| Privacy Policy | https://runna-io.pages.dev/privacy |

---

## 🎯 Next Steps

1. **Generate logos:** `python generate_coros_logos.py`
2. **Email logos to COROS:** api@coros.com (Subject: "Runna.io - API Images")
3. **Submit application:** https://coros.com/api
4. **Wait for approval:** COROS will email credentials
5. **Configure environment:** Add CLIENT_ID and CLIENT_SECRET
6. **Update implementation:** Fill in TODO comments with actual API URLs
7. **Run migration:** Apply database schema
8. **Test OAuth:** Verify connection flow works
9. **Notify COROS:** 1 week before launch
10. **Launch:** Enable COROS button in production

---

**Good luck with your application! 🚀**
