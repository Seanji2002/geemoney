import { describe, expect, it } from 'vitest';
import { allocate, buildShares, parseSplitValues } from '../../src/domain/split';

const users = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => String(100000000000000000n + BigInt(i)));

describe('allocate (largest remainder)', () => {
  it('splits $10.00 three ways as 334/333/333', () => {
    const shares = allocate(1000, users(3).map((userId) => ({ userId, weight: 1 })), 0);
    expect([...shares].sort((a, b) => b - a)).toEqual([334, 333, 333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('always sums exactly to the total with max 1-cent deviation', () => {
    for (const total of [1, 7, 99, 1000, 12345, 999999, 10_000_000]) {
      for (const n of [1, 2, 3, 5, 7, 10]) {
        const shares = allocate(total, users(n).map((userId) => ({ userId, weight: 1 })), total);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        const ideal = total / n;
        for (const s of shares) expect(Math.abs(s - ideal)).toBeLessThan(1);
      }
    }
  });

  it('rotates who gets the extra cent as the offset changes', () => {
    const participants = users(3).map((userId) => ({ userId, weight: 1 }));
    const winners = new Set<number>();
    for (let offset = 0; offset < 3; offset++) {
      const shares = allocate(100, participants, offset);
      winners.add(shares.findIndex((s) => s === 34));
    }
    expect(winners.size).toBe(3);
  });

  it('is deterministic for the same offset (edit reproducibility)', () => {
    const participants = users(7).map((userId) => ({ userId, weight: 1 }));
    expect(allocate(12347, participants, 42)).toEqual(allocate(12347, participants, 42));
  });

  it('respects weights', () => {
    const [a, b] = users(2);
    const shares = allocate(3000, [
      { userId: a!, weight: 2 },
      { userId: b!, weight: 1 },
    ], 0);
    expect(shares).toEqual([2000, 1000]);
  });
});

describe('parseSplitValues', () => {
  const ids = users(3);

  it('equal ignores the raw text', () => {
    const result = parseSplitValues('equal', '', ids, 1000, 0, 'USD');
    expect(result.ok && result.owedCents.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('exact accepts values summing to the total', () => {
    const result = parseSplitValues('exact', '12.50, 10.45, 8.25', ids, 3120, 0, 'USD');
    expect(result).toEqual({ ok: true, owedCents: [1250, 1045, 825] });
  });

  it('exact reports the signed delta', () => {
    const short = parseSplitValues('exact', '10.00, 10.00, 10.00', ids, 3120, 0, 'USD');
    expect(!short.ok && short.error).toContain('short by $1.20');
    const over = parseSplitValues('exact', '11.00, 11.00, 10.00', ids, 3120, 0, 'USD');
    expect(!over.ok && over.error).toContain('over by $0.80');
  });

  it('exact rejects a wrong count of values', () => {
    const result = parseSplitValues('exact', '10.00, 21.20', ids, 3120, 0, 'USD');
    expect(!result.ok && result.error).toContain('exactly 3');
  });

  it('exact accepts an explicit 0 as "owes nothing"', () => {
    const result = parseSplitValues('exact', '0, 15.60, 15.60', ids, 3120, 0, 'USD');
    expect(result).toEqual({ ok: true, owedCents: [0, 1560, 1560] });
    expect(parseSplitValues('exact', '0.00, $0, 31.20', ids, 3120, 0, 'USD')).toEqual({
      ok: true,
      owedCents: [0, 0, 3120],
    });
  });

  it('percent must total exactly 100', () => {
    const bad = parseSplitValues('percent', '50, 25, 24.9', ids, 1000, 0, 'USD');
    expect(!bad.ok && bad.error).toContain('off by 0.1%');
    const good = parseSplitValues('percent', '50, 25, 25', ids, 1000, 0, 'USD');
    expect(good).toEqual({ ok: true, owedCents: [500, 250, 250] });
  });

  it('percent handles cent-lossy ratios via largest remainder', () => {
    const result = parseSplitValues('percent', '33.33, 33.33, 33.34', ids, 100, 0, 'USD');
    expect(result.ok && result.owedCents.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('explicit zero weights are allowed for percent and shares', () => {
    expect(parseSplitValues('percent', '0, 50, 50', ids, 1000, 0, 'USD')).toEqual({
      ok: true,
      owedCents: [0, 500, 500],
    });
    expect(parseSplitValues('shares', '2, 0, 1', ids, 900, 0, 'USD')).toEqual({
      ok: true,
      owedCents: [600, 0, 300],
    });
    expect(parseSplitValues('shares', '0, 0, 0', ids, 900, 0, 'USD').ok).toBe(false);
  });

  it('rejects ACCIDENTAL zero-cent shares from rounding (DB CHECK would abort)', () => {
    // $0.05 equally among 6 people: someone must land on $0.00.
    const six = users(6);
    const equal = parseSplitValues('equal', '', six, 5, 0, 'USD');
    expect(!equal.ok && equal.error).toContain('$0.00');

    // 1% of $0.50 rounds to 0 or 1 cent depending on the rotation offset —
    // both must reject or both must succeed consistently; the 0-cent case
    // must never reach the database.
    const two = users(2);
    for (const offset of [0, 1]) {
      const result = parseSplitValues('percent', '1, 99', two, 50, offset, 'USD');
      if (!result.ok) {
        expect(result.error).toContain('$0.00');
      } else {
        expect(result.owedCents.every((c) => c > 0)).toBe(true);
      }
    }

    const lopsided = parseSplitValues('shares', '1000, 1', two, 100, 0, 'USD');
    expect(lopsided.ok).toBe(false);
  });

  it('shares uses integer weights', () => {
    const result = parseSplitValues('shares', '2, 1, 1', ids, 1000, 0, 'USD');
    expect(result.ok && result.owedCents).toEqual([500, 250, 250]);
    expect(parseSplitValues('shares', '2, 1.5, 1', ids, 1000, 0, 'USD').ok).toBe(false);
    expect(parseSplitValues('shares', '2, 1001, 1', ids, 1000, 0, 'USD').ok).toBe(false);
  });
});

describe('buildShares', () => {
  const [a, b, c] = users(3) as [string, string, string];

  it('payer inside the split keeps their own share', () => {
    const rows = buildShares(1000, a, [a, b], [500, 500]);
    expect(rows).toContainEqual({ userId: a, paidCents: 1000, owedCents: 500 });
    expect(rows).toContainEqual({ userId: b, paidCents: 0, owedCents: 500 });
  });

  it('payer outside the split pays without owing', () => {
    const rows = buildShares(1000, c, [a, b], [500, 500]);
    expect(rows).toContainEqual({ userId: c, paidCents: 1000, owedCents: 0 });
    expect(rows).toHaveLength(3);
  });

  it('omits rows for participants with an explicit 0 share', () => {
    const rows = buildShares(1000, a, [a, b, c], [500, 500, 0]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === c)).toBeUndefined();
    const covered = buildShares(1000, a, [a, b], [0, 1000]);
    expect(covered).toContainEqual({ userId: a, paidCents: 1000, owedCents: 0 });
    expect(covered).toContainEqual({ userId: b, paidCents: 0, owedCents: 1000 });
  });

  it('enforces the paid = owed = total invariant', () => {
    expect(() => buildShares(1000, a, [a, b], [500, 400])).toThrow(/invariant/);
  });
});
