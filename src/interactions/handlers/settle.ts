import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { ButtonStyle, invokerOf } from '../../discord/types';
import { button, container, row, text } from '../../discord/components';
import { channelMessage, updateMessage } from '../../discord/responses';
import { formatCents, parseAmount } from '../../domain/money';
import { pairwiseDebt } from '../../domain/balance';
import {
  findPendingSettlement,
  getExpense,
  getExpenseByInteractionId,
  getShares,
  insertExpense,
  liveShareRows,
  transitionSettlement,
} from '../../db/expenses';
import {
  ephemeralNotice,
  ledgerCurrency,
  ledgerIdOf,
  nowSeconds,
  optionValue,
  rejectBotDm,
} from '../common';
import { customIds, type ParsedCustomId } from '../customId';
import { groupByExpense } from './balance';
import { mention, notice, settleOutcomeText, settlePromptText, type SettlePromptData } from '../render';

export async function handleSettle(i: Interaction, env: Env): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;
  const invoker = invokerOf(i);
  const toId = String(optionValue(i.data?.options, 'to') ?? '');
  const amountRaw = optionValue(i.data?.options, 'amount');
  if (!toId) return ephemeralNotice('Pick who you paid.');
  if (toId === invoker.id) return ephemeralNotice("You can't settle with yourself.");
  if (i.data?.resolved?.users?.[toId]?.bot) return ephemeralNotice("You can't settle with a bot.");

  const ledgerId = ledgerIdOf(i);
  const currency = await ledgerCurrency(env, ledgerId);

  const renderPrompt = (expenseId: number, cents: number, extra = ''): Response => {
    const data: SettlePromptData = { expenseId, debtorId: invoker.id, creditorId: toId, cents, currency };
    return channelMessage([
      container([text(settlePromptText(data) + extra)]),
      row(
        button({ customId: customIds.settle(expenseId, true), label: '✓ Confirm received', style: ButtonStyle.Success }),
        button({ customId: customIds.settle(expenseId, false), label: '✗ Not received / cancel', style: ButtonStyle.Danger }),
      ),
    ]);
  };

  // Replayed delivery: the settlement exists but our first response (with the
  // confirm buttons) may never have reached Discord — re-render it.
  const replayed = await getExpenseByInteractionId(env.DB, i.id);
  if (replayed?.is_payment) {
    return replayed.payment_status === 'pending' && replayed.deleted_at === null
      ? renderPrompt(replayed.id, replayed.total_cents)
      : ephemeralNotice('Already recorded.');
  }

  const rows = await liveShareRows(env.DB, ledgerId);
  const debt = pairwiseDebt(groupByExpense(rows), invoker.id, toId);

  let cents: number;
  if (amountRaw === undefined) {
    // Don't stack a second full-amount settlement on top of an unconfirmed
    // one — both confirming would double-pay the debt.
    const alreadyPending = await findPendingSettlement(env.DB, ledgerId, invoker.id, toId);
    if (alreadyPending) {
      return ephemeralNotice(
        `You already have a pending settlement of ${formatCents(alreadyPending.total_cents, currency)} to ${mention(toId)} — ` +
          `ask them to tap ✓ on it (or remove it with \`/expense delete\`) before recording another. ` +
          `To add an extra payment anyway, pass an explicit amount.`,
      );
    }
    if (debt <= 0) {
      return ephemeralNotice(
        `You don't owe ${mention(toId)} anything right now. To record a payment anyway, pass an explicit amount.`,
      );
    }
    cents = debt;
  } else {
    const parsed = parseAmount(String(amountRaw));
    if (!parsed.ok) return ephemeralNotice(parsed.error);
    cents = parsed.cents;
  }

  const now = nowSeconds();
  const outcome = await insertExpense(env.DB, {
    interactionId: i.id,
    ledgerId,
    currency,
    description: 'Settlement',
    totalCents: cents,
    isPayment: true,
    splitMethod: 'payment',
    splitInput: null,
    createdBy: invoker.id,
    createdAt: now,
    shares: [
      { userId: invoker.id, paidCents: cents, owedCents: 0 },
      { userId: toId, paidCents: 0, owedCents: cents },
    ],
  });
  if (outcome.status !== 'ok') {
    // A replay that raced past the check above; the row exists now.
    const existing = await getExpenseByInteractionId(env.DB, i.id);
    if (existing && existing.is_payment && existing.payment_status === 'pending') {
      return renderPrompt(existing.id, existing.total_cents);
    }
    return ephemeralNotice('Already recorded.');
  }

  const overpay = amountRaw !== undefined && cents > debt;
  const extra = overpay
    ? `\n(That's ${formatCents(cents - debt, currency)} beyond the current debt — the rest becomes credit.)`
    : '';
  return renderPrompt(outcome.expenseId, cents, extra);
}

export async function handleSettleButton(
  i: Interaction,
  env: Env,
  parsed: Extract<ParsedCustomId, { op: 'settle' }>,
): Promise<Response> {
  const clicker = invokerOf(i);
  const record = await getExpense(env.DB, parsed.expenseId);
  if (!record || !record.is_payment) return updateMessage(notice('This settlement no longer exists.'));
  const shares = await getShares(env.DB, parsed.expenseId);
  const debtorId = shares.find((s) => s.paid_cents > 0)?.user_id ?? '';
  const creditorId = shares.find((s) => s.owed_cents > 0)?.user_id ?? '';
  const data: SettlePromptData = {
    expenseId: record.id,
    debtorId,
    creditorId,
    cents: record.total_cents,
    currency: record.currency,
  };
  const now = nowSeconds();

  const renderCurrent = (): Response => {
    if (record.deleted_at !== null) return updateMessage(notice('This settlement was deleted.'));
    if (record.payment_status === 'confirmed') {
      return updateMessage([container([text(settleOutcomeText(data, 'confirmed', creditorId, now))])]);
    }
    if (record.payment_status === 'rejected') {
      return updateMessage([container([text(settleOutcomeText(data, 'rejected', creditorId, now))])]);
    }
    return updateMessage([
      container([text(settlePromptText(data))]),
      row(
        button({ customId: customIds.settle(record.id, true), label: '✓ Confirm received', style: ButtonStyle.Success }),
        button({ customId: customIds.settle(record.id, false), label: '✗ Not received / cancel', style: ButtonStyle.Danger }),
      ),
    ]);
  };

  if (parsed.confirm) {
    if (clicker.id !== creditorId) {
      return ephemeralNotice(`Only ${mention(creditorId)} can confirm this.`);
    }
    const done = await transitionSettlement(env.DB, record.id, 'confirmed', clicker.id, now);
    if (!done) {
      const fresh = await getExpense(env.DB, parsed.expenseId);
      if (fresh) Object.assign(record, fresh);
      return renderCurrent();
    }
    return updateMessage([container([text(settleOutcomeText(data, 'confirmed', clicker.id, now))])]);
  }

  if (clicker.id !== creditorId && clicker.id !== debtorId) {
    return ephemeralNotice(`Only ${mention(creditorId)} or ${mention(debtorId)} can act on this.`);
  }
  const done = await transitionSettlement(env.DB, record.id, 'rejected', clicker.id, now);
  if (!done) {
    const fresh = await getExpense(env.DB, parsed.expenseId);
    if (fresh) Object.assign(record, fresh);
    return renderCurrent();
  }
  return updateMessage([container([text(settleOutcomeText(data, 'rejected', clicker.id, now))])]);
}
