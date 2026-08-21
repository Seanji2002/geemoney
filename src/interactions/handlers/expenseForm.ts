import type { Env } from '../../config';
import { MAX_PARTICIPANTS } from '../../config';
import type { CommandOptionValue, Interaction } from '../../discord/types';
import { ButtonStyle, ChannelType, invokerOf } from '../../discord/types';
import { button, container, row, text } from '../../discord/components';
import { channelMessage, followUpBody, modal, updateMessage } from '../../discord/responses';
import { discordRest } from '../../discord/rest';
import { formatCents, parseAmount } from '../../domain/money';
import { buildShares, composeValues, parseSplitValues, type ShareRow, type SplitMethod } from '../../domain/split';
import { compareSnowflakes } from '../../domain/split';
import {
  editExpense,
  editExpenseViaPendingClaim,
  getExpense,
  getShares,
  insertExpense,
  insertExpenseViaPendingClaim,
  ledgerMembers,
  liveShareRows,
  type ExpenseEdit,
  type ExpenseInsert,
} from '../../db/expenses';
import { addToRoster, getRoster } from '../../db/roster';
import { computePairwise, settleSuggestions } from '../../domain/balance';
import { groupByExpense } from './balance';
import {
  cancelPending,
  createPending,
  getOpenPending,
  newToken,
  type PendingPayload,
  type PendingRecord,
} from '../../db/pending';
import {
  botsAmong,
  collectModalInputs,
  ephemeralNotice,
  inputString,
  inputValues,
  ledgerCurrency,
  ledgerIdOf,
  nowSeconds,
  optionValue,
  rejectBotDm,
  usernameOf,
} from '../common';
import { customIds, type ParsedCustomId } from '../customId';
import { expenseModalComponents, splitModalComponents, splitModalTitle } from '../forms';
import { notice, pickerView, receiptView } from '../render';

// ---- Slash commands ----

/**
 * /expense add works two ways: fill the slots (amount + description + with)
 * to record straight from the chat bar, or leave them all empty to get the
 * full form. Slot mode identifies participants by parsing @mentions out of
 * the `with` string — their order is the order for `values`.
 *
 * In a 1:1 DM the `with` slot may be omitted: the recorder paid and the DM
 * partner owes the full amount (pass payer_shares: True for a 2-way split
 * instead). The partner comes from the channel's recipients when Discord
 * provides them, else from the ledger's history.
 */
export async function handleExpenseAdd(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  options: CommandOptionValue[],
): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;

  const amountRaw = optionValue(options, 'amount');
  const descriptionRaw = optionValue(options, 'description');
  const withRaw = optionValue(options, 'with');

  if (amountRaw === undefined && descriptionRaw === undefined && withRaw === undefined) {
    return modal(customIds.modAdd(), 'Add expense', expenseModalComponents());
  }

  const isOneOnOneDm = i.channel?.type === ChannelType.DM;
  const missing = [
    amountRaw === undefined ? '`amount`' : null,
    descriptionRaw === undefined ? '`description`' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    return ephemeralNotice(
      `To add straight from chat, also fill ${missing.join(' and ')} — or leave all slots empty to use the form.`,
    );
  }

  const invoker = invokerOf(i);
  const ledgerId = ledgerIdOf(i);
  const amount = parseAmount(String(amountRaw));
  if (!amount.ok) return ephemeralNotice(amount.error);
  const description = String(descriptionRaw).trim().slice(0, 80);
  if (!description) return ephemeralNotice('Enter a description.');

  const payerId = String(optionValue(options, 'paid_by') ?? invoker.id);
  if (i.data?.resolved?.users?.[payerId]?.bot) {
    return ephemeralNotice('Bots can’t take part in an expense.');
  }
  const payerSharesOpt = optionValue(options, 'payer_shares');
  const exceptIds = mentionIds(String(optionValue(options, 'except') ?? ''));

  let participantIds: string[];
  let payerAutoAdded = false;

  if (withRaw === undefined && isOneOnOneDm) {
    // 1:1 DM shorthand: the recorder paid, the DM partner owes it all.
    if (String(optionValue(options, 'split') ?? 'equal') !== 'equal') {
      return ephemeralNotice('Custom splits need the `with` slot — @mention the participants.');
    }
    let otherId = i.channel?.recipients?.find((u) => u.id !== invoker.id && !u.bot)?.id;
    if (!otherId) {
      const others = (await ledgerMembers(env.DB, ledgerId)).filter((id) => id !== invoker.id);
      if (others.length === 1) otherId = others[0];
    }
    if (!otherId) {
      return ephemeralNotice("I can't tell who this DM is with yet — include `with: @them` this once.");
    }
    const owerId = payerId === otherId ? invoker.id : otherId;
    // payer_shares: True turns the IOU into a 2-way split.
    participantIds = payerSharesOpt === true ? [owerId, payerId] : [owerId];
  } else if (withRaw === undefined) {
    // Group chat without `with`: open the picker, pre-filled from the roster,
    // so recording is "two slots + one click".
    const roster = await getRoster(env.DB, ledgerId);
    const defaults = roster.filter((m) => !exceptIds.includes(m.id) && m.id !== env.DISCORD_APP_ID);
    const valuesOpt = optionValue(options, 'values');
    const payload: PendingPayload = {
      amountCents: amount.cents,
      description,
      method: String(optionValue(options, 'split') ?? 'equal'),
      payerId,
      participants: defaults.map((m) => ({ id: m.id, username: m.username })),
      priorInput: valuesOpt === undefined ? undefined : String(valuesOpt),
      payerShares: payerSharesOpt !== false,
    };
    const token = await createPending(env.DB, {
      kind: 'expense_add',
      ledgerId,
      invokerId: invoker.id,
      payload,
      now: nowSeconds(),
    });
    return channelMessage(
      pickerView({
        token,
        amountCents: amount.cents,
        description,
        currency: await ledgerCurrency(env, ledgerId),
        payerId,
        selected: defaults.map((m) => m.id),
        rosterEmpty: roster.length === 0,
      }),
      { ephemeral: true },
    );
  } else {
    participantIds = mentionIds(String(withRaw)).filter((id) => !exceptIds.includes(id));
    if (participantIds.length === 0) {
      return ephemeralNotice('In `with`, @mention the people who share the cost (type @ and pick them).');
    }
    if (participantIds.includes(env.DISCORD_APP_ID)) {
      return ephemeralNotice("geemoney can't take part in an expense — mention only people.");
    }

    // Whoever paid shares the cost by default; payer_shares: False opts out.
    if (payerSharesOpt !== false) {
      if (!participantIds.includes(payerId)) {
        participantIds.push(payerId);
        payerAutoAdded = true;
      }
    } else if (participantIds.includes(payerId)) {
      return ephemeralNotice(
        'You set `payer_shares: False` but @mentioned the payer in `with` — drop one of the two.',
      );
    }
    if (participantIds.length > MAX_PARTICIPANTS) {
      return ephemeralNotice(`Pick at most ${MAX_PARTICIPANTS} people (the payer counts too).`);
    }
    if (participantIds.length === 1 && participantIds[0] === payerId) {
      return ephemeralNotice("That's just you — nothing to split.");
    }
  }

  const method = (['equal', 'exact', 'percent', 'shares'] as const).find(
    (m) => m === String(optionValue(options, 'split') ?? 'equal'),
  );
  if (!method) return ephemeralNotice('Pick a valid split method.');
  const valuesRaw = optionValue(options, 'values');
  if (method !== 'equal' && valuesRaw === undefined) {
    return ephemeralNotice(
      `A ${method} split needs the \`values\` slot too — one value per person, comma-separated, in the order you @mentioned them.`,
    );
  }

  const now = nowSeconds();
  const currency = await ledgerCurrency(env, ledgerId);
  const split = parseSplitValues(method, String(valuesRaw ?? ''), participantIds, amount.cents, now, currency);
  if (!split.ok) {
    const hint = payerAutoAdded && method !== 'equal' ? ' (whoever paid counts too — their value goes last)' : '';
    return ephemeralNotice(split.error + hint);
  }
  const shares = buildShares(amount.cents, payerId, participantIds, split.owedCents);

  const participantsWithNames = participantIds.map((id) => ({ id, username: usernameOf(i, id) }));
  const splitInput = JSON.stringify(
    method === 'equal'
      ? { participants: participantsWithNames }
      : { values: String(valuesRaw), participants: participantsWithNames },
  );
  const form: ParsedForm = {
    amountCents: amount.cents,
    rawAmount: '',
    description,
    method,
    participantIds,
    payerId,
  };
  return finalizeAdd(i, env, ctx, {
    form,
    shares,
    currency,
    ledgerId,
    splitInput,
    timestamp: now,
    via: null,
  });
}

export async function handleExpenseEdit(i: Interaction, env: Env, idRaw: string): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;
  const expenseId = Number(idRaw);
  if (!Number.isInteger(expenseId) || expenseId < 1) {
    return ephemeralNotice('Pick an expense from the suggestions.');
  }
  return openEditModal(i, env, expenseId);
}

/** The prefilled edit modal — reached from /expense edit or a receipt's Edit button. */
export async function openEditModal(i: Interaction, env: Env, expenseId: number): Promise<Response> {
  const record = await getExpense(env.DB, expenseId);
  if (!record || record.deleted_at !== null) return ephemeralNotice('That expense no longer exists.');
  if (record.ledger_id !== ledgerIdOf(i)) return ephemeralNotice('That expense belongs to a different chat.');
  if (record.is_payment) {
    return ephemeralNotice('Settlements can’t be edited — delete it with `/expense delete` and settle again.');
  }
  return modal(
    customIds.modEdit(record.id, record.revision),
    `Edit expense #${record.id}`.slice(0, 45),
    expenseModalComponents({
      amount: (record.total_cents / 100).toFixed(2),
      description: record.description,
      method: record.split_method,
      isEdit: true,
    }),
  );
}

// ---- The expense form modal submit (add and edit) ----

/** Parses `<@id>` / `<@!id>` mentions out of a free-text slot, deduplicated, in order. */
function mentionIds(raw: string): string[] {
  return [...new Set([...raw.matchAll(/<@!?(\d{17,20})>/g)].map((m) => m[1]!))];
}

export interface ParsedForm {
  amountCents: number;
  rawAmount: string;
  description: string;
  method: SplitMethod;
  participantIds: string[];
  payerId: string;
}

type FormParse = { ok: true; form: ParsedForm } | { ok: false; error: string; raw: RawForm };

interface RawForm {
  rawAmount: string;
  description: string;
  method: string;
}

function parseExpenseForm(
  i: Interaction,
  fallback: { participantIds: string[]; payerId: string } | null,
): FormParse {
  const inputs = collectModalInputs(i.data?.components ?? []);
  const rawAmount = inputString(inputs, 'amount');
  const description = inputString(inputs, 'desc');
  const methodRaw = inputString(inputs, 'method') || 'equal';
  const raw: RawForm = { rawAmount, description, method: methodRaw };
  const fail = (error: string): FormParse => ({ ok: false, error, raw });

  const method = (['equal', 'exact', 'percent', 'shares'] as const).find((m) => m === methodRaw);
  if (!method) return fail('Pick a split method.');

  const amount = parseAmount(rawAmount);
  if (!amount.ok) return fail(amount.error);
  if (!description) return fail('Enter a description.');

  let participantIds = inputValues(inputs, 'participants');
  const payerSelected = inputValues(inputs, 'payer');
  let payerId = payerSelected[0] ?? '';
  let fromSelect = true;
  if (participantIds.length === 0) {
    if (!fallback) return fail('Pick who shares this cost.');
    // Kept-current participants (edit): preserve the stored ower set as-is,
    // including a payer who wasn't splitting.
    participantIds = fallback.participantIds;
    fromSelect = false;
  }
  if (!payerId) payerId = fallback?.payerId ?? invokerOf(i).id;

  participantIds = [...new Set(participantIds)];
  // Whoever paid shares the cost — auto-included when picking fresh.
  // (The "paid but not splitting" case is the payer_shares slot on /expense add.)
  if (fromSelect && !participantIds.includes(payerId)) participantIds.push(payerId);
  if (participantIds.length < 1 || participantIds.length > MAX_PARTICIPANTS) {
    return fail(`Pick between 1 and ${MAX_PARTICIPANTS} people (the payer counts too).`);
  }
  const bots = botsAmong(i, [...participantIds, payerId]);
  if (bots.length > 0) return fail('Bots can’t take part in an expense — deselect them.');
  if (participantIds.length === 1 && participantIds[0] === payerId) {
    return fail("That's just you — nothing to split.");
  }
  return {
    ok: true,
    form: { amountCents: amount.cents, rawAmount, description, method, participantIds, payerId },
  };
}

function pendingPrompt(token: string, payload: PendingPayload, currency: string, error?: string): unknown[] {
  const methodName =
    payload.method === 'exact' ? 'exact amounts' : payload.method === 'percent' ? 'percentages' : 'shares';
  const headline = `${formatCents(payload.amountCents, currency)} — ${payload.description}, ${methodName} for ${payload.participants.length} people.`;
  const body = error ? `⚠️ ${error}` : `Enter each person's ${payload.method === 'exact' ? 'amount' : 'value'} next.`;
  return [
    container([text(`${headline}\n${body}`)]),
    row(
      button({ customId: customIds.pending(token, 'go'), label: 'Enter values', style: ButtonStyle.Primary }),
      button({ customId: customIds.pending(token, 'x'), label: 'Cancel', style: ButtonStyle.Secondary }),
    ),
  ];
}

function retryPrompt(token: string, error: string): unknown[] {
  return [
    container([text(`⚠️ ${error}`)]),
    row(
      button({ customId: customIds.pending(token, 'rt'), label: 'Edit & retry', style: ButtonStyle.Primary }),
      button({ customId: customIds.pending(token, 'x'), label: 'Cancel', style: ButtonStyle.Secondary }),
    ),
  ];
}

async function respondFormError(
  i: Interaction,
  env: Env,
  parse: { error: string; raw: RawForm },
  edit: { expenseId: number; baseRevision: number } | null,
): Promise<Response> {
  const token = await createPending(env.DB, {
    kind: edit ? 'retry_edit' : 'retry_add',
    ledgerId: ledgerIdOf(i),
    invokerId: invokerOf(i).id,
    payload: {
      amountCents: 0,
      description: parse.raw.description,
      method: parse.raw.method,
      payerId: '',
      participants: [],
      priorInput: parse.raw.rawAmount,
    },
    now: nowSeconds(),
    expenseId: edit?.expenseId,
    baseRevision: edit?.baseRevision,
  });
  return channelMessage(retryPrompt(token, parse.error), { ephemeral: true });
}

export async function handleExpenseFormSubmit(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  parsed: Extract<ParsedCustomId, { op: 'modAdd' } | { op: 'modEdit' }>,
): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;
  const invoker = invokerOf(i);
  const ledgerId = ledgerIdOf(i);
  const now = nowSeconds();

  // This submission consumes the retry draft that reopened the modal (if any).
  if (parsed.retryToken) await cancelPending(env.DB, parsed.retryToken);

  const isEdit = parsed.op === 'modEdit';
  let record = null;
  const storedNames = new Map<string, string>();
  let fallback: { participantIds: string[]; payerId: string } | null = null;
  if (isEdit) {
    record = await getExpense(env.DB, parsed.expenseId);
    if (!record || record.deleted_at !== null || record.is_payment) {
      return ephemeralNotice('That expense no longer exists.');
    }
    const shares = await getShares(env.DB, parsed.expenseId);
    const currentOwers = shares.filter((s) => s.owed_cents > 0).map((s) => s.user_id);
    const stored = parseStoredSplitInput(record.split_input);
    // Positional split values were entered against the ORIGINAL selection
    // order, so "keep current participants" must reuse that stored order —
    // re-sorting would silently reassign amounts between people.
    const storedIds = stored?.participants?.map((p) => p.id) ?? [];
    const orderStillValid =
      storedIds.length === currentOwers.length &&
      [...storedIds].sort().join(',') === [...currentOwers].sort().join(',');
    if (stored?.participants && orderStillValid) {
      for (const p of stored.participants) storedNames.set(p.id, p.username);
    }
    fallback = {
      participantIds: orderStillValid ? storedIds : [...currentOwers].sort(compareSnowflakes),
      payerId: shares.find((s) => s.paid_cents > 0)?.user_id ?? invoker.id,
    };
  }

  const editRef = isEdit && parsed.op === 'modEdit'
    ? { expenseId: parsed.expenseId, baseRevision: parsed.baseRevision }
    : null;
  const parse = parseExpenseForm(i, fallback);
  if (!parse.ok) {
    return respondFormError(i, env, parse, editRef);
  }
  const form = parse.form;
  const currency = record?.currency ?? (await ledgerCurrency(env, ledgerId));
  const participantsWithNames = form.participantIds.map((id) => ({
    id,
    username: usernameOf(i, id, storedNames.get(id)),
  }));

  if (form.method === 'equal') {
    const timestamp = record?.created_at ?? now;
    const split = parseSplitValues('equal', '', form.participantIds, form.amountCents, timestamp, currency);
    if (!split.ok) {
      return respondFormError(
        i,
        env,
        {
          error: split.error,
          raw: { rawAmount: form.rawAmount, description: form.description, method: form.method },
        },
        editRef,
      );
    }
    const shares = buildShares(form.amountCents, form.payerId, form.participantIds, split.owedCents);
    const splitInput = JSON.stringify({ participants: participantsWithNames });
    return isEdit && record
      ? finalizeEdit(i, env, ctx, {
          record: { id: record.id, createdAt: record.created_at },
          baseRevision: editRef?.baseRevision ?? record.revision,
          form,
          shares,
          currency,
          splitInput,
          via: null,
        })
      : finalizeAdd(i, env, ctx, { form, shares, currency, ledgerId, splitInput, timestamp: now, via: null });
  }

  // Exact / percent / shares need the stage-2 values modal.
  const payload: PendingPayload = {
    amountCents: form.amountCents,
    description: form.description,
    method: form.method,
    payerId: form.payerId,
    participants: participantsWithNames,
    priorInput:
      isEdit && record?.split_method === form.method
        ? parseStoredSplitInput(record.split_input)?.values
        : undefined,
  };
  const token = await createPending(env.DB, {
    kind: isEdit ? 'expense_edit' : 'expense_add',
    ledgerId,
    invokerId: invoker.id,
    payload,
    now,
    expenseId: isEdit ? parsed.expenseId : undefined,
    baseRevision: editRef?.baseRevision,
  });
  return channelMessage(pendingPrompt(token, payload, currency), { ephemeral: true });
}

/**
 * split_input JSON stored on every expense: the ordered participant list
 * (with display names for stage-2 modals) plus, for exact/percent/shares,
 * the raw values string for edit prefill.
 */
interface StoredSplitInput {
  values?: string;
  participants?: { id: string; username: string }[];
}

function parseStoredSplitInput(splitInput: string | null): StoredSplitInput | null {
  if (!splitInput) return null;
  try {
    return JSON.parse(splitInput) as StoredSplitInput;
  } catch {
    return null;
  }
}

// ---- Finalizers (shared by the equal path and the stage-2 path) ----

interface AddArgs {
  form: ParsedForm;
  shares: ShareRow[];
  currency: string;
  ledgerId: string;
  splitInput: string | null;
  /**
   * The unix-seconds moment the shares were allocated against. Stored as
   * created_at so a later no-change edit reproduces identical shares.
   */
  timestamp: number;
  /** Set when arriving via a pending claim (stage-2 modal). */
  via: { token: string } | null;
}

export async function finalizeAdd(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  args: AddArgs,
): Promise<Response> {
  const now = args.timestamp;
  const invoker = invokerOf(i);
  const ins: ExpenseInsert = {
    interactionId: i.id,
    ledgerId: args.ledgerId,
    currency: args.currency,
    description: args.form.description,
    totalCents: args.form.amountCents,
    isPayment: false,
    splitMethod: args.form.method,
    splitInput: args.splitInput,
    createdBy: invoker.id,
    createdAt: now,
    shares: args.shares,
  };
  const outcome = args.via
    ? await insertExpenseViaPendingClaim(env.DB, args.via.token, now, ins)
    : await insertExpense(env.DB, ins);

  if (outcome.status === 'duplicate') {
    return args.via ? updateMessage(notice('Already recorded.')) : ephemeralNotice('Already recorded.');
  }
  if (outcome.status === 'not_claimed') {
    return updateMessage(notice('This draft was already used or expired — run `/expense add` again.'));
  }

  const balancesNow = await balancesAfterWrite(env, args.ledgerId);
  await seedRoster(env, i, args.ledgerId, args.form, args.splitInput, now);
  const receipt = receiptView({
    balancesNow,
    id: outcome.expenseId,
    description: args.form.description,
    totalCents: args.form.amountCents,
    currency: args.currency,
    splitMethod: args.form.method,
    payerId: args.form.payerId,
    owers: args.shares
      .filter((s) => s.owedCents > 0)
      .map((s) => ({ userId: s.userId, owedCents: s.owedCents })),
    actorId: invoker.id,
    timestamp: now,
    action: 'added',
  });

  if (args.via) {
    // Stage-2 submit: update the ephemeral prompt, then post the public receipt.
    ctx.waitUntil(discordRest.postFollowUp(env.DISCORD_APP_ID, i.token, followUpBody(receipt)));
    return updateMessage(notice('Recorded ✅ — receipt posted to the chat.'));
  }
  return channelMessage(receipt);
}

interface EditArgs {
  record: { id: number; createdAt: number };
  baseRevision: number;
  form: ParsedForm;
  shares: ShareRow[];
  currency: string;
  splitInput: string | null;
  via: { token: string } | null;
}

async function finalizeEdit(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  args: EditArgs,
): Promise<Response> {
  const now = nowSeconds();
  const invoker = invokerOf(i);
  const edit: ExpenseEdit = {
    expenseId: args.record.id,
    baseRevision: args.baseRevision,
    editToken: newToken(),
    description: args.form.description,
    totalCents: args.form.amountCents,
    splitMethod: args.form.method,
    splitInput: args.splitInput,
    updatedBy: invoker.id,
    updatedAt: now,
    shares: args.shares,
  };
  const outcome = args.via
    ? await editExpenseViaPendingClaim(env.DB, args.via.token, now, edit)
    : await editExpense(env.DB, edit);

  if (outcome === 'not_claimed') {
    return updateMessage(notice('This draft was already used or expired — run `/expense edit` again.'));
  }
  if (outcome === 'conflict') {
    const msg = 'This expense changed since you opened the editor — run `/expense edit` again.';
    return args.via ? updateMessage(notice(msg)) : ephemeralNotice(msg);
  }

  const balancesNow = await balancesAfterWrite(env, ledgerIdOf(i));
  await seedRoster(env, i, ledgerIdOf(i), args.form, args.splitInput, now);
  const receipt = receiptView({
    balancesNow,
    id: args.record.id,
    description: args.form.description,
    totalCents: args.form.amountCents,
    currency: args.currency,
    splitMethod: args.form.method,
    payerId: args.form.payerId,
    owers: args.shares
      .filter((s) => s.owedCents > 0)
      .map((s) => ({ userId: s.userId, owedCents: s.owedCents })),
    actorId: invoker.id,
    timestamp: now,
    action: 'edited',
  });
  if (args.via) {
    ctx.waitUntil(discordRest.postFollowUp(env.DISCORD_APP_ID, i.token, followUpBody(receipt)));
    return updateMessage(notice('Updated ✅ — new receipt posted to the chat.'));
  }
  return channelMessage(receipt);
}

// ---- Pending buttons (go / cancel / retry) and the stage-2 modal ----

export async function handlePendingButton(
  i: Interaction,
  env: Env,
  parsed: Extract<ParsedCustomId, { op: 'pending' }>,
): Promise<Response> {
  const invoker = invokerOf(i);

  if (parsed.action === 'x') {
    await cancelPending(env.DB, parsed.token);
    return updateMessage(notice('Cancelled — nothing was recorded.'));
  }

  const row = await getOpenPending(env.DB, parsed.token, nowSeconds());
  if (!row) {
    return updateMessage(notice('This draft expired — run `/expense add` again.'));
  }
  if (row.invoker_id !== invoker.id) {
    return ephemeralNotice('This draft belongs to someone else.');
  }
  const payload = JSON.parse(row.payload) as PendingPayload;

  if (parsed.action === 'go') {
    const currency = await ledgerCurrency(env, row.ledger_id);
    return modal(
      customIds.pending(parsed.token, 'm2'),
      splitModalTitle(payload.method, payload.amountCents, currency),
      splitModalComponents(payload, payload.priorInput),
    );
  }

  // 'rt' — reopen the prefilled expense form after a validation error. The
  // reopened modal carries the draft token so its submit consumes the draft.
  const prefill = {
    amount: payload.priorInput,
    description: payload.description,
    method: payload.method,
    isEdit: row.kind === 'retry_edit',
  };
  if (row.kind === 'retry_edit' && row.expense_id !== null && row.base_revision !== null) {
    return modal(
      customIds.modEdit(row.expense_id, row.base_revision, parsed.token),
      `Edit expense #${row.expense_id}`.slice(0, 45),
      expenseModalComponents(prefill),
    );
  }
  return modal(customIds.modAdd(parsed.token), 'Add expense', expenseModalComponents({ ...prefill, isEdit: false }));
}

export async function handleSplitModalSubmit(
  i: Interaction,
  env: Env,
  ctx: ExecutionContext,
  parsed: Extract<ParsedCustomId, { op: 'pending' }>,
): Promise<Response> {
  const invoker = invokerOf(i);
  const now = nowSeconds();
  const row = await getOpenPending(env.DB, parsed.token, now);
  if (!row) return updateMessage(notice('This draft was already used or expired — run `/expense add` again.'));
  if (row.invoker_id !== invoker.id) return ephemeralNotice('This draft belongs to someone else.');

  const payload = JSON.parse(row.payload) as PendingPayload;
  const inputs = collectModalInputs(i.data?.components ?? []);
  const currency = await ledgerCurrency(env, row.ledger_id);
  let raw: string;
  if (inputs.has('values')) {
    raw = inputString(inputs, 'values');
  } else {
    // One box per person (<= 5 participants): compose the comma list.
    const cells = payload.participants.map((_, idx) => inputString(inputs, `v:${idx}`));
    const composed = composeValues(payload.method as SplitMethod, cells, payload.amountCents);
    if (!composed.ok) {
      await savePriorInput(env.DB, parsed.token, payload, cells.join(', '));
      return updateMessage(pendingPrompt(parsed.token, payload, currency, composed.error));
    }
    raw = composed.raw;
  }

  const isEdit = row.kind === 'expense_edit';
  let createdAt = now;
  let record = null;
  if (isEdit) {
    if (row.expense_id === null || row.base_revision === null) {
      return updateMessage(notice('This draft is corrupted — run `/expense edit` again.'));
    }
    record = await getExpense(env.DB, row.expense_id);
    if (!record || record.deleted_at !== null) {
      return updateMessage(notice('That expense no longer exists.'));
    }
    createdAt = record.created_at;
  }

  const participantIds = payload.participants.map((p) => p.id);
  const split = parseSplitValues(
    payload.method as SplitMethod,
    raw,
    participantIds,
    payload.amountCents,
    createdAt,
    currency,
  );
  if (!split.ok) {
    // Remember what they typed so reopening the modal prefills it.
    await savePriorInput(env.DB, parsed.token, payload, raw);
    return updateMessage(pendingPrompt(parsed.token, payload, currency, split.error));
  }

  const shares = buildShares(payload.amountCents, payload.payerId, participantIds, split.owedCents);
  const form: ParsedForm = {
    amountCents: payload.amountCents,
    rawAmount: '',
    description: payload.description,
    method: payload.method as SplitMethod,
    participantIds,
    payerId: payload.payerId,
  };
  const splitInput = JSON.stringify({ values: raw, participants: payload.participants });

  if (isEdit && record) {
    return finalizeEdit(i, env, ctx, {
      record: { id: record.id, createdAt },
      baseRevision: row.base_revision!,
      form,
      shares,
      currency,
      splitInput,
      via: { token: parsed.token },
    });
  }
  return finalizeAdd(i, env, ctx, {
    form,
    shares,
    currency,
    ledgerId: row.ledger_id,
    splitInput,
    timestamp: now,
    via: { token: parsed.token },
  });
}

/** Pairwise "who owes whom" after a write, for the receipt footer. */
async function balancesAfterWrite(env: Env, ledgerId: string) {
  const rows = await liveShareRows(env.DB, ledgerId);
  return settleSuggestions(computePairwise(groupByExpense(rows)));
}

/** Every recorded expense teaches the chat's roster who "everyone" is. */
async function seedRoster(
  env: Env,
  i: Interaction,
  ledgerId: string,
  form: ParsedForm,
  splitInput: string | null,
  now: number,
): Promise<void> {
  const stored = parseStoredSplitInput(splitInput)?.participants ?? [];
  const names = new Map(stored.map((p) => [p.id, p.username]));
  const ids = [...new Set([...form.participantIds, form.payerId])];
  await addToRoster(
    env.DB,
    ledgerId,
    ids.map((id) => ({ id, username: usernameOf(i, id, names.get(id)) })),
    now,
  );
}

async function savePriorInput(
  db: D1Database,
  token: string,
  payload: PendingPayload,
  raw: string,
): Promise<void> {
  const updated: PendingPayload = { ...payload, priorInput: raw };
  await db
    .prepare("UPDATE pending_actions SET payload = ?1 WHERE token = ?2 AND state = 'open'")
    .bind(JSON.stringify(updated), token)
    .run();
}
