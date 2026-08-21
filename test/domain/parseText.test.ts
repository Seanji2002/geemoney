import { describe, expect, it } from 'vitest';
import { parseExpenseText } from '../../src/domain/parseText';

describe('parseExpenseText', () => {
  it.each([
    ['pizza 42.50', 4250, 'pizza'],
    ['$30 for ramen', 3000, 'ramen'],
    ['paid 12 uber', 1200, 'uber'],
    ['Groceries - 1,234.56', 123456, 'Groceries'],
    ['42.5', 4250, 'Expense'],
    ['movie tickets $18.00 tonight', 1800, 'movie tickets tonight'],
    ['  lunch   9  ', 900, 'lunch'],
  ])('%s → %d cents, "%s"', (input, cents, description) => {
    expect(parseExpenseText(input)).toEqual({ amountCents: cents, description });
  });

  it('returns null when there is no amount', () => {
    expect(parseExpenseText('who wants pizza?')).toBeNull();
    expect(parseExpenseText('')).toBeNull();
  });

  it('skips tokens that are not money (too many decimals, zero) and uses the next', () => {
    expect(parseExpenseText('v1.2.3 release dinner 40')).toEqual({ amountCents: 4000, description: 'v1.2.3 release dinner' });
    expect(parseExpenseText('0 then 25 for drinks')).toEqual({ amountCents: 2500, description: '0 then drinks' });
  });
});
