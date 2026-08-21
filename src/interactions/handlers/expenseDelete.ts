import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { ButtonStyle, invokerOf } from '../../discord/types';
import { button, container, row, text } from '../../discord/components';
import { channelMessage, followUpBody, updateMessage } from '../../discord/responses';
import { discordRest } from '../../discord/rest';
import { formatCents } from '../../domain/money';
import { getExpense, getShares, softDeleteExpense } from '../../db/expenses';
import { ephemeralNotice, ledgerIdOf, nowSeconds, rejectBotDm } from '../common';
import { customIds, type ParsedCustomId } from '../customId';
import { deleteNoticeView, historyLine, notice } from '../render';

export async function handleExpenseDelete(i: Interaction, env: Env, idRaw: string): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;
  const expenseId = Number(idRaw);
  if (!Number.isInteger(expenseId) || expenseId < 1) {
    return ephemeralNotice('Pick an expense from the suggestions.');
  }
  const record = await getExpense(env.DB, expenseId);
  if (!record || record.deleted_at !== null) return ephemeralNotice('That expense no longer exists.');
  if (record.ledger_id !== ledgerIdOf(i)) return ephemeralNotice('That expense belongs to a different chat.');
  const shares = await getShares(env.DB, expenseId);

  return channelMessage(
    [
      container([
        text(`${historyLine(record, shares)}\nDelete this? Balances will recompute.`),
      ]),
      row(
        button({ customId: customIds.del(expenseId, true), label: 'Delete', style: ButtonStyle.Danger }),
        button({ customId: customIds.del(expenseId, false), label: 'Keep', style: ButtonStyle.Secondary }),
      ),
    ],
    { ephemeral: true },
  );
}

export async function handleDeleteButton(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  parsed: Extract<ParsedCustomId, { op: 'delete' }>,
): Promise<Response> {
  if (!parsed.confirm) return updateMessage(notice('Kept — nothing changed.'));

  const invoker = invokerOf(i);
  const record = await getExpense(env.DB, parsed.expenseId);
  if (!record) return updateMessage(notice('That expense no longer exists.'));
  const shares = await getShares(env.DB, parsed.expenseId);

  const deleted = await softDeleteExpense(env.DB, parsed.expenseId, invoker.id, nowSeconds());
  if (!deleted) return updateMessage(notice('Already deleted.'));

  ctx.waitUntil(
    discordRest.postFollowUp(env.DISCORD_APP_ID, i.token, followUpBody(deleteNoticeView(invoker.id, record, shares))),
  );
  const label = record.is_payment
    ? `settlement #${record.id}`
    : `#${record.id} · ${record.description} (${formatCents(record.total_cents, record.currency)})`;
  return updateMessage(notice(`Deleted ${label} ✅`));
}
