import type { Env } from '../../config';
import type { Interaction } from '../../discord/types';
import { InteractionContext, invokerOf } from '../../discord/types';
import { container, text } from '../../discord/components';
import { followUpBody } from '../../discord/responses';
import { discordRest } from '../../discord/rest';
import { claimFirstUse, claimTipSlot } from '../../db/hints';
import { nowSeconds } from '../common';

const GUIDE = [
  '👋  **First time here? 20-second tour**',
  '• `/add amount: 30 description: ramen` → a picker with everyone pre-selected → tap **Split equally**. Done.',
  '• Every receipt ends with who owes whom; `/balance` has **Pay** buttons to settle in one tap (they confirm).',
  '• Made a mistake? **Edit** / **Undo** are right on the receipt. `/help` has the rest.',
].join('\n');

const TIPS = [
  '💡 Tip: the receipt already shows who owes whom — when it’s time to pay up, `/balance` gives you a one-tap **Pay** button.',
  '💡 Tip: typo? Tap **Edit** on the receipt. Wrong expense? **Undo**. No need to hunt for it.',
  '💡 Tip: someone absent? `except: @name` skips them for one expense; `/roster` changes who “everyone” means.',
];

/** Ephemeral one-time tour, posted as a follow-up the first time someone uses the app in a chat. */
export function maybeShowGuide(i: Interaction, env: Env): Promise<void> {
  if (i.context === InteractionContext.BotDM || !i.channel_id) return Promise.resolve();
  return (async () => {
    const first = await claimFirstUse(env.DB, i.channel_id!, invokerOf(i).id, nowSeconds());
    if (!first || i.data?.name === 'help') return;
    await discordRest.postFollowUp(
      env.DISCORD_APP_ID,
      i.token,
      followUpBody([container([text(GUIDE)])], { ephemeral: true }),
    );
  })();
}

/** A few rotating next-step tips after recording an expense, then silence. */
export function maybeShowTip(i: Interaction, env: Env, ledgerId: string): Promise<void> {
  return (async () => {
    const slot = await claimTipSlot(env.DB, ledgerId, invokerOf(i).id, TIPS.length);
    if (slot === null) return;
    await discordRest.postFollowUp(
      env.DISCORD_APP_ID,
      i.token,
      followUpBody([text(TIPS[slot]!)], { ephemeral: true }),
    );
  })();
}
