/**
 * marketRegime.js
 * Tracks aggregate market health metrics from trending signal data.
 * Used to dynamically adjust filter strictness.
 */

let regime = {
  snapshot: null,
  updatedAt: 0,
  avgRugRatio: null,
  avgBundlerRate: null,
  dexPaidRate: null,
  avgVolume: null,
  avgSwaps: null,
  totalTokens: 0,
  marketCondition: 'unknown', // 'risky' | 'neutral' | 'healthy'
};

export function getMarketRegime() {
  return regime;
}

/**
 * Update market regime from a batch of trending rows.
 * Call this after each trending fetch.
 * @param {Array} rows - array of trending token objects
 */
export function updateMarketRegime(rows) {
  if (!Array.isArray(rows) || rows.length < 5) return;

  let totalRugRatio = 0, rugCount = 0;
  let totalBundlerRate = 0, bundlerCount = 0;
  let dexPaidTotal = 0, dexCount = 0;
  let totalVolume = 0, volCount = 0;
  let totalSwaps = 0, swapCount = 0;

  for (const row of rows) {
    const rr = Number(row.rug_ratio);
    if (Number.isFinite(rr) && rr >= 0) {
      totalRugRatio += Math.min(rr, 1); // cap at 1
      rugCount++;
    }
    const br = Number(row.bundler_rate);
    if (Number.isFinite(br) && br >= 0) {
      totalBundlerRate += Math.min(br, 1);
      bundlerCount++;
    }
    const dp = row.dex_paid || row.is_dex_paid || row.launchpad_status === '2' ? 1 : 0;
    dexPaidTotal += dp;
    dexCount++;
    const vol = Number(row.volume);
    if (Number.isFinite(vol) && vol > 0) {
      totalVolume += vol;
      volCount++;
    }
    const sw = Number(row.swaps);
    if (Number.isFinite(sw) && sw > 0) {
      totalSwaps += sw;
      swapCount++;
    }
  }

  const avgRugRatio = rugCount > 0 ? totalRugRatio / rugCount : null;
  const avgBundlerRate = bundlerCount > 0 ? totalBundlerRate / bundlerCount : null;
  const dexPaidRate = dexCount > 0 ? dexPaidTotal / dexCount : null;
  const avgVolume = volCount > 0 ? totalVolume / volCount : null;
  const avgSwaps = swapCount > 0 ? totalSwaps / swapCount : null;

  // Determine market condition
  let marketCondition = 'unknown';
  if (avgRugRatio != null && dexPaidRate != null) {
    if (avgRugRatio > 0.4 || dexPaidRate < 0.3) {
      marketCondition = 'risky';    // lots of rugs, few verified
    } else if (avgRugRatio < 0.2 && dexPaidRate > 0.6) {
      marketCondition = 'healthy';  // clean market
    } else {
      marketCondition = 'neutral';
    }
  }

  regime = {
    snapshot: rows.length,
    updatedAt: Date.now(),
    avgRugRatio: avgRugRatio ? parseFloat(avgRugRatio.toFixed(4)) : null,
    avgBundlerRate: avgBundlerRate ? parseFloat(avgBundlerRate.toFixed(4)) : null,
    dexPaidRate: dexPaidRate ? parseFloat(dexPaidRate.toFixed(2)) : null,
    avgVolume: avgVolume ? Math.round(avgVolume) : null,
    avgSwaps: avgSwaps ? Math.round(avgSwaps) : null,
    totalTokens: rows.length,
    marketCondition,
  };
}
