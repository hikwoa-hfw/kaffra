import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC 
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
//console.log(`[c] : ${JSON.stringify(c)}`);
//console.log(`[c]: "name": ${c.token?.name}, "mint" : trade.padre.gg/trade/solana${c.token?.mint}, "metrics" : ${JSON.stringify(c.metrics)})`)
  // Kalkulasi Quant: Fee Density (1.0x = 1 SOL fee per $10k MCap)
  const mcap = Number(c.metrics?.marketCapUsd || c.metrics?.graduatedMarketCapUsd || 0);
  
  // Ekstraksi fee tingkat lanjut: memindai seluruh letak data yang mungkin
  const feesSol = Number(
    c.metrics?.gmgnTotalFeesSol || 
    c.feeClaim?.distributedSol || 
    c.feeClaim?.totalFeeSol || 
    c.metrics?.totalFeeSol || 
    0
  );

  const feeDensity = mcap > 0 ? (feesSol / (mcap / 10000)) : 0;

  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: {
      ...c.metrics,
      totalFeesSol: feesSol, 
      feeDensityMultiplier: Number(feeDensity.toFixed(2))
    },
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    organicBuyer5m:c.trending?.stats5m?.numOrganicBuyers,
    smartWallets: c.gmgn?.wallet_tags_stat?.smart_wallet || 0,
    ratWallets: c.gmgn?.wallet_tags_stat?.rat_trader_wallets || 0,
    whaleWallets: c.gmgn?.wallet_tags_stat?.whale_wallets || 0,
    volume5m: Math.round(Number(c.gmgn?.price?.volume_5m || 0)),
    visitingCount: c.gmgn?.visiting_count || 0,
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
      lpPercent: c.holders?.lpPercent || 0
    },
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

// TRENCH MASTER SYSTEM PROMPT (WITH LESSON OVERRIDE PROTECTION)
  const system = [
    'You are Kaffra, an elite quantitative Solana meme coin analyst.',
    'Return strict JSON only.',
    'You receive up to 10 recently matched candidates. Pick MAXIMUM ONE solid candidate for a high-probability short-term momentum trade, or use WATCH/PASS.',
    'RULES OF THE TRENCH:',
    '1. BALANCED QUANT SNIPER: You are highly selective but pragmatic. Seek strong statistical confluence.',
    '2. HOLDER DISTRIBUTION: Top 20 holders < 45% is the golden zone. Strictly PASS if a single non-developer wallet (maxHolderPercent) holds > 15%.',
    '3. LIQUIDITY POOL: "lpPercent" is cleanly separated. If lpPercent < 25% when marketcap under 40k or if lpPercent <35% when marketcap over than 40k, the liquidity size is healthy and safe.',
    '4. FEE DENSITY IS KING: "feeDensityMultiplier" > 1.5x is EXTREMELY BULLISH. < 0.5x is a RED FLAG.',
    '5. DEEP DIP vs FALLING KNIFE: A pullback of 40% to 85% from ATH is a PRIME "Buy the Dip" opportunity AS LONG AS fee density is high (>1.5x). It is ONLY a "falling knife" if down > 85% with dead volume.',
    '6. VOLUME & TRENDING CONFLUENCE: If volume1m > 1000, it indicates massive immediate buying pressure. If visitingCount > 50, it confirms genuine organic trending status but, visitingCount is just additional flavor, not a must-have.',
    '7. BUY/SELL RATIO TIMING (CONVICTION INDICATOR): Evaluate "bscountRatio5m" (retail count) and "bsvolRatio5m" (money size).',
    '   - STEALTH ACCUMULATION: bscountRatio5m ~1.0 but bsvolRatio5m > 1.2 (or vol > count by 10-25%). HIGHLY BULLISH.',
    '   - HEALTHY MOMENTUM: Both ratios > 1.2. Valid entry if MCap is low.',
    '   - FRAGILE FOMO: bscountRatio5m > 1.2 but bsvolRatio5m ~1.0. Tread cautiously.',
    '   - DISTRIBUTION: Both ratios < 1.0. Early buyers are exiting. Lean towards WATCH/PASS.',
    '8. WHALE WALLETS: If "whaleWallets" >= 1, it is a MASSIVE bullish signal indicating deep-pocket accumulation. MUST drastically increase confidence score.',
    '9. SMART MONEY & RATS: "smartWallets" >= 2 is a nice bonus. "ratWallets" (1 to 5) are normal noise; penalize only if > 10.',
    '10. VERDICTS: Use BUY for prime setups. Use WATCH if it needs consolidation. Use PASS for obvious dumps. observe real data. Do not add more complexity. Trust the system.',
    '11. REDEFINING CONFIDENCE: Confidence (0-100) MUST represent the "Overall Bullish Score". DO NOT round to multiples of 5.',
    '12. VERDICT ALIGNMENT: BUY must have score >= 70. WATCH is 40-69. PASS is < 40.',
    '13. LESSON HIERARCHY: "recent_lessons" are strictly ADVISORY. CORE RULES (like Top 20 < 45%) OVERRIDE lessons. If a lesson suggests strict limits (e.g., banning Top 20 > 20%), treat it only as a minor caution factor, NOT an automatic PASS, if the fee density and chart are prime.' // <-- ATURAN BARU ANTI-KOWARD
  ].join(' ');

 const user = {
    task: 'Analyze the candidates on-chain metrics and chart context. Pick the absolute safest and most explosive gem, or choose none. Follow the trench rules strictly. YOUR OUTPUT MUST BE 100% VALID JSON. Do not use unescaped double quotes inside strings.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'Strict trench analysis explaining WHY it is a gem or a trap. Avoid using double quotes inside this text.',
      risks: ['Risk 1', 'Risk 2', 'Risk 3'], 
      suggested_tp_percent: 'positive number (e.g., 10 to 50)',
      suggested_sl_percent: 'negative number STRICTLY between -35 and -15',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.11, 
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}