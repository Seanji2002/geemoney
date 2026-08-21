import type { Env } from './config';
import { autocomplete, pong } from './discord/responses';
import { verifyRequest } from './discord/verify';
import type { Interaction } from './discord/types';
import { InteractionType } from './discord/types';
import { ephemeralNotice } from './interactions/common';
import { routeInteraction } from './interactions/router';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') return new Response('geemoney ok');

    const body = await req.text();
    const valid = await verifyRequest(
      body,
      req.headers.get('x-signature-ed25519'),
      req.headers.get('x-signature-timestamp'),
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) return new Response('invalid request signature', { status: 401 });

    const interaction = JSON.parse(body) as Interaction;
    if (interaction.type === InteractionType.Ping) return pong();

    try {
      const response = await routeInteraction(interaction, env, ctx);
      console.log(
        JSON.stringify({
          type: interaction.type,
          name: interaction.data?.name ?? interaction.data?.custom_id,
          channel: interaction.channel_id,
          user: (interaction.member?.user ?? interaction.user)?.id,
        }),
      );
      return response;
    } catch (err) {
      console.error('interaction failed', err);
      // Autocomplete interactions only accept a type-8 response.
      if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
        return autocomplete([]);
      }
      return ephemeralNotice('Something went wrong — nothing was recorded.');
    }
  },
} satisfies ExportedHandler<Env>;
