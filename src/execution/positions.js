import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';
import { fetchOHLC } from '../enrichment/fetchOHLC.js';

/**
 * Calculate ATR as % of current price from OHLC candles.
 */
function calculateATRPercent(candles, currentPrice, period = 14) {
  if (!candles || candles.length < period + 1 || !currentPrice || currentPrice <= 0) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    const prevClose = Number(candles[i - 1].close);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  if (trueRanges.length < period) return null;
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return parseFloat((atr / currentPrice * 100).toFixed(2));
}

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const lowWaterMcap = position.low_water_mcap != null
    ? Math.min(Number(position.low_water_mcap), Number(mcap))
    : Number(mcap);
  const lowWaterPrice = position.low_water_price != null
    ? Math.min(Number(position.low_water_price), Number(price || 0))
    : Number(price || 0);
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const strat = strategyById(position.strategy_id);
  const profitLockEnabled = Boolean(strat?.profit_lock_enabled);
  const tpHit = !profitLockEnabled && pnlPercent >= Number(position.tp_percent);

  // --- Dynamic Volatility Bounds (ATR-based SL & Trailing) ---
  let atrPercent = null;
  try {
    const { default: axios } = await import('axios');
    const url = new URL(`https://datapi.jup.ag/v2/charts/${position.mint}`);
    url.searchParams.set('interval', '5_MINUTE');
    url.searchParams.set('candles', '20');
    url.searchParams.set('type', 'price');
    url.searchParams.set('quote', 'native');
    const res = await axios.get(url.toString(), { timeout: 8000, headers: { Accept: 'application/json' } });
    const candles = Array.isArray(res.data?.candles) ? res.data.candles : [];
    if (candles.length > 14 && Number(price) > 0) {
      const trs = [];
      for (let i = 1; i < candles.length; i++) {
        const h = Number(candles[i].high);
        const l = Number(candles[i].low);
        const pc = Number(candles[i - 1].close);
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      if (trs.length >= 14) {
        let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
        for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
        atrPercent = parseFloat((atr / Number(price) * 100).toFixed(2));
      }
    }
  } catch (_) { /* chart data unavailable, fall back to static bounds */ }

  // Dynamic SL: wider of strategy SL or ATR x 2 (more volatile = wider stop)
  const staticSL = Number(position.sl_percent);
  const dynamicSL = atrPercent != null
    ? Math.min(staticSL, -(Math.max(atrPercent * 2, 5)))
    : staticSL;

  // Dynamic trailing: wider of strategy trail or ATR x 1.5
  const staticTrail = Number(position.trailing_percent);
  const dynamicTrail = atrPercent != null
    ? Math.max(staticTrail, Math.ceil(atrPercent * 1.5))
    : staticTrail;

  const slHit = pnlPercent <= dynamicSL;
  const trailingArmed = position.trailing_armed || (!profitLockEnabled && position.trailing_enabled && tpHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = !profitLockEnabled && trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(dynamicTrail);
  let exitReason = null;
  let closed = false;

  // Max hold time check
  const highPnlPercent = (highWaterMcap / Number(position.entry_mcap) - 1) * 100;
  let profitLockFloor = null;
  if (profitLockEnabled) {
    const trigger1 = Number(strat.profit_lock_trigger_1_percent ?? 15);
    const floor1 = Number(strat.profit_lock_floor_1_percent ?? 5);
    const trigger2 = Number(strat.profit_lock_trigger_2_percent ?? 40);
    const floor2 = Number(strat.profit_lock_floor_2_percent ?? 20);
    const trigger3 = Number(strat.profit_lock_trigger_3_percent ?? 80);
    const floor3 = Number(strat.profit_lock_floor_3_percent ?? 50);
    const dynamicDrawdown = Number(strat.profit_lock_dynamic_drawdown_percent ?? 30);
    if (highPnlPercent >= trigger3) profitLockFloor = Math.max(floor3, highPnlPercent - dynamicDrawdown);
    else if (highPnlPercent >= trigger2) profitLockFloor = floor2;
    else if (highPnlPercent >= trigger1) profitLockFloor = floor1;
  }
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP check
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (profitLockFloor != null && pnlPercent <= profitLockFloor) exitReason = 'PROFIT_LOCK';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, 
        low_water_mcap = ?, low_water_price = ?,
        trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, lowWaterMcap, lowWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    lowWaterMcap,
    low_water_mcap: lowWaterMcap,
    low_water_price: lowWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function forceClosePosition(positionId, exitReason) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ? AND status = ?').get(positionId, 'open');
  if (!position) return null;
  if (sellInProgress.has(positionId)) return null;
  sellInProgress.add(positionId);
  try {
    const asset = await fetchJupiterAsset(position.mint);
    const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
    const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
    let pnlPercent = Number(position.entry_mcap) > 0 ? (Number(mcap) / Number(position.entry_mcap) - 1) * 100 : 0;
    let pnlSol = Number(position.size_sol) * pnlPercent / 100;
    let sell = null;
    if (position.execution_mode === 'live') {
      sell = await executeLiveSell(position, exitReason);
      const receivedSol = Number(sell?.outputAmount || 0) / 1e9;
      if (receivedSol > 0) {
        pnlSol = receivedSol - Number(position.size_sol);
        pnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
      }
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, sell?.signature || null, positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol, sell }));
    return { ...position, status: 'closed', exitReason, price, mcap, pnlPercent, pnl_percent: pnlPercent, pnlSol, pnl_sol: pnlSol };
  } finally {
    sellInProgress.delete(positionId);
  }
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
