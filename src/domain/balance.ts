export interface ExpenseShares {
  expenseId: number;
  shares: { userId: string; paidCents: number; owedCents: number }[];
}

/** Net position per user: positive = is owed, negative = owes. Nets always sum to 0. */
export function computeNets(expenses: ExpenseShares[]): Map<string, number> {
  const nets = new Map<string, number>();
  for (const expense of expenses) {
    for (const share of expense.shares) {
      nets.set(share.userId, (nets.get(share.userId) ?? 0) + share.paidCents - share.owedCents);
    }
  }
  return nets;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Pairwise debts: for each expense every ower owes their share to that
 * expense's payer (the user with paid_cents > 0 — single payer in v1).
 * Confirmed settlements flow through the same arithmetic: the debtor "paid"
 * and the creditor "owes", which nets the debt down.
 *
 * Returns a map keyed "lowId|highId" → cents owed by lowId to highId
 * (negative = highId owes lowId). Zero entries are dropped.
 */
export function computePairwise(expenses: ExpenseShares[]): Map<string, number> {
  const pairs = new Map<string, number>();
  for (const expense of expenses) {
    const payer = expense.shares.reduce(
      (best, s) => (s.paidCents > (best?.paidCents ?? 0) ? s : best),
      undefined as ExpenseShares['shares'][number] | undefined,
    );
    if (!payer) continue;
    for (const share of expense.shares) {
      if (share.userId === payer.userId || share.owedCents === 0) continue;
      const key = pairKey(share.userId, payer.userId);
      const direction = share.userId < payer.userId ? 1 : -1;
      pairs.set(key, (pairs.get(key) ?? 0) + direction * share.owedCents);
    }
  }
  for (const [key, cents] of pairs) if (cents === 0) pairs.delete(key);
  return pairs;
}

/** Cents `debtor` currently owes `creditor` (0 if even or owed the other way). */
export function pairwiseDebt(expenses: ExpenseShares[], debtor: string, creditor: string): number {
  const pairs = computePairwise(expenses);
  const cents = pairs.get(pairKey(debtor, creditor)) ?? 0;
  const owedByLow = debtor < creditor ? cents : -cents;
  return Math.max(0, owedByLow);
}

export interface SettleSuggestion {
  from: string;
  to: string;
  cents: number;
}

/** Flattens the pairwise map into "A pays B" suggestion lines. */
export function settleSuggestions(pairs: Map<string, number>): SettleSuggestion[] {
  const suggestions: SettleSuggestion[] = [];
  for (const [key, cents] of pairs) {
    if (cents === 0) continue;
    const [low, high] = key.split('|') as [string, string];
    suggestions.push(cents > 0 ? { from: low, to: high, cents } : { from: high, to: low, cents: -cents });
  }
  suggestions.sort((a, b) => b.cents - a.cents);
  return suggestions;
}
