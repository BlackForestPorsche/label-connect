export const MAX_COPIES = 20;

/** Whole number of labels to print, 1..MAX_COPIES. Blank, zero or junk means 1. */
export function normalizeCopies(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_COPIES, Math.max(1, n));
}
