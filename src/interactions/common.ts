import type { Env } from '../config';
import type { CommandOptionValue, Interaction, ModalSubmitNode } from '../discord/types';
import { InteractionContext } from '../discord/types';
import { channelMessage } from '../discord/responses';
import { notice } from './render';

export function ephemeralNotice(content: string): Response {
  return channelMessage(notice(content), { ephemeral: true });
}

/** Group-chat guard for mutating commands (contexts registration is the primary gate). */
export function rejectBotDm(i: Interaction): Response | null {
  if (i.context === InteractionContext.BotDM) {
    return ephemeralNotice('Run this in your group chat — the ledger lives where the group can see it.');
  }
  return null;
}

export function subcommandOf(i: Interaction): { name: string; options: CommandOptionValue[] } | null {
  const first = i.data?.options?.[0];
  if (first && first.type === 1) return { name: first.name, options: first.options ?? [] };
  return null;
}

export function optionValue(
  options: CommandOptionValue[] | undefined,
  name: string,
): string | number | boolean | undefined {
  return options?.find((o) => o.name === name)?.value;
}

/** Flattens a modal submit's component tree into custom_id → node. */
export function collectModalInputs(nodes: ModalSubmitNode[]): Map<string, ModalSubmitNode> {
  const map = new Map<string, ModalSubmitNode>();
  const walk = (node: ModalSubmitNode): void => {
    if (node.custom_id && (node.value !== undefined || node.values !== undefined)) {
      map.set(node.custom_id, node);
    }
    if (node.component) walk(node.component);
    if (node.components) node.components.forEach(walk);
  };
  nodes.forEach(walk);
  return map;
}

export function inputString(map: Map<string, ModalSubmitNode>, id: string): string {
  const node = map.get(id);
  return (node?.value ?? node?.values?.[0] ?? '').trim();
}

export function inputValues(map: Map<string, ModalSubmitNode>, id: string): string[] {
  const node = map.get(id);
  if (node?.values) return node.values;
  return node?.value ? [node.value] : [];
}

export function ledgerIdOf(i: Interaction): string {
  if (!i.channel_id) throw new Error('interaction has no channel_id');
  return i.channel_id;
}

export async function ledgerCurrency(env: Env, ledgerId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT currency FROM ledgers WHERE channel_id = ?1')
    .bind(ledgerId)
    .first<{ currency: string }>();
  return row?.currency ?? env.DEFAULT_CURRENCY;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Rejects bot accounts selected as participants or payer. */
export function botsAmong(i: Interaction, userIds: string[]): string[] {
  const resolved = i.data?.resolved?.users ?? {};
  return userIds.filter((id) => resolved[id]?.bot === true);
}

export function usernameOf(i: Interaction, userId: string, storedName?: string): string {
  const user = i.data?.resolved?.users?.[userId];
  return user?.global_name || user?.username || storedName || `user-${userId.slice(-4)}`;
}
