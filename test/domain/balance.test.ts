import { describe, expect, it } from 'vitest';
import {
  computeNets,
  computePairwise,
  pairwiseDebt,
  settleSuggestions,
  type ExpenseShares,
} from '../../src/domain/balance';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

// A fronts $30 split equally three ways.
const dinner: ExpenseShares = {
  expenseId: 1,
  shares: [
    { userId: A, paidCents: 3000, owedCents: 1000 },
    { userId: B, paidCents: 0, owedCents: 1000 },
    { userId: C, paidCents: 0, owedCents: 1000 },
  ],
};

// B pays A back their $10 (a confirmed settlement).
const payment: ExpenseShares = {
  expenseId: 2,
  shares: [
    { userId: B, paidCents: 1000, owedCents: 0 },
    { userId: A, paidCents: 0, owedCents: 1000 },
  ],
};

describe('computeNets', () => {
  it('nets sum to zero and match paid minus owed', () => {
    const nets = computeNets([dinner]);
    expect(nets.get(A)).toBe(2000);
    expect(nets.get(B)).toBe(-1000);
    expect(nets.get(C)).toBe(-1000);
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('confirmed settlements reduce debt to zero', () => {
    const nets = computeNets([dinner, payment]);
    expect(nets.get(B)).toBe(0);
    expect(nets.get(A)).toBe(1000);
  });
});

describe('computePairwise / pairwiseDebt', () => {
  it('owers owe the payer', () => {
    expect(pairwiseDebt([dinner], B, A)).toBe(1000);
    expect(pairwiseDebt([dinner], A, B)).toBe(0);
    expect(pairwiseDebt([dinner], C, A)).toBe(1000);
    expect(pairwiseDebt([dinner], B, C)).toBe(0);
  });

  it('a settlement zeroes the pairwise debt', () => {
    expect(pairwiseDebt([dinner, payment], B, A)).toBe(0);
    expect(pairwiseDebt([dinner, payment], C, A)).toBe(1000);
  });

  it('overpayment flips the direction', () => {
    const overpay: ExpenseShares = {
      expenseId: 3,
      shares: [
        { userId: B, paidCents: 1500, owedCents: 0 },
        { userId: A, paidCents: 0, owedCents: 1500 },
      ],
    };
    expect(pairwiseDebt([dinner, overpay], B, A)).toBe(0);
    expect(pairwiseDebt([dinner, overpay], A, B)).toBe(500);
  });
});

describe('settleSuggestions', () => {
  it('emits one line per indebted pair, largest first', () => {
    const suggestions = settleSuggestions(computePairwise([dinner, payment]));
    expect(suggestions).toEqual([{ from: C, to: A, cents: 1000 }]);
  });

  it('is empty when everyone is square', () => {
    const cPays: ExpenseShares = {
      expenseId: 4,
      shares: [
        { userId: C, paidCents: 1000, owedCents: 0 },
        { userId: A, paidCents: 0, owedCents: 1000 },
      ],
    };
    expect(settleSuggestions(computePairwise([dinner, payment, cPays]))).toEqual([]);
  });
});
