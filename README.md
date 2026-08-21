# geemoney

Bill splitting for friend groups as a Discord app. Install it to your account and use it
in your group DM, a DM with a friend, or any server — it never joins a server as a bot.

## Features

- **Record expenses** — `/expense add` with slots (`amount`, `description`, `with:` @mentions)
  or leave the slots empty for a pop-up form. Whoever paid is included in the split
  automatically; set `paid_by` if it wasn't you.
- **Split any way** — equally, exact amounts, percentages, or shares. A `0` means that
  person owes nothing; `payer_shares: False` means the payer only fronted the money.
- **1-on-1 DM shorthand** — `/expense add amount: 20 description: ticket` records that you
  paid and the other person owes the full amount.
- **Balances** — `/balance` shows who owes whom and suggested pay-backs (private by default,
  `share: True` to post it). `/balance with: @someone` for just the two of you.
- **Settle up** — `/settle to: @someone [amount]` records a pay-back; it counts once the
  recipient taps ✓ Confirm.
- **History** — `/history` browses everything, newest first; `/expense edit` and
  `/expense delete` fix mistakes (with autocomplete).
- **Help** — `/help` for a quick guide in Discord.

Everyone is identified by Discord user ID, amounts are exact to the cent, and each chat
keeps its own ledger.
