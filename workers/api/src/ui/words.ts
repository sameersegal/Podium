/**
 * Small numbers, spelled.
 *
 * The console's headings are sentences — "Twelve things need you today",
 * "Nine left, three of them late" — and a sentence that opens with a digit
 * reads as a label somebody forgot to finish. Above twenty the word is longer
 * than the number it replaces and stops helping, so the digits come back.
 *
 * Only ever used in prose. Every *value* on these screens — a count in the
 * rail, a figure in a card, a due date — stays a numeral in the mono face,
 * because those are read by comparison and words cannot be compared at a
 * glance.
 */

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

export function spell(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 20 || !Number.isInteger(n)) return String(n);
  return WORDS[n];
}

/** The same, capitalised, for the start of a sentence. */
export function Spell(n: number): string {
  const word = spell(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `1 thing` / `2 things`, where the count is a numeral either way. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
