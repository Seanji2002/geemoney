import { PENDING_TTL_SECONDS } from '../config';

export type PendingKind = 'expense_add' | 'expense_edit' | 'retry_add' | 'retry_edit';

/** Draft of an expense mid-flow (two-modal splits, validation retries). */
export interface PendingPayload {
  amountCents: number;
  description: string;
  method: string;
  payerId: string;
  /** Ordered ower set; usernames only for display inside the stage-2 modal. */
  participants: { id: string; username: string }[];
  /** Raw values the user previously typed, for retry/edit prefill. */
  priorInput?: string;
  /** false = the payer only fronted the money (picker flows). Default true. */
  payerShares?: boolean;
}

export interface PendingRecord {
  token: string;
  kind: PendingKind;
  ledger_id: string;
  invoker_id: string;
  expense_id: number | null;
  base_revision: number | null;
  payload: string;
  state: string;
  created_at: number;
  expires_at: number;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newToken(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => BASE32[b % 32]).join('');
}

export async function createPending(
  db: D1Database,
  args: {
    kind: PendingKind;
    ledgerId: string;
    invokerId: string;
    payload: PendingPayload;
    now: number;
    expenseId?: number;
    baseRevision?: number;
  },
): Promise<string> {
  const token = newToken();
  await db.batch([
    // Lazy hygiene: expired drafts go whenever a new one is created.
    db.prepare('DELETE FROM pending_actions WHERE expires_at < ?1').bind(args.now),
    db
      .prepare(
        `INSERT INTO pending_actions
           (token, kind, ledger_id, invoker_id, expense_id, base_revision, payload, state, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9)`,
      )
      .bind(
        token,
        args.kind,
        args.ledgerId,
        args.invokerId,
        args.expenseId ?? null,
        args.baseRevision ?? null,
        JSON.stringify(args.payload),
        args.now,
        args.now + PENDING_TTL_SECONDS,
      ),
  ]);
  return token;
}

export async function getOpenPending(
  db: D1Database,
  token: string,
  now: number,
): Promise<PendingRecord | null> {
  return await db
    .prepare("SELECT * FROM pending_actions WHERE token = ?1 AND state = 'open' AND expires_at > ?2")
    .bind(token, now)
    .first<PendingRecord>();
}

export async function cancelPending(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE pending_actions SET state = 'cancelled' WHERE token = ?1 AND state = 'open'")
    .bind(token)
    .run();
  return result.meta.changes === 1;
}
