import type { Env } from '../config';
import type { Interaction } from '../discord/types';
import { InteractionType } from '../discord/types';
import { ephemeralNotice, optionValue } from './common';
import { parseCustomId } from './customId';
import { handleAutocomplete } from './handlers/autocomplete';
import { maybeShowGuide } from './handlers/hints';
import { handleBalance } from './handlers/balance';
import { handleDeleteButton, handleExpenseDelete } from './handlers/expenseDelete';
import {
  handleAddFromMessage,
  handleExpenseAdd,
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
    case InteractionType.ApplicationCommand: {
      const response = await routeCommand(i, env, ctx);
      ctx.waitUntil(maybeShowGuide(i, env));
      return response;
    }
    case InteractionType.ApplicationCommandAutocomplete:
      return handleAutocomplete(i, env);
    case InteractionType.MessageComponent:
      return routeComponent(i, env, ctx);
    case InteractionType.ModalSubmit:
      return routeModalSubmit(i, env, ctx);
    default:
      return ephemeralNotice('Unsupported interaction.');
  }
}

async function routeCommand(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (i.data?.type === 3 && i.data.name === 'Add as expense') return handleAddFromMessage(i, env);
  switch (i.data?.name) {
    case 'add':
      return handleExpenseAdd(i, env, ctx, i.data?.options ?? []);
    case 'delete':
      return handleExpenseDelete(i, env, String(optionValue(i.data?.options, 'id') ?? ''));
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
