import { describe, it, expect } from 'vitest';
import { formatAmount } from '../format';

describe('formatAmount', () => {
  it('preserves small fractional amounts without rounding to zero', () => {
    expect(formatAmount(0.5)).toBe('0.5');
    expect(formatAmount(0.01)).toBe('0.01');
    expect(formatAmount(0.1234)).toBe('0.1234');
  });

  it('rounds beyond maxFractionDigits and strips trailing zeros', () => {
    expect(formatAmount(0.12345)).toBe('0.1235');
    expect(formatAmount(5.0)).toBe('5');
    expect(formatAmount(12.5)).toBe('12.5');
    expect(formatAmount(0)).toBe('0');
  });

  it('formats large totals with thousands separators', () => {
    expect(formatAmount(1234)).toBe('1,234');
    expect(formatAmount(1234.5)).toBe('1,234.5');
    expect(formatAmount(1000000.25)).toBe('1,000,000.25');
  });

  it('handles non-finite values safely', () => {
    expect(formatAmount(Number.NaN)).toBe('0');
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe('0');
  });
});
