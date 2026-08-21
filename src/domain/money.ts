import { MAX_AMOUNT_CENTS } from '../config';

export type ParseResult = { ok: true; cents: number } | { ok: false; error: string };

// Commas are accepted only as correctly-placed thousands separators —
// a European decimal comma ("12,50") must be rejected, not silently
// parsed as $1,250.00.
const AMOUNT_RE = /^(\d{1,3}(,\d{3})*|\d{1,7})(\.\d{1,2})?$/;

/**
 * Parses a money string ("12.50", "$1,200", "12.5") to integer cents using
 * string math — floats never touch an amount.
 */
export function parseAmount(raw: string): ParseResult {
  const trimmed = raw.trim().replace(/^\$/, '');
  if (trimmed.length === 0) return { ok: false, error: 'Enter an amount.' };
  if (!AMOUNT_RE.test(trimmed)) {
    if (/\.\d{3,}$/.test(trimmed)) return { ok: false, error: 'Use at most 2 decimal places.' };
    if (/,/.test(trimmed)) {
      return { ok: false, error: `"${raw.trim()}" is ambiguous — use a dot for decimals, like 12.50.` };
    }
    return { ok: false, error: `"${raw.trim()}" is not a valid amount — use a format like 12.50.` };
  }
  const cleaned = trimmed.replace(/,/g, '');
  if (cleaned.replace(/\..*$/, '').length > 7) {
    return { ok: false, error: `That's above the per-expense cap of ${formatCents(MAX_AMOUNT_CENTS, 'USD')}.` };
  }
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (cents <= 0) return { ok: false, error: 'The amount must be more than zero.' };
  if (cents > MAX_AMOUNT_CENTS) {
    return { ok: false, error: `That's above the per-expense cap of ${formatCents(MAX_AMOUNT_CENTS, 'USD')}.` };
  }
  return { ok: true, cents };
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${whole}.${frac}` : `${sign}${whole}.${frac} ${currency}`;
}
