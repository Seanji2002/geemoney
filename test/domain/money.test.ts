import { describe, expect, it } from 'vitest';
import { formatCents, parseAmount } from '../../src/domain/money';

describe('parseAmount', () => {
  it.each([
    ['12.50', 1250],
    ['12.5', 1250],
    ['12', 1200],
    ['0.01', 1],
    ['$1,200.99', 120099],
    [' 7.30 ', 730],
    ['100000.00', 10_000_000],
  ])('parses %s to %d cents', (input, cents) => {
    expect(parseAmount(input)).toEqual({ ok: true, cents });
  });

  it.each([['12.505'], ['0'], ['0.00'], [''], ['-5'], ['abc'], ['12.'], ['1e3'], ['100000.01'], ['12,34.5.6']])(
    'rejects %s',
    (input) => {
      expect(parseAmount(input).ok).toBe(false);
    },
  );

  it('rejects European decimal commas instead of parsing them 100x too large', () => {
    // "12,50" meant $12.50 — silently reading it as $1,250.00 would be a
    // silent 100x money error.
    for (const bad of ['12,50', '1,23,45', '12,3456', '1 200', '12 . 50']) {
      expect(parseAmount(bad).ok).toBe(false);
    }
    // Correctly-grouped thousands separators still work.
    expect(parseAmount('1,200')).toEqual({ ok: true, cents: 120000 });
    expect(parseAmount('1,200.99')).toEqual({ ok: true, cents: 120099 });
  });

  it('never round-trips through floats', () => {
    // 19.99 is not representable in binary floating point.
    expect(parseAmount('19.99')).toEqual({ ok: true, cents: 1999 });
    expect(parseAmount('0.29')).toEqual({ ok: true, cents: 29 });
  });
});

describe('formatCents', () => {
  it.each([
    [1250, 'USD', '$12.50'],
    [5, 'USD', '$0.05'],
    [-1250, 'USD', '-$12.50'],
    [120099, 'USD', '$1,200.99'],
    [1250, 'EUR', '€12.50'],
    [1250, 'XYZ', '12.50 XYZ'],
  ])('%d cents in %s → %s', (cents, currency, expected) => {
    expect(formatCents(cents, currency)).toBe(expected);
  });
});
