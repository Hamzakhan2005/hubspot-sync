CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  hub_id TEXT UNIQUE NOT NULL,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_state (
  account_id BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|running|completed|failed
  cursor TEXT,                              -- HubSpot "after" cursor, enables resume
  synced_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hubspot_id TEXT NOT NULL,
  email TEXT, firstname TEXT, lastname TEXT, phone TEXT, company TEXT,
  hs_updated_at TIMESTAMPTZ,
  UNIQUE (account_id, hubspot_id)           -- no duplicates, enables idempotent upsert
);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts (account_id, lower(email), lower(lastname));

CREATE TABLE IF NOT EXISTS notes (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  hubspot_note_id TEXT,                     -- set once pushed; guards against double-push
  sync_status TEXT NOT NULL DEFAULT 'pending', -- pending|synced|failed
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_pending ON notes (sync_status) WHERE sync_status <> 'synced';