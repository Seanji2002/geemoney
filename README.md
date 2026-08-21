# geemoney

Bill splitting for friend groups as a Discord app. Install it to your account and use it
in your group DM, a DM with a friend, or any server — it never joins a server as a bot.

## Install

1. Open **https://discord.com/oauth2/authorize?client_id=1538767713772511242** and choose
   **Add to my apps**. That's it — no server setup, nothing to download.
2. Go to any chat (your group DM works great), type `/`, and the geemoney commands appear.
   If they don't show up right away, press Ctrl+R (or restart the app on mobile).
3. Friends who want to *type* commands install it the same way. Friends who don't can still
   see every receipt and tap every button, including confirming settlements.

Start with `/add`, then `/help` any time you need a reminder.

## Features

- **Record expenses in two slots and a click** — `/add amount: 30 description: ramen`
  opens a picker pre-filled with the chat's roster; tap **Split equally** and you're done.
  Add `except: @cara` to leave someone out, or `with: @alice @bob` to name people yourself.
  Leave every slot empty for a pop-up form instead. Whoever paid is included automatically;
  set `paid_by` if it wasn't you.
- **Add straight from a message** — someone typed “pizza 42.50”? Right-click / long-press it →
  Apps → **Add as expense**. Amount, description, and payer are filled in; you just confirm.
- **Every receipt shows the new balances** — no need to ask who owes whom after each expense.
- **A roster per chat** — `/roster` sets who "everyone" means; it also learns from the
  expenses you record.
- **Split any way** — equally, exact amounts, percentages, or shares. Custom splits give you
  one box per person (leave one empty for the remainder); a `0` means that person owes
  nothing, and `payer_shares: False` means the payer only fronted the money.
- **1-on-1 DM shorthand** — `/add amount: 20 description: ticket` records that you
  paid and the other person owes the full amount.
- **Balances** — `/balance` shows who owes whom and suggested pay-backs (private by default,
  `share: True` to post it). `/balance with: @someone` for just the two of you.
- **Settle up with one tap** — `/balance` shows a **Pay** button for each of your debts; tap it
  and the recipient confirms. (`/settle to: @someone [amount]` still works too.)
- **Fix mistakes in place** — every receipt has **Edit** and **Undo** buttons; `/history`
  browses everything, and `/delete` removes an old expense (with autocomplete).
- **Help** — `/help` for a quick guide in Discord.

Everyone is identified by Discord user ID, amounts are exact to the cent, and each chat
keeps its own ledger.

## How it works

- **A Discord app, not a server bot.** geemoney is user-installable: each person adds it to
  their own account, so it works in group DMs, direct messages, and servers without ever
  being added as a member anywhere.
- **Slash commands over HTTP.** Discord sends every command, button click, and form submit
  as a signed HTTPS request to a Cloudflare Worker, which verifies the signature and replies
  within a few milliseconds. There is no always-on process.
- **A ledger per chat.** Expenses are stored in Cloudflare D1 (SQLite), keyed by the chat they
  were recorded in. Every expense is a set of per-person rows — what each person paid and
  what they owe — and all writes are atomic, so the books always balance to the cent.
- **Balances are derived, never stored.** Who owes whom is computed from the expense rows on
  demand. Settling up is just another expense that the recipient has to confirm.
- **Shipped by CI.** Every change is typechecked and tested in GitHub Actions; merges to
  `main` deploy to Cloudflare automatically — nothing deploys from a laptop.

