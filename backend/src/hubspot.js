import axios from "axios";
import { cfg } from "./config.js";
import { pool, q } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

export const SCOPES =
  "oauth crm.objects.contacts.read crm.objects.contacts.write";
const api = axios.create({ baseURL: "https://api.hubapi.com", timeout: 20000 });

export const authUrl = (state) =>
  "https://app.hubspot.com/oauth/authorize?" +
  new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    state,
  });

async function tokenRequest(params) {
  const { data } = await api.post(
    "/oauth/v1/token",
    new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      ...params,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return data; // access_token, refresh_token, expires_in
}

export const exchangeCode = (code) =>
  tokenRequest({ grant_type: "authorization_code", code });

export async function fetchHubId(accessToken) {
  const { data } = await api.get(`/oauth/v1/access-tokens/${accessToken}`);
  return String(data.hub_id);
}

export async function saveAccount(hubId, t) {
  const { rows } = await q(
    `INSERT INTO accounts (hub_id, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)
     ON CONFLICT (hub_id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc,
       refresh_token_enc=EXCLUDED.refresh_token_enc, expires_at=EXCLUDED.expires_at
     RETURNING id`,
    [
      hubId,
      encrypt(t.access_token),
      encrypt(t.refresh_token),
      String(t.expires_in),
    ]
  );
  return rows[0].id;
}

// Row lock serializes concurrent refreshes across workers (HubSpot rotates tokens).
export async function getAccessToken(accountId, force = false) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const {
      rows: [a],
    } = await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    if (!a) throw new Error("Account not found");
    if (!force && a.expires_at.getTime() - Date.now() > 60_000) {
      await c.query("COMMIT");
      return decrypt(a.access_token_enc);
    }
    const t = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: decrypt(a.refresh_token_enc),
    });
    await c.query(
      `UPDATE accounts SET access_token_enc=$2, refresh_token_enc=$3,
       expires_at = now() + ($4 || ' seconds')::interval WHERE id=$1`,
      [
        accountId,
        encrypt(t.access_token),
        encrypt(t.refresh_token),
        String(t.expires_in),
      ]
    );
    await c.query("COMMIT");
    return t.access_token;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

// Authenticated call: auto-refresh on 401 (once); surfaces 429 with retryAfterMs.
export async function hs(accountId, config) {
  const call = async (force) =>
    api({
      ...config,
      headers: {
        Authorization: `Bearer ${await getAccessToken(accountId, force)}`,
      },
    });
  try {
    try {
      return await call(false);
    } catch (e) {
      if (e.response?.status === 401) return await call(true);
      throw e;
    }
  } catch (e) {
    if (e.response?.status === 429) {
      e.retryAfterMs = (Number(e.response.headers["retry-after"]) || 10) * 1000;
    }
    throw e;
  }
}
