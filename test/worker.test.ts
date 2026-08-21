import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { discordRest } from '../src/discord/rest';
import {
  ALICE,
  BOB,
  CARA,
  CHANNEL,
  EPHEMERAL,
  autocompleteFor,
  click,
  customIdsIn,
  expenseModalSubmit,
  ping,
  resolvedUsers,
  send,
  signedRequest,
  slash,
  perPersonModalSubmit,
  splitModalSubmit,
  testKeys,
  textIn,
} from './helpers';

// Follow-up posts are outbound REST calls — stubbed at the network seam so
// tests can assert the public receipt without hitting discord.com.
const followUps = vi.spyOn(discordRest, 'postFollowUp').mockResolvedValue(undefined);

beforeEach(() => {
  followUps.mockClear();
});

/** Public (non-ephemeral) follow-up bodies — receipts and notices, not hints. */
function publicFollowUps(): unknown[] {
  return followUps.mock.calls.filter((c) => ((c[2] as any).flags & EPHEMERAL) === 0).map((c) => c[2]);
}

async function expenseRows() {
  const { results } = await env.DB.prepare('SELECT * FROM expenses ORDER BY id').all();
  return results as any[];
}

async function shareRows(expenseId: number) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM expense_shares WHERE expense_id = ?1 ORDER BY user_id',
  )
    .bind(expenseId)
    .all();
  return results as any[];
}

/** Records a $30 dinner paid by Alice, split equally with Bob and Cara. */
async function recordDinner() {
  const submit = expenseModalSubmit(
    'mod:add',
    {
      amount: '30.00',
      desc: 'Dinner',
      participants: [ALICE.id, BOB.id, CARA.id],
      method: 'equal',
    },
    { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
  );
  const res = await send(submit);
  expect(res.body.type).toBe(4);
  const rows = await expenseRows();
  return rows[rows.length - 1].id as number;
}

describe('request handling', () => {
  it('answers GET with a health line', async () => {
    const { publicKeyHex } = await testKeys();
    const res = await worker.fetch(
      new Request('https://bot.example/'),
      { ...env, DISCORD_PUBLIC_KEY: publicKeyHex },
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    );
    expect(await res.text()).toBe('geemoney ok');
  });

  it('rejects unsigned and tampered requests with 401', async () => {
    const { publicKeyHex } = await testKeys();
    const testEnv = { ...env, DISCORD_PUBLIC_KEY: publicKeyHex };
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

    const unsigned = new Request('https://bot.example/', { method: 'POST', body: '{}' });
    expect((await worker.fetch(unsigned, testEnv, ctx)).status).toBe(401);

    const tampered = await signedRequest(JSON.stringify(ping()), true);
    expect((await worker.fetch(tampered, testEnv, ctx)).status).toBe(401);
  });

  it('answers a signed PING with PONG', async () => {
    const res = await send(ping());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 1 });
  });
});

describe('/expense add', () => {
  it('responds to the slash command with the 5-component modal', async () => {
    const res = await send(slash('expense', { sub: 'add', user: ALICE }));
    expect(res.body.type).toBe(9);
    expect(res.body.data.custom_id).toBe('mod:add');
    const components = res.body.data.components;
    expect(components).toHaveLength(5);
    const types = components.map((c: any) => c.component?.type);
    expect(types).toEqual([4, 4, 5, 21, 5]);
  });

  it('equal split writes the expense atomically and posts a public receipt', async () => {
    const submit = expenseModalSubmit(
      'mod:add',
      { amount: '10.00', desc: 'Pizza', participants: [ALICE.id, BOB.id, CARA.id], method: 'equal' },
      { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
    );
    const res = await send(submit);
    expect(res.body.type).toBe(4);
    expect(res.body.data.flags & EPHEMERAL).toBe(0);
    expect(textIn(res.body.data.components)).toContain('Pizza');

    const [expense] = await expenseRows();
    expect(expense.total_cents).toBe(1000);
    expect(expense.split_method).toBe('equal');
    const shares = await shareRows(expense.id);
    expect(shares).toHaveLength(3);
    expect(shares.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(1000);
    expect(shares.reduce((a: number, s: any) => a + s.paid_cents, 0)).toBe(1000);
    expect([...shares.map((s: any) => s.owed_cents)].sort((a, b) => b - a)).toEqual([334, 333, 333]);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.paid_cents).toBe(1000);

    // Replayed delivery of the same interaction is caught by the UNIQUE guard.
    const replay = await send(submit);
    expect(textIn(replay.body.data.components)).toContain('Already recorded');
    expect(await expenseRows()).toHaveLength(1);
  });

  it('the payer is auto-included in the split when not selected', async () => {
    const submit = expenseModalSubmit(
      'mod:add',
      { amount: '30.00', desc: 'Treat', participants: [BOB.id, CARA.id], payer: [ALICE.id], method: 'equal' },
      { user: BOB, resolved: resolvedUsers(ALICE, BOB, CARA) },
    );
    const res = await send(submit);
    expect(res.body.type).toBe(4);
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    expect(shares).toHaveLength(3);
    const alice = shares.find((s: any) => s.user_id === ALICE.id)!;
    expect(alice.paid_cents).toBe(3000);
    expect(alice.owed_cents).toBe(1000);
  });

  it('rejects bots, self-only splits, and bad amounts with a retry prompt', async () => {
    const bot = { id: '100000000000000009', username: 'beepboop', bot: true };
    const withBot = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '10.00', desc: 'x', participants: [ALICE.id, bot.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, { ...bot }) },
      ),
    );
    expect(textIn(withBot.body.data.components)).toContain('Bots');

    const selfOnly = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '10.00', desc: 'x', participants: [ALICE.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE) },
      ),
    );
    expect(textIn(selfOnly.body.data.components)).toContain("just you");

    const badAmount = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '12.505', desc: 'x', participants: [ALICE.id, BOB.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
      ),
    );
    expect(badAmount.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(textIn(badAmount.body.data.components)).toContain('decimal');
    const retryIds = customIdsIn(badAmount.body.data.components);
    expect(retryIds.some((id) => id.endsWith(':rt'))).toBe(true);
    expect(await expenseRows()).toHaveLength(0);
  });

  it('exact split: prompt → stage-2 modal → validation → atomic insert → public receipt', async () => {
    const submit = expenseModalSubmit(
      'mod:add',
      { amount: '31.20', desc: 'Pizza night', participants: [ALICE.id, BOB.id, CARA.id], method: 'exact' },
      { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
    );
    const prompt = await send(submit);
    expect(prompt.body.type).toBe(4);
    expect(prompt.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    const ids = customIdsIn(prompt.body.data.components);
    const goId = ids.find((id) => id.endsWith(':go'))!;
    expect(goId).toBeTruthy();
    const token = goId.split(':')[1]!;

    const modalRes = await send(click(goId, { user: ALICE }));
    expect(modalRes.body.type).toBe(9);
    expect(textIn(modalRes.body.data.components)).toContain('alice');

    // Wrong sum → in-place error with the delta, nothing written.
    const bad = await send(splitModalSubmit(`pnd:${token}:m2`, '10.00, 10.00, 10.00', { user: ALICE }));
    expect(bad.body.type).toBe(7);
    expect(textIn(bad.body.data.components)).toContain('short by $1.20');
    expect(await expenseRows()).toHaveLength(0);

    // Correct values → claim + insert; response updates the prompt; receipt follows up.
    const good = await send(splitModalSubmit(`pnd:${token}:m2`, '12.50, 10.45, 8.25', { user: ALICE }));
    expect(good.body.type).toBe(7);
    expect(textIn(good.body.data.components)).toContain('Recorded');
    await good.settled;
    expect(publicFollowUps()).toHaveLength(1);
    expect(textIn(publicFollowUps()[0])).toContain('Pizza night');

    const [expense] = await expenseRows();
    expect(expense.total_cents).toBe(3120);
    const shares = await shareRows(expense.id);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1250);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1045);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(825);

    // The claimed draft cannot be spent twice.
    const again = await send(splitModalSubmit(`pnd:${token}:m2`, '12.50, 10.45, 8.25', { user: ALICE }));
    expect(textIn(again.body.data.components)).toContain('expired');
    expect(await expenseRows()).toHaveLength(1);
  });

  it('a split that would give someone $0.00 is a clean validation error, not a crash', async () => {
    const tiny = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '0.02', desc: 'Tiny', participants: [ALICE.id, BOB.id, CARA.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    expect(tiny.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(textIn(tiny.body.data.components)).toContain('$0.00');
    expect(textIn(tiny.body.data.components)).not.toContain('Something went wrong');
    expect(await expenseRows()).toHaveLength(0);
  });

  it('retry drafts are consumed by the resubmission', async () => {
    const bad = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: 'abc', desc: 'Groceries', participants: [ALICE.id, BOB.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
      ),
    );
    const rtId = customIdsIn(bad.body.data.components).find((c) => c.endsWith(':rt'))!;
    const token = rtId.split(':')[1]!;

    const reopened = await send(click(rtId, { user: ALICE }));
    expect(reopened.body.type).toBe(9);
    expect(reopened.body.data.custom_id).toBe(`mod:add:${token}`);

    const fixed = await send(
      expenseModalSubmit(
        `mod:add:${token}`,
        { amount: '10.00', desc: 'Groceries', participants: [ALICE.id, BOB.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
      ),
    );
    expect(fixed.body.type).toBe(4);
    expect(await expenseRows()).toHaveLength(1);

    // The stale error prompt's button is now dead.
    const stale = await send(click(rtId, { user: ALICE }));
    expect(textIn(stale.body.data.components)).toContain('expired');
  });

  it('stored created_at reproduces the exact cent allocation (rotation offset consistency)', async () => {
    const { allocate } = await import('../src/domain/split');
    await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '10.00', desc: 'Rotation', participants: [ALICE.id, BOB.id, CARA.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    const recomputed = allocate(
      1000,
      [ALICE.id, BOB.id, CARA.id].map((userId) => ({ userId, weight: 1 })),
      expense.created_at,
    );
    const expected = new Map([ALICE.id, BOB.id, CARA.id].map((id, idx) => [id, recomputed[idx]!]));
    for (const s of shares) expect(s.owed_cents).toBe(expected.get(s.user_id));
  });

  it("someone else's draft buttons are refused", async () => {
    const prompt = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '9.00', desc: 'Snacks', participants: [ALICE.id, BOB.id], method: 'shares' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
      ),
    );
    const goId = customIdsIn(prompt.body.data.components).find((id) => id.endsWith(':go'))!;
    const res = await send(click(goId, { user: BOB }));
    expect(textIn(res.body.data.components)).toContain('someone else');
  });
});

describe('/expense add via slots', () => {
  const withMentions = `<@${ALICE.id}> <@${BOB.id}> <@${CARA.id}>`;

  it('records an equal split straight from the slots', async () => {
    const res = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'Sushi' },
          { type: 3, name: 'with', value: withMentions },
        ],
        user: ALICE,
      }),
    );
    expect(res.body.type).toBe(4);
    expect(res.body.data.flags & EPHEMERAL).toBe(0);
    expect(textIn(res.body.data.components)).toContain('Sushi');

    const [expense] = await expenseRows();
    expect(expense.total_cents).toBe(3000);
    const shares = await shareRows(expense.id);
    expect(shares).toHaveLength(3);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.paid_cents).toBe(3000);
    expect(shares.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3000);
  });

  it('supports exact splits with values in @mention order, and paid_by', async () => {
    const res = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '31.20' },
          { type: 3, name: 'description', value: 'Pizza' },
          { type: 3, name: 'with', value: withMentions },
          { type: 6, name: 'paid_by', value: BOB.id },
          { type: 3, name: 'split', value: 'exact' },
          { type: 3, name: 'values', value: '12.50, 10.45, 8.25' },
        ],
        user: ALICE,
        resolved: resolvedUsers(ALICE, BOB, CARA),
      }),
    );
    expect(res.body.type).toBe(4);
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1250);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.paid_cents).toBe(3120);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(825);
  });

  it('the payer is auto-included when not @mentioned; payer_shares: False opts out', async () => {
    // Alice pays, mentions only Bob and Cara → 3-way split.
    await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'Brunch' },
          { type: 3, name: 'with', value: `<@${BOB.id}> <@${CARA.id}>` },
        ],
        user: ALICE,
      }),
    );
    let [expense] = await expenseRows();
    let shares = await shareRows(expense.id);
    expect(shares).toHaveLength(3);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1000);

    // payer_shares: False → Alice fronted the money but isn't splitting.
    await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '20.00' },
          { type: 3, name: 'description', value: 'Their treat' },
          { type: 3, name: 'with', value: `<@${BOB.id}> <@${CARA.id}>` },
          { type: 5, name: 'payer_shares', value: false },
        ],
        user: ALICE,
      }),
    );
    const rows = await expenseRows();
    shares = await shareRows(rows[1].id);
    const alice = shares.find((s: any) => s.user_id === ALICE.id)!;
    expect(alice.paid_cents).toBe(2000);
    expect(alice.owed_cents).toBe(0);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1000);

    // Contradiction: payer_shares False but payer mentioned in with.
    const contradiction = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '10.00' },
          { type: 3, name: 'description', value: 'x' },
          { type: 3, name: 'with', value: `<@${ALICE.id}> <@${BOB.id}>` },
          { type: 5, name: 'payer_shares', value: false },
        ],
        user: ALICE,
      }),
    );
    expect(textIn(contradiction.body.data.components)).toContain('payer_shares');
  });

  it('non-equal slot splits count the auto-added payer and hint about it', async () => {
    // Two mentions + auto-added payer = 3 values needed; giving 2 must say so.
    const wrong = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'x' },
          { type: 3, name: 'with', value: `<@${BOB.id}> <@${CARA.id}>` },
          { type: 3, name: 'split', value: 'exact' },
          { type: 3, name: 'values', value: '15.00, 15.00' },
        ],
        user: ALICE,
      }),
    );
    expect(textIn(wrong.body.data.components)).toContain('whoever paid counts too');

    const right = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'Ordered treat' },
          { type: 3, name: 'with', value: `<@${BOB.id}> <@${CARA.id}>` },
          { type: 3, name: 'split', value: 'exact' },
          { type: 3, name: 'values', value: '15.00, 10.00, 5.00' },
        ],
        user: ALICE,
      }),
    );
    expect(right.body.type).toBe(4);
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1500);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(1000);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(500);
  });

  it('1:1 DM shorthand: no `with` means the partner owes the full amount', async () => {
    const dm = { channelId: 'dm-alice-bob', channel: { type: 1, recipients: [ALICE, BOB] } };
    const res = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '20.00' },
          { type: 3, name: 'description', value: 'Movie ticket' },
        ],
        user: ALICE,
        ...dm,
      }),
    );
    expect(res.body.type).toBe(4);
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    expect(shares).toHaveLength(2);
    const alice = shares.find((s: any) => s.user_id === ALICE.id)!;
    const bob = shares.find((s: any) => s.user_id === BOB.id)!;
    expect(alice.paid_cents).toBe(2000);
    expect(alice.owed_cents).toBe(0);
    expect(bob.owed_cents).toBe(2000);

    // payer_shares: True flips the shorthand into a 2-way split.
    await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '20.00' },
          { type: 3, name: 'description', value: 'Lunch' },
          { type: 5, name: 'payer_shares', value: true },
        ],
        user: ALICE,
        ...dm,
      }),
    );
    const rows = await expenseRows();
    const lunchShares = await shareRows(rows[1].id);
    expect(lunchShares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1000);
    expect(lunchShares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1000);
  });

  it('1:1 DM shorthand falls back to ledger history when recipients are missing', async () => {
    const dm = { channelId: 'dm-alice-cara', channel: { type: 1 } };
    // Nothing recorded yet and no recipients → must ask for `with` once.
    const first = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '5.00' },
          { type: 3, name: 'description', value: 'Coffee' },
        ],
        user: ALICE,
        ...dm,
      }),
    );
    expect(textIn(first.body.data.components)).toContain('`with: @them`');

    // Record one expense with an explicit mention; after that the shorthand works.
    await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '5.00' },
          { type: 3, name: 'description', value: 'Coffee' },
          { type: 3, name: 'with', value: `<@${CARA.id}>` },
        ],
        user: ALICE,
        ...dm,
      }),
    );
    const second = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '7.00' },
          { type: 3, name: 'description', value: 'Bagel' },
        ],
        user: ALICE,
        ...dm,
      }),
    );
    expect(second.body.type).toBe(4);
    const rows = await expenseRows();
    const shares = await shareRows(rows[1].id);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(700);
  });

  it('a 0 value lets the payer cover everyone (no share row, no DB CHECK crash)', async () => {
    const res = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'On me' },
          { type: 3, name: 'with', value: `<@${BOB.id}> <@${CARA.id}>` },
          { type: 3, name: 'split', value: 'exact' },
          { type: 3, name: 'values', value: '20.00, 10.00, 0' },
        ],
        user: ALICE,
      }),
    );
    expect(res.body.type).toBe(4);
    expect(textIn(res.body.data.components)).toContain("payer isn't splitting");
    const [expense] = await expenseRows();
    const shares = await shareRows(expense.id);
    expect(shares).toHaveLength(3);
    const alice = shares.find((s: any) => s.user_id === ALICE.id)!;
    expect(alice.paid_cents).toBe(3000);
    expect(alice.owed_cents).toBe(0);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(2000);
  });

  it('partial slots are refused with guidance; non-equal without values too', async () => {
    const partial = await send(
      slash('expense', {
        sub: 'add',
        options: [{ type: 3, name: 'amount', value: '30.00' }],
        user: ALICE,
      }),
    );
    expect(textIn(partial.body.data.components)).toContain('`description`');
    expect(textIn(partial.body.data.components)).not.toContain('`with`');

    const noValues = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'x' },
          { type: 3, name: 'with', value: withMentions },
          { type: 3, name: 'split', value: 'percent' },
        ],
        user: ALICE,
      }),
    );
    expect(textIn(noValues.body.data.components)).toContain('`values`');
    expect(await expenseRows()).toHaveLength(0);
  });

  it('a with-string without mentions is refused; empty slots still open the form', async () => {
    const noMentions = await send(
      slash('expense', {
        sub: 'add',
        options: [
          { type: 3, name: 'amount', value: '30.00' },
          { type: 3, name: 'description', value: 'x' },
          { type: 3, name: 'with', value: 'alice and bob' },
        ],
        user: ALICE,
      }),
    );
    expect(textIn(noMentions.body.data.components)).toContain('@mention');

    const empty = await send(slash('expense', { sub: 'add', user: ALICE }));
    expect(empty.body.type).toBe(9);
  });
});

describe('/expense add picker (roster)', () => {
  const twoSlots = (user = ALICE, extra: { name: string; type: number; value: unknown }[] = []) =>
    slash('expense', {
      sub: 'add',
      options: [
        { type: 3, name: 'amount', value: '30.00' },
        { type: 3, name: 'description', value: 'Ramen' },
        ...extra,
      ],
      user,
    });

  function selectIn(body: any): any {
    const rows = body.data.components.filter((c: any) => c.type === 1);
    return rows[0].components[0];
  }

  it('two slots open a picker pre-filled from the roster; one click records it', async () => {
    await recordDinner(); // seeds the roster with Alice, Bob, Cara

    const picker = await send(twoSlots());
    expect(picker.body.type).toBe(4);
    expect(picker.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    const select = selectIn(picker.body);
    expect(select.type).toBe(5);
    expect(select.default_values.map((d: any) => d.id).sort()).toEqual([ALICE.id, BOB.id, CARA.id].sort());
    const ids = customIdsIn(picker.body.data.components);
    const equalId = ids.find((c) => c.endsWith(':equal'))!;
    expect(ids.filter((c) => c.startsWith('pk:'))).toHaveLength(6);

    const done = await send(click(equalId, { user: ALICE }));
    expect(done.body.type).toBe(7);
    expect(textIn(done.body.data.components)).toContain('Recorded');
    await done.settled;
    expect(publicFollowUps()).toHaveLength(1);
    const receipt = textIn(publicFollowUps()[0]);
    expect(receipt).toContain('Ramen');
    expect(receipt).toContain('Now:'); // balances footer

    const rows = await expenseRows();
    expect(rows).toHaveLength(2);
    const shares = await shareRows(rows[1].id);
    expect(shares).toHaveLength(3);
    expect(shares.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3000);

    // The draft is consumed: a second click can't double-record.
    const again = await send(click(equalId, { user: ALICE }));
    expect(textIn(again.body.data.components)).toContain('expired');
    expect(await expenseRows()).toHaveLength(2);
  });

  it('`except` drops people from the pre-filled list; the select edits it; payer is auto-added', async () => {
    await recordDinner();
    const picker = await send(twoSlots(ALICE, [{ type: 3, name: 'except', value: `<@${CARA.id}>` }]));
    const select = selectIn(picker.body);
    expect(select.default_values.map((d: any) => d.id).sort()).toEqual([ALICE.id, BOB.id].sort());
    const token = select.custom_id.split(':')[1]!;

    // Deselect everyone but Bob; Alice (payer) still gets added automatically.
    const changed = await send({
      ...click(`pk:${token}:sel`, { user: ALICE, resolved: resolvedUsers(BOB) }),
      data: { custom_id: `pk:${token}:sel`, component_type: 5, values: [BOB.id], resolved: resolvedUsers(BOB) },
    });
    expect(changed.body.type).toBe(7);
    expect(textIn(changed.body.data.components)).toContain('as payer');

    await send(click(`pk:${token}:equal`, { user: ALICE }));
    const rows = await expenseRows();
    const shares = await shareRows(rows[1].id);
    expect(shares).toHaveLength(2);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1500);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1500);
  });

  it('custom split from the picker goes through the values modal', async () => {
    await recordDinner();
    const picker = await send(twoSlots());
    const token = selectIn(picker.body).custom_id.split(':')[1]!;
    const modalRes = await send(click(`pk:${token}:exact`, { user: ALICE }));
    expect(modalRes.body.type).toBe(9);
    expect(modalRes.body.data.custom_id).toBe(`pnd:${token}:m2`);
    expect(textIn(modalRes.body.data.components)).toContain('alice');

    const done = await send(splitModalSubmit(`pnd:${token}:m2`, '15.00, 10.00, 5.00', { user: ALICE }));
    expect(textIn(done.body.data.components)).toContain('Recorded');
    const rows = await expenseRows();
    const shares = await shareRows(rows[1].id);
    expect(shares.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3000);
  });

  it('custom split shows one labeled box per person; an empty box gets the remainder', async () => {
    await recordDinner();
    const picker = await send(twoSlots());
    const token = selectIn(picker.body).custom_id.split(':')[1]!;
    const modalRes = await send(click(`pk:${token}:exact`, { user: ALICE }));
    const comps = modalRes.body.data.components;
    expect(comps).toHaveLength(3);
    expect(comps.map((c: any) => c.label).sort()).toEqual(['alice', 'bob', 'cara']);
    expect(comps.map((c: any) => c.component.custom_id)).toEqual(['v:0', 'v:1', 'v:2']);

    // Two filled, one empty → remainder; order matches the labels.
    const order = comps.map((c: any) => c.label);
    const cells = order.map((name: string) => (name === 'bob' ? '10.00' : name === 'cara' ? '5.00' : ''));
    const done = await send(perPersonModalSubmit(`pnd:${token}:m2`, cells, { user: ALICE }));
    expect(textIn(done.body.data.components)).toContain('Recorded');
    const rows = await expenseRows();
    const shares = await shareRows(rows[1].id);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1500);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1000);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(500);

    // Two empty boxes is an error that keeps the prompt open.
    const picker2 = await send(twoSlots());
    const token2 = selectIn(picker2.body).custom_id.split(':')[1]!;
    await send(click(`pk:${token2}:exact`, { user: ALICE }));
    const bad = await send(perPersonModalSubmit(`pnd:${token2}:m2`, ['', '', '5.00'], { user: ALICE }));
    expect(textIn(bad.body.data.components)).toContain('at most one box empty');
    expect(await expenseRows()).toHaveLength(2);
  });

  it('a fresh chat shows an empty picker with a hint, and refuses to record nobody', async () => {
    const picker = await send(twoSlots());
    expect(textIn(picker.body.data.components)).toContain('roster');
    expect(selectIn(picker.body).default_values).toBeUndefined();
    const token = selectIn(picker.body).custom_id.split(':')[1]!;
    const nobody = await send(click(`pk:${token}:equal`, { user: ALICE }));
    expect(textIn(nobody.body.data.components)).toContain('at least one other person');
    expect(await expenseRows()).toHaveLength(0);
  });

  it('/roster shows and edits who "everyone" means', async () => {
    await recordDinner();
    const view = await send(slash('roster', { user: BOB }));
    expect(view.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(selectIn(view.body).default_values).toHaveLength(3);

    const saved = await send({
      ...click('ro:set', { user: BOB }),
      data: { custom_id: 'ro:set', component_type: 5, values: [ALICE.id, BOB.id], resolved: resolvedUsers(ALICE, BOB) },
    });
    expect(textIn(saved.body.data.components)).toContain('Roster saved');

    const picker = await send(twoSlots(BOB));
    expect(selectIn(picker.body).default_values.map((d: any) => d.id).sort()).toEqual([ALICE.id, BOB.id].sort());
  });
});

describe('buttons over commands', () => {
  it('/balance shows Pay buttons only for your own debts; one tap records a pending settlement', async () => {
    await recordDinner(); // Bob and Cara each owe Alice $10

    const asAlice = await send(slash('balance', { user: ALICE }));
    expect(customIdsIn(asAlice.body.data.components).filter((c) => c.startsWith('stb:'))).toHaveLength(0);

    const asBob = await send(slash('balance', { user: BOB }));
    const payIds = customIdsIn(asBob.body.data.components).filter((c) => c.startsWith('stb:'));
    expect(payIds).toEqual([`stb:${BOB.id}:${ALICE.id}:1000`]);
    expect(textIn(asBob.body.data.components)).toContain('Pay alice $10.00');

    // Someone else clicking Bob's button is refused.
    const cara = await send(click(payIds[0]!, { user: CARA }));
    expect(textIn(cara.body.data.components)).toContain('That button is for');
    expect((await expenseRows()).filter((r: any) => r.is_payment === 1)).toHaveLength(0);

    // Bob taps it: a public confirm prompt for Alice appears.
    const paid = await send(click(payIds[0]!, { user: BOB }));
    expect(paid.body.type).toBe(4);
    expect(paid.body.data.flags & EPHEMERAL).toBe(0);
    expect(customIdsIn(paid.body.data.components).some((c) => c.startsWith('stl:'))).toBe(true);
    const settlement = (await expenseRows()).find((r: any) => r.is_payment === 1)!;
    expect(settlement.total_cents).toBe(1000);
    expect(settlement.payment_status).toBe('pending');

    // A stale button (debt already pending) does not stack a second one.
    const again = await send(click(payIds[0]!, { user: BOB }));
    expect(textIn(again.body.data.components)).toContain('already have a pending settlement');
  });

  it('receipts carry Edit and Undo buttons that open the existing flows', async () => {
    const id = await recordDinner();
    const picker = await send(
      slash('add', {
        options: [
          { type: 3, name: 'amount', value: '12.00' },
          { type: 3, name: 'description', value: 'Coffee run' },
        ],
        user: BOB,
      }),
    );
    // /add is the same flow as /expense add.
    expect(customIdsIn(picker.body.data.components).some((c) => c.startsWith('pk:'))).toBe(true);

    const edit = await send(click(`rx:${id}:edit`, { user: CARA }));
    expect(edit.body.type).toBe(9);
    expect(edit.body.data.custom_id).toBe(`mod:edit:${id}:1`);

    const undo = await send(click(`rx:${id}:undo`, { user: CARA }));
    expect(undo.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    expect(customIdsIn(undo.body.data.components)).toContain(`del:${id}:y`);
  });

  it('the receipt itself includes the action row', async () => {
    const submit = expenseModalSubmit(
      'mod:add',
      { amount: '10.00', desc: 'Tea', participants: [ALICE.id, BOB.id], method: 'equal' },
      { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
    );
    const res = await send(submit);
    const [expense] = await expenseRows();
    const ids = customIdsIn(res.body.data.components);
    expect(ids).toContain(`rx:${expense.id}:edit`);
    expect(ids).toContain(`rx:${expense.id}:undo`);
  });
});

describe('hints', () => {
  const ephemeralFollowUps = () =>
    followUps.mock.calls.filter((c) => ((c[2] as any).flags & EPHEMERAL) !== 0).map((c) => textIn(c[2]));

  it('shows the tour once per person per chat, as an ephemeral follow-up', async () => {
    const first = await send(slash('balance', { user: ALICE }));
    await first.settled;
    expect(ephemeralFollowUps().some((t) => t.includes('First time here'))).toBe(true);

    followUps.mockClear();
    const second = await send(slash('history', { user: ALICE }));
    await second.settled;
    expect(ephemeralFollowUps().some((t) => t.includes('First time here'))).toBe(false);

    // A different person in the same chat gets their own tour.
    const bob = await send(slash('balance', { user: BOB }));
    await bob.settled;
    expect(ephemeralFollowUps().some((t) => t.includes('First time here'))).toBe(true);

    // The bot's own DM never gets it.
    followUps.mockClear();
    const dm = await send(slash('balance', { user: CARA, context: 1, channelId: 'dm-x' }));
    await dm.settled;
    expect(ephemeralFollowUps()).toHaveLength(0);
  });

  it('shows three rotating tips after recording, then stops', async () => {
    const add = () =>
      expenseModalSubmit(
        'mod:add',
        { amount: '10.00', desc: 'Snack', participants: [ALICE.id, BOB.id], method: 'equal' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB) },
      );
    const seen: string[] = [];
    for (let n = 0; n < 4; n++) {
      followUps.mockClear();
      const res = await send(add());
      await res.settled;
      seen.push(...ephemeralFollowUps().filter((t) => t.includes('Tip:')));
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('description autocomplete offers recent descriptions plus the typed text', async () => {
    await recordDinner();
    const res = await send({
      ...slash('add', { user: BOB }),
      type: 4,
      data: { name: 'add', type: 1, options: [{ type: 3, name: 'description', value: 'Din', focused: true }] },
    });
    expect(res.body.type).toBe(8);
    const names = res.body.data.choices.map((c: any) => c.name);
    expect(names[0]).toBe('Din');
    expect(names).toContain('Dinner');

    const exact = await send({
      ...slash('add', { user: BOB }),
      type: 4,
      data: { name: 'add', type: 1, options: [{ type: 3, name: 'description', value: 'dinner', focused: true }] },
    });
    expect(exact.body.data.choices.map((c: any) => c.name)).toEqual(['Dinner']);
  });
});

describe('/expense edit', () => {
  it('edits with optimistic locking; the stale editor loses cleanly', async () => {
    const id = await recordDinner();

    const first = await send(
      expenseModalSubmit(
        `mod:edit:${id}:1`,
        { amount: '36.00', desc: 'Dinner + tip', participants: [], method: 'equal' },
        { user: BOB, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    expect(first.body.type).toBe(4);
    expect(textIn(first.body.data.components)).toContain('Dinner + tip');

    const rows = await expenseRows();
    expect(rows[0].total_cents).toBe(3600);
    expect(rows[0].revision).toBe(2);
    const shares = await shareRows(id);
    expect(shares.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3600);
    expect(shares).toHaveLength(3);

    // A second editor still holding revision 1 must not corrupt shares.
    const stale = await send(
      expenseModalSubmit(
        `mod:edit:${id}:1`,
        { amount: '99.00', desc: 'Hijack', participants: [], method: 'equal' },
        { user: CARA, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    expect(textIn(stale.body.data.components)).toContain('changed since');
    const after = await expenseRows();
    expect(after[0].total_cents).toBe(3600);
    const sharesAfter = await shareRows(id);
    expect(sharesAfter.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3600);
  });

  it('edit to an exact split runs the two-modal pending flow with the optimistic lock', async () => {
    const id = await recordDinner();

    const prompt = await send(
      expenseModalSubmit(
        `mod:edit:${id}:1`,
        { amount: '30.00', desc: 'Dinner exact', participants: [], method: 'exact' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    expect(prompt.body.type).toBe(4);
    const goId = customIdsIn(prompt.body.data.components).find((c) => c.endsWith(':go'))!;
    const token = goId.split(':')[1]!;

    // Participants kept from the current ower set, ordered by snowflake:
    // alice, bob, cara.
    const done = await send(splitModalSubmit(`pnd:${token}:m2`, '15.00, 10.00, 5.00', { user: ALICE }));
    expect(done.body.type).toBe(7);
    expect(textIn(done.body.data.components)).toContain('Updated');
    await done.settled;
    expect(publicFollowUps()).toHaveLength(1);

    const rows = await expenseRows();
    expect(rows[0].split_method).toBe('exact');
    expect(rows[0].revision).toBe(2);
    const shares = await shareRows(id);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1500);
    expect(shares.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(1000);
    expect(shares.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(500);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.paid_cents).toBe(3000);

    // A pending edit still holding revision 1 claims its draft but must lose
    // the optimistic lock without touching shares.
    const stalePrompt = await send(
      expenseModalSubmit(
        `mod:edit:${id}:1`,
        { amount: '90.00', desc: 'Stale', participants: [], method: 'exact' },
        { user: BOB, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    const staleGo = customIdsIn(stalePrompt.body.data.components).find((c) => c.endsWith(':go'))!;
    const staleToken = staleGo.split(':')[1]!;
    const lost = await send(splitModalSubmit(`pnd:${staleToken}:m2`, '30.00, 30.00, 30.00', { user: BOB }));
    expect(textIn(lost.body.data.components)).toContain('changed since');
    const after = await shareRows(id);
    expect(after.reduce((a: number, s: any) => a + s.owed_cents, 0)).toBe(3000);
    expect((await expenseRows())[0].total_cents).toBe(3000);
  });

  it('keeping current participants preserves the ORIGINAL entry order and names for split values', async () => {
    // Add $30 exact with participants selected in order [Cara, Alice, Bob]
    // and values 15/10/5 → Cara owes 15, Alice 10, Bob 5.
    const prompt = await send(
      expenseModalSubmit(
        'mod:add',
        { amount: '30.00', desc: 'Ordered', participants: [CARA.id, ALICE.id, BOB.id], method: 'exact' },
        { user: ALICE, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    const goId = customIdsIn(prompt.body.data.components).find((c) => c.endsWith(':go'))!;
    await send(splitModalSubmit(`pnd:${goId.split(':')[1]}:m2`, '15.00, 10.00, 5.00', { user: ALICE }));
    const [expense] = await expenseRows();
    expect((await shareRows(expense.id)).find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(1500);

    // Description-only edit, selects left empty ("keep current"), method
    // unchanged — the stage-2 modal must show the SAME order with real names
    // and the prefilled old values, so submitting unchanged changes nothing.
    const editPrompt = await send(
      expenseModalSubmit(
        `mod:edit:${expense.id}:1`,
        { amount: '30.00', desc: 'Ordered v2', participants: [], payer: [], method: 'exact' },
        { user: ALICE }, // no resolved data — names must come from split_input
      ),
    );
    const editGo = customIdsIn(editPrompt.body.data.components).find((c) => c.endsWith(':go'))!;
    const editToken = editGo.split(':')[1]!;
    const modalRes = await send(click(editGo, { user: ALICE }));
    const modalText = textIn(modalRes.body.data.components);
    expect(modalText).toMatch(/cara[\s\S]*alice[\s\S]*bob/); // original entry order, real names
    expect(modalText).not.toContain('user-');
    expect(customIdsIn(modalRes.body.data.components)).toBeDefined();

    const done = await send(splitModalSubmit(`pnd:${editToken}:m2`, '15.00, 10.00, 5.00', { user: ALICE }));
    expect(textIn(done.body.data.components)).toContain('Updated');
    await done.settled;
    const after = await shareRows(expense.id);
    expect(after.find((s: any) => s.user_id === CARA.id)!.owed_cents).toBe(1500);
    expect(after.find((s: any) => s.user_id === ALICE.id)!.owed_cents).toBe(1000);
    expect(after.find((s: any) => s.user_id === BOB.id)!.owed_cents).toBe(500);
  });

  it('empty participants keep the current ower set and payer', async () => {
    const id = await recordDinner();
    await send(
      expenseModalSubmit(
        `mod:edit:${id}:1`,
        { amount: '30.00', desc: 'Dinner v2', participants: [], payer: [], method: 'equal' },
        { user: CARA, resolved: resolvedUsers(ALICE, BOB, CARA) },
      ),
    );
    const shares = await shareRows(id);
    expect(shares).toHaveLength(3);
    expect(shares.find((s: any) => s.user_id === ALICE.id)!.paid_cents).toBe(3000);
  });
});

describe('/expense delete', () => {
  it('confirm flow soft-deletes and excludes from balances', async () => {
    const id = await recordDinner();

    const confirm = await send(
      slash('expense', {
        sub: 'delete',
        options: [{ type: 3, name: 'id', value: String(id) }],
        user: BOB,
      }),
    );
    expect(confirm.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    const yes = customIdsIn(confirm.body.data.components).find((c) => c === `del:${id}:y`)!;

    const deleted = await send(click(yes, { user: BOB }));
    expect(deleted.body.type).toBe(7);
    expect(textIn(deleted.body.data.components)).toContain('Deleted');
    await deleted.settled;
    expect(publicFollowUps()).toHaveLength(1);
    expect(textIn(publicFollowUps()[0])).toContain('deleted');

    const rows = await expenseRows();
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[0].deleted_by).toBe(BOB.id);

    const again = await send(click(yes, { user: BOB }));
    expect(textIn(again.body.data.components)).toContain('Already deleted');

    const balance = await send(slash('balance', { user: ALICE }));
    expect(textIn(balance.body.data.components)).toContain('No expenses');
  });
});

describe('/settle', () => {
  it('full flow: pending settle does not count until the creditor confirms', async () => {
    const id = await recordDinner();
    void id;

    // Bob owes Alice $10. Settle defaults to the full pairwise debt.
    const prompt = await send(
      slash('settle', {
        options: [{ type: 6, name: 'to', value: ALICE.id }],
        user: BOB,
        resolved: resolvedUsers(ALICE, BOB),
      }),
    );
    expect(prompt.body.type).toBe(4);
    expect(prompt.body.data.flags & EPHEMERAL).toBe(0);
    expect(textIn(prompt.body.data.components)).toContain('$10.00');
    const rows = await expenseRows();
    const settlement = rows.find((r: any) => r.is_payment === 1)!;
    expect(settlement.payment_status).toBe('pending');

    // Pending: balance still shows Bob owing, with a pending footnote.
    const pendingBalance = await send(slash('balance', { user: ALICE }));
    const pendingText = textIn(pendingBalance.body.data.components);
    expect(pendingText).toContain('pending confirmation');
    expect(pendingText).toContain(`<@${BOB.id}>  owes`);

    // A bystander cannot confirm; the debtor cannot confirm either.
    const caraTry = await send(click(`stl:${settlement.id}:y`, { user: CARA }));
    expect(textIn(caraTry.body.data.components)).toContain('Only');
    const bobTry = await send(click(`stl:${settlement.id}:y`, { user: BOB }));
    expect(textIn(bobTry.body.data.components)).toContain('Only');

    // The creditor confirms; the pairwise debt disappears.
    const confirmed = await send(click(`stl:${settlement.id}:y`, { user: ALICE }));
    expect(confirmed.body.type).toBe(7);
    expect(textIn(confirmed.body.data.components)).toContain('confirmed');

    const finalBalance = await send(slash('balance', { user: ALICE }));
    const finalText = textIn(finalBalance.body.data.components);
    expect(finalText).not.toContain(`<@${BOB.id}>  owes`);

    // Double-confirm re-renders the settled state instead of erroring.
    const replay = await send(click(`stl:${settlement.id}:y`, { user: ALICE }));
    expect(replay.body.type).toBe(7);
    expect(textIn(replay.body.data.components)).toContain('confirmed');
  });

  it('a second no-arg settle is refused while one is pending (no double-payment stacking)', async () => {
    await recordDinner();
    const first = await send(
      slash('settle', {
        options: [{ type: 6, name: 'to', value: ALICE.id }],
        user: BOB,
        resolved: resolvedUsers(ALICE, BOB),
      }),
    );
    expect(customIdsIn(first.body.data.components).some((c) => c.startsWith('stl:'))).toBe(true);

    const second = await send(
      slash('settle', {
        options: [{ type: 6, name: 'to', value: ALICE.id }],
        user: BOB,
        resolved: resolvedUsers(ALICE, BOB),
      }),
    );
    expect(textIn(second.body.data.components)).toContain('already have a pending settlement');
    expect((await expenseRows()).filter((r: any) => r.is_payment === 1)).toHaveLength(1);
  });

  it('a replayed settle delivery re-renders the confirm prompt instead of orphaning it', async () => {
    await recordDinner();
    const interaction = slash('settle', {
      options: [{ type: 6, name: 'to', value: ALICE.id }],
      user: BOB,
      resolved: resolvedUsers(ALICE, BOB),
    });
    await send(interaction);
    const replay = await send(interaction);
    expect(customIdsIn(replay.body.data.components).some((c) => c.startsWith('stl:'))).toBe(true);
    expect((await expenseRows()).filter((r: any) => r.is_payment === 1)).toHaveLength(1);
  });

  it('refuses a no-arg settle when nothing is owed, and self/bot targets', async () => {
    const nothing = await send(
      slash('settle', {
        options: [{ type: 6, name: 'to', value: ALICE.id }],
        user: CARA,
        resolved: resolvedUsers(ALICE, CARA),
      }),
    );
    expect(textIn(nothing.body.data.components)).toContain("don't owe");

    const self = await send(
      slash('settle', {
        options: [{ type: 6, name: 'to', value: ALICE.id }],
        user: ALICE,
        resolved: resolvedUsers(ALICE),
      }),
    );
    expect(textIn(self.body.data.components)).toContain("yourself");
  });
});

describe('/balance and /history', () => {
  it('renders nets, suggestions, and pairwise detail', async () => {
    await recordDinner();
    const balance = await send(slash('balance', { user: ALICE }));
    expect(balance.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    const text = textIn(balance.body.data.components);
    expect(text).toContain(`<@${ALICE.id}>  is owed  **$20.00**`);
    expect(text).toContain('Suggested:');

    const detail = await send(
      slash('balance', {
        options: [{ type: 6, name: 'with', value: ALICE.id }],
        user: BOB,
        resolved: resolvedUsers(ALICE, BOB),
      }),
    );
    expect(textIn(detail.body.data.components)).toContain('You owe');

    const shared = await send(
      slash('balance', { options: [{ type: 5, name: 'share', value: true }], user: ALICE }),
    );
    expect(shared.body.data.flags & EPHEMERAL).toBe(0);
  });

  it('history paginates and the autocomplete lists expenses', async () => {
    const id = await recordDinner();
    const history = await send(slash('history', { user: BOB }));
    const text = textIn(history.body.data.components);
    expect(text).toContain('Dinner');
    expect(text).toContain('page 1/1');

    const auto = await send(autocompleteFor('expense', 'edit', 'Din', { user: BOB }));
    expect(auto.body.type).toBe(8);
    expect(auto.body.data.choices[0].name).toContain('Dinner');
    expect(auto.body.data.choices[0].value).toBe(String(id));

    const noMatch = await send(autocompleteFor('expense', 'edit', 'zzz', { user: BOB }));
    expect(noMatch.body.data.choices).toHaveLength(0);
  });

  it('/help returns the ephemeral quick guide', async () => {
    const res = await send(slash('help', { user: ALICE }));
    expect(res.body.type).toBe(4);
    expect(res.body.data.flags & EPHEMERAL).toBe(EPHEMERAL);
    const text = textIn(res.body.data.components);
    expect(text).toContain('/expense add');
    expect(text).toContain('Confirm');
  });

  it('mutating commands are rejected in the bot DM; reads resolve the single ledger', async () => {
    await recordDinner();
    const addInDm = await send(slash('expense', { sub: 'add', user: ALICE, context: 1, channelId: 'dm1' }));
    expect(textIn(addInDm.body.data.components)).toContain('group chat');

    const balanceInDm = await send(slash('balance', { user: ALICE, context: 1, channelId: 'dm1' }));
    expect(textIn(balanceInDm.body.data.components)).toContain(`<@${ALICE.id}>  is owed`);
  });
});
