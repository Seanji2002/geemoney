import type { Env } from '../../config';
import { MAX_PARTICIPANTS } from '../../config';
import type { Interaction } from '../../discord/types';
import { container, messageUserSelect, row, text } from '../../discord/components';
import { channelMessage, updateMessage } from '../../discord/responses';
import { getRoster, setRoster } from '../../db/roster';
import { botsAmong, ledgerIdOf, nowSeconds, rejectBotDm, usernameOf } from '../common';
import { customIds } from '../customId';
import { rosterView } from '../render';

function rosterComponents(memberIds: string[], saved: boolean, error?: string): unknown[] {
  const body = rosterView(memberIds, saved) + (error ? `\n⚠️ ${error}` : '');
  return [
    container([text(body)]),
    row(
      messageUserSelect({
        customId: customIds.roster(),
        minValues: 0,
        maxValues: MAX_PARTICIPANTS,
        placeholder: 'Choose who “everyone” means here',
        defaultUserIds: memberIds,
      }),
    ),
  ];
}

export async function handleRoster(i: Interaction, env: Env): Promise<Response> {
  const guard = rejectBotDm(i);
  if (guard) return guard;
  const members = await getRoster(env.DB, ledgerIdOf(i));
  return channelMessage(rosterComponents(members.map((m) => m.id), false), { ephemeral: true });
}

export async function handleRosterSelect(i: Interaction, env: Env): Promise<Response> {
  const chosen = [...new Set(i.data?.values ?? [])];
  const bots = botsAmong(i, chosen);
  if (bots.length > 0) {
    return updateMessage(rosterComponents(chosen.filter((id) => !bots.includes(id)), false, 'Bots can’t be on the roster.'));
  }
  await setRoster(
    env.DB,
    ledgerIdOf(i),
    chosen.map((id) => ({ id, username: usernameOf(i, id) })),
    nowSeconds(),
  );
  return updateMessage(rosterComponents(chosen, true));
}
