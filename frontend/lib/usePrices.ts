'use client';

import { useEffect, useState } from 'react';
import { fetchUsdPrices } from './prices';

// Poll CoinGecko for USD prices of the assets we support and keep them fresh.
// Prices are best-effort: if the fetch fails, `prices` stays null and callers
// simply hide USD values rather than showing a wrong number.
export function usePrices(refreshMs = 60_000): Record<string, number> | null {
  const [prices, setPrices] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      const p = await fetchUsdPrices();
      if (active && p && Object.keys(p).length > 0) {
        setPrices(p);
      }
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    void load();
    const timer = window.setInterval(load, refreshMs);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshMs]);

  return prices;
}
