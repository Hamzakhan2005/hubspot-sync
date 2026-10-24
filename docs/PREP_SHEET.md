# Interview Prep Sheet (read top to bottom)

## 0. The 30-second pitch
"I built an app where a user clicks Connect HubSpot, logs in through OAuth, and the app automatically downloads their contacts into PostgreSQL using a background job queue. Users can add notes to contacts, and those notes are pushed back to HubSpot. Everything slow runs in workers with retries, and the sync can resume if it crashes."

## 1. Glossary (full forms and plain meaning)
- **API** (Application Programming Interface): a way for programs to talk to each other.
- **REST** (Representational State Transfer): API style using URLs plus HTTP verbs (GET read, POST create).
- **HTTP** (HyperText Transfer Protocol): how browsers and servers talk.
- **OAuth 2.0** (Open Authorization): lets a user grant an app access to their HubSpot data without sharing their password. The app gets tokens instead.
- **Access token**: short-lived key used to call HubSpot. **Refresh token**: long-lived key used to get a new access token.
- **Scope**: a permission (for example read contacts).
- **Client ID / Client Secret**: the app's username and password with HubSpot. The secret must stay private.
- **Redirect URI**: where HubSpot sends the user back after approval.
- **JWT** (JSON Web Token): signed piece of text proving who you are. Signed, so it cannot be changed without the secret.
- **CSRF** (Cross-Site Request Forgery): attack where another site tricks your browser into an action. The `state` parameter blocks this in OAuth.
- **XSS** (Cross-Site Scripting): attack that injects script into a page. Scripts can read localStorage, which is why tokens there are a risk.
- **CORS** (Cross-Origin Resource Sharing): browser rule on which websites may call the API. We allow only the frontend URL.
- **AES-256-GCM** (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode): encryption that also detects tampering. IV (initialization vector) is a random value per encryption so the same text encrypts differently each time.
- **SQL** (Structured Query Language). **PostgreSQL**: relational database. **Upsert**: insert, or update if it already exists.
- **UNIQUE constraint**: database rule that blocks duplicates.
- **Idempotent**: doing it twice has the same result as once. Key to safe retries.
- **Queue**: a to-do list for jobs. **Worker**: a process that takes jobs and runs them. **Job**: one unit of work.
- **Redis** (Remote Dictionary Server): fast in-memory store. Here it only holds the queue.
- **BullMQ**: Node library for queues on Redis.
- **Cursor pagination**: HubSpot returns a bookmark ("after") for the next page. We save it to resume.
- **Exponential backoff**: wait 2s, 4s, 8s... between retries.
- **Rate limit / HTTP 429**: HubSpot says "too many requests, wait".
- **HTTP 401**: unauthorized (token expired). **403**: forbidden (missing scope). **4xx**: client error. **5xx**: server error.
- **Outbox pattern**: save to the database first, then send to the queue, so nothing is lost.
- **Horizontal scaling**: add more machines/processes. **Vertical**: bigger machine.
- **CRM** (Customer Relationship Management): HubSpot's contact database.
- **SPA** (Single Page Application): React app. **Vite**: dev server and build tool.
- **env var** (environment variable): setting kept outside code, such as secrets.
- **Docker / docker-compose**: runs Postgres and Redis in containers with one command.
- **WSL2** (Windows Subsystem for Linux): Linux inside Windows, where I developed.
- **PgBouncer**: Postgres connection pooler. **SQS** (Simple Queue Service, AWS). **Kafka**: high-volume event streaming platform.

## 2. Folder and file walkthrough (explain each in one breath)
- `docker-compose.yml`: starts Postgres and Redis locally.
- `backend/schema.sql`: creates the 4 tables, run at startup.
- `config.js`: reads env vars, crashes early if one is missing.
- `db.js`: Postgres connection pool, and `migrate()` runs schema.sql.
- `crypto.js`: `encrypt`/`decrypt` for tokens using AES-256-GCM (iv, tag, ciphertext stored together as base64).
- `hubspot.js`: OAuth URL, code exchange, saving account, `getAccessToken` (refresh with row lock), and `hs()` wrapper that adds the token, retries once on 401, and tags 429 with wait time.
- `queues.js`: Redis connection, the two queues, retry defaults (6 attempts, exponential), `enqueue*` helpers with job ids.
- `api.js`: Express server: OAuth routes, JWT auth middleware, REST endpoints (status, contacts, contact detail, add note, retry note), metrics, reconciler timer.
- `worker.js`: `syncPage` (fetch 100 contacts, bulk upsert, save cursor, enqueue next), `pushNote` (create HubSpot note and link it), rate-limit wrapper, failure handlers.
- `frontend/src/App.jsx`: status bar, connect button, search, list, pagination, detail panel, notes, polling while syncing.
- `frontend/src/main.jsx`: mounts React.

## 3. Walk-through flows (say these out loud)
**Connect:** Click button, frontend gets URL, user approves at HubSpot, HubSpot calls my callback with a code, I verify state, swap code for tokens, encrypt and save them, enqueue page 1 of the sync, redirect to the frontend with a JWT.
**Sync:** Job fetches 100 contacts, one SQL upsert, save cursor, enqueue next page. If it crashes, BullMQ re-runs the job, and the upsert makes that safe.
**Note:** Insert row as pending, enqueue, return instantly. Worker pushes to HubSpot, saves the HubSpot note id, marks synced. UI polls every 3 seconds while pending.
**Token refresh:** Before every call, if the token expires within 60 s, lock the account row, refresh, save the new tokens. The lock prevents two workers refreshing at once (HubSpot rotates refresh tokens, so a race would break one).

## 4. Why each decision (defend these)
- **Why a queue?** HubSpot calls are slow and rate-limited. The queue gives retries, backpressure and scaling, and keeps the API fast.
- **Why Postgres?** Unique constraints and upserts give clean duplicate prevention; relational fits accounts, contacts and notes.
- **Why Redis?** BullMQ requires it. It stores only jobs.
- **Why save the cursor after the upsert?** So the checkpoint never points past data we have not saved.
- **Why ON CONFLICT with `hs_updated_at`?** Idempotent, and never overwrites newer data with older.
- **Why encrypt tokens?** If the DB leaks, tokens stay unreadable without the key.
- **Why signed `state`?** Stops CSRF in the OAuth callback.
- **Why JWT sessions?** Simple for a separate frontend domain, at the cost of no server-side revocation.
- **Why jobIds?** Prevent duplicate jobs; a timestamp suffix on reconnect allows a fresh run.
- **Why unrecoverable on most 4xx?** Retrying a bad request never helps.

## 5. Likely interview questions with answers
1. **How is sync resumable?** Cursor in `sync_state`, saved after each persisted page.
2. **How do you avoid duplicates?** UNIQUE(account_id, hubspot_id), ON CONFLICT upsert, job ids.
3. **Worker dies mid-job?** BullMQ detects the stalled job and re-runs it; idempotent upsert makes it safe.
4. **Token expires mid-sync?** `hs()` refreshes on 401 or near expiry and retries once.
5. **Notes lost if Redis is down?** The note is already in Postgres as pending; the reconciler re-enqueues it.
6. **What is your biggest weakness?** Duplicate note window (crash after HubSpot create, before DB update). Fix: embed a marker like `[ref:noteId]` in the body and search HubSpot before retrying.
7. **100k contacts per minute?** Honest answer: one HubSpot account is limited by HubSpot's API rate limits, so that figure comes from many accounts in parallel. Design levers: more workers, batching, bulk writes, partitioning, read replicas, sharded queues.
8. **Webhooks?** Subscribe to contact creation and property change events, verify the signature, enqueue the contact ids, and fetch and upsert them.
9. **Incremental sync?** Use the Search API filtered on last-modified date greater than the last sync time.
10. **Security?** Encrypted tokens, signed state, every query scoped by account_id, input validation (note length), CORS restricted, secrets in env vars, .env git-ignored.
11. **What would you improve?** Tests, HttpOnly cookies, webhooks, Prometheus, a user table, the duplicate-note marker.
12. **What if the user disconnects or revokes access?** Not handled yet: the refresh would fail and the job would fail visibly. Future: detect and mark the account disconnected.
13. **Why can reviewers not connect to your app?** It is a private-distribution HubSpot app, so only the owner account can install it; the README tells them to create their own app.

## 6. Known quirks (admit them yourself)
- `synced_count` adds up across reconnects (cosmetic; the DB count is the truth).
- Search uses `LIKE` over several columns, fine for now, would use a trigram or full-text index at scale.
- Offset pagination on contacts gets slow at huge sizes; keyset pagination would fix it.
- Tokens in localStorage.

## 7. Demo script (3 minutes)
1. Show the status bar: Not connected. Click Connect HubSpot and approve.
2. Land back: Connected, sync completed, contacts listed.
3. Open a contact, add a note, watch pending then synced.
4. Show the note in HubSpot's contact timeline.
5. In the terminal: `select count(*) from contacts;`, reconnect, count unchanged (no duplicates).
6. Expire the token with SQL, add another note, show it still syncs (auto refresh).
7. Show `curl localhost:4000/metrics/queues`.

## 8. Commands to remember
```
cd ~/hubspot-sync && docker compose up -d
cd ~/hubspot-sync/backend && npm run api
cd ~/hubspot-sync/backend && npm run worker
cd ~/hubspot-sync/frontend && npm run dev
```
