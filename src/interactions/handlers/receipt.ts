import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import type { ParsedCustomId } from '../customId';
import { handleExpenseDelete } from './expenseDelete';
import { openEditModal } from './expenseForm';

/** Edit / Undo buttons on public receipts — shortcuts to the existing flows. */
export async function handleReceiptButton(
  i: Interaction,
  env: Env,
  parsed: Extract<ParsedCustomId, { op: 'receipt' }>,
): Promise<Response> {
  if (parsed.action === 'edit') return openEditModal(i, env, parsed.expenseId);
  // Undo = the normal delete confirmation (ephemeral, so only the clicker decides).
  return handleExpenseDelete(i, env, String(parsed.expenseId));
}
