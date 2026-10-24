# Technical Documentation

## 1. System architecture
Three runtime parts: stateless API, background workers, and data stores (PostgreSQL for data, Redis for the queue). The API never calls HubSpot for bulk work. It enqueues jobs, and workers do the slow, rate-limited external calls. This keeps HTTP responses fast and lets each part scale on its own.

## 2. OAuth implementation
1. Frontend asks `GET /auth/hubspot/url`. Backend returns the HubSpot authorize URL with a `state` value (a signed JWT valid 10 minutes).
2. User approves in HubSpot, which redirects to `/auth/hubspot/callback?code=...&state=...`.
3. Backend verifies `state` (CSRF protection), exchanges `code` for access and refresh tokens, and looks up the hub id.
4. Tokens are encrypted with AES-256-GCM and upserted into `accounts`.
5. Sync is enqueued automatically, and the user is redirected to the frontend with a session JWT.
Refresh: before each HubSpot call the token is refreshed if it expires within 60 seconds, and also once on any 401. A `SELECT ... FOR UPDATE` row lock ensures only one worker refreshes at a time, since HubSpot rotates refresh tokens.

## 3. Database schema
- `accounts(id, hub_id UNIQUE, access_token_enc, refresh_token_enc, expires_at)`
- `sync_state(account_id PK, status, cursor, synced_count, last_error, updated_at)`: the resume checkpoint
- `contacts(id, account_id, hubspot_id, email, firstname, lastname, phone, company, hs_updated_at)` with `UNIQUE(account_id, hubspot_id)`
- `notes(id, contact_id, body, hubspot_note_id, sync_status, attempts, last_error, created_at)`
Indexes: contact search index, notes by contact, partial index on non-synced notes.

## 4. Synchronization flow
Contacts: callback enqueues job for page 1. Each job fetches 100 contacts, bulk-upserts them in one SQL statement, saves the cursor and count, then enqueues the next page until HubSpot returns no next cursor, then status becomes `completed`.
Notes: user submits a note, API inserts a row (`pending`), enqueues a push job, and returns immediately. Worker creates the HubSpot note associated to the contact, then stores `hubspot_note_id` and marks `synced`.

## 5. Background processing strategy
Two BullMQ queues (`contact-sync`, `note-sync`). Workers run with configurable concurrency and a limiter (8 jobs/second). More worker processes can be added with no code changes because Redis coordinates them.

## 6. Error handling
- 401: refresh token and retry once.
- 429: queue is paused for the `Retry-After` period, and the job is retried.
- Other 4xx: treated as unrecoverable, not retried, recorded as failed.
- 5xx and network errors: retried with backoff.
- Final failures are saved to the DB (`sync_state.last_error`, `notes.last_error`) and shown in the UI.

## 7. Retry strategy
Up to 6 attempts, exponential backoff starting at 2 seconds. Failed jobs are kept for inspection. Failed notes have a manual retry endpoint. A reconciler runs every minute and re-enqueues notes stuck in `pending` for over 2 minutes (covers Redis outages at insert time).

## 8. Idempotency and resume
- Contacts: `UNIQUE(account_id, hubspot_id)` plus `ON CONFLICT DO UPDATE` (only if HubSpot's copy is newer) means re-processing a page is harmless.
- Cursor is saved only after the page is persisted, so a crash means at most one page is redone.
- Job ids (`c-<account>-<cursor>`, `n-<note>`) stop duplicate jobs. Reconnect uses a fresh id so a completed sync can run again.
- Notes: worker skips a note whose `hubspot_note_id` is already set.

## 9. Scalability approach
- Horizontal: stateless API replicas, N worker replicas.
- Batching: 100 contacts per request, one bulk upsert per page.
- Parallelism: across accounts (tenants). Within one account, pages are chained because cursors are sequential.
- Rate limiting: queue limiter plus 429 handling.
- Database: bulk writes; at larger scale add COPY into staging tables, partitioning by account_id, read replicas, PgBouncer connection pooling.
- Queue: Redis Cluster or sharded queues if Redis becomes the bottleneck. BullMQ can be swapped for SQS or Kafka.
- Observability: structured logs, `/metrics/queues`; production would add Prometheus, Grafana and Bull Board with alerts on queue depth and failure rate.
- Honest limit: 100,000 contacts per minute cannot be reached for a single HubSpot account because of HubSpot's own API rate limits (verify current limits in HubSpot docs). It is reachable as an aggregate across many accounts by adding workers. A single huge account could be partitioned using the Search API by id ranges, within its limits.

## 10. Design decisions and tradeoffs
| Decision | Why | Tradeoff |
|---|---|---|
| Queue instead of sync in the request | Resilience, retries, scale | More moving parts (Redis, workers) |
| Chained page jobs | Simple resume | Serial per account |
| Postgres over MongoDB | Constraints, upserts, joins | Less flexible schema |
| BullMQ over Kafka/SQS | Simple, enough scale | Redis is a single dependency |
| Outbox-style notes (DB first, queue second) | Never lose a note | Needs a reconciler |
| JWT in URL hash and localStorage | Frontend and backend on different domains | XSS risk vs HttpOnly cookie |
| Encrypt tokens in DB | Limits damage of DB leak | Key management needed |
