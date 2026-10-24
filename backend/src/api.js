import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { cfg } from "./config.js";
import { q, migrate } from "./db.js";
import { authUrl, exchangeCode, fetchHubId, saveAccount } from "./hubspot.js";
import {
  enqueueContactPage,
  enqueueNote,
  contactQueue,
  noteQueue,
} from "./queues.js";

await migrate();
const app = express();
app.use(cors({ origin: cfg.frontendUrl }));
app.use(express.json({ limit: "100kb" }));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e.response?.data || e);
    res.status(500).json({ error: "Internal error" });
  });

app.get("/health", (_, res) => res.json({ ok: true }));

/* ---------- OAuth ---------- */
// state = short-lived signed JWT (CSRF protection)
app.get("/auth/hubspot/url", (_, res) => {
  const state = jwt.sign({ n: Math.random() }, cfg.jwtSecret, {
    expiresIn: "10m",
  });
  res.json({ url: authUrl(state) });
});

app.get(
  "/auth/hubspot/callback",
  wrap(async (req, res) => {
    const { code, state } = req.query;
    try {
      jwt.verify(state, cfg.jwtSecret);
    } catch {
      return res.status(400).send("Invalid state");
    }
    const tokens = await exchangeCode(code);
    const hubId = await fetchHubId(tokens.access_token);
    const accountId = await saveAccount(hubId, tokens);
    // AUTOMATIC SYNC: start immediately; resume from stored cursor if one exists
    const {
      rows: [s],
    } = await q("SELECT cursor, status FROM sync_state WHERE account_id=$1", [
      accountId,
    ]);
    await q(
      `INSERT INTO sync_state (account_id,status) VALUES ($1,'pending')
           ON CONFLICT (account_id) DO UPDATE SET status='pending', last_error=NULL,
             synced_count = CASE WHEN sync_state.cursor IS NULL THEN 0 ELSE sync_state.synced_count END`,
      [accountId]
    );
    await enqueueContactPage(
      accountId,
      s?.status !== "completed" ? s?.cursor : null,
      true
    );
    const session = jwt.sign({ accountId }, cfg.jwtSecret, { expiresIn: "7d" });
    res.redirect(`${cfg.frontendUrl}/#token=${session}`);
  })
);

/* ---------- Auth middleware ---------- */
app.use("/api", (req, res, next) => {
  try {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    req.accountId = jwt.verify(t, cfg.jwtSecret).accountId;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
});

/* ---------- API ---------- */
app.get(
  "/api/status",
  wrap(async (req, res) => {
    const {
      rows: [a],
    } = await q("SELECT hub_id FROM accounts WHERE id=$1", [req.accountId]);
    const {
      rows: [s],
    } = await q(
      "SELECT status, synced_count, last_error, updated_at FROM sync_state WHERE account_id=$1",
      [req.accountId]
    );
    res.json({ connected: !!a, hubId: a?.hub_id, sync: s || null });
  })
);

app.get(
  "/api/contacts",
  wrap(async (req, res) => {
    const page = Math.max(1, +req.query.page || 1),
      size = 20;
    const search = `%${(req.query.q || "").toLowerCase()}%`;
    const where = `account_id=$1 AND (lower(coalesce(email,'')||' '||coalesce(firstname,'')||' '||coalesce(lastname,'')) LIKE $2)`;
    const { rows } = await q(
      `SELECT id,email,firstname,lastname,phone,company FROM contacts
    WHERE ${where} ORDER BY id LIMIT $3 OFFSET $4`,
      [req.accountId, search, size, (page - 1) * size]
    );
    const {
      rows: [{ count }],
    } = await q(`SELECT count(*) FROM contacts WHERE ${where}`, [
      req.accountId,
      search,
    ]);
    res.json({ contacts: rows, total: +count, page, size });
  })
);

app.get(
  "/api/contacts/:id",
  wrap(async (req, res) => {
    const {
      rows: [c],
    } = await q("SELECT * FROM contacts WHERE id=$1 AND account_id=$2", [
      req.params.id,
      req.accountId,
    ]);
    if (!c) return res.status(404).json({ error: "Not found" });
    const { rows: notes } = await q(
      "SELECT id,body,sync_status,last_error,created_at FROM notes WHERE contact_id=$1 ORDER BY created_at DESC",
      [c.id]
    );
    res.json({ contact: c, notes });
  })
);

app.post(
  "/api/contacts/:id/notes",
  wrap(async (req, res) => {
    const body = String(req.body.body || "").trim();
    if (!body || body.length > 5000)
      return res.status(400).json({ error: "Note must be 1-5000 chars" });
    const {
      rows: [c],
    } = await q("SELECT id FROM contacts WHERE id=$1 AND account_id=$2", [
      req.params.id,
      req.accountId,
    ]);
    if (!c) return res.status(404).json({ error: "Contact not found" });
    const {
      rows: [n],
    } = await q(
      "INSERT INTO notes (contact_id, body) VALUES ($1,$2) RETURNING *",
      [c.id, body]
    );
    await enqueueNote(n.id); // DB is source of truth; queue push is async
    res.status(201).json(n);
  })
);

// Manual retry for failed notes
app.post(
  "/api/notes/:id/retry",
  wrap(async (req, res) => {
    const { rowCount } = await q(
      `UPDATE notes SET sync_status='pending', last_error=NULL WHERE id=$1 AND sync_status='failed'
     AND contact_id IN (SELECT id FROM contacts WHERE account_id=$2)`,
      [req.params.id, req.accountId]
    );
    if (!rowCount)
      return res.status(404).json({ error: "Not found or not failed" });
    await noteQueue.remove(`n-${req.params.id}`).catch(() => {});
    await enqueueNote(req.params.id);
    res.json({ ok: true });
  })
);

// Queue metrics (observability)
app.get(
  "/metrics/queues",
  wrap(async (_, res) => {
    res.json({
      contacts: await contactQueue.getJobCounts(),
      notes: await noteQueue.getJobCounts(),
    });
  })
);

// Safety net: re-enqueue notes stuck in pending (e.g. Redis was down on insert)
setInterval(async () => {
  const { rows } = await q(
    `SELECT id FROM notes WHERE sync_status='pending' AND created_at < now() - interval '2 minutes' LIMIT 200`
  );
  for (const r of rows) await enqueueNote(r.id).catch(() => {});
}, 60_000);

app.listen(cfg.port, () => console.log(`API on :${cfg.port}`));
