export interface Env {
  DB: D1Database;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DEFAULT_CURRENCY: string;
}

/** Hard cap per expense/settlement: $100,000.00 */
export const MAX_AMOUNT_CENTS = 10_000_000;

/** Group DMs cap at 10 members. */
export const MAX_PARTICIPANTS = 10;

export const HISTORY_PAGE_SIZE = 10;

/** Drafts are pure hygiene, not a token constraint — buttons mint fresh tokens. */
export const PENDING_TTL_SECONDS = 60 * 60;
