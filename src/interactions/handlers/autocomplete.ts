import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { InteractionContext } from '../../discord/types';
import { autocomplete, type AutocompleteChoice } from '../../discord/responses';
import { formatCents } from '../../domain/money';
import { searchExpenses } from '../../db/expenses';
import { subcommandOf } from '../common';
import { plainDate } from '../render';

/**
 * Autocomplete for /expense edit|delete `id`. Choice names are plain text
 * (mentions don't render there) and stay name-free for payments — the app
 * stores no display names.
 */
export async function handleExpenseAutocomplete(i: Interaction, env: Env): Promise<Response> {
  if (i.context === InteractionContext.BotDM || !i.channel_id) {
    return autocomplete([{ name: '⚠ Run this in your group chat', value: '-' }]);
  }
  const sub = subcommandOf(i);
  const includePayments = sub?.name === 'delete';
  const query = String(sub?.options.find((o) => o.focused)?.value ?? '');
  const rows = await searchExpenses(env.DB, i.channel_id, query, includePayments);
  const choices: AutocompleteChoice[] = rows.map((r) => {
    const amount = formatCents(r.total_cents, r.currency);
    const name = r.is_payment
      ? `#${r.id} · 💸 settlement ${amount} (${r.payment_status}) · ${plainDate(r.created_at)}`
      : `#${r.id} · ${r.description.slice(0, 50)} · ${amount} · ${plainDate(r.created_at)}`;
    return { name: name.slice(0, 100), value: String(r.id) };
  });
  return autocomplete(choices);
}
