import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { InteractionContext } from '../../discord/types';
import { autocomplete, type AutocompleteChoice } from '../../discord/responses';
import { formatCents } from '../../domain/money';
import { searchExpenses } from '../../db/expenses';
import { recentDescriptions } from '../../db/hints';
import type { CommandOptionValue } from '../../discord/types';
import { plainDate } from '../render';

function focusedOption(options: CommandOptionValue[] | undefined): CommandOptionValue | undefined {
  for (const o of options ?? []) {
    if (o.focused) return o;
    const nested = focusedOption(o.options);
    if (nested) return nested;
  }
  return undefined;
}

export async function handleAutocomplete(i: Interaction, env: Env): Promise<Response> {
  const focused = focusedOption(i.data?.options);
  if (focused?.name === 'description') return handleDescriptionAutocomplete(i, env, String(focused.value ?? ''));
  return handleExpenseAutocomplete(i, env);
}

/** Recent descriptions in this chat; the typed text stays the first choice so free text is never blocked. */
async function handleDescriptionAutocomplete(i: Interaction, env: Env, query: string): Promise<Response> {
  if (!i.channel_id) return autocomplete([]);
  const recent = await recentDescriptions(env.DB, i.channel_id, query);
  const typed = query.trim();
  const choices = [
    ...(typed && !recent.some((d) => d.toLowerCase() === typed.toLowerCase()) ? [typed] : []),
    ...recent,
  ];
  return autocomplete(choices.slice(0, 25).map((d) => ({ name: d.slice(0, 100), value: d.slice(0, 100) })));
}

/**
 * Autocomplete for /delete `id`. Choice names are plain text
 * (mentions don't render there) and stay name-free for payments — the app
 * stores no display names.
 */
async function handleExpenseAutocomplete(i: Interaction, env: Env): Promise<Response> {
  if (i.context === InteractionContext.BotDM || !i.channel_id) {
    return autocomplete([{ name: '⚠ Run this in your group chat', value: '-' }]);
  }
  const includePayments = i.data?.name === 'delete';
  const query = String(focusedOption(i.data?.options)?.value ?? '');
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
