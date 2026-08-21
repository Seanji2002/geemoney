/** Returns true exactly once per (chat, user): the first time they use the app there. */
export async function claimFirstUse(
  db: D1Database,
  ledgerId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const [, updated] = await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_chat_state (ledger_id, user_id) VALUES (?1, ?2)')
      .bind(ledgerId, userId),
    db
      .prepare(
        'UPDATE user_chat_state SET guide_shown_at = ?3 WHERE ledger_id = ?1 AND user_id = ?2 AND guide_shown_at IS NULL',
      )
      .bind(ledgerId, userId, now),
  ]);
  return updated!.meta.changes === 1;
}

/** Claims the next tip slot (0-based); null once the user has seen them all. */
export async function claimTipSlot(
  db: D1Database,
  ledgerId: string,
  userId: string,
  maxTips: number,
): Promise<number | null> {
  const [, updated, row] = await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO user_chat_state (ledger_id, user_id) VALUES (?1, ?2)')
      .bind(ledgerId, userId),
    db
      .prepare(
        'UPDATE user_chat_state SET tips_shown = tips_shown + 1 WHERE ledger_id = ?1 AND user_id = ?2 AND tips_shown < ?3',
      )
      .bind(ledgerId, userId, maxTips),
    db
      .prepare('SELECT tips_shown FROM user_chat_state WHERE ledger_id = ?1 AND user_id = ?2')
      .bind(ledgerId, userId),
  ]);
  if (updated!.meta.changes !== 1) return null;
  const shown = (row!.results[0] as { tips_shown: number } | undefined)?.tips_shown ?? 1;
  return shown - 1;
}

/** Distinct recent descriptions in a chat, for autocomplete. */
export async function recentDescriptions(
  db: D1Database,
  ledgerId: string,
  query: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT description, MAX(id) AS last_id FROM expenses
       WHERE ledger_id = ?1 AND deleted_at IS NULL AND is_payment = 0
         AND (?2 = '' OR description LIKE ?3)
       GROUP BY description ORDER BY last_id DESC LIMIT 25`,
    )
    .bind(ledgerId, query.trim(), `%${query.trim()}%`)
    .all<{ description: string }>();
  return results.map((r) => r.description);
}
