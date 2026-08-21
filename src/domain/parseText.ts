import { parseAmount } from './money';

export interface ParsedExpenseText {
  amountCents: number;
  description: string;
}

// A money-looking token with optional "$", bounded by whitespace/punctuation.
const MONEY_TOKEN = /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w.]|,\d)/g;

/**
 * Pulls an amount and a description out of a chat message like
 * "pizza 42.50", "$30 for ramen", or "paid 12 uber". The first token that
 * parses as money wins; the rest of the text becomes the description.
 */
export function parseExpenseText(content: string): ParsedExpenseText | null {
  const text = content.replace(/\s+/g, ' ').trim();
  for (const match of text.matchAll(MONEY_TOKEN)) {
    const parsed = parseAmount(match[1]!);
    if (!parsed.ok) continue;
    // Drop filler words that only made sense next to the amount ("paid 12", "30 for").
    const before = text.slice(0, match.index!).replace(/\b(for|paid|spent|on|bought|cost)\s*$/i, '');
    const after = text.slice(match.index! + match[0].length).replace(/^\s*(for|on|each)\b/i, '');
    const description = `${before} ${after}`
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\-–—:,.]+|[\-–—:,.]+$/g, '')
      .trim();
    return { amountCents: parsed.cents, description: (description || 'Expense').slice(0, 80) };
  }
  return null;
}
