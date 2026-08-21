-- geemoney ledger schema.
-- Money is integer minor units (cents). Discord snowflakes are TEXT (they exceed
-- JS safe integers). Timestamps are unix seconds.
-- Per-expense invariant enforced in application code before every write:
--   sum(paid_cents) = sum(owed_cents) = total_cents

CREATE TABLE ledgers (
  channel_id  TEXT PRIMARY KEY,           -- Discord channel snowflake (group DM or guild channel)
  currency    TEXT NOT NULL DEFAULT 'USD',
  created_at  INTEGER NOT NULL
);

CREATE TABLE expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id       TEXT    NOT NULL REFERENCES ledgers(channel_id),
  description     TEXT    NOT NULL,
  total_cents     INTEGER NOT NULL CHECK (total_cents > 0),
  currency        TEXT    NOT NULL DEFAULT 'USD',
  is_payment      INTEGER NOT NULL DEFAULT 0 CHECK (is_payment IN (0, 1)),
  payment_status  TEXT    CHECK (
                    (is_payment = 0 AND payment_status IS NULL) OR
                    (is_payment = 1 AND payment_status IN ('pending', 'confirmed', 'rejected'))),
  split_method    TEXT    NOT NULL CHECK (split_method IN ('equal', 'exact', 'percent', 'shares', 'payment')),
  split_input     TEXT,                   -- raw user entry JSON, kept for edit prefill
  revision        INTEGER NOT NULL DEFAULT 1,
  edit_token      TEXT,                   -- random token set by the batch that last rewrote shares;
                                          -- lets later statements in the same batch guard on
                                          -- "my UPDATE won" without branching (D1 batches can't branch)
  created_interaction_id TEXT UNIQUE,     -- idempotency guard against replayed interaction deliveries
  created_by      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      INTEGER,
  deleted_by      TEXT,
  deleted_at      INTEGER                 -- soft delete; NULL = live
);
CREATE INDEX idx_expenses_ledger ON expenses (ledger_id, deleted_at, id DESC);

CREATE TABLE expense_shares (
  expense_id  INTEGER NOT NULL REFERENCES expenses(id),
  user_id     TEXT    NOT NULL,
  paid_cents  INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  owed_cents  INTEGER NOT NULL DEFAULT 0 CHECK (owed_cents >= 0),
  PRIMARY KEY (expense_id, user_id),
  CHECK (paid_cents > 0 OR owed_cents > 0)
);
CREATE INDEX idx_shares_user ON expense_shares (user_id);

CREATE TABLE pending_actions (
  token         TEXT PRIMARY KEY,         -- crypto-random base32; unguessable so forged custom_ids can't hijack drafts
  kind          TEXT NOT NULL CHECK (kind IN ('expense_add', 'expense_edit', 'retry_add', 'retry_edit')),
  ledger_id     TEXT NOT NULL,
  invoker_id    TEXT NOT NULL,
  expense_id    INTEGER,                  -- set for edit kinds
  base_revision INTEGER,                  -- optimistic lock carried through the two-modal edit flow
  payload       TEXT NOT NULL,            -- JSON draft of the expense being built
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'cancelled')),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_pending_expiry ON pending_actions (expires_at);
