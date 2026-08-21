-- Per (chat, user) onboarding state: the one-time guide and a few next-step tips.
CREATE TABLE user_chat_state (
  ledger_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  guide_shown_at  INTEGER,
  tips_shown      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ledger_id, user_id)
);
