import { label, radioGroup, textInput, userSelect } from '../discord/components';
import { ComponentType } from '../discord/types';
import { formatCents } from '../domain/money';
import { MAX_PARTICIPANTS } from '../config';
import type { PendingPayload } from '../db/pending';

export interface ExpenseModalPrefill {
  amount?: string;
  description?: string;
  method?: string;
  /** Edit mode relaxes the selects: empty = keep current. */
  isEdit?: boolean;
}

/**
 * The single-modal expense form: exactly 5 top-level components (the modal
 * cap). Select prefill via default_values is unverified for modals as of
 * Aug 2026, so edit mode uses empty-means-keep-current semantics instead.
 */
export function expenseModalComponents(prefill: ExpenseModalPrefill = {}): unknown[] {
  const isEdit = prefill.isEdit ?? false;
  const methods = [
    { label: 'Equal', value: 'equal' },
    { label: 'Exact amounts', value: 'exact' },
    { label: 'Percentages', value: 'percent' },
    { label: 'Shares', value: 'shares' },
  ].map((m) => ({ ...m, default: m.value === (prefill.method ?? 'equal') }));

  return [
    label(
      'Amount',
      textInput({
        customId: 'amount',
        required: true,
        placeholder: '12.50',
        value: prefill.amount,
        maxLength: 12,
      }),
      'The full amount paid — numbers only, up to 2 decimals.',
    ),
    label(
      'Description',
      textInput({
        customId: 'desc',
        required: true,
        placeholder: 'Pizza night',
        value: prefill.description,
        maxLength: 80,
      }),
      'What was it for?',
    ),
    label(
      'Who shares this cost?',
      userSelect({
        customId: 'participants',
        minValues: isEdit ? 0 : 1,
        maxValues: MAX_PARTICIPANTS,
        required: !isEdit,
      }),
      isEdit
        ? 'Leave empty to keep the current participants.'
        : 'Whoever paid is included automatically — no need to pick them.',
    ),
    label(
      'Split method',
      radioGroup('method', methods),
      'Equal divides evenly. The others ask for per-person values in a next step.',
    ),
    label(
      'Paid by',
      userSelect({ customId: 'payer', minValues: 0, maxValues: 1, required: false }),
      isEdit ? 'Leave empty to keep the current payer.' : 'Leave empty if you paid.',
    ),
  ];
}

export function splitModalTitle(method: string, totalCents: number, currency: string): string {
  const name = method === 'exact' ? 'Exact amounts' : method === 'percent' ? 'Percentages' : 'Shares';
  // Modal titles cap at 45 chars.
  return `${name} — total ${formatCents(totalCents, currency)}`.slice(0, 45);
}

export function splitModalComponents(payload: PendingPayload, prefill?: string): unknown[] {
  const order = payload.participants.map((p, idx) => `${idx + 1}. ${p.username}`).join('\n');
  const placeholder =
    payload.method === 'exact' ? '12.50, 10.45, 8.25' : payload.method === 'percent' ? '50, 25, 25' : '2, 1, 1';
  const hint =
    payload.method === 'exact'
      ? 'Amounts in order, comma-separated'
      : payload.method === 'percent'
        ? 'Percentages in order, comma-separated'
        : 'Shares in order, comma-separated';
  return [
    { type: ComponentType.TextDisplay, content: `Enter one value per person, in this order:\n${order}` },
    label(
      hint,
      textInput({
        customId: 'values',
        required: true,
        placeholder,
        value: prefill,
        maxLength: 200,
      }),
    ),
  ];
}
