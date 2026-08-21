import { MessageFlags, ResponseType } from './types';

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

export function pong(): Response {
  return json({ type: ResponseType.Pong });
}

export interface MessageOptions {
  ephemeral?: boolean;
}

/**
 * Components V2 message payload. `components` is the full top-level tree
 * (containers, text displays, action rows). Mentions render but never ping.
 */
function messageData(components: unknown[], opts: MessageOptions = {}) {
  return {
    flags: MessageFlags.IsComponentsV2 | (opts.ephemeral ? MessageFlags.Ephemeral : 0),
    components,
    allowed_mentions: { parse: [] },
  };
}

export function channelMessage(components: unknown[], opts: MessageOptions = {}): Response {
  return json({ type: ResponseType.ChannelMessageWithSource, data: messageData(components, opts) });
}

/** Edits the message the interaction came from (component clicks, message-launched modal submits). */
export function updateMessage(components: unknown[]): Response {
  return json({
    type: ResponseType.UpdateMessage,
    data: {
      flags: MessageFlags.IsComponentsV2,
      components,
      allowed_mentions: { parse: [] },
    },
  });
}

export function modal(customId: string, title: string, components: unknown[]): Response {
  return json({ type: ResponseType.Modal, data: { custom_id: customId, title, components } });
}

export interface AutocompleteChoice {
  name: string;
  value: string;
}

export function autocomplete(choices: AutocompleteChoice[]): Response {
  return json({ type: ResponseType.AutocompleteResult, data: { choices: choices.slice(0, 25) } });
}

/** Follow-up / webhook message body (same shape as an initial CV2 message). */
export function followUpBody(components: unknown[], opts: MessageOptions = {}): unknown {
  return messageData(components, opts);
}
