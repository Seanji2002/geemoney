import { container, separator, text } from '../discord/components';
import { formatCents } from '../domain/money';
import type { SettleSuggestion } from '../domain/balance';
import type { ExpenseRecord, ShareRecord } from '../db/expenses';

export function mention(userId: string): string {
  return `<@${userId}>`;
}

export function dateStamp(unixSeconds: number): string {
  return `<t:${unixSeconds}:D>`;
}

/** Plain-text date for autocomplete labels, where markdown does not render. */
export function plainDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function splitMethodLabel(method: string, participantCount: number): string {
  switch (method) {
    case 'equal':
      return `split equally ${participantCount} ways`;
    case 'exact':
      return 'split by exact amounts';
    case 'percent':
      return 'split by percentages';
    case 'shares':
      return 'split by shares';
    default:
      return method;
  }
}

/** A bare one-line notice (ephemeral errors, confirmations). */
export function notice(content: string): unknown[] {
  return [text(content)];
}

export interface ReceiptData {
  id: number;
  description: string;
  totalCents: number;
  currency: string;
  splitMethod: string;
  payerId: string;
  /** Ordered ower rows (owed_cents > 0). */
  owers: { userId: string; owedCents: number }[];
  actorId: string;
  timestamp: number;
  action: 'added' | 'edited';
}

export function receiptView(r: ReceiptData): unknown[] {
  const payerOwes = r.owers.find((o) => o.userId === r.payerId);
  const others = r.owers.filter((o) => o.userId !== r.payerId);
  const oweLines = others
    .map((o) => `${mention(o.userId)} owes ${formatCents(o.owedCents, r.currency)}`)
    .join(' · ');
  const payerNote = payerOwes
    ? `(payer's own share: ${formatCents(payerOwes.owedCents, r.currency)})`
    : "(payer isn't splitting)";
  const lines = [
    `🧾  **#${r.id} · ${r.description} — ${formatCents(r.totalCents, r.currency)}**`,
    `Paid by ${mention(r.payerId)} · ${splitMethodLabel(r.splitMethod, r.owers.length)}`,
    [oweLines, payerNote].filter(Boolean).join('\n'),
    `${r.action === 'added' ? 'Added' : '✏️ Edited'} by ${mention(r.actorId)} · ${dateStamp(r.timestamp)}`,
  ];
  return [container([text(lines.join('\n'))])];
}

export function deleteNoticeView(
  deletedBy: string,
  expense: ExpenseRecord,
  shares: ShareRecord[],
): unknown[] {
  if (expense.is_payment) {
    const debtor = shares.find((s) => s.paid_cents > 0);
    const creditor = shares.find((s) => s.owed_cents > 0);
    return [
      container([
        text(
          `🗑  ${mention(deletedBy)} deleted settlement #${expense.id} — ` +
            `${debtor ? mention(debtor.user_id) : '?'} → ${creditor ? mention(creditor.user_id) : '?'} ` +
            `${formatCents(expense.total_cents, expense.currency)}`,
        ),
      ]),
    ];
  }
  const payer = shares.find((s) => s.paid_cents > 0);
  return [
    container([
      text(
        `🗑  ${mention(deletedBy)} deleted #${expense.id} — ${expense.description} ` +
          `(${formatCents(expense.total_cents, expense.currency)}${payer ? `, paid by ${mention(payer.user_id)}` : ''})`,
      ),
    ]),
  ];
}

export interface BalanceViewData {
  title: string;
  currency: string;
  nets: { userId: string; cents: number }[];
  suggestions: SettleSuggestion[];
  pendingCount: number;
}

export function balanceView(b: BalanceViewData): unknown[] {
  if (b.nets.length === 0) {
    return notice(`💰  **${b.title}**\nNo expenses recorded here yet — start with \`/expense add\`.`);
  }
  const sorted = [...b.nets].sort((x, y) => y.cents - x.cents);
  const netLines = sorted
    .map(({ userId, cents }) => {
      if (cents > 0) return `${mention(userId)}  is owed  **${formatCents(cents, b.currency)}**`;
      if (cents < 0) return `${mention(userId)}  owes  **${formatCents(-cents, b.currency)}**`;
      return `${mention(userId)}  is settled up`;
    })
    .join('\n');
  const children: unknown[] = [text(`💰  **${b.title}**\n${netLines}`)];
  if (b.suggestions.length > 0) {
    const sug = b.suggestions
      .map((s) => `${mention(s.from)} → ${mention(s.to)} ${formatCents(s.cents, b.currency)}`)
      .join(' · ');
    children.push(separator(), text(`Suggested: ${sug}`));
  }
  if (b.pendingCount > 0) {
    children.push(
      text(`⏳ ${b.pendingCount} settlement${b.pendingCount === 1 ? '' : 's'} pending confirmation (not counted)`),
    );
  }
  return [container(children)];
}

export interface PairwiseDetailData {
  invokerId: string;
  otherId: string;
  currency: string;
  /** Positive = invoker owes other; negative = other owes invoker. */
  netCents: number;
  recent: { record: ExpenseRecord; shares: ShareRecord[] }[];
}

export function pairwiseDetailView(d: PairwiseDetailData): unknown[] {
  const headline =
    d.netCents > 0
      ? `You owe ${mention(d.otherId)} **${formatCents(d.netCents, d.currency)}**`
      : d.netCents < 0
        ? `${mention(d.otherId)} owes you **${formatCents(-d.netCents, d.currency)}**`
        : `You and ${mention(d.otherId)} are settled up`;
  const children: unknown[] = [text(`💰  ${headline}`)];
  if (d.recent.length > 0) {
    const lines = d.recent.map(({ record, shares }) => historyLine(record, shares)).join('\n');
    children.push(separator(), text(`Recent between you:\n${lines}`));
  }
  return [container(children)];
}

export function historyLine(e: ExpenseRecord, shares: ShareRecord[]): string {
  if (e.is_payment) {
    const debtor = shares.find((s) => s.paid_cents > 0);
    const creditor = shares.find((s) => s.owed_cents > 0);
    const status = e.payment_status === 'confirmed' ? '✅' : e.payment_status === 'rejected' ? '✗' : '⏳';
    return (
      `#${e.id} · 💸 ${debtor ? mention(debtor.user_id) : '?'} → ${creditor ? mention(creditor.user_id) : '?'} ` +
      `${formatCents(e.total_cents, e.currency)} ${status} · ${dateStamp(e.created_at)}`
    );
  }
  const payer = shares.find((s) => s.paid_cents > 0);
  return (
    `#${e.id} · 🧾 ${e.description} · ${formatCents(e.total_cents, e.currency)}` +
    `${payer ? ` · paid by ${mention(payer.user_id)}` : ''} · ${dateStamp(e.created_at)}`
  );
}

export interface SettlePromptData {
  expenseId: number;
  debtorId: string;
  creditorId: string;
  cents: number;
  currency: string;
}

export function settlePromptText(s: SettlePromptData): string {
  return (
    `💸  ${mention(s.debtorId)} says they paid ${mention(s.creditorId)} **${formatCents(s.cents, s.currency)}**\n` +
    `${mention(s.creditorId)} — tap ✓ to confirm you received it.`
  );
}

export function settleOutcomeText(
  s: SettlePromptData,
  outcome: 'confirmed' | 'rejected',
  actorId: string,
  timestamp: number,
): string {
  if (outcome === 'confirmed') {
    return `✅  ${mention(s.creditorId)} confirmed: ${mention(s.debtorId)} → ${mention(s.creditorId)} ${formatCents(s.cents, s.currency)} · ${dateStamp(timestamp)}`;
  }
  const verb = actorId === s.debtorId ? 'cancelled this settlement' : 'marked this as not received';
  return `✗  ${mention(actorId)} ${verb}: ${mention(s.debtorId)} → ${mention(s.creditorId)} ${formatCents(s.cents, s.currency)} — not counted.`;
}
