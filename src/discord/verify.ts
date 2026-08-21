import { verifyKey } from 'discord-interactions';

/** Single seam over the official verifier so tests can exercise the real path. */
export async function verifyRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !timestamp) return false;
  try {
    return await verifyKey(rawBody, signature, timestamp, publicKey);
  } catch {
    return false;
  }
}
