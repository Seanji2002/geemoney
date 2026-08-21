import type { ShareRow } from '../domain/split';

// D1 batches are transactional but cannot branch on a prior statement's
// outcome, so every conditional multi-statement write here carries its
// precondition inside each statement:
//  - inserts are guarded by `changes() = 1` (the immediately preceding claim
//    UPDATE) and by re-selecting the expense via its UNIQUE interaction id;
//  - share rewrites are guarded by a per-batch random edit_token that only
//    this batch's UPDATE could have set.

export interface ExpenseRecord {
  id: number;
  ledger_id: string;
  description: string;
  total_cents: number;
  currency: string;
  is_payment: number;
  payment_status: string | null;
  split_method: string;
  split_input: string | null;
  revision: number;
  created_by: string;
  created_at: number;
  deleted_at: number | null;
}

export interface ShareRecord {
  expense_id: number;
  user_id: string;
  paid_cents: number;
  owed_cents: number;
}

export interface ExpenseInsert {
  interactionId: string;
  ledgerId: string;
  currency: string;
  description: string;
  totalCents: number;
  isPayment: boolean;
  splitMethod: string;
  splitInput: string | null;
  createdBy: string;
  createdAt: number;
  shares: ShareRow[];
}

export type InsertOutcome =
  | { status: 'ok'; expenseId: number }
  | { status: 'duplicate' }
  | { status: 'not_claimed' };

function ledgerStmt(db: D1Database, ledgerId: string, currency: string, now: number) {
  return db
    .prepare('INSERT OR IGNORE INTO ledgers (channel_id, currency, created_at) VALUES (?1, ?2, ?3)')
    .bind(ledgerId, currency, now);
}

const EXPENSE_COLUMNS =
  '(ledger_id, description, total_cents, currency, is_payment, payment_status, split_method, split_input, created_interaction_id, created_by, created_at)';

function shareStmts(db: D1Database, interactionId: string, shares: ShareRow[]) {
  return shares.map((share) =>
    db
      .prepare(
        `INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents)
         SELECT e.id, ?1, ?2, ?3 FROM expenses e WHERE e.created_interaction_id = ?4`,
      )
      .bind(share.userId, share.paidCents, share.owedCents, interactionId),
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message);
}

export async function insertExpense(db: D1Database, ins: ExpenseInsert): Promise<InsertOutcome> {
  try {
    const results = await db.batch([
      ledgerStmt(db, ins.ledgerId, ins.currency, ins.createdAt),
      db
        .prepare(
          `INSERT INTO expenses ${EXPENSE_COLUMNS}
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
        .bind(
          ins.ledgerId,
          ins.description,
          ins.totalCents,
          ins.currency,
          ins.isPayment ? 1 : 0,
          ins.isPayment ? 'pending' : null,
          ins.splitMethod,
          ins.splitInput,
          ins.interactionId,
          ins.createdBy,
          ins.createdAt,
        ),
      ...shareStmts(db, ins.interactionId, ins.shares),
    ]);
    return { status: 'ok', expenseId: Number(results[1]!.meta.last_row_id) };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'duplicate' };
    throw err;
  }
}

/**
 * Claims an open pending_actions row and inserts the expense in one atomic
 * batch. If the claim finds nothing (expired / already used), every following
 * statement is a no-op.
 */
export async function insertExpenseViaPendingClaim(
  db: D1Database,
  token: string,
  now: number,
  ins: ExpenseInsert,
): Promise<InsertOutcome> {
  try {
    const results = await db.batch([
      ledgerStmt(db, ins.ledgerId, ins.currency, ins.createdAt),
      db
        .prepare(
          "UPDATE pending_actions SET state = 'done' WHERE token = ?1 AND state = 'open' AND expires_at > ?2",
        )
        .bind(token, now),
      db
        .prepare(
          `INSERT INTO expenses ${EXPENSE_COLUMNS}
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE changes() = 1`,
        )
        .bind(
          ins.ledgerId,
          ins.description,
          ins.totalCents,
          ins.currency,
          ins.isPayment ? 1 : 0,
          ins.isPayment ? 'pending' : null,
          ins.splitMethod,
          ins.splitInput,
          ins.interactionId,
          ins.createdBy,
          ins.createdAt,
        ),
      ...shareStmts(db, ins.interactionId, ins.shares),
    ]);
    if (results[1]!.meta.changes !== 1) return { status: 'not_claimed' };
    return { status: 'ok', expenseId: Number(results[2]!.meta.last_row_id) };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'duplicate' };
    throw err;
  }
}

export interface ExpenseEdit {
  expenseId: number;
  baseRevision: number;
  editToken: string;
  description: string;
  totalCents: number;
  splitMethod: string;
  splitInput: string | null;
  updatedBy: string;
  updatedAt: number;
  shares: ShareRow[];
}

export type EditOutcome = 'ok' | 'conflict' | 'not_claimed';

function editStmts(db: D1Database, edit: ExpenseEdit, claimGuard: boolean) {
  const update = db
    .prepare(
      `UPDATE expenses
       SET description = ?1, total_cents = ?2, split_method = ?3, split_input = ?4,
           revision = revision + 1, edit_token = ?5, updated_by = ?6, updated_at = ?7
       WHERE id = ?8 AND revision = ?9 AND deleted_at IS NULL AND is_payment = 0
         ${claimGuard ? 'AND changes() = 1' : ''}`,
    )
    .bind(
      edit.description,
      edit.totalCents,
      edit.splitMethod,
      edit.splitInput,
      edit.editToken,
      edit.updatedBy,
      edit.updatedAt,
      edit.expenseId,
      edit.baseRevision,
    );
  const wipe = db
    .prepare(
      'DELETE FROM expense_shares WHERE expense_id = ?1 AND (SELECT edit_token FROM expenses WHERE id = ?1) = ?2',
    )
    .bind(edit.expenseId, edit.editToken);
  const inserts = edit.shares.map((share) =>
    db
      .prepare(
        `INSERT INTO expense_shares (expense_id, user_id, paid_cents, owed_cents)
         SELECT ?1, ?2, ?3, ?4 WHERE (SELECT edit_token FROM expenses WHERE id = ?1) = ?5`,
      )
      .bind(edit.expenseId, share.userId, share.paidCents, share.owedCents, edit.editToken),
  );
  return [update, wipe, ...inserts];
}

export async function editExpense(db: D1Database, edit: ExpenseEdit): Promise<EditOutcome> {
  const results = await db.batch(editStmts(db, edit, false));
  return results[0]!.meta.changes === 1 ? 'ok' : 'conflict';
}

export async function editExpenseViaPendingClaim(
  db: D1Database,
  token: string,
  now: number,
  edit: ExpenseEdit,
): Promise<EditOutcome> {
  const results = await db.batch([
    db
      .prepare(
        "UPDATE pending_actions SET state = 'done' WHERE token = ?1 AND state = 'open' AND expires_at > ?2",
      )
      .bind(token, now),
    ...editStmts(db, edit, true),
  ]);
  if (results[0]!.meta.changes !== 1) return 'not_claimed';
  return results[1]!.meta.changes === 1 ? 'ok' : 'conflict';
}

export async function softDeleteExpense(
  db: D1Database,
  expenseId: number,
  deletedBy: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE expenses SET deleted_by = ?1, deleted_at = ?2 WHERE id = ?3 AND deleted_at IS NULL')
    .bind(deletedBy, now, expenseId)
    .run();
  return result.meta.changes === 1;
}

export async function transitionSettlement(
  db: D1Database,
  expenseId: number,
  status: 'confirmed' | 'rejected',
  by: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE expenses SET payment_status = ?1, updated_by = ?2, updated_at = ?3
       WHERE id = ?4 AND is_payment = 1 AND payment_status = 'pending' AND deleted_at IS NULL`,
    )
    .bind(status, by, now, expenseId)
    .run();
  return result.meta.changes === 1;
}

// ---- Reads ----

export async function getExpense(db: D1Database, expenseId: number): Promise<ExpenseRecord | null> {
  return await db.prepare('SELECT * FROM expenses WHERE id = ?1').bind(expenseId).first<ExpenseRecord>();
}

/** Recovers the expense a replayed interaction delivery already created. */
export async function getExpenseByInteractionId(
  db: D1Database,
  interactionId: string,
): Promise<ExpenseRecord | null> {
  return await db
    .prepare('SELECT * FROM expenses WHERE created_interaction_id = ?1')
    .bind(interactionId)
    .first<ExpenseRecord>();
}

/** The newest unconfirmed settlement from debtor to creditor in a ledger. */
export async function findPendingSettlement(
  db: D1Database,
  ledgerId: string,
  debtorId: string,
  creditorId: string,
): Promise<ExpenseRecord | null> {
  return await db
    .prepare(
      `SELECT e.* FROM expenses e
       JOIN expense_shares d ON d.expense_id = e.id AND d.user_id = ?2 AND d.paid_cents > 0
       JOIN expense_shares c ON c.expense_id = e.id AND c.user_id = ?3 AND c.owed_cents > 0
       WHERE e.ledger_id = ?1 AND e.is_payment = 1 AND e.payment_status = 'pending'
         AND e.deleted_at IS NULL
       ORDER BY e.id DESC LIMIT 1`,
    )
    .bind(ledgerId, debtorId, creditorId)
    .first<ExpenseRecord>();
}

export async function getShares(db: D1Database, expenseId: number): Promise<ShareRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM expense_shares WHERE expense_id = ?1')
    .bind(expenseId)
    .all<ShareRecord>();
  return results;
}

/** Live expense/share rows that count toward balances (payments only when confirmed). */
export async function liveShareRows(
  db: D1Database,
  ledgerId: string,
): Promise<{ expense_id: number; user_id: string; paid_cents: number; owed_cents: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.expense_id, s.user_id, s.paid_cents, s.owed_cents
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.ledger_id = ?1 AND e.deleted_at IS NULL
         AND (e.is_payment = 0 OR e.payment_status = 'confirmed')
       ORDER BY s.expense_id`,
    )
    .bind(ledgerId)
    .all<{ expense_id: number; user_id: string; paid_cents: number; owed_cents: number }>();
  return results;
}

export async function pendingSettlements(db: D1Database, ledgerId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM expenses
       WHERE ledger_id = ?1 AND is_payment = 1 AND payment_status = 'pending' AND deleted_at IS NULL`,
    )
    .bind(ledgerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function searchExpenses(
  db: D1Database,
  ledgerId: string,
  query: string,
  includePayments: boolean,
): Promise<ExpenseRecord[]> {
  const idMatch = /^#?(\d{1,10})$/.exec(query.trim());
  const { results } = await db
    .prepare(
      `SELECT * FROM expenses
       WHERE ledger_id = ?1 AND deleted_at IS NULL
         AND (?2 = 1 OR is_payment = 0)
         AND (?3 = '' OR description LIKE ?4 OR id = ?5)
       ORDER BY id DESC LIMIT 25`,
    )
    .bind(
      ledgerId,
      includePayments ? 1 : 0,
      query.trim(),
      `%${query.trim()}%`,
      idMatch ? Number(idMatch[1]) : -1,
    )
    .all<ExpenseRecord>();
  return results;
}

export interface HistoryPage {
  rows: ExpenseRecord[];
  page: number;
  totalPages: number;
}

export async function historyPage(
  db: D1Database,
  ledgerId: string,
  page: number,
  pageSize: number,
  withUser: string | null,
): Promise<HistoryPage> {
  const filter = withUser
    ? 'AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = expenses.id AND s.user_id = ?2)'
    : '';
  const bindings: (string | number)[] = withUser ? [ledgerId, withUser] : [ledgerId];
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE ledger_id = ?1 AND deleted_at IS NULL ${filter}`)
    .bind(...bindings)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const { results } = await db
    .prepare(
      `SELECT * FROM expenses WHERE ledger_id = ?1 AND deleted_at IS NULL ${filter}
       ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(clamped - 1) * pageSize}`,
    )
    .bind(...bindings)
    .all<ExpenseRecord>();
  return { rows: results, page: clamped, totalPages };
}

/** Newest live expenses involving both users (for /balance with:@user detail). */
export async function recentExpensesInvolving(
  db: D1Database,
  ledgerId: string,
  userA: string,
  userB: string,
  limit: number,
): Promise<ExpenseRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM expenses
       WHERE ledger_id = ?1 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = expenses.id AND s.user_id = ?2)
         AND EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = expenses.id AND s.user_id = ?3)
       ORDER BY id DESC LIMIT ${Math.max(1, Math.min(25, limit))}`,
    )
    .bind(ledgerId, userA, userB)
    .all<ExpenseRecord>();
  return results;
}

/** Shares for a set of expenses in one query (history pages, receipts). */
export async function sharesForExpenses(
  db: D1Database,
  expenseIds: number[],
): Promise<Map<number, ShareRecord[]>> {
  const map = new Map<number, ShareRecord[]>();
  if (expenseIds.length === 0) return map;
  const placeholders = expenseIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const { results } = await db
    .prepare(`SELECT * FROM expense_shares WHERE expense_id IN (${placeholders})`)
    .bind(...expenseIds)
    .all<ShareRecord>();
  for (const row of results) {
    const list = map.get(row.expense_id) ?? [];
    list.push(row);
    map.set(row.expense_id, list);
  }
  return map;
}

/** Everyone who appears in a ledger's live expenses. */
export async function ledgerMembers(db: D1Database, ledgerId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.user_id AS user_id
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.ledger_id = ?1 AND e.deleted_at IS NULL`,
    )
    .bind(ledgerId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Ledgers a user appears in (for /balance and /history in the bot's own DM). */
export async function ledgersForUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT e.ledger_id AS ledger_id
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE s.user_id = ?1 AND e.deleted_at IS NULL`,
    )
    .bind(userId)
    .all<{ ledger_id: string }>();
  return results.map((r) => r.ledger_id);
}
