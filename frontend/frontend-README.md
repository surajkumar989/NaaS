# NaaS Frontend — Developer Dashboard

> The control surface for NaaS: manage projects, watch notifications move through the pipeline in real time, and read delivery analytics — without touching the API directly.

---

## Table of Contents

1. [What This App Does](#1-what-this-app-does)
2. [Core Design Principle](#2-core-design-principle)
3. [How It Fits Into the System](#3-how-it-fits-into-the-system)
4. [Pages & Components](#4-pages--components)
5. [API Reference (Consumed)](#5-api-reference-consumed)
6. [Tech Stack & Why](#6-tech-stack--why)
7. [Key Engineering Decisions](#7-key-engineering-decisions)
8. [Handling Async & Failure States](#8-handling-async--failure-states)
9. [Repo Structure](#9-repo-structure)
10. [Local Setup](#10-local-setup)
11. [Deployment (Vercel, Free Tier)](#11-deployment-vercel-free-tier)
12. [Demo Strategy](#12-demo-strategy)

---

## 1. What This App Does

The frontend is a React dashboard that gives a developer a visual layer over the NaaS API: sign up, create a project, upload Firebase credentials, grab an API key, then watch notifications flow through queued → sent/failed with live analytics.

**Developer experience:** log in → see projects → open a project → view notification logs and success-rate charts. No part of sending a notification happens here — that's the backend's job via the developer's *own* server. This dashboard is read/manage-only.

---

## 2. Core Design Principle

> **The dashboard never stores or touches end-user device tokens either.**

It only ever calls the NaaS API and renders what comes back: developer/project metadata, notification logs, and aggregated analytics. It has no direct database connection and no knowledge of the developer's own user schema — same boundary the backend enforces, just expressed as "don't fetch or render anything outside the API contract."

---

## 3. How It Fits Into the System

```
Browser (this app)
      │
      │  Axios client, JWT in Authorization header
      ▼
NaaS API Server (Express)
      │
      ├─ Project CRUD, API key management
      └─ Notification logs + analytics (read-only from here)
```

The dashboard never talks to Redis, Mongo, or FCM directly — every read goes through the same REST API a third-party developer would use, just authenticated with a JWT session instead of a project API key.

---

## 4. Pages & Components

| Page | Purpose |
|---|---|
| `Login.jsx` / `Signup.jsx` | JWT-based auth, stores token for subsequent requests |
| `Dashboard.jsx` | Landing view — summary cards across all projects |
| `Projects.jsx` | Create/list projects, upload Firebase service account, view/regenerate API key |
| `NotificationLogs.jsx` | Paginated log table per project, with status and retry history |
| `Analytics.jsx` | Success-rate trends, per-project breakdown |

| Component | Purpose |
|---|---|
| `Navbar.jsx` | Auth-aware nav |
| `StatCard.jsx` | Reusable metric tile (total/sent/failed/success rate) |
| `DeliveryChart.jsx` | Recharts wrapper for delivery trend visualization |

---

## 5. API Reference (Consumed)

The dashboard is a pure client of the backend's existing endpoints — it introduces no new API surface:

- `POST /auth/login`, `POST /auth/signup`
- `GET /projects`, `POST /projects`, `POST /projects/:id/regenerate-key`
- `GET /notifications`, `GET /notifications/:id`
- `GET /analytics/summary`

Note: `fcmServiceAccount` and the raw API key are never re-displayed after creation — the UI shows a one-time reveal on creation/regeneration, matching what the backend actually returns.

---

## 6. Tech Stack & Why

| Layer | Choice | Why |
|---|---|---|
| Framework | React + Vite | Fast dev loop; Vite's HMR is noticeably quicker than CRA |
| Charts | Recharts | Composable, React-native API, no need for raw D3 for this use case |
| HTTP client | Axios | Interceptors make attaching the JWT and handling 401s trivial |
| Deploy | Vercel | Zero-config for Vite projects, free tier, auto-deploy on push |

---

## 7. Key Engineering Decisions

- **No client-side polling loop for "live" status by default:** since the backend guarantees at-least-once delivery within seconds under normal load, the logs page re-fetches on navigation/interval rather than holding a websocket open — simpler, and consistent with the API's poll-based design (webhooks are backend roadmap, not yet needed here).
- **Axios interceptor for auth, not per-call header stitching:** the JWT is attached once in `api/client.js`, and a 401 response triggers a redirect to `Login.jsx` — keeps every page component free of auth plumbing.
- **StatCard/DeliveryChart kept generic:** both take props rather than fetching their own data, so `Dashboard.jsx` and `Analytics.jsx` can reuse them with different slices of the same `/analytics/summary` response instead of duplicating chart logic.

---

## 8. Handling Async & Failure States

- **Project creation:** the Firebase service account upload is a plain JSON paste/upload — validated client-side for shape before the API call, since a malformed credential otherwise only surfaces later, at send time, in the backend worker.
- **Log table:** a `"queued"` row that never resolves to `sent`/`failed` (the backend's documented Redis-failure edge case) is surfaced as a visibly stale/pending state rather than silently left as-is, so a developer notices something needs investigating.
- **Bulk sends:** since the backend gives each token its own log entry, the UI shows genuine partial-failure states (e.g. 190 sent / 10 failed) rather than a single pass/fail badge for the whole batch.

---

## 9. Repo Structure

```
frontend/
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
│   ├── api/
│   │   └── client.js          ← Axios instance + interceptors
│   └── public/
│       └── demo.html          ← real-device FCM subscribe page (Level 2 demo)
├── .env.example
└── README.md
```

---

## 10. Local Setup

```bash
cd frontend
cp .env.example .env
# Fill in: VITE_API_BASE_URL=http://localhost:3000
npm install
npm run dev       # Vite dev server on :5173
```

Requires the backend API server (and ideally the worker) running locally, or pointed at a deployed instance via `VITE_API_BASE_URL`.

---

## 11. Deployment (Vercel, Free Tier)

Zero-config Vite deploy: connect the repo, set `VITE_API_BASE_URL` to the deployed Render API URL, auto-deploys on push to `main`.

Note: since the backend's free-tier Render services cold-start after 15min idle, the dashboard's first data fetch after a period of inactivity may take 10–30s — worth a loading state, not a bug.

---

## 12. Demo Strategy

The dashboard is the visible half of both demo levels described in the main README:

- **Scale/reliability demo:** after the seed script's ~1000-token bulk send, `NotificationLogs.jsx` and `Analytics.jsx` show 0 sent / 1000 failed with correct error classification — proving the UI surfaces failure at scale, not just success.
- **Real delivery demo:** `public/demo.html` registers 2–3 real browser tokens; a send triggered via the API shows up as `sent` in the logs table in real time, with the notification landing on an actual browser tab.
