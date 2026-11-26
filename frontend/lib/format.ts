/**
 * Format a numeric amount with up to 4 fractional digits and thousands separators,
 * avoiding rounding small amounts like `0.5` to `0` while omitting unnecessary
 * trailing zeros.
 */
export function formatAmount(amount: number, maxFractionDigits = 4): string {
  if (!Number.isFinite(amount)) return '0';
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}
