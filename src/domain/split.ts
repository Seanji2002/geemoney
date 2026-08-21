import { formatCents, parseAmount } from './money';

export type SplitMethod = 'equal' | 'exact' | 'percent' | 'shares';

export type SplitResult = { ok: true; owedCents: number[] } | { ok: false; error: string };

/** Numeric-string comparison for snowflakes (they exceed 2^53). */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Largest-remainder allocation of `totalCents` over positive integer weights.
 * Guarantees the shares sum to the total exactly, each within 1 cent of the
 * ideal. Ties for the extra cent go by ascending snowflake, rotated by
 * `rotationOffset` (we pass the expense's created_at) so the same person
 * doesn't eat the extra cent every time — and so an edit that changes nothing
 * reproduces identical shares from persisted fields alone.
 */
export function allocate(
  totalCents: number,
  participants: { userId: string; weight: number }[],
  rotationOffset: number,
): number[] {
  const n = participants.length;
  if (n === 0) throw new Error('allocate: no participants');
  const totalWeight = participants.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) throw new Error('allocate: non-positive total weight');
  // total*weight stays < 2^53: total <= 1e7 cents, weights <= 1e4 bp / 1e3 shares.
  const base = participants.map((p) => Math.floor((totalCents * p.weight) / totalWeight));
  const remainder = participants.map((p) => (totalCents * p.weight) % totalWeight);
  let extra = totalCents - base.reduce((sum, b) => sum + b, 0);

  const bySnowflake = participants
    .map((p, idx) => ({ idx, userId: p.userId }))
    .sort((a, b) => compareSnowflakes(a.userId, b.userId));
  const tieRank = new Array<number>(n);
  const k = ((rotationOffset % n) + n) % n;
  bySnowflake.forEach((entry, pos) => {
    tieRank[entry.idx] = (pos - k + n) % n;
  });

  const order = participants
    .map((_, idx) => idx)
    .sort((a, b) => remainder[b]! - remainder[a]! || tieRank[a]! - tieRank[b]!);

  const shares = [...base];
  for (const idx of order) {
    if (extra === 0) break;
    shares[idx]! += 1;
    extra -= 1;
  }
  return shares;
}

/**
 * Parses the stage-2 comma-separated values for a split method and returns
 * each participant's owed cents (already summing exactly to the total).
 */
/**
 * An explicit zero (weight 0 / "0" amount) is allowed and means "owes
 * nothing" — e.g. the payer covering everyone. But a NON-zero weight that
 * rounds down to 0 cents is an accident (the total is too small), so reject
 * it instead of silently dropping someone.
 */
function rejectRoundedToZero(owedCents: number[], weights: number[]): SplitResult {
  if (owedCents.some((c, i) => c <= 0 && weights[i]! > 0)) {
    return {
      ok: false,
      error:
        "The total is too small for this split — someone's share rounds to $0.00. Raise the amount, adjust the weights, or give them an explicit 0.",
    };
  }
  return { ok: true, owedCents };
}

const ZERO_RE = /^0+(\.0{1,2})?$/;

export function parseSplitValues(
  method: SplitMethod,
  raw: string,
  participantIds: string[],
  totalCents: number,
  rotationOffset: number,
  currency: string,
): SplitResult {
  const n = participantIds.length;
  if (method === 'equal') {
    const weights = participantIds.map(() => 1);
    return rejectRoundedToZero(
      allocate(totalCents, participantIds.map((userId, i) => ({ userId, weight: weights[i]! })), rotationOffset),
      weights,
    );
  }

  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== n || parts.some((p) => p.length === 0)) {
    return { ok: false, error: `Enter exactly ${n} comma-separated values, one per person in the listed order.` };
  }

  if (method === 'exact') {
    const cents: number[] = [];
    for (const part of parts) {
      if (ZERO_RE.test(part.replace(/^\$/, ''))) {
        cents.push(0); // explicit "owes nothing"
        continue;
      }
      const parsed = parseAmount(part);
      if (!parsed.ok) return { ok: false, error: `"${part}": ${parsed.error}` };
      cents.push(parsed.cents);
    }
    const sum = cents.reduce((a, b) => a + b, 0);
    if (sum !== totalCents) {
      const delta = totalCents - sum;
      const side = delta > 0 ? `short by ${formatCents(delta, currency)}` : `over by ${formatCents(-delta, currency)}`;
      return {
        ok: false,
        error: `Your amounts sum to ${formatCents(sum, currency)} but the total is ${formatCents(totalCents, currency)} — ${side}.`,
      };
    }
    return { ok: true, owedCents: cents };
  }

  if (method === 'percent') {
    const bps: number[] = [];
    for (const part of parts) {
      const cleaned = part.replace(/%/g, '');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(cleaned)) {
        return { ok: false, error: `"${part}" is not a valid percentage (up to 2 decimal places).` };
      }
      const [whole, frac = ''] = cleaned.split('.');
      const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
      bps.push(bp); // 0% is allowed: that person owes nothing
    }
    const sum = bps.reduce((a, b) => a + b, 0);
    if (sum !== 10_000) {
      const pct = (sum / 100).toFixed(2).replace(/\.?0+$/, '');
      const deltaPct = (Math.abs(10_000 - sum) / 100).toFixed(2).replace(/\.?0+$/, '');
      return { ok: false, error: `Percentages sum to ${pct}% — off by ${deltaPct}%. They must total exactly 100%.` };
    }
    return rejectRoundedToZero(
      allocate(
        totalCents,
        participantIds.map((userId, i) => ({ userId, weight: bps[i]! })),
        rotationOffset,
      ),
      bps,
    );
  }

  // shares
  const weights: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,4}$/.test(part)) return { ok: false, error: `"${part}" is not a whole number of shares.` };
    const w = Number(part);
    if (w > 1000) return { ok: false, error: 'Shares must be between 0 and 1000.' };
    weights.push(w); // 0 shares is allowed: that person owes nothing
  }
  if (weights.every((w) => w === 0)) {
    return { ok: false, error: 'At least one person must hold a share.' };
  }
  return rejectRoundedToZero(
    allocate(
      totalCents,
      participantIds.map((userId, i) => ({ userId, weight: weights[i]! })),
      rotationOffset,
    ),
    weights,
  );
}

export interface ShareRow {
  userId: string;
  paidCents: number;
  owedCents: number;
}

/**
 * Builds the final share rows for an expense: participants owe their split;
 * the payer paid the total (adding to their own row if they also partake).
 * Participants with an explicit 0 share get no row — they owe nothing.
 * Enforces the ledger invariant sum(paid) = sum(owed) = total.
 */
export function buildShares(
  totalCents: number,
  payerId: string,
  participantIds: string[],
  owedCents: number[],
): ShareRow[] {
  const rows = new Map<string, ShareRow>();
  participantIds.forEach((userId, i) => {
    if (owedCents[i]! > 0) rows.set(userId, { userId, paidCents: 0, owedCents: owedCents[i]! });
  });
  const payerRow = rows.get(payerId) ?? { userId: payerId, paidCents: 0, owedCents: 0 };
  payerRow.paidCents = totalCents;
  rows.set(payerId, payerRow);

  const list = [...rows.values()];
  const paidSum = list.reduce((sum, r) => sum + r.paidCents, 0);
  const owedSum = list.reduce((sum, r) => sum + r.owedCents, 0);
  if (paidSum !== totalCents || owedSum !== totalCents) {
    throw new Error(`share invariant violated: paid=${paidSum} owed=${owedSum} total=${totalCents}`);
  }
  return list;
}
