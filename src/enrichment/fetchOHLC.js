/**
 * fetchOHLC.js
 * Ambil candle data dari GeckoTerminal — gratis, no API key.
 *
 * Strategi rate limit:
 * - Cache per pool+timeframe selama TTL_MS (default 3 menit)
 * - Backoff global kalau kena 429 — semua request ditahan sampai cooldown habis
 * - Jitter kecil antar request supaya tidak burst bersamaan
 */

const GECKO_BASE     = 'https://api.geckoterminal.com/api/v2';
const NETWORK        = 'solana';
const TTL_MS         = 3 * 60 * 1000;  // cache 3 menit
const BACKOFF_MS     = 60 * 1000;       // cooldown 60s setelah 429
const REQUEST_GAP_MS = 1200;            // jeda antar request (~50 req/menit)

// In-memory cache: key = `${poolAddress}:${timeframe}:${aggregate}`
const ohlcCache = new Map();

// Global rate limit state
const rateLimit = { blockedUntil: 0, lastRequestAt: 0 };

function cacheKey(poolAddress, timeframe, aggregate) {
  return `${poolAddress}:${timeframe}:${aggregate}`;
}

function parseCandles(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
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
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @param {string} poolAddress  - dari graduation.poolAddress atau gmgn.pool.pool_address
 * @param {string} timeframe    - 'minute', 'hour', 'day'
 * @param {number} aggregate    - kelipatan timeframe: 5 = 5m candle, 1 = 1h candle
 * @param {number} limit        - jumlah candle, max 1000
 * @returns {Array<{time, open, high, low, close, volume}> | null}
 */
export async function fetchOHLC(poolAddress, timeframe = 'minute', aggregate = 5, limit = 100) {
  if (!poolAddress) return null;

  const key    = cacheKey(poolAddress, timeframe, aggregate);
  const cached = ohlcCache.get(key);

  // Cache hit
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  // Global backoff aktif
  if (Date.now() < rateLimit.blockedUntil) {
    const remaining = Math.ceil((rateLimit.blockedUntil - Date.now()) / 1000);
    console.warn(`[fetchOHLC] rate limited, skip ${poolAddress.slice(0, 8)}... (${remaining}s remaining)`);
    return cached?.data ?? null;
  }

  // Jeda antar request
  const elapsed = Date.now() - rateLimit.lastRequestAt;
  if (elapsed < REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS - elapsed);

  const url = `${GECKO_BASE}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${timeframe}`
    + `?aggregate=${aggregate}&limit=${limit}&currency=usd&token=base`;

  try {
    rateLimit.lastRequestAt = Date.now();

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json;version=20230302' },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const cooldown   = retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS;
      rateLimit.blockedUntil = Date.now() + cooldown;
      console.warn(`[fetchOHLC] 429 — backing off ${Math.round(cooldown / 1000)}s`);
      return cached?.data ?? null;
    }

    if (!res.ok) {
      console.warn(`[fetchOHLC] ${res.status} for pool ${poolAddress.slice(0, 8)}...`);
      return null;
    }

    const json = await res.json();
    const data = parseCandles(json?.data?.attributes?.ohlcv_list);

    // Cache hasil (termasuk null supaya tidak retry terus untuk pool tanpa data)
    ohlcCache.set(key, { at: Date.now(), data });

    // Cleanup cache lama
    if (ohlcCache.size > 500) {
      const cutoff = Date.now() - TTL_MS;
      for (const [k, v] of ohlcCache) {
        if (v.at < cutoff) ohlcCache.delete(k);
      }
    }

    return data;

  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.warn(`[fetchOHLC] ${isTimeout ? 'timeout' : err.message} for pool ${poolAddress.slice(0, 8)}...`);
    return cached?.data ?? null;
  }
}