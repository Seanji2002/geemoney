const API = 'https://discord.com/api/v10';

/**
 * Posts a follow-up message on an interaction token. Runs inside ctx.waitUntil
 * after the initial response has been returned; the short delay keeps us from
 * racing Discord's processing of that initial response. If it ultimately fails
 * we log and accept it — the ledger already committed and /history is the
 * source of truth.
 */
async function postFollowUp(appId: string, token: string, body: unknown): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API}/webhooks/${appId}/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      console.error('follow-up failed', res.status, await res.text());
    } catch (err) {
      console.error('follow-up error', err);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

/** Namespace object (not bare exports) so tests can stub the network seam. */
export const discordRest = { postFollowUp };
