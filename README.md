# HubSpot Contact and Notes Sync

A full stack app that connects to HubSpot with OAuth 2.0, automatically syncs contacts into PostgreSQL through a background job queue, and keeps notes synchronized from the app back to HubSpot.

## Demo and review notes
- **Demo video:** https://drive.google.com/file/d/1yGf_gvjfQf0rVPSEBG-Rwhb6XkWu4dxr/view?usp=sharing
- The backend is not deployed. Run it locally with the steps above.
- The HubSpot app is private-distribution, so reviewers should create their own HubSpot developer app and connect the account that owns it.
- The Vercel frontend loads but needs the backend running locally to function.


## Architecture

```
React (Vercel) --JWT--> API (Express) --> PostgreSQL (source of truth)
                           |                    ^
                           +-- enqueue --> Redis/BullMQ --> Workers (N replicas) --> HubSpot API
```

- **API process** (`backend/src/api.js`): OAuth, REST endpoints, enqueues jobs. Stateless.
- **Worker process** (`backend/src/worker.js`): runs contact sync and note push jobs. Scales horizontally.
- **PostgreSQL**: all data (accounts, tokens, contacts, notes, sync state).
- **Redis + BullMQ**: job queue only. No business data lives in Redis.
- **React + Vite frontend**: status, contacts, details, notes.

## Technology choices

| Choice | Reason |
|---|---|
| Node.js + Express | Preferred stack, simple and explicit |
| PostgreSQL | Relational integrity, `ON CONFLICT` upserts, bulk writes |
| BullMQ (Redis) | Retries, backoff, rate limiting, concurrency, idempotent job ids |
| React + Vite | Fast SPA, easy Vercel deploy |
| AES-256-GCM | Encrypts OAuth tokens at rest, with tamper detection |
| JWT | Signed OAuth state (CSRF) and session token |

## Features implemented

Required:
- HubSpot OAuth (Connect button, callback, encrypted tokens, automatic refresh)
- Automatic contact sync after connect (no manual button), with a saved cursor for resuming, upsert-based duplicate prevention, and retries
- Notes: add in app, store in DB, push to HubSpot with retries and manual retry
- UI: connection status, contacts list, details, notes, loading/success/error states

Extras:
- Pagination and search, queue metrics endpoint (`/metrics/queues`), reconciler for lost jobs, per-job retry/backoff, docker-compose for Postgres and Redis

## Setup

Requirements: Node 20+, Docker (for Postgres and Redis), Git.
Docker is only used to run Postgres and Redis. The app itself runs with Node.
### 1. Create a HubSpot app (each reviewer needs their own)
1. Create a free account at developers.hubspot.com and create an app.
2. In the app's Auth settings add the redirect URL `http://localhost:4000/auth/hubspot/callback`.
3. Required scopes: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`.
4. Copy the Client ID and Client Secret. If the app is private-distribution, it can only be installed in the account that owns it, so connect that same account and add test contacts there.
5. Add a few test contacts to that HubSpot account (new accounts come with 2 sample contacts).

### 2. Run locally
```bash
docker compose up -d
cd backend && cp .env.example .env     # then fill in values (see below)
npm install
npm run api        # terminal 1
npm run worker     # terminal 2
cd ../frontend && echo "VITE_API_URL=http://localhost:4000" > .env
npm install && npm run dev   # terminal 3
```
Open http://localhost:5173 and click Connect HubSpot.

### Environment variables (backend/.env)

| Variable | Meaning |
|---|---|
| PORT | API port (4000) |
| DATABASE_URL | Postgres connection string |
| REDIS_URL | Redis connection string |
| HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET | From the HubSpot app |
| HUBSPOT_REDIRECT_URI | Must exactly match the HubSpot app redirect URL |
| FRONTEND_URL | Allowed CORS origin and post-login redirect |
| JWT_SECRET | Random string for signing JWTs |
| ENCRYPTION_KEY | 64 hex chars (32 bytes): `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| WORKER_CONCURRENCY | Optional, parallel jobs per worker (default 5) |


## Deployment
- **Frontend (Vercel):** import the repo, set Root Directory to `frontend`, set `VITE_API_URL`.
- **Backend:** any host that can run two Node processes (`npm run api`, `npm run worker`) plus Postgres and Redis. Update `HUBSPOT_REDIRECT_URI`, `FRONTEND_URL` and the HubSpot app redirect URL to the deployed URLs. 

## Assumptions
- One connected HubSpot account per session; the session JWT identifies the account (no separate user table).
- Contacts are synced one way (HubSpot to app). Notes are synced one way (app to HubSpot).

## Limitations
- Duplicate note window: if a worker crashes after HubSpot creates a note but before the DB is updated, a retry can create a second note (HubSpot has no idempotency key).
- Session token is stored in localStorage (XSS exposure); production should use an HttpOnly cookie.
- No webhooks or incremental sync, so contacts changed in HubSpot after the first sync are refreshed only on reconnect.
- No automated tests or CI.
- Contact pagination chain is sequential per account.
- Throughput is bounded by HubSpot's per-account API rate limits (see TECHNICAL.md).

## Future improvements
Webhooks, incremental sync (Search API on last modified date), duplicate-note marker with search-before-retry, HttpOnly cookie sessions, tests and CI, Prometheus metrics and Bull Board, Dockerfiles, token revocation handling.

See `docs/TECHNICAL.md` for the detailed technical documentation.
