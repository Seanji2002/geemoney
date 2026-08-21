import type { Env } from '../../config';
import { MAX_PARTICIPANTS } from '../../config';
import type { Interaction } from '../../discord/types';
import { invokerOf } from '../../discord/types';
import { modal, updateMessage } from '../../discord/responses';
import { buildShares, parseSplitValues, type SplitMethod } from '../../domain/split';
import { cancelPending, getOpenPending, type PendingPayload } from '../../db/pending';
import { botsAmong, ephemeralNotice, ledgerCurrency, nowSeconds, usernameOf } from '../common';
import type { ParsedCustomId } from '../customId';
import { customIds } from '../customId';
import { splitModalComponents, splitModalTitle } from '../forms';
import { notice, pickerView } from '../render';
import { finalizeAdd, type ParsedForm } from './expenseForm';

/**
 * The participant picker: an ephemeral message with a user-select pre-filled
 * from the chat's roster and one-click split buttons. State lives in the
 * pending_actions row; the select edits it, the buttons consume it.
 */
export async function handlePickerComponent(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  parsed: Extract<ParsedCustomId, { op: 'pick' }>,
): Promise<Response> {
  const invoker = invokerOf(i);
  const now = nowSeconds();

  if (parsed.action === 'x') {
    await cancelPending(env.DB, parsed.token);
    return updateMessage(notice('Cancelled — nothing was recorded.'));
  }

  const row = await getOpenPending(env.DB, parsed.token, now);
  if (!row) return updateMessage(notice('This draft expired — run `/expense add` again.'));
  if (row.invoker_id !== invoker.id) return ephemeralNotice('This draft belongs to someone else.');
  const payload = JSON.parse(row.payload) as PendingPayload;
  const currency = await ledgerCurrency(env, row.ledger_id);

  const render = (error?: string): Response =>
    updateMessage(
      pickerView({
        token: parsed.token,
        amountCents: payload.amountCents,
        description: payload.description,
        currency,
        payerId: payload.payerId,
        selected: payload.participants.map((p) => p.id),
        rosterEmpty: false,
        error,
      }),
    );

  if (parsed.action === 'sel') {
    const chosen = [...new Set(i.data?.values ?? [])];
    const bots = botsAmong(i, chosen);
    if (bots.length > 0) return render('Bots can’t take part in an expense — deselect them.');
    payload.participants = chosen.map((id) => ({ id, username: usernameOf(i, id) }));
    await savePayload(env.DB, parsed.token, payload);
    return render();
  }

  // A split button: finalize the participant list (payer auto-included).
  const method = parsed.action as SplitMethod;
  let participantIds = payload.participants.map((p) => p.id);
  if (payload.payerShares !== false && !participantIds.includes(payload.payerId)) {
    participantIds = [...participantIds, payload.payerId];
    payload.participants = [
      ...payload.participants,
      { id: payload.payerId, username: usernameOf(i, payload.payerId) },
    ];
  } else if (payload.payerShares === false) {
    participantIds = participantIds.filter((id) => id !== payload.payerId);
    payload.participants = payload.participants.filter((p) => p.id !== payload.payerId);
  }
  if (participantIds.length === 0 || (participantIds.length === 1 && participantIds[0] === payload.payerId)) {
    return render('Pick at least one other person to share with.');
  }
  if (participantIds.length > MAX_PARTICIPANTS) {
    return render(`Pick at most ${MAX_PARTICIPANTS} people (the payer counts too).`);
  }
  payload.method = method;

  if (method !== 'equal') {
    // Stage-2 values modal; its submit (pnd:<token>:m2) records the expense
    // and updates this picker message.
    await savePayload(env.DB, parsed.token, payload);
    return modal(
      customIds.pending(parsed.token, 'm2'),
      splitModalTitle(method, payload.amountCents, currency),
      splitModalComponents(payload, payload.priorInput),
    );
  }

  const split = parseSplitValues('equal', '', participantIds, payload.amountCents, now, currency);
  if (!split.ok) return render(split.error);
  const shares = buildShares(payload.amountCents, payload.payerId, participantIds, split.owedCents);
  const form: ParsedForm = {
    amountCents: payload.amountCents,
    rawAmount: '',
    description: payload.description,
    method: 'equal',
    participantIds,
    payerId: payload.payerId,
  };
  return finalizeAdd(i, env, ctx, {
    form,
    shares,
    currency,
    ledgerId: row.ledger_id,
    splitInput: JSON.stringify({ participants: payload.participants }),
    timestamp: now,
    via: { token: parsed.token },
  });
}

async function savePayload(db: D1Database, token: string, payload: PendingPayload): Promise<void> {
  await db
    .prepare("UPDATE pending_actions SET payload = ?1 WHERE token = ?2 AND state = 'open'")
    .bind(JSON.stringify(payload), token)
    .run();
}
