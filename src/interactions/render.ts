import { MAX_PARTICIPANTS } from '../config';
import { button, container, messageUserSelect, row, separator, text } from '../discord/components';
import { ButtonStyle } from '../discord/types';
import { formatCents } from '../domain/money';
import type { SettleSuggestion } from '../domain/balance';
import type { ExpenseRecord, ShareRecord } from '../db/expenses';
import { customIds } from './customId';

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
  /** Current pairwise state of the ledger after this change. */
  balancesNow?: SettleSuggestion[];
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
  const children: unknown[] = [text(lines.join('\n'))];
  if (r.balancesNow) {
    const now =
      r.balancesNow.length === 0
        ? 'Now: everyone is settled up.'
        : `Now: ${r.balancesNow
            .slice(0, 6)
            .map((s) => `${mention(s.from)} → ${mention(s.to)} ${formatCents(s.cents, r.currency)}`)
            .join(' · ')}${r.balancesNow.length > 6 ? ' · …' : ''}`;
    children.push(separator(), text(now));
  }
  return [
    container(children),
    row(
      button({ customId: customIds.receipt(r.id, 'edit'), label: 'Edit' }),
      button({ customId: customIds.receipt(r.id, 'undo'), label: 'Undo' }),
    ),
  ];
}

export interface PickerData {
  token: string;
  amountCents: number;
  description: string;
  currency: string;
  payerId: string;
  selected: string[];
  rosterEmpty: boolean;
  error?: string;
}

/** Ephemeral participant picker: pre-filled user select + one-click split buttons. */
export function pickerView(d: PickerData): unknown[] {
  const who =
    d.selected.length === 0
      ? d.rosterEmpty
        ? 'Pick who shares it — your choice becomes this chat’s roster for next time.'
        : 'Pick who shares it.'
      : `Sharing: ${d.selected.map(mention).join(' ')}${d.selected.includes(d.payerId) ? '' : ` (+ ${mention(d.payerId)} as payer)`}`;
  const lines = [
    `🧾  **${formatCents(d.amountCents, d.currency)} — ${d.description}** · paid by ${mention(d.payerId)}`,
    who,
    d.error ? `⚠️ ${d.error}` : 'Adjust the list if needed, then choose how to split.',
  ];
  return [
    container([text(lines.join('\n'))]),
    row(
      messageUserSelect({
        customId: customIds.pick(d.token, 'sel'),
        minValues: 0,
        maxValues: MAX_PARTICIPANTS,
        placeholder: 'Who shares this cost?',
        defaultUserIds: d.selected,
      }),
    ),
    row(
      button({ customId: customIds.pick(d.token, 'equal'), label: 'Split equally', style: ButtonStyle.Primary }),
      button({ customId: customIds.pick(d.token, 'exact'), label: 'Exact amounts' }),
      button({ customId: customIds.pick(d.token, 'percent'), label: 'Percentages' }),
      button({ customId: customIds.pick(d.token, 'shares'), label: 'Shares' }),
      button({ customId: customIds.pick(d.token, 'x'), label: 'Cancel' }),
    ),
  ];
}

export function rosterView(members: string[], saved: boolean): string {
  const list = members.length === 0 ? 'Nobody yet.' : members.map(mention).join(' ');
  return `${saved ? '✅ Roster saved' : '👥  **This chat’s roster**'}\n${list}\n${
    saved ? '' : 'This is who `/expense add` splits with when you don’t say otherwise. Change it below.'
  }`.trim();
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

export interface PayButton {
  fromId: string;
  toId: string;
  cents: number;
  /** Plain-text name for the button label (mentions don't render there). */
  toName: string;
}

export function payButtonsRow(buttons: PayButton[], currency: string): unknown[] {
  if (buttons.length === 0) return [];
  return [
    row(
      ...buttons.slice(0, 5).map((b) =>
        button({
          customId: customIds.settleButton(b.fromId, b.toId, b.cents),
          label: `Pay ${b.toName} ${formatCents(b.cents, currency)}`.slice(0, 80),
          style: ButtonStyle.Success,
        }),
      ),
    ),
  ];
}

export interface BalanceViewData {
  title: string;
  currency: string;
  nets: { userId: string; cents: number }[];
  suggestions: SettleSuggestion[];
  pendingCount: number;
  /** One-tap settle buttons for the viewer's own debts. */
  payButtons?: PayButton[];
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
  return [container(children), ...payButtonsRow(b.payButtons ?? [], b.currency)];
}

export interface PairwiseDetailData {
  invokerId: string;
  otherId: string;
  currency: string;
  /** Positive = invoker owes other; negative = other owes invoker. */
  netCents: number;
  recent: { record: ExpenseRecord; shares: ShareRecord[] }[];
  payButton?: PayButton;
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
  return [container(children), ...payButtonsRow(d.payButton ? [d.payButton] : [], d.currency)];
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
