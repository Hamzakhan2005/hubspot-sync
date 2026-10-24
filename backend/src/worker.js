import { Worker, UnrecoverableError } from "bullmq";
import { connection, enqueueContactPage } from "./queues.js";
import { q, migrate } from "./db.js";
import { hs } from "./hubspot.js";

await migrate();
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);

// Wrap processor: on HubSpot 429, pause the whole queue then retry the job
function withRateLimit(getWorker, fn) {
  return async (job) => {
    try {
      return await fn(job);
    } catch (e) {
      if (e.retryAfterMs) {
        await getWorker().rateLimit(e.retryAfterMs);
        throw Worker.RateLimitError();
      }
      // non-retryable client errors (except 401/429 handled) -> stop retrying
      const s = e.response?.status;
      if (s && s >= 400 && s < 500 && ![401, 408, 429].includes(s)) {
        throw new UnrecoverableError(
          `${s}: ${JSON.stringify(e.response.data).slice(0, 300)}`
        );
      }
      throw e;
    }
  };
}

/* ---------- Contact sync: one job = one page (100 contacts) ---------- */
async function syncPage({ data: { accountId, after } }) {
  await q(
    `INSERT INTO sync_state (account_id,status) VALUES ($1,'running')
           ON CONFLICT (account_id) DO UPDATE SET status='running', updated_at=now()`,
    [accountId]
  );

  const r = await hs(accountId, {
    method: "get",
    url: "/crm/v3/objects/contacts",
    params: {
      limit: 100,
      after,
      properties: "firstname,lastname,email,phone,company",
    },
  });
  const rows = r.data.results;

  if (rows.length) {
    // single bulk upsert; only overwrite if HubSpot's copy is newer
    await q(
      `INSERT INTO contacts (account_id,hubspot_id,email,firstname,lastname,phone,company,hs_updated_at)
              SELECT $1::bigint, * FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::timestamptz[])
       ON CONFLICT (account_id,hubspot_id) DO UPDATE SET
         email=EXCLUDED.email, firstname=EXCLUDED.firstname, lastname=EXCLUDED.lastname,
         phone=EXCLUDED.phone, company=EXCLUDED.company, hs_updated_at=EXCLUDED.hs_updated_at
       WHERE contacts.hs_updated_at IS NULL OR contacts.hs_updated_at < EXCLUDED.hs_updated_at`,
      [
        accountId,
        rows.map((c) => c.id),
        rows.map((c) => c.properties.email ?? null),
        rows.map((c) => c.properties.firstname ?? null),
        rows.map((c) => c.properties.lastname ?? null),
        rows.map((c) => c.properties.phone ?? null),
        rows.map((c) => c.properties.company ?? null),
        rows.map((c) => c.updatedAt),
      ]
    );
  }

  const next = r.data.paging?.next?.after || null;
  // cursor + count saved AFTER page persisted => safe resume point
  await q(
    `UPDATE sync_state SET cursor=$2, synced_count=synced_count+$3,
           status=$4, last_error=NULL, updated_at=now() WHERE account_id=$1`,
    [accountId, next, rows.length, next ? "running" : "completed"]
  );
  if (next) await enqueueContactPage(accountId, next); // chain next page
}

/* ---------- Note push: contact note -> HubSpot ---------- */
async function pushNote({ data: { noteId } }) {
  const {
    rows: [n],
  } = await q(
    `SELECT n.*, c.hubspot_id, c.account_id FROM notes n JOIN contacts c ON c.id=n.contact_id WHERE n.id=$1`,
    [noteId]
  );
  if (!n || n.hubspot_note_id) return; // idempotent: already pushed
  await q("UPDATE notes SET attempts=attempts+1 WHERE id=$1", [noteId]);

  const r = await hs(n.account_id, {
    method: "post",
    url: "/crm/v3/objects/notes",
    data: {
      properties: {
        hs_note_body: n.body,
        hs_timestamp: new Date(n.created_at).toISOString(),
      },
      associations: [
        {
          to: { id: n.hubspot_id },
          types: [
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 },
          ], // note->contact
        },
      ],
    },
  });
  await q(
    `UPDATE notes SET hubspot_note_id=$2, sync_status='synced', last_error=NULL WHERE id=$1`,
    [noteId, r.data.id]
  );
}

const contactWorker = new Worker(
  "contact-sync",
  withRateLimit(() => contactWorker, syncPage),
  { connection, concurrency: CONCURRENCY, limiter: { max: 8, duration: 1000 } }
); // ~HubSpot 100/10s
const noteWorker = new Worker(
  "note-sync",
  withRateLimit(() => noteWorker, pushNote),
  { connection, concurrency: CONCURRENCY, limiter: { max: 8, duration: 1000 } }
);

// Final failure bookkeeping (after all retries exhausted)
contactWorker.on("failed", async (job, err) => {
  if (
    (job && job.attemptsMade >= job.opts.attempts) ||
    err.name === "UnrecoverableError"
  )
    await q(
      `UPDATE sync_state SET status='failed', last_error=$2 WHERE account_id=$1`,
      [job.data.accountId, err.message.slice(0, 500)]
    );
  console.error("[contact-sync] failed", job?.id, err.message);
});
noteWorker.on("failed", async (job, err) => {
  if (
    (job && job.attemptsMade >= job.opts.attempts) ||
    err.name === "UnrecoverableError"
  )
    await q(
      `UPDATE notes SET sync_status='failed', last_error=$2 WHERE id=$1`,
      [job.data.noteId, err.message.slice(0, 500)]
    );
  console.error("[note-sync] failed", job?.id, err.message);
});
contactWorker.on("completed", (j) => console.log("[contact-sync] done", j.id));
noteWorker.on("completed", (j) => console.log("[note-sync] done", j.id));
console.log("Workers running");
