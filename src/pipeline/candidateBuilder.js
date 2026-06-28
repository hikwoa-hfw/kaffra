import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy, boolSetting, numSetting } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { extractDevAddress, checkDevHolding } from '../enrichment/devWallet.js';
import { gmgnLink } from '../format.js';
import { computeFibonacci } from './fibonacci.js';
import { fetchOHLC } from '../enrichment/fetchOHLC.js';
import { db } from '../db/connection.js';

function detectDexPaid({ gmgn, graduatedCoin, trendingToken, jupiterAsset }) {
  const values = [
    gmgn?.dex_paid,
    gmgn?.dexPaid,
    gmgn?.is_dex_paid,
    gmgn?.isDexPaid,
    graduatedCoin?.dex_paid,
    graduatedCoin?.dexPaid,
    trendingToken?.dex_paid,
    trendingToken?.dexPaid,
    jupiterAsset?.dex_paid,
    jupiterAsset?.dexPaid,
  ];
  for (const value of values) {
    if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes') return true;
    if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no') return false;
  }
  return false;
}

function deriveTokenAgeMs({ gmgn, graduatedCoin, trendingToken, jupiterAsset }) {
  const directAge = Number(firstPositiveNumber(
    trendingToken?.ageMs,
    trendingToken?.age_ms,
    graduatedCoin?.ageMs,
    graduatedCoin?.age_ms,
    gmgn?.age_ms,
    gmgn?.token_age_ms,
  ) || 0);
  if (directAge > 0) return directAge;

  const createdAtRaw = firstPositiveNumber(
    trendingToken?.createdAtMs,
    graduatedCoin?.createdAtMs,
    gmgn?.created_at_ms,
    gmgn?.open_timestamp,
    gmgn?.created_at,
    graduatedCoin?.createdAt,
    trendingToken?.created_at,
    jupiterAsset?.createdAt,
  );
  if (!createdAtRaw) return 0;
  const tsMs = createdAtRaw < 1e12 ? createdAtRaw * 1000 : createdAtRaw;
  const age = now() - tsMs;
  return age > 0 ? age : 0;
}

function computeTrenchScore(candidate) {
  let score = 0;

  // Fee claim / total fees (0-25 pts): 1 SOL = ~8, 10 SOL = ~20, 50+ SOL = 25
  const feeSol = candidate.feeClaim?.distributedSol ?? candidate.metrics?.gmgnTotalFeesSol ?? 0;
  if (feeSol > 0) score += Math.min(25, Math.log10(feeSol + 1) / Math.log10(51) * 25);

  // Smart wallet exposure (0-25 pts): each smart wallet = 6 pts, each KOL = 4 pts, cap 25
  const smartCount = candidate.savedWalletExposure?.smartWalletCount ?? 0;
  const kolCount = candidate.savedWalletExposure?.kolCount ?? 0;
  score += Math.min(25, smartCount * 6 + kolCount * 4);

  // Buy pressure (0-20 pts): ratio 1.5 = 10 pts, ratio 3+ = 20 pts
  const bsr = candidate.metrics?.buySellRatio ?? 0;
  if (bsr > 0) score += Math.min(20, (bsr / 3) * 20);

  // Organic activity (0-20 pts): smart degen count + holder growth
  const degens = candidate.metrics?.trendingSmartDegenCount ?? 0;
  const growth = Number(candidate.trending?.holder_growth ?? candidate.trending?.holders_growth ?? 0);
  score += Math.min(10, degens * 2);
  score += Math.min(10, growth > 0 ? Math.min(growth / 50, 1) * 10 : 0);

  // Quality signals (0-10 pts)
  if (candidate.devWallet?.isHolding) score += 5;
  if (!candidate.trending?.is_wash_trading) score += 3;
  if (candidate.metrics?.dexPaid) score += 2;

  return Math.round(Math.min(100, Math.max(0, score)));
}

function normalizeHolderGrowthPercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  // Some sources send ratio (0.15), others send percent (15)
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  if (signals.route === 'smart_wallet_buy') return '🧠 smart wallet buy';
  if (signals.route === 'kol_buy') return '🌟 KOL buy';
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const holderGrowth = normalizeHolderGrowthPercent(
    candidate.trending?.holder_growth ?? candidate.trending?.holders_growth ?? 0,
  );
  const buySellRatio = Number(candidate.metrics.buySellRatio || 0);
  const countRatio = Math.round(Number(candidate.gmgn?.price))
  const chartAthDistance = Number(candidate.chart?.distanceFromAthPercent);
  const dexPaidEnabled = boolSetting('dex_paid', false);
  const tokenAgeMs = Number(candidate.metrics.tokenAgeMs || 0);

  //Cooldown guard
  const cooldownMinutes = 30; 
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const sinceMs = now() - cooldownMs;

  try {
    const recentLive = db.prepare(`SELECT id, status FROM dry_run_positions WHERE mint = ? AND opened_at_ms > ? AND status = 'live'`).get(candidate.token.mint, sinceMs);
    const recentDryRun = db.prepare(`SELECT id, status FROM dry_run_positions WHERE mint = ? AND opened_at_ms > ?`).get(candidate.token.mint, sinceMs);
    const recentTrade = recentLive || recentDryRun;

    if (recentTrade) {
      failures.push(`cooldown: Recently traded (Status: ${recentTrade.status}) in the last ${cooldownMinutes}m. No revenge trading!`);
    }
  } catch (err) {
    console.error("[Cooldown Guard Error]:", err.message);
  }
  // ────────────────────────────────────────────────────────────────────
  // NOTE [LLM-only filters]: These are now soft/advisory — passed to LLM
  // via compactCandidateForLlm for LLM to evaluate. Strategy config
  // (min_mcap_usd / max_mcap_usd / trending_min_volume_usd) still applies.
  // ────────────────────────────────────────────────────────────────────
  // Previously blocked before LLM (commented out to let LLM decide):
  //   - strictMinMcap / strictMaxMcap (hardcoded 15k-80k)
  //   - volume_5m_min (hardcoded $1000)
  //   - liquidity_min (relaxed from 10k → 1k, just a sanity floor)
  //   - topBlastRisk (moved to LLM prompt as advisory)
  //   - fee distribution check (moved to LLM prompt as advisory)
  //
  // Hard block filters that remain active:
  //   - Strategy config: min_mcap_usd / max_mcap_usd
  //   - Strategy config: trending_min_volume_usd / trending_min_swaps
  //   - Strategy config: max_top20_holder_percent / min_trench_score
  //   - Strategy config: trending_max_rug_ratio / trending_max_bundler_rate
  //   - Cooldown guard (30m)
  //   - Blast shield (stratozone: pump >800%, shallow dip)
  // ────────────────────────────────────────────────────────────────────

  // Phoenix -75%
  const liquidityUsd = candidate.metrics.liquidityUsd || 0;
  const vol5m = candidate.metrics.trendingVolumeUsd || candidate.metrics.graduatedVolumeUsd || 0;
  const dipPercent = candidate.chart?.distanceFromAthPercent || 0;
  const isPhoenix = dipPercent <= -75 && dipPercent >= -98;
  // Relaxed liquidity floor: sanity check so we don't trade dead pools
  const minLiq = isPhoenix ? 4000 : numSetting('liquidity_min', 1000);

  if (minLiq > 0 && (!Number.isFinite(liquidityUsd) || liquidityUsd < minLiq)) {
    failures.push(`liquidity: $${liquidityUsd.toFixed(0)} < min $${minLiq} (Phoenix: ${isPhoenix})`);
  }
  // [LLM] volume_5m_min — moved to LLM advisory via compactCandidateForLlm
  // const minVol5m = numSetting('volume_5m_min', 1000);
  // if (minVol5m > 0 && vol5m < minVol5m) {
  //   failures.push(`volume 5m: $${vol5m.toFixed(0)} < min $${minVol5m}`);
  // }
  // [LLM] strictMinMcap / strictMaxMcap — moved to LLM, strategy config handles it
  // const strictMinMcap = isPhoenix ? 4000 : numSetting('strict_mcap_min', 15000);
  // const strictMaxMcap = numSetting('strict_mcap_max', 80000);
  // if (strictMinMcap > 0 && (!Number.isFinite(mcap) || mcap < strictMinMcap)) {
  //   failures.push(`strict market cap: $${mcap.toFixed(0)} < min $${strictMinMcap} (Phoenix: ${isPhoenix})`);
  // }
  // if (strictMaxMcap > 0 && Number.isFinite(mcap) && mcap > strictMaxMcap) {
  //   failures.push(`strict market cap: $${mcap.toFixed(0)} > max $${strictMaxMcap}`);
  // }

  //stratosphere strat
  const rangeLow = candidate.chart?.rangeLowPercent || 0; 
  const dipFromAth = candidate.chart?.distanceFromAthPercent || 0; 
  const bsVolRatio = candidate.metrics?.bsVolRatio5m || 1; // Default to 1 if missing

  // If token is in the stratosphere (pumped >800% with shallow dip)...
  if (rangeLow >= 800 && dipFromAth >= -35 && dipFromAth <= 0) {
    // EXCEPTION: If buying volume is extremely aggressive (> 1.5x selling volume), 
    // it indicates a potential Parabolic Breakout. We let it pass to the LLM.
    if (bsVolRatio >= 1.5) {
      console.log(`[Bypass] Stratosphere allowed due to extreme momentum (bsVolRatio: ${bsVolRatio.toFixed(2)})`);
    } else {
      failures.push(`stratosphere trap: Pumped +${rangeLow.toFixed(0)}% (Dip ${dipFromAth.toFixed(1)}%). VolRatio ${bsVolRatio.toFixed(2)} is too weak for a breakout. Danger of exit liquidity.`);
    }
  }

  // Wallet-signal routes (smart_wallet_buy / kol_buy) bypass fee requirement
  const isWalletSignal = candidate.walletSignal != null ||
    candidate.signals?.route === 'smart_wallet_buy' ||
    candidate.signals?.route === 'kol_buy';

  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim && !isWalletSignal) {
    failures.push('fee claim: missing (required by strategy)');
  }

  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }
  const feeMcapDivisor = numSetting('fee_mcap_divisor', 0);
  if (feeMcapDivisor > 0 && candidate.gmgn !== null && Number.isFinite(mcap) && mcap > 0) {
    const requiredFee = mcap / feeMcapDivisor;
    if (totalFees < requiredFee) {
      failures.push(`fee/mcap: ${totalFees.toFixed(2)} < required ${requiredFee.toFixed(2)} (mcap/${feeMcapDivisor})`);
    }
  }

  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  const smartWalletCount = candidate.savedWalletExposure.smartWalletCount ?? 0;
  if (strat.min_smart_wallet_holders > 0 && smartWalletCount < strat.min_smart_wallet_holders) {
    failures.push(`smart wallet holders: ${smartWalletCount} < ${strat.min_smart_wallet_holders}`);
  }

  const kolCount = candidate.savedWalletExposure.kolCount ?? 0;
  if (strat.min_kol_holders > 0 && kolCount < strat.min_kol_holders) {
    failures.push(`KOL holders: ${kolCount} < ${strat.min_kol_holders}`);
  }

  const smartDegenCount = candidate.metrics.trendingSmartDegenCount ?? 0;
  if (strat.min_smart_degen_count > 0 && smartDegenCount < strat.min_smart_degen_count) {
    failures.push(`smart degen count: ${smartDegenCount} < ${strat.min_smart_degen_count}`);
  }

  const dev = candidate.devWallet;
  if (dev) {
    if (strat.require_dev_holding && !dev.isHolding) {
      failures.push(`dev wallet: not holding (dumped)`);
    }
    if (strat.max_dev_sold_pct > 0 && dev.soldPercent != null && dev.soldPercent > strat.max_dev_sold_pct) {
      failures.push(`dev wallet: sold ${dev.soldPercent.toFixed(0)}% > max ${strat.max_dev_sold_pct}%`);
    }
  }

  if (strat.token_age_max_ms > 0) {
    if (tokenAgeMs <= 0) {
      failures.push('token age: unavailable while age filter is enabled');
    } else if (tokenAgeMs > strat.token_age_max_ms) {
      failures.push(`token age: ${(tokenAgeMs / 60000).toFixed(1)}m > ${(strat.token_age_max_ms / 60000).toFixed(1)}m`);
    }
  }

  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }
  const migratedBuyMaxAthDistance = numSetting('migrated_buy_max_ath_distance_pct', 0);
  if (migratedBuyMaxAthDistance < 0 && candidate.graduation) {
    if (Number.isFinite(chartAthDistance) && chartAthDistance > migratedBuyMaxAthDistance) {
      failures.push(`migrated dump-buy: ATH distance ${chartAthDistance.toFixed(0)}% > target ${migratedBuyMaxAthDistance}%`);
    }
  }

  const bestVolumeUsd = Math.max(
    Number(candidate.metrics.trendingVolumeUsd || 0),
    Number(candidate.metrics.graduatedVolumeUsd || 0),
  );
  const volumeToMcapMinRatio = numSetting('volume_to_mcap_min_ratio', 0);
  if (volumeToMcapMinRatio > 0 && Number.isFinite(mcap) && mcap > 0) {
    const ratio = bestVolumeUsd / mcap;
    if (!Number.isFinite(ratio) || ratio < volumeToMcapMinRatio) {
      failures.push(`volume/mcap ratio: ${ratio.toFixed(2)} < ${volumeToMcapMinRatio}`);
    }
  }

  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
    if (strat.min_holder_growth_pct > 0 && holderGrowth < strat.min_holder_growth_pct) {
      failures.push(`holder growth: ${holderGrowth}% < ${strat.min_holder_growth_pct}%`);
    }
    if (strat.min_buy_sell_ratio > 0 && buySellRatio < strat.min_buy_sell_ratio) {
      failures.push(`buy/sell ratio: ${buySellRatio.toFixed(2)} < ${strat.min_buy_sell_ratio}`);
    }
  }
  if (dexPaidEnabled && !candidate.metrics.dexPaid) {
    failures.push('dex paid: required but token is not flagged as paid');
  }
  // topBlastRisk — moved to LLM advisory. Data passed via compactCandidateForLlm
  // (candidate.chart.topBlastRisk). LLM decides.
  // if (candidate.chart?.topBlastRisk === true) {
  //   failures.push('top blast risk: price within 85% of 24h range high, likely to face selling pressure');
  // }
  // Fee distribution check — moved to LLM advisory. feeClaim + devWallet passed
  // to LLM via compactCandidateForLlm. LLM decides when it's a red flag.
  // const feeRecipients = candidate.feeClaim?.recipients || [];
  // if (feeRecipients.length > 0 && candidate.devWallet) {
  //   const devAddress = candidate.devWallet.address;
  //   const devFeeShare = devAddress
  //     ? feeRecipients.filter(r => r.address === devAddress).reduce((sum, r) => sum + r.percent, 0)
  //     : 0;
  //   if (devFeeShare > 50 && !candidate.devWallet.isHolding) {
  //     failures.push(`fee distribution: dev gets ${devFeeShare.toFixed(1)}% of fees but holds 0% of supply`);
  //   }
  // }

  const trenchScore = candidate.metrics.trenchScore ?? 0;
  const minTrenchScore = strat.min_trench_score ?? 0;
  if (minTrenchScore > 0 && trenchScore < minTrenchScore) {
    failures.push(`trench score: ${trenchScore} < min ${minTrenchScore}`);
  }

  const ratWalletCount = candidate.savedWalletExposure.ratWalletCount ?? 0;
  const maxRatWalletHolders = strat.max_rat_wallet_holders ?? 0;
  if (maxRatWalletHolders > 0 && ratWalletCount > maxRatWalletHolders) {
    failures.push(`rat wallet holders: ${ratWalletCount} > max ${maxRatWalletHolders}`);
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route, walletSignal = null }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);

  // --- TRENCH MASTER FIX: DYNAMIC LIQUIDITY POOL EXTRACTION ---
  // Ekstrak semua pool address secara dinamis dari API tanpa hardcode
  const rawPoolAddresses = [
    gmgn?.pool?.pool_address,
    gmgn?.pool_address,
    gmgn?.biggest_pool_address,
    trendingToken?.pool_address,
    graduatedCoin?.poolAddress
  ].filter(Boolean);

  // Hilangkan duplikasi address
  const systemAddresses = [...new Set(rawPoolAddresses)];

  if (holders) {
    let lpTotalPercent = 0;
    const lpHoldersToRemove = new Set();

    // 1. Cari dompet LP di dalam array top20 berdasarkan address yang persis sama
    if (Array.isArray(holders.top20)) {
      const foundLPs = holders.top20.filter(h => systemAddresses.includes(h.address));
      
      foundLPs.forEach(lp => {
        lpTotalPercent += Number(lp.percent || lp.pct || 0);
        lpHoldersToRemove.add(lp.address); // Tandai address yang harus dibuang
      });
    }

    // Set nilai final persentase LP
    holders.lpPercent = Number(lpTotalPercent.toFixed(2));

    if (lpHoldersToRemove.size > 0) {
      // 2. Cabut LP dari array top20 dan hitung ulang konsentrasi manusia
      if (Array.isArray(holders.top20)) {
        holders.top20Percent = Math.max(0, (holders.top20Percent || 0) - lpTotalPercent);
        holders.top20 = holders.top20.filter(h => !lpHoldersToRemove.has(h.address));
        
        // Cari maxHolderPercent baru (Paus Manusia)
        holders.maxHolderPercent = holders.top20.length > 0 
          ? Math.max(...holders.top20.map(h => Number(h.percent || h.pct || 0)))
          : 0;
      }

      // 3. Pastikan LP juga dicabut dari array holders utama (jika API memberikannya)
      if (Array.isArray(holders.holders)) {
        holders.holders = holders.holders.filter(h => !lpHoldersToRemove.has(h.address));
      }
    }
  }
  // --------------------------------------------------------------------

  const chart = await fetchJupiterChartContext(mint);
  const poolAddress = gmgn?.pool?.pool_address || gmgn?.biggest_pool_address || graduatedCoin?.poolAddress;
  const ohlcCandles = await fetchOHLC(poolAddress, 'minute', 5, 100);
  const ohlcCandles1h = await fetchOHLC(poolAddress, 'hour', 1, 100);
  const athPrice    = Number(gmgn?.ath_price ?? 0) || null;
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const devAddress = extractDevAddress({ graduatedCoin, gmgn, jupiterAsset });
  const devWallet = checkDevHolding(devAddress, holders, gmgn);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');
//console.log(`fibonacci : ${JSON.stringify(computeFibonacci(ohlcCandles, priceUsd, athPrice))}`)
 // console.log(`[trending_check] buys: ${trendingToken?.buys}, sells: ${trendingToken?.sells}`)
  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      // buySellRatio: (() => {
      //   const buys = Number(trendingToken?.buys ?? 0);
      //   const sells = Number(trendingToken?.sells ?? 0);
      //   if (buys <= 0 && sells <= 0) return 0;
      //   if (sells <= 0) return buys > 0 ? 999 : 0;
      //   return buys / sells;
      // })(),
      bsCountRatio5m: (() => {
        const buys = Number(gmgn?.price?.buys_5m ?? 0);
        const sells = Number(gmgn?.price?.sells_5m ?? 0);
        if (sells <= 0) return buys > 0 ? 999 : 0;
        return parseFloat((buys / sells).toFixed(2));
      })(),
      bsVolRatio5m: (() => {
        const buyVol = Number(gmgn?.price?.buy_volume_5m ?? 0);
        const sellVol = Number(gmgn?.price?.sell_volume_5m ?? 0);
        if (sellVol <= 0) return buyVol > 0 ? 999 : 0;
        return parseFloat((buyVol / sellVol).toFixed(2));
      })(),
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
      dexPaid: detectDexPaid({ gmgn, graduatedCoin, trendingToken, jupiterAsset }),
      tokenAgeMs: deriveTokenAgeMs({ gmgn, graduatedCoin, trendingToken, jupiterAsset }),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    fibonacci: computeFibonacci(ohlcCandles, priceUsd, athPrice, ohlcCandles1h),
    savedWalletExposure,
    devWallet,
    twitterNarrative,
    walletSignal,
    createdAtMs: now(),
  };
  candidate.metrics.trenchScore = computeTrenchScore(candidate);
  candidate.filters = filterCandidate(candidate);
  //console.log(`[builders] :${JSON.stringify(candidate)}`);
  return candidate;
}