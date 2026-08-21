// Single source of truth for the command contract — imported by the Worker's
// router (names/option parsing) and by scripts/register.ts (REST registration).
//
// integration_types: [1] = USER_INSTALL only; the app is never joinable to a
// server. contexts: 0 = server channels (user-installed commands work there
// without the bot joining), 1 = the bot's own DM, 2 = DMs and group DMs.
// Mutating commands omit context 1 so Discord hides them in the bot DM.

const USER_INSTALL = [1];
const EVERYWHERE = [0, 1, 2];
const SHARED_CHATS_ONLY = [0, 2];

const ADD_OPTIONS = [
      {
        type: 3,
        name: 'amount',
        description: 'Total paid, like 12.50',
        required: false,
      },
      {
        type: 3,
        name: 'description',
        description: 'What was it for? e.g. Pizza night',
        required: false,
        autocomplete: true,
      },
      {
        type: 3,
        name: 'with',
        description: 'Who shares the cost — @mention them; leave empty to pick from this chat’s roster',
        required: false,
      },
      {
        type: 3,
        name: 'except',
        description: 'Leave these people out — @mention them, e.g. @cara',
        required: false,
      },
      {
        type: 6,
        name: 'paid_by',
        description: 'Who paid (default: you)',
        required: false,
      },
      {
        type: 3,
        name: 'split',
        description: 'How to split (default: equally)',
        required: false,
        choices: [
          { name: 'Equally', value: 'equal' },
          { name: 'Exact amounts', value: 'exact' },
          { name: 'Percentages', value: 'percent' },
          { name: 'Shares', value: 'shares' },
        ],
      },
      {
        type: 3,
        name: 'values',
        description: 'Values for exact/percent/shares, comma-separated: @mention order, payer last if not mentioned',
        required: false,
      },
      {
        type: 5,
        name: 'payer_shares',
        description: 'Set False if the payer is not splitting (paid for the others only)',
        required: false,
      },
];

export const commandDefinitions = [
  {
    name: 'expense',
    type: 1,
    description: 'Add, edit, or delete a shared expense',
    integration_types: USER_INSTALL,
    contexts: SHARED_CHATS_ONLY,
    options: [
      {
        type: 1,
        name: 'add',
        description: 'Record a shared expense (fill the slots, or leave them empty for a form)',
        options: ADD_OPTIONS,
      },
      {
        type: 1,
        name: 'edit',
        description: "Edit an expense in this chat's ledger",
        options: [
          {
            type: 3,
            name: 'id',
            description: 'Which expense? Start typing a description or #id',
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        type: 1,
        name: 'delete',
        description: 'Delete an expense or settlement',
        options: [
          {
            type: 3,
            name: 'id',
            description: 'Which expense? Start typing a description or #id',
            required: true,
            autocomplete: true,
          },
        ],
      },
    ],
  },
  {
    name: 'balance',
    type: 1,
    description: 'Who owes whom',
    integration_types: USER_INSTALL,
    contexts: EVERYWHERE,
    options: [
      {
        type: 6,
        name: 'with',
        description: 'Show detail between you and this person',
        required: false,
      },
      {
        type: 5,
        name: 'share',
        description: 'Post publicly to the chat (default: only you see it)',
        required: false,
      },
    ],
  },
  {
    name: 'settle',
    type: 1,
    description: 'Record that you paid someone back',
    integration_types: USER_INSTALL,
    contexts: SHARED_CHATS_ONLY,
    options: [
      {
        type: 6,
        name: 'to',
        description: 'Who you paid',
        required: true,
      },
      {
        type: 3,
        name: 'amount',
        description: 'Amount like 12.50 (default: everything you owe them)',
        required: false,
      },
    ],
  },
  {
    name: 'history',
    type: 1,
    description: 'Browse the ledger',
    integration_types: USER_INSTALL,
    contexts: EVERYWHERE,
    options: [
      {
        type: 6,
        name: 'with',
        description: 'Only expenses involving this person',
        required: false,
      },
    ],
  },
  {
    name: 'add',
    type: 1,
    description: 'Shortcut for /expense add',
    integration_types: USER_INSTALL,
    contexts: SHARED_CHATS_ONLY,
    options: ADD_OPTIONS,
  },
  {
    name: 'roster',
    type: 1,
    description: 'Who “everyone” means in this chat — view or change the people expenses default to',
    integration_types: USER_INSTALL,
    contexts: SHARED_CHATS_ONLY,
  },
  {
    name: 'help',
    type: 1,
    description: 'How to use geemoney — commands, splits, settling up',
    integration_types: USER_INSTALL,
    contexts: EVERYWHERE,
  },
];
