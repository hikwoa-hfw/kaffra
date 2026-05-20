

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK    = 'solana';

/**
 * @param {string} poolAddress  - dari graduation.poolAddress atau gmgn.pool.pool_address
 * @param {string} timeframe    - 'minute', 'hour', 'day'
 * @param {number} aggregate    - kelipatan timeframe: 5 = 5m candle, 1 = 1h candle
 * @param {number} limit        - jumlah candle, max 1000
 * @returns {Array<{time, open, high, low, close, volume}> | null}
 */
export async function fetchOHLC(poolAddress, timeframe = 'minute', aggregate = 5, limit = 100) {
  if (!poolAddress) return null;

  const url = `${GECKO_BASE}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`
    + `?aggregate=${aggregate}&limit=${limit}&currency=usd&token=base`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json;version=20230302' },
    });

    if (!res.ok) {
      console.warn(`[fetchOHLC] GeckoTerminal ${res.status} for pool ${poolAddress}`);
      return null;
    }

    const json = await res.json();
    const raw  = json?.data?.attributes?.ohlcv_list;

    if (!Array.isArray(raw) || raw.length === 0) return null;

    // GeckoTerminal format: [timestamp, open, high, low, close, volume]
    // Urutkan ascending (terlama → terbaru) supaya swing detection benar
    return raw
      .map(([time, open, high, low, close, volume]) => ({
        time:   Number(time),
        open:   Number(open),
        high:   Number(high),
        low:    Number(low),
        close:  Number(close),
        volume: Number(volume),
      }))
      .sort((a, b) => a.time - b.time);

  } catch (err) {
    console.error(`[fetchOHLC] Error fetching pool ${poolAddress}:`, err.message);
    return null;
  }
}