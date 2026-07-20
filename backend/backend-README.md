# NaaS Backend — API Server + Notification Worker

> The engine room of NaaS: multi-tenant credential isolation, async queue processing, and delivery tracking, exposed as a clean REST API.

---

## Table of Contents

1. [What This Service Does](#1-what-this-service-does)
2. [Core Design Principle](#2-core-design-principle)
3. [Architecture — Two Processes](#3-architecture--two-processes)
4. [FCM Multi-Tenancy Model](#4-fcm-multi-tenancy-model)
5. [API Reference](#5-api-reference)
6. [Tech Stack & Why](#6-tech-stack--why)
7. [Data Models](#7-data-models)
8. [Key Engineering Decisions](#8-key-engineering-decisions)
9. [Error Handling & Delivery Guarantees](#9-error-handling--delivery-guarantees)
10. [Rate Limiting](#10-rate-limiting)
11. [Repo Structure](#11-repo-structure)
12. [Local Setup](#12-local-setup)
13. [Deployment (Render, Free Tier)](#13-deployment-render-free-tier)

---

## 1. What This Service Does

The backend is a REST API + background worker pair that lets a developer send push notifications without building their own FCM plumbing.

**Flow:** upload Firebase service account → get an API key → `POST /notifications` with `{ deviceToken, title, body }`. The backend handles queuing, delivery, retries, status tracking, and analytics.

---

## 2. Core Design Principle

> **The backend never touches or stores the client's own users or device-token database.**

We store only: developer accounts, projects/API keys, encrypted Firebase service accounts, notification logs, and aggregated analytics. Developers keep device tokens in their own DB and pass them in per-request. This keeps the backend stateless with respect to end users and removes any GDPR surface around identity.

---

## 3. Architecture — Two Processes

The API server (`src/server.js`) and worker (`worker/notificationWorker.js`) are **separate deployed services**, not threads in one process.

- FCM calls are slow/throttleable network I/O. If they ran inline, they could block the API from accepting new requests.
- The API's only job is validate → log → enqueue → respond (202 in <50ms).
- The worker's only job is to drain the queue at whatever pace FCM allows.
- A worker crash never takes the API down; the queue persists in Redis and resumes on restart.

```
Request → Rate Limiter → Auth → Controller → Log Entry → Enqueue (Redis) → 202
                                                                 │
                                                    (separate process, async)
                                                                 ▼
                                        Pull Job → Decrypt Creds → Init FCM App
                                                                 │
                                                    Send → Update Log → Retry on failure
```

---

## 4. FCM Multi-Tenancy Model

An FCM device token is permanently bound to the Firebase project that issued it. To send to it, we must authenticate as that same project.

**Our model:** each developer uploads their own Firebase service account JSON at Project creation. We store it AES-256 encrypted in MongoDB. At send time, the worker:

1. Loads the Project, decrypts the service account.
2. Initializes a Firebase Admin SDK instance namespaced by project ID.
3. Sends via that instance, then **caches it in memory** so re-init doesn't happen per job.

This means developers keep full ownership of their Firebase project — we're granted a scoped, revocable permission, not control of their whole Firebase setup. Keys are AES-256-CBC encrypted, the encryption key lives only in env vars, and keys are never returned in any API response. Rotating the NaaS API key (`/projects/:id/regenerate-key`) never touches the FCM credential.

### Where the Firebase Credential File Actually Lives

There is **no `serviceAccountKey.json` (or similar) file stored anywhere in this repo**, and that's intentional — not a missing piece.

- You download it once from Firebase Console → **Project Settings → Service Accounts → Generate new private key**.
- Its *contents* (not the file itself) are sent as JSON in the request body of `POST /projects`, under `fcmServiceAccount`.
- The backend encrypts it (AES-256) and stores it in MongoDB on the `Project` document — never on disk.
- The worker decrypts it in memory at send time and never writes it back to disk.

If you need Firebase Admin initialized directly for a local script (e.g. testing outside the API), reference the downloaded file via an env var instead of hardcoding a path:
```
GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json
```
Add that filename to `.gitignore` immediately if you do this — it's a real secret, same tier as `.env`.

### Security Considerations

- Service account keys are encrypted with AES-256-CBC before being stored in MongoDB.
- The encryption key lives only in environment variables, never in the database.
- Keys are never returned in any API response after upload.
- Rotating the NaaS API key never rotates the FCM service account — those are the developer's credentials, not ours to touch.

---

## 5. API Reference

All endpoints except `/auth/*` require `Authorization: Bearer <jwt>`. Notification endpoints use `x-api-key: <projectApiKey>` instead — the developer's *backend* calls these, identifying itself by project, not personal session.

**Auth**
- `POST /auth/signup` — `{ email, password }` → `201`
- `POST /auth/login` — `{ email, password }` → `{ token }`

**Projects**
- `POST /projects` — `{ name, fcmServiceAccount }` → `{ projectId, apiKey }`
- `GET /projects` — list developer's projects (service account never returned)
- `POST /projects/:id/regenerate-key` — rotates NaaS API key only

**Notifications**
- `POST /notifications` — `{ deviceToken, title, body }` → `202 { notificationId, status: "queued" }`
- `POST /notifications/bulk` — `{ deviceTokens[], title, body }` → `202 { queued, notificationIds[] }` (loops the same single-send pipeline)
- `GET /notifications` — paginated logs
- `GET /notifications/:id` — single log with retry history

**Analytics**
- `GET /analytics/summary` — `{ total, sent, failed, retried, successRate, byProject }`

---

## 6. Tech Stack & Why

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js | Non-blocking I/O suits FCM's wait-heavy workload |
| Framework | Express | Minimal, explicit, no magic |
| Database | MongoDB (Atlas free tier) | Semi-structured, append-heavy logs; TTL indexes fit naturally |
| Queue | Redis + BullMQ (Upstash free tier) | Persistent jobs, backoff, concurrency control out of the box |
| Push Provider | Firebase Admin SDK | Industry standard; web + Android now, APNs on roadmap |
| Auth | JWT + bcrypt | Stateless, no session store |
| Rate Limiting | express-rate-limit | Per API key; in-memory for MVP |
| Deploy | Render | API + worker as two free-tier services |

**Why BullMQ, not Kafka:** at MVP scale (one producer, one consumer group, moderate throughput) BullMQ gives everything needed with far less operational overhead. Migration trigger: single Redis instance becomes a bottleneck, or an independent consumer group (e.g. a separate analytics consumer) is needed — the worker interface stays the same, only the transport changes.

---

## 7. Data Models

```
Developer      { email, passwordHash, createdAt }
Project        { developerId, name, apiKey (hashed), fcmServiceAccount (AES-256), createdAt }
NotificationLog{ projectId, deviceToken, title, body, status, attempts, error, fcmMessageId, createdAt, updatedAt }
```
Indexes: `projectId + createdAt` (pagination), `status` (analytics), TTL on `createdAt` (90 days, keeps Atlas free tier lean).

---

## 8. Key Engineering Decisions

- **202, not 200:** the API responds the instant the job is enqueued, decoupling request latency from FCM's response time. Tradeoff: delivery confirmation requires polling `GET /notifications/:id` (webhooks are roadmap).
- **Log before enqueue:** the log is written with `status: "queued"` *before* the Redis push, so a Redis outage still leaves a visible record instead of silently losing the request.
- **Per-tenant SDK instance caching:** avoids paying Firebase Admin's init cost on every job; cache lives in-process, so a worker restart just re-pays that cost once per project.
- **Bulk = single-send in a loop:** every token gets its own job, log, and retry budget, so one bad token in a batch of 200 can't affect the other 199.

---

## 9. Error Handling & Delivery Guarantees

- `messaging/registration-token-not-registered` → marked `failed` immediately, **no retry** (retrying a dead token wastes quota).
- `messaging/quota-exceeded` and other transient errors → retried with backoff (30s, 2min, 10min), then moved to a dead letter queue and marked `failed`.
- Worker crash mid-job → BullMQ's lock timeout returns the job to the queue; FCM's own message-ID deduplication absorbs the resulting at-least-once semantics.
- **Guarantee:** at-least-once delivery, not exactly-once. Exactly-once would require distributed transactions across Redis/Mongo/FCM — not worth the complexity at this scale.

---

## 10. Rate Limiting

Per API key, via `express-rate-limit`:
- `POST /notifications`: 100/min
- `POST /notifications/bulk`: 10/min
- Auth endpoints: 20/min per IP

Currently in-memory (per process, resets on restart, not shared across instances). Upgrade path: `rate-limit-redis` adapter — same interface, shared backing store.

---

## 11. Repo Structure

```
backend/
├── src/
│   ├── config/            db.js, redis.js
│   ├── models/            Developer.js, Project.js, NotificationLog.js
│   ├── controllers/       auth/project/notification/analyticsController.js
│   ├── routes/
│   ├── middleware/         authMiddleware.js, apiKeyMiddleware.js, rateLimiter.js
│   ├── queues/             notificationQueue.js
│   ├── utils/              encryption.js
│   ├── app.js
│   └── server.js
├── worker/
│   └── notificationWorker.js
├── scripts/
│   └── seedFakeUsers.js
├── .env               ← real secrets, gitignored, never committed
├── .env.example       ← template with placeholder values, committed
└── .gitignore
```

---

## 12. Local Setup

```bash
cd backend
cp .env.example .env
# Fill in: MONGO_URI, REDIS_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm run dev       # API server on :3000
npm run worker    # separate terminal
```

Seed demo data (creates a project + ~1000 fake tokens, triggers a bulk send that FCM rejects — proving failure tracking works):
```bash
node scripts/seedFakeUsers.js
```

**Reminder:** there is no Firebase credential file checked into this repo. When testing locally, paste your downloaded service account JSON into the `POST /projects` request body — don't drop the raw file into `src/` or `config/`.

---

## 13. Deployment (Render, Free Tier)

| Service | Start command | Root |
|---|---|---|
| API Server | `node src/server.js` | `backend` |
| Notification Worker | `node worker/notificationWorker.js` | `backend` |

Shared env vars: `MONGO_URI`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `PORT`, `NODE_ENV`.

Free tier cold starts after 15min inactivity — first request after idle can take 10–30s. Expected and noted for demo purposes.
