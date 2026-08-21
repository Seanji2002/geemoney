import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { InteractionContext, invokerOf } from '../../discord/types';
import { channelMessage } from '../../discord/responses';
import {
  computeNets,
  computePairwise,
  settleSuggestions,
  type ExpenseShares,
} from '../../domain/balance';
import {
  ledgersForUser,
  liveShareRows,
  pendingSettlements,
  recentExpensesInvolving,
  sharesForExpenses,
} from '../../db/expenses';
import { ephemeralNotice, ledgerCurrency, optionValue } from '../common';
import { balanceView, pairwiseDetailView } from '../render';

export function groupByExpense(
  rows: { expense_id: number; user_id: string; paid_cents: number; owed_cents: number }[],
): ExpenseShares[] {
  const map = new Map<number, ExpenseShares>();
  for (const row of rows) {
    let entry = map.get(row.expense_id);
    if (!entry) {
      entry = { expenseId: row.expense_id, shares: [] };
      map.set(row.expense_id, entry);
    }
    entry.shares.push({ userId: row.user_id, paidCents: row.paid_cents, owedCents: row.owed_cents });
  }
  return [...map.values()];
}

/** Resolves which ledger a read command targets; null Response = error already built. */
export async function resolveReadLedger(
  i: Interaction,
  env: Env,
): Promise<{ ledgerId: string } | { errorResponse: Response }> {
  if (i.context !== InteractionContext.BotDM) return { ledgerId: i.channel_id! };
  const ledgers = await ledgersForUser(env.DB, invokerOf(i).id);
  if (ledgers.length === 1) return { ledgerId: ledgers[0]! };
  if (ledgers.length === 0) {
    return { errorResponse: ephemeralNotice('No expenses involve you yet — start with `/expense add` in your group chat.') };
  }
  return {
    errorResponse: ephemeralNotice(
      `You're in ${ledgers.length} ledgers — run this in the group chat you mean.`,
    ),
  };
}

export async function handleBalance(i: Interaction, env: Env): Promise<Response> {
  const target = await resolveReadLedger(i, env);
  if ('errorResponse' in target) return target.errorResponse;
  const { ledgerId } = target;

  const invoker = invokerOf(i);
  const withId = optionValue(i.data?.options, 'with');
  const share = optionValue(i.data?.options, 'share') === true;
  const ephemeral = !share || i.context === InteractionContext.BotDM;

  const currency = await ledgerCurrency(env, ledgerId);
  const rows = await liveShareRows(env.DB, ledgerId);
  const expenses = groupByExpense(rows);

  if (withId !== undefined) {
    const otherId = String(withId);
    const pairs = computePairwise(expenses);
    const key = invoker.id < otherId ? `${invoker.id}|${otherId}` : `${otherId}|${invoker.id}`;
    const raw = pairs.get(key) ?? 0;
    const netCents = invoker.id < otherId ? raw : -raw; // positive = invoker owes other
    const recentRecords = await recentExpensesInvolving(env.DB, ledgerId, invoker.id, otherId, 5);
    const shareMap = await sharesForExpenses(env.DB, recentRecords.map((r) => r.id));
    return channelMessage(
      pairwiseDetailView({
        invokerId: invoker.id,
        otherId,
        currency,
        netCents,
        recent: recentRecords.map((record) => ({ record, shares: shareMap.get(record.id) ?? [] })),
      }),
      { ephemeral },
    );
  }

  const nets = [...computeNets(expenses).entries()].map(([userId, cents]) => ({ userId, cents }));
  const suggestions = settleSuggestions(computePairwise(expenses));
  const pendingCount = await pendingSettlements(env.DB, ledgerId);
  return channelMessage(
    balanceView({ title: 'Balances — this chat', currency, nets, suggestions, pendingCount }),
    { ephemeral },
  );
}
