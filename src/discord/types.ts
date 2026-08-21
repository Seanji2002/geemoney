// Self-owned Discord wire types covering exactly what geemoney sends and reads.
// We deliberately do not depend on a types package for the 2025-26 component
// additions (Label, Radio Group, selects-in-modals) — we own the JSON.

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5,
} as const;

export const ResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  AutocompleteResult: 8,
  Modal: 9,
} as const;

export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  TextDisplay: 10,
  Separator: 14,
  Container: 17,
  Label: 18,
  RadioGroup: 21,
} as const;

export const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
} as const;

export const TextInputStyle = {
  Short: 1,
  Paragraph: 2,
} as const;

export const MessageFlags = {
  Ephemeral: 1 << 6,
  IsComponentsV2: 1 << 15,
} as const;

export const InteractionContext = {
  Guild: 0,
  BotDM: 1,
  PrivateChannel: 2,
} as const;

export const CommandOptionType = {
  SubCommand: 1,
  SubCommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
} as const;

export interface APIUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface APIMessageLite {
  id: string;
  content: string;
  author: APIUser;
}

export interface ResolvedData {
  users?: Record<string, APIUser>;
  messages?: Record<string, APIMessageLite>;
}

export interface CommandOptionValue {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOptionValue[];
  focused?: boolean;
}

export interface CommandData {
  name: string;
  /** 1 = slash command, 2 = user context menu, 3 = message context menu. */
  type: number;
  options?: CommandOptionValue[];
  resolved?: ResolvedData;
  /** Target message/user id for context-menu commands. */
  target_id?: string;
}

export interface ComponentData {
  custom_id: string;
  component_type: number;
  values?: string[];
  resolved?: ResolvedData;
}

/**
 * Modal submits mirror the modal's component tree; nodes may nest via
 * `component` (Label child) or `components` (rows). We walk it generically.
 */
export interface ModalSubmitNode {
  type: number;
  custom_id?: string;
  value?: string;
  values?: string[];
  component?: ModalSubmitNode;
  components?: ModalSubmitNode[];
}

export interface ModalSubmitData {
  custom_id: string;
  components: ModalSubmitNode[];
  resolved?: ResolvedData;
}

export const ChannelType = {
  DM: 1,
  GroupDM: 3,
} as const;

export interface PartialChannel {
  id: string;
  type: number;
  /** Present on some DM payloads; never rely on it exclusively. */
  recipients?: APIUser[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  channel?: PartialChannel;
  guild_id?: string;
  /** 0 = guild, 1 = the bot's own DM, 2 = DM/group DM. */
  context?: number;
  user?: APIUser;
  member?: { user: APIUser };
  data?: CommandData & ComponentData & ModalSubmitData;
  /** Present on component interactions and on modal submits launched from a message. */
  message?: { id: string };
}

export function invokerOf(i: Interaction): APIUser {
  const user = i.member?.user ?? i.user;
  if (!user) throw new Error('interaction has no user');
  return user;
}
