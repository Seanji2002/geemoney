-- Per-chat roster: who "everyone" means when an expense omits participants.
-- Seeded automatically from recorded expenses; editable with /roster.
-- display_name is best-effort (from Discord's resolved data) and only used
-- as plain-text labels inside modals, where mentions don't render.
CREATE TABLE roster_members (
  ledger_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);
