import type { Env } from '../config';
import type { Interaction } from '../discord/types';
import { InteractionType } from '../discord/types';
import { ephemeralNotice, optionValue, subcommandOf } from './common';
import { parseCustomId } from './customId';
import { handleExpenseAutocomplete } from './handlers/autocomplete';
import { handleBalance } from './handlers/balance';
import { handleDeleteButton, handleExpenseDelete } from './handlers/expenseDelete';
import {
  handleExpenseAdd,
  handleExpenseEdit,
  handleExpenseFormSubmit,
  handlePendingButton,
  handleSplitModalSubmit,
} from './handlers/expenseForm';
import { handleHelp } from './handlers/help';
import { handleHistory, handleHistoryButton } from './handlers/history';
import { handlePickerComponent } from './handlers/picker';
import { handleRoster, handleRosterSelect } from './handlers/roster';
import { handleReceiptButton } from './handlers/receipt';
import { handleSettle, handleSettleButton, handleSettleShortcut } from './handlers/settle';

export async function routeInteraction(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  switch (i.type) {
    case InteractionType.ApplicationCommand:
      return routeCommand(i, env, ctx);
    case InteractionType.ApplicationCommandAutocomplete:
      return handleExpenseAutocomplete(i, env);
    case InteractionType.MessageComponent:
      return routeComponent(i, env, ctx);
    case InteractionType.ModalSubmit:
      return routeModalSubmit(i, env, ctx);
    default:
      return ephemeralNotice('Unsupported interaction.');
  }
}

async function routeCommand(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  switch (i.data?.name) {
    case 'expense': {
      const sub = subcommandOf(i);
      if (sub?.name === 'add') return handleExpenseAdd(i, env, ctx, sub.options);
      if (sub?.name === 'edit') return handleExpenseEdit(i, env, String(optionValue(sub.options, 'id') ?? ''));
      if (sub?.name === 'delete') return handleExpenseDelete(i, env, String(optionValue(sub.options, 'id') ?? ''));
      return ephemeralNotice('Unknown subcommand.');
    }
    case 'add':
      return handleExpenseAdd(i, env, ctx, i.data?.options ?? []);
    case 'balance':
      return handleBalance(i, env);
    case 'settle':
      return handleSettle(i, env);
    case 'history':
      return handleHistory(i, env);
    case 'roster':
      return handleRoster(i, env);
    case 'help':
      return handleHelp();
    default:
      return ephemeralNotice('Unknown command.');
  }
}

async function routeComponent(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parsed = parseCustomId(i.data?.custom_id ?? '');
  if (!parsed) return ephemeralNotice('This button is no longer supported.');
  switch (parsed.op) {
    case 'pending':
      return handlePendingButton(i, env, parsed);
    case 'delete':
      return handleDeleteButton(i, env, ctx, parsed);
    case 'settle':
      return handleSettleButton(i, env, parsed);
    case 'history':
      return handleHistoryButton(i, env, parsed);
    case 'pick':
      return handlePickerComponent(i, env, ctx, parsed);
    case 'roster':
      return handleRosterSelect(i, env);
    case 'settleButton':
      return handleSettleShortcut(i, env, parsed);
    case 'receipt':
      return handleReceiptButton(i, env, parsed);
    default:
      return ephemeralNotice('This button is no longer supported.');
  }
}

async function routeModalSubmit(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parsed = parseCustomId(i.data?.custom_id ?? '');
  if (!parsed) return ephemeralNotice('This form is no longer supported.');
  if (parsed.op === 'modAdd' || parsed.op === 'modEdit') {
    return handleExpenseFormSubmit(i, env, ctx, parsed);
  }
  if (parsed.op === 'pending' && parsed.action === 'm2') {
    return handleSplitModalSubmit(i, env, ctx, parsed);
  }
  return ephemeralNotice('This form is no longer supported.');
}
