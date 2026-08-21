import type { Env } from '../../config';
import { HISTORY_PAGE_SIZE } from '../../config';
import type { Interaction } from '../../discord/types';
import { button, container, row, separator, text } from '../../discord/components';
import { channelMessage, updateMessage } from '../../discord/responses';
import { historyPage, sharesForExpenses } from '../../db/expenses';
import { optionValue } from '../common';
import { customIds, type ParsedCustomId } from '../customId';
import { historyLine, mention } from '../render';
import { resolveReadLedger } from './balance';

async function historyComponents(
  env: Env,
  ledgerId: string,
  page: number,
  withUser: string | null,
): Promise<unknown[]> {
  const result = await historyPage(env.DB, ledgerId, page, HISTORY_PAGE_SIZE, withUser);
  if (result.rows.length === 0) {
    return [
      container([
        text(
          withUser
            ? `📜  No expenses involving ${mention(withUser)} yet.`
            : '📜  Nothing here yet — start with `/add`.',
        ),
      ]),
    ];
  }
  const shareMap = await sharesForExpenses(env.DB, result.rows.map((r) => r.id));
  const lines = result.rows.map((r) => historyLine(r, shareMap.get(r.id) ?? [])).join('\n');
  const title = withUser ? `📜  History with ${mention(withUser)}` : '📜  History — this chat';
  return [
    container([text(`${title}\n${lines}`), separator()]),
    row(
      button({
        customId: customIds.history(result.page - 1, withUser),
        label: '◀ Prev',
        disabled: result.page <= 1,
      }),
      button({
        customId: `hst-noop:${result.page}`,
        label: `page ${result.page}/${result.totalPages}`,
        disabled: true,
      }),
      button({
        customId: customIds.history(result.page + 1, withUser),
        label: 'Next ▶',
        disabled: result.page >= result.totalPages,
      }),
    ),
  ];
}

export async function handleHistory(i: Interaction, env: Env): Promise<Response> {
  const target = await resolveReadLedger(i, env);
  if ('errorResponse' in target) return target.errorResponse;
  const withUser = optionValue(i.data?.options, 'with');
  const components = await historyComponents(env, target.ledgerId, 1, withUser ? String(withUser) : null);
  return channelMessage(components, { ephemeral: true });
}

export async function handleHistoryButton(
  i: Interaction,
  env: Env,
  parsed: Extract<ParsedCustomId, { op: 'history' }>,
): Promise<Response> {
  // Re-resolve the ledger (covers pagination inside the bot's own DM) and
  // recompute the page fresh and clamped, so stale buttons re-render truth.
  const target = await resolveReadLedger(i, env);
  if ('errorResponse' in target) return target.errorResponse;
  const components = await historyComponents(env, target.ledgerId, parsed.page, parsed.withUser);
  return updateMessage(components);
}
