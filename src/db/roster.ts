import { compareSnowflakes } from '../domain/split';

export interface RosterMember {
  id: string;
  username: string;
}

/** Placeholder names come from usernameOf() when Discord sent no resolved user. */
export function isPlaceholderName(name: string): boolean {
  return /^user-\d{4}$/.test(name);
}

/** Members of a chat's roster, ordered by snowflake for stable display. */
export async function getRoster(db: D1Database, ledgerId: string): Promise<RosterMember[]> {
  const { results } = await db
    .prepare('SELECT user_id, display_name FROM roster_members WHERE ledger_id = ?1')
    .bind(ledgerId)
    .all<{ user_id: string; display_name: string }>();
  return results
    .map((r) => ({ id: r.user_id, username: r.display_name }))
    .sort((a, b) => compareSnowflakes(a.id, b.id));
}

/** Replaces the roster wholesale (the /roster picker). */
export async function setRoster(
  db: D1Database,
  ledgerId: string,
  members: RosterMember[],
  now: number,
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM roster_members WHERE ledger_id = ?1').bind(ledgerId),
    ...members.map((m) =>
      db
        .prepare(
          'INSERT INTO roster_members (ledger_id, user_id, display_name, added_at) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(ledgerId, m.id, m.username, now),
    ),
  ]);
}

/**
 * Adds anyone new and upgrades placeholder names to real ones (called after
 * every recorded expense).
 */
export async function addToRoster(
  db: D1Database,
  ledgerId: string,
  members: RosterMember[],
  now: number,
): Promise<void> {
  if (members.length === 0) return;
  await db.batch(
    members.map((m) =>
      db
        .prepare(
          `INSERT INTO roster_members (ledger_id, user_id, display_name, added_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (ledger_id, user_id) DO UPDATE SET
             display_name = CASE
               WHEN excluded.display_name LIKE 'user-%' THEN roster_members.display_name
               ELSE excluded.display_name
             END`,
        )
        .bind(ledgerId, m.id, m.username, now),
    ),
  );
}
