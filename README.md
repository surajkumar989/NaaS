# NaaS — Push Notification as a Service

> A distributed system built to prove end-to-end engineering ownership: multi-tenant credential isolation, async queue processing, real-time delivery tracking, and a clean developer-facing API — all deployable on free tier.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [What This Platform Does](#2-what-this-platform-does)
3. [Core Design Principle](#3-core-design-principle)
4. [The Stripe Analogy](#4-the-stripe-analogy)
5. [How It Works — End to End](#5-how-it-works--end-to-end)
6. [Architecture](#6-architecture)
7. [FCM Multi-Tenancy Model](#7-fcm-multi-tenancy-model)
8. [API Reference](#8-api-reference)
9. [Tech Stack & Why](#9-tech-stack--why)
10. [Data Models](#10-data-models)
11. [Key Engineering Decisions & Tradeoffs](#11-key-engineering-decisions--tradeoffs)
12. [Error Handling & Edge Cases](#12-error-handling--edge-cases)
13. [Delivery Guarantees](#13-delivery-guarantees)
14. [Rate Limiting](#14-rate-limiting)
15. [Repo Structure](#15-repo-structure)
16. [Local Setup](#16-local-setup)
17. [Deployment (Free Tier)](#17-deployment-free-tier)
18. [Demo Strategy](#18-demo-strategy)
19. [Roadmap — Not in V1](#19-roadmap--not-in-v1)

---

## 1. Problem Statement

Every app eventually needs push notifications. But building the infrastructure from scratch means managing FCM credentials, token storage, retry logic, delivery status, analytics, and a queue — before you've sent a single notification. Most teams either overbuild this (a full internal service), underbuild it (fire-and-forget fetch calls with no retries), or pay for a third-party service they don't fully control or understand.

NaaS is that third-party service — but built in the open, fully explainable, and deployable by any developer on free infrastructure.

---

## 2. What This Platform Does

NaaS is a REST API that lets developers send push notifications to their web or mobile app users without building their own notification infrastructure.

**Developer experience:**
1. Sign up, create a Project, upload your Firebase service account credentials once.
2. Get an API key.
3. Call one endpoint: `POST /notifications` with `{ deviceToken, title, body }`.
4. NaaS handles queuing, delivery, retries, status tracking, and analytics.

That's the entire integration surface. No SDK required. No schema changes to the developer's own database.

---

## 3. Core Design Principle

> **NaaS never touches or depends on the client's own database or user schema.**

Developers store their own users' FCM device tokens in their own database (Postgres, Mongo, MySQL — whatever they use). When they want to notify a user, their backend calls our API with the token. We don't store tokens. We don't know who the end user is. We only store:

- Developer accounts
- Projects and API keys
- Firebase service account credentials (encrypted at rest, per project)
- Notification logs and delivery status
- Aggregated analytics

This boundary is deliberate. It keeps NaaS stateless with respect to end users, eliminates any GDPR surface around user identity, and means our data model stays simple regardless of how complex a developer's own user schema is.

---

## 4. The Stripe Analogy

The mental model for this platform is **Stripe for push notifications**.

Stripe doesn't own your customers or their payment methods. You bring your customers; Stripe provides the infrastructure to charge them and handles all the hard parts (PCI compliance, retries, failure tracking, webhooks). You integrate once and get all of that for free.

NaaS works the same way:

| Stripe | NaaS |
|---|---|
| You bring your customers | You bring your users' device tokens |
| Stripe stores your payment gateway credentials | NaaS stores your Firebase service account (encrypted) |
| Stripe charges on your behalf | NaaS sends push notifications on your behalf |
| Stripe gives you payment logs and analytics | NaaS gives you delivery logs and analytics |
| Stripe doesn't store your customers in their DB | NaaS doesn't store your users or their tokens |

The key insight: NaaS is a **routing and reliability layer**, not a user management layer.

---

## 5. How It Works — End to End

```
Developer's backend
        │
        │  POST /notifications
        │  { apiKey, deviceToken, title, body }
        ▼
  NaaS API Server (Express)
        │
        ├─ 1. Validate API key → look up Project → get developer account
        ├─ 2. Create NotificationLog entry (status: "queued")
        ├─ 3. Push job to Redis queue (BullMQ)
        └─ 4. Return 202 Accepted immediately
                          │
                          │  (async, separate process)
                          ▼
             NaaS Notification Worker
                          │
                          ├─ 1. Pull job from queue
                          ├─ 2. Load Project → decrypt FCM service account
                          ├─ 3. Init Firebase Admin SDK instance for this project
                          ├─ 4. Send push via FCM
                          ├─ 5. Update NotificationLog (status: "sent" or "failed")
                          └─ 6. On failure: exponential backoff retry (BullMQ)
                                          │
                                          ▼
                               Developer's Firebase Project
                                          │
                                          ▼
                               End user's device (web/Android)
```

---

## 6. Architecture

### Why Two Separate Processes?

The API server (`src/server.js`) and the notification worker (`worker/notificationWorker.js`) are deployed as **two separate services** on Render.

This is the most important architectural decision in the system. The reason:

- FCM calls are network I/O — they can be slow, throttled, or hang entirely.
- If the worker lived in the same process as the API server, a slow or crashing FCM call could block the API from accepting new requests.
- Separating them means the API server's only job is to validate, log, and enqueue — it always responds fast (202 in < 50ms). The worker's only job is to process the queue reliably, at whatever pace FCM allows.
- A crash in the worker doesn't take down the API. The queue persists in Redis. When the worker restarts, it picks up where it left off.

This is the same pattern used by every serious job-processing system: the web tier and the worker tier are independent units that can scale, crash, and restart independently.

### Request Lifecycle

```
Incoming Request → Rate Limiter → Auth Middleware → Controller
                                                         │
                                               Create Log Entry
                                                         │
                                               Enqueue Job (Redis)
                                                         │
                                               Return 202 Accepted
```

### Worker Lifecycle

```
Queue Event → Pull Job → Decrypt Credentials → Init FCM App
                                                      │
                                              Send Notification
                                                      │
                              ┌───────────────────────┤
                         Success                   Failure
                              │                       │
                    Update Log: "sent"     Retry with backoff
                                               (up to 3 times)
                                                      │
                                             Update Log: "failed"
```

---

## 7. FCM Multi-Tenancy Model

This is the most nuanced part of the system and worth understanding deeply.

### The Problem

An FCM device token is not neutral. When a user's device registers with Firebase, it generates a token that is **permanently tied to a specific Firebase project** (identified by a Sender ID). To send a push notification to that token, the sender must authenticate as that same Firebase project using a service account private key.

This means: if Developer A's users registered their devices using Developer A's Firebase project, only someone with Developer A's service account can send to those users.

### Our Solution: Per-Tenant Credential Storage

When a developer creates a Project on NaaS, they upload their Firebase service account JSON (downloadable from their Firebase console: Project Settings → Service Accounts → Generate new private key). We store it encrypted at rest in MongoDB, tied to their Project document.

At send time, the worker:
1. Loads the Project from the DB.
2. Decrypts the service account JSON using a symmetric key stored in our environment variables.
3. Initializes a Firebase Admin SDK app instance named after the project ID (so it doesn't collide with other tenants' instances).
4. Sends the notification using that instance.
5. Caches the initialized app instance in memory so re-initialization doesn't happen on every job.

### Why This Is the Right Model

The alternative (Model A) would be to own a single Firebase project and have all developers embed *our* Firebase config in their client app. This means:
- Developers have to modify their existing client-side Firebase setup.
- All push tokens are registered under our sender ID — we control too much.
- Any Firebase feature the developer uses (Analytics, Crashlytics, etc.) routes through our project.

Model B (what we built) means developers keep full ownership of their Firebase projects. We're just given a scoped permission (the service account key) to act on their behalf, for push only. This is the correct infrastructure-as-a-service pattern.

### Security Considerations

- Service account keys are encrypted with AES-256-CBC before being stored in MongoDB.
- The encryption key lives only in environment variables, never in the database.
- Keys are never returned in any API response after upload.
- On `POST /projects/:id/regenerate-key`, only the NaaS API key is regenerated — the FCM service account remains unchanged (those are the developer's credentials, not ours to rotate).

---

## 8. API Reference

All endpoints except `/auth/*` require an `Authorization: Bearer <jwt>` header.
Notification endpoints use `x-api-key: <projectApiKey>` instead of JWT.

### Auth

#### `POST /auth/signup`
```json
Body: { "email": "dev@example.com", "password": "..." }
Response 201: { "message": "Account created" }
```

#### `POST /auth/login`
```json
Body: { "email": "dev@example.com", "password": "..." }
Response 200: { "token": "<jwt>" }
```

---

### Projects

#### `POST /projects`
Creates a project. Accepts the Firebase service account JSON as part of the body.
```json
Body: { "name": "My App", "fcmServiceAccount": { ...serviceAccountJson } }
Response 201: { "projectId": "...", "apiKey": "naas_..." }
```

#### `GET /projects`
Returns all projects belonging to the authenticated developer.
```json
Response 200: [{ "id": "...", "name": "My App", "createdAt": "..." }]
```
Note: `fcmServiceAccount` is never returned.

#### `POST /projects/:id/regenerate-key`
Rotates the NaaS API key for this project. The FCM service account is unaffected.
```json
Response 200: { "apiKey": "naas_newkey..." }
```

---

### Notifications

All notification endpoints authenticate via `x-api-key` header (the project's API key), not JWT. This is intentional — the developer's backend server calls these endpoints, not their frontend, and they identify themselves by project API key, not by their personal account session.

#### `POST /notifications`
```json
Headers: { "x-api-key": "naas_..." }
Body: { "deviceToken": "fcm_token_here", "title": "Hello", "body": "World" }
Response 202: { "notificationId": "...", "status": "queued" }
```

#### `POST /notifications/bulk`
Same message, many tokens. Internally loops through the same single-send pipeline — not a separate system.
```json
Headers: { "x-api-key": "naas_..." }
Body: { "deviceTokens": ["token1", "token2", ...], "title": "Hello", "body": "World" }
Response 202: { "queued": 150, "notificationIds": ["...", "..."] }
```

#### `GET /notifications`
Returns paginated notification logs for the authenticated project.
```json
Response 200: { "data": [...], "total": 1000, "page": 1 }
```

#### `GET /notifications/:id`
Returns a single notification log entry including retry history.
```json
Response 200: { "id": "...", "status": "failed", "attempts": 3, "error": "..." }
```

---

### Analytics

#### `GET /analytics/summary`
Returns aggregated stats for the authenticated developer's projects.
```json
Response 200: {
  "total": 1523,
  "sent": 1401,
  "failed": 87,
  "retried": 35,
  "successRate": "91.99%",
  "byProject": [...]
}
```

---

## 9. Tech Stack & Why

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js | Non-blocking I/O fits notification workloads perfectly — lots of waiting on FCM responses, not CPU work |
| Framework | Express | Minimal, explicit, easy to reason about in interviews. No magic. |
| Database | MongoDB (Atlas) | Notification logs are semi-structured and append-heavy. Mongo's flexible schema and TTL indexes are a natural fit. Free tier on Atlas. |
| Queue | Redis + BullMQ | BullMQ gives us persistent jobs, exponential backoff, concurrency control, and a retry UI out of the box. Upstash Redis is free tier. |
| Push Provider | Firebase Admin SDK (FCM) | Industry standard. Supports web, Android. iOS (APNs) is roadmap. |
| Auth | JWT + bcrypt | Stateless auth, no session storage needed. bcrypt for password hashing with cost factor. |
| Rate Limiting | express-rate-limit | Per API key, in-memory for MVP. Upgrade path: Redis-backed for multi-instance consistency. |
| Frontend | React + Vite | Fast dev experience. Vite's HMR is genuinely faster than CRA. |
| Charts | Recharts | Composable, React-native, no D3 complexity needed for our use case. |
| Frontend deploy | Vercel | Zero config for Vite projects. Free tier. |
| Backend deploy | Render | Two services (API + worker) on free tier. Honest about cold-start behavior. |

### Why BullMQ and not Kafka?

Kafka is the right answer when you need: multiple independent consumer groups reading the same stream, log compaction, very high throughput (millions/sec), or exactly-once semantics across distributed transactions.

For this system at MVP scale: one producer (the API), one consumer group (the worker), moderate throughput. BullMQ on Redis gives us everything we need with a fraction of the operational complexity. Kafka would be premature infrastructure.

**Documented migration path:** When notification volume grows to the point where a single Redis instance becomes a bottleneck, or when we need independent consumer groups (e.g., a separate analytics consumer that doesn't interfere with the delivery consumer), that's the right time to migrate the queue to Kafka. The worker interface would stay the same — only the queue transport changes.

---

## 10. Data Models

### Developer
```
email         String, unique
passwordHash  String
createdAt     Date
```

### Project
```
developerId       ObjectId → Developer
name              String
apiKey            String, unique (naas_ prefixed, hashed for lookup)
fcmServiceAccount String (AES-256 encrypted JSON blob)
createdAt         Date
```

### NotificationLog
```
projectId    ObjectId → Project
deviceToken  String
title        String
body         String
status       Enum: "queued" | "sent" | "failed"
attempts     Number
error        String (last error message if failed)
fcmMessageId String (returned by FCM on success)
createdAt    Date
updatedAt    Date
```

Indexes:
- `projectId + createdAt` (descending) — for paginated log queries
- `status` — for analytics aggregation
- TTL index on `createdAt` (90 days) — logs auto-expire, keeping Atlas free tier storage in check

---

## 11. Key Engineering Decisions & Tradeoffs

### 202 Accepted, not 200 OK

The API returns 202 immediately after enqueuing — before FCM is called. This means "we have your request and will process it" not "the notification was delivered."

**Why:** FCM calls can take 100ms–2s+. Making the developer's backend wait for FCM before responding would couple their request latency to FCM's response time. With a queue, our API always responds in < 50ms regardless of FCM's state.

**Tradeoff:** The developer doesn't know immediately if the notification was sent. They find out by polling `GET /notifications/:id` or watching the dashboard. For most notification use cases (marketing pushes, alerts), this is fine. For truly time-critical delivery confirmation, this would need a webhook pattern (roadmap).

### Log Before Enqueue

The `NotificationLog` entry is created with `status: "queued"` **before** the job is pushed to Redis.

**Why:** If Redis is temporarily unavailable and the enqueue fails, the log entry still exists. The developer can see their request was received. If we created the log after enqueuing, a Redis failure would silently lose the request.

**Tradeoff:** There's a window where a log entry exists but no corresponding job is in the queue (if Redis fails between log creation and enqueue). The log status stays "queued" indefinitely in that case — a visible signal to investigate, not a silent drop.

### Per-Tenant Firebase Admin SDK Instances

The worker caches an initialized Firebase Admin app per project ID in a local Map. This avoids re-initializing the SDK (which includes parsing and validating the service account) on every job.

**Why:** Firebase Admin `initializeApp()` is not free — it validates credentials and sets up internal state. For a high-volume worker processing thousands of notifications per minute across many projects, re-initializing on every job would be significant overhead.

**Tradeoff:** The cache is in-process memory — if the worker restarts, all cached app instances are lost and will be re-initialized on the next job for each project. This is fine for correctness; it just means the first job for each project after a restart pays the initialization cost.

### Bulk Send = Single Send in a Loop

The `POST /notifications/bulk` endpoint doesn't use a separate pipeline — it loops through the tokens array and enqueues individual jobs for each token.

**Why:** This means bulk sends get the same retry logic, status tracking, and failure isolation as single sends. A failure on token #47 out of 200 doesn't affect token #48. Each has its own log entry and its own retry budget.

**Tradeoff:** For very large bulk sends (10,000+ tokens), enqueueing in a loop has overhead. A more advanced pattern would be a single "batch job" that the worker fans out into per-token jobs internally. That's the right migration when bulk size grows — documented as a roadmap improvement.

---

## 12. Error Handling & Edge Cases

### Invalid or Expired Device Tokens

FCM returns a specific error code (`messaging/registration-token-not-registered`) for invalid or expired tokens. The worker catches this, marks the log as `failed`, and does **not** retry — retrying a known-invalid token is pointless and wastes quota. The error message is stored in the log for the developer to see.

### FCM Provider Rate Limiting / Throttling

FCM can return `messaging/quota-exceeded` or similar throttling errors. These are transient. The worker treats them as retryable and uses exponential backoff: retry 1 at 30s, retry 2 at 2min, retry 3 at 10min. After 3 failed retries the job is moved to the dead letter queue and the log is marked `failed`.

### Partial Failure in Bulk Sends

Each token in a bulk send is a separate job. If 10 out of 200 tokens fail after retries, those 10 have individual log entries marked `failed`. The 190 successes are marked `sent`. There is no "partially complete bulk job" at the API level — the developer's dashboard shows per-token status.

### Worker Crash Mid-Job

BullMQ jobs are only marked `completed` or `failed` by the worker after processing. If the worker crashes mid-job, BullMQ's lock timeout mechanism returns the job to the queue. It will be picked up and retried when the worker restarts. This means a job could be processed twice in theory — we handle this with idempotency at the FCM layer (FCM deduplicates by message ID within a short window).

---

## 13. Delivery Guarantees

NaaS provides **at-least-once delivery** semantics at the queue level:

- A notification will be attempted at least once.
- On transient failures, it will be retried up to 3 times with backoff.
- After 3 failures, it is marked failed and not retried further.

NaaS does **not** guarantee exactly-once delivery. In a worker crash + restart scenario, a notification could be sent twice. This is acceptable for most push notification use cases. Exactly-once would require distributed transactions across Redis, MongoDB, and FCM — significantly more complexity for marginal real-world benefit at this scale.

---

## 14. Rate Limiting

Rate limiting is applied per API key using `express-rate-limit`.

Default limits:
- `POST /notifications`: 100 requests/minute per API key
- `POST /notifications/bulk`: 10 requests/minute per API key
- Auth endpoints: 20 requests/minute per IP

**Current implementation:** In-memory store (per API server process). Limits reset on server restart and are not shared across multiple API server instances.

**Upgrade path:** Replace the in-process store with the `rate-limit-redis` adapter to share rate limit state across processes and instances. The interface stays the same — only the backing store changes.

---

## 15. Repo Structure

```
naas/
├── README.md                          ← This file
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── db.js                  ← MongoDB connection
│   │   │   └── redis.js               ← Upstash Redis connection
│   │   ├── models/
│   │   │   ├── Developer.js
│   │   │   ├── Project.js
│   │   │   └── NotificationLog.js
│   │   ├── controllers/
│   │   │   ├── authController.js
│   │   │   ├── projectController.js
│   │   │   ├── notificationController.js
│   │   │   └── analyticsController.js
│   │   ├── routes/
│   │   │   ├── authRoutes.js
│   │   │   ├── projectRoutes.js
│   │   │   ├── notificationRoutes.js
│   │   │   └── analyticsRoutes.js
│   │   ├── middleware/
│   │   │   ├── authMiddleware.js      ← JWT verification
│   │   │   ├── apiKeyMiddleware.js    ← API key lookup + project injection
│   │   │   └── rateLimiter.js
│   │   ├── queues/
│   │   │   └── notificationQueue.js  ← BullMQ queue definition
│   │   ├── utils/
│   │   │   └── encryption.js         ← AES-256 encrypt/decrypt for FCM keys
│   │   ├── app.js                     ← Express app setup (no listen)
│   │   └── server.js                  ← Binds port, starts HTTP server
│   ├── worker/
│   │   └── notificationWorker.js      ← Separate process, BullMQ consumer
│   ├── scripts/
│   │   └── seedFakeUsers.js           ← Generates ~1000 fake tokens for demo
│   ├── docs/
│   │   ├── architecture-diagram.png
│   │   └── api-reference.md
│   ├── .env.example
│   └── README.md
└── frontend/
    ├── src/
    │   ├── pages/
    │   │   ├── Login.jsx
    │   │   ├── Signup.jsx
    │   │   ├── Dashboard.jsx
    │   │   ├── Projects.jsx
    │   │   ├── NotificationLogs.jsx
    │   │   └── Analytics.jsx
    │   ├── components/
    │   │   ├── Navbar.jsx
    │   │   ├── StatCard.jsx
    │   │   └── DeliveryChart.jsx
    │   └── api/
    │       └── client.js              ← Axios instance + interceptors
    ├── .env.example
    └── README.md
```

---

## 16. Local Setup

### Prerequisites
- Node.js 18+
- A MongoDB Atlas cluster (free tier)
- An Upstash Redis instance (free tier)
- A Firebase project with a service account JSON (for your own test project)

### Backend

```bash
cd backend
cp .env.example .env
# Fill in: MONGO_URI, REDIS_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm run dev          # Starts API server on :3000
npm run worker       # Starts notification worker (separate terminal)
```

### Frontend

```bash
cd frontend
cp .env.example .env
# Fill in: VITE_API_BASE_URL=http://localhost:3000
npm install
npm run dev          # Starts Vite dev server on :5173
```

### Seed Demo Data

```bash
cd backend
node scripts/seedFakeUsers.js
# Creates a demo project + ~1000 fake device tokens in the DB
# Triggers a bulk send — FCM will reject fake tokens, proving failure tracking works
```

---

## 17. Deployment (Free Tier)

| Service | Platform | Notes |
|---|---|---|
| MongoDB | MongoDB Atlas (M0 free) | 512MB storage, TTL indexes keep it lean |
| Redis | Upstash Redis (free tier) | 10K commands/day limit — fine for demo volume |
| API Server | Render (free web service) | Cold starts after 15min inactivity — noted in demo |
| Worker | Render (free background worker) | Separate service, same repo, different start command |
| Frontend | Vercel (free tier) | Auto-deploys on push to main |

### Render Services

**API Server:**
- Build command: `npm install`
- Start command: `node src/server.js`
- Root directory: `backend`

**Notification Worker:**
- Build command: `npm install`
- Start command: `node worker/notificationWorker.js`
- Root directory: `backend`

### Environment Variables (both Render services share the same set)

```
MONGO_URI=
REDIS_URL=
JWT_SECRET=
ENCRYPTION_KEY=        # 32-byte hex string for AES-256
PORT=3000
NODE_ENV=production
```

**Note on cold starts:** Render's free tier spins down services after 15 minutes of inactivity. The first request after a cold start may take 10–30 seconds. This is expected in a portfolio/demo context.

---

## 18. Demo Strategy

Since there are no real users, the demo proves the system works at two levels:

### Level 1 — Scale & Reliability (Fake Tokens)
The seed script generates ~1000 fake FCM device tokens and triggers a bulk send. FCM rejects all of them with `registration-token-not-registered`. The dashboard shows:
- 1000 notifications enqueued
- 0 sent, 1000 failed
- No retries (invalid token errors are non-retryable by design)

This proves: queue processing at scale, per-token failure tracking, correct error classification, and that bulk failure doesn't crash the system.

### Level 2 — Real Delivery (Real Tokens)
A simple test webpage (included in `frontend/public/demo.html`) subscribes to Firebase push notifications using the developer's own Firebase project config. 2–3 real browser tokens are registered and stored manually in the DB. A send is triggered via the API and the notification lands on a real browser tab/device.

This is recorded in a short screen-capture video and included in the project README as the primary shareable demo asset.

---

## 19. Roadmap — Not in V1

These features are deliberately excluded from the MVP. Each has a real architectural reason for being deferred:

| Feature | Why deferred | When to add |
|---|---|---|
| **APNs / iOS delivery** | Requires Apple Developer account ($99/year) and certificate management. The worker architecture already supports a second provider — just a new send strategy needed. | When the platform targets iOS apps |
| **Scheduled notifications** | Needs a separate scheduler process and a `scheduledAt` field on the job. Not complex, just out of MVP scope. | When developers request time-based sends |
| **Notification templates** | Adds a new data model (Template) and a render step in the controller. | When repeat notification formats emerge |
| **Topic-based notifications** | FCM supports server-side topics natively. Adds a subscription management layer and changes the send target from `deviceToken` to `topic`. | When a multi-subscriber use case appears |
| **Webhooks** | Lets developers receive delivery status callbacks instead of polling. Needs outbound HTTP call in the worker + a WebhookLog model. | When polling the dashboard isn't enough |
| **Node.js SDK** | A thin wrapper around the REST API — adds convenience but no new capability. Build after the API is fully stable. | After v1 is proven stable |
| **Admin panel** | Internal cross-developer oversight. Not needed for a solo resume project. | If this becomes a real product |
| **Kafka migration** | Current Redis/BullMQ queue becomes a bottleneck at very high throughput, or when independent consumer groups are needed. | When volume justifies the operational cost |
| **Redis-backed rate limiting** | Current in-memory rate limiting doesn't share state across API server instances. | When the API server scales horizontally |

---

*Built by Suraj Kumar · GitHub: surajkumar989 · [Live demo link]-comming soon · [Demo video link]- comming soon*
