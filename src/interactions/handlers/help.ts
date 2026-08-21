import { container, separator, text } from '../../discord/components';
import { channelMessage } from '../../discord/responses';

const GUIDE = `📖  **geemoney — quick guide**

**\`/expense add\`** — record a shared expense:
• **Fastest**: \`amount: 12.50\` \`description: Pizza\` and press enter. A picker pops up pre-filled with this chat's roster — adjust if needed, then tap **Split equally** (or a custom split). Use \`except: @cara\` to leave someone out without touching the picker.
• **Explicit**: add \`with: @alice @bob\` to name the people yourself. Whoever paid is **included automatically** (payer defaults to you; override with \`paid_by\`). Optional: \`split\` + \`values\` for non-equal splits (comma-separated, @mention order, payer's value last if you didn't mention them), and \`payer_shares: False\` if the payer only fronted the money.
• **\`/roster\`** — view or change who “everyone” means in this chat (it learns from your expenses too).
• **Custom splits** open a form with one box per person — fill them in, leave one empty and it gets the remainder, or put \`0\` for someone who owes nothing. (Groups over 5 get a single comma-separated box instead.)
• **Form**: leave every slot empty and press enter — a pop-up form collects the same things with pickers.
• **In a 1-on-1 DM** you can skip \`with\` entirely: \`/expense add amount: 20 description: ticket\` records that you paid and they owe the full amount. Add \`payer_shares: True\` to split it two ways instead.

**\`/balance\`** — who owes whom, plus suggested pay-backs. Only you see it unless you set \`share: True\`. Add \`with: @someone\` for just the two of you.

**\`/settle to: @someone\`** — record "I paid you back". Leave the amount empty to settle everything you owe them. It only counts after **they** tap ✓ Confirm on the prompt.

**\`/history\`** — browse every expense, newest first. Filter with \`with: @someone\`.

**\`/expense edit\` / \`/expense delete\`** — fix mistakes. Start typing a description or #id and pick from the suggestions. Deleting a settlement is how you undo one.`;

const TIPS = `**Tips**
• Amounts are plain numbers like \`12.50\` (up to 2 decimals).
• Friends who haven't installed the app can still see receipts and tap every button — including ✓ Confirm — they just can't type commands until they install.
• Anything that changes the ledger posts a public receipt; lookups stay private to you.`;

export function handleHelp(): Response {
  return channelMessage([container([text(GUIDE), separator(), text(TIPS)])], { ephemeral: true });
}
