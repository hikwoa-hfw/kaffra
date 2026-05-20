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
      fibo: c.chart?.fibo,
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

  // TRENCH MASTER SYSTEM PROMPT (V12 - FIBONACCI BSR CONFLUENCE)
  const system = [
    'You are Kaffra, an elite quantitative Solana analyst operating strictly on factual data and Ponyin principles.',
    'Return strict JSON only.',
    'Pick MAXIMUM ONE candidate for a high-probability trade, or output WATCH/PASS.',
    'RULES OF THE TRENCH:',
 
    '1. TRUST THE HOLDER METRICS: The candidate data provided to you has ALREADY cleaned and extracted the Liquidity Pool (LP) from the holder percentages. Trust the metrics implicitly: Top 20 holders < 45% is the golden safety zone. If the provided maxHolderPercent (human wallet) is > 15%, strictly PASS.',
 
    '2. DYNAMIC LIQUIDITY POOL: lpPercent < 40% when marketcap under 40k, or lpPercent < 25% when marketcap over 40k is healthy.',
 
    '3. PONYIN IF-ELSE VOLUME FILTER (DYNAMIC): Evaluate "volume5m" relative to marketcap to detect real momentum vs dead coins:',
    '   - IF marketCapUsd is BELOW $60k: volume5m MUST be >= $1000 to be valid for a BUY.',
    '   - IF marketCapUsd is ABOVE $60k: volume5m MUST be >= $3000 to be valid for a BUY. If volume5m is below this tier threshold, the coin is resting with dead volume; flag it as WATCH or PASS.',
    '   - DO NOT issue a hard wash-trading rejection on high feeDensity if past volume (graduatedVolumeUsd) was massive; treat low 5m volume strictly as a resting/dip phase.',
 
    '4. FIBONACCI TIMING: Use "chart.fibo.dipSignal" and "chart.fibo.zone" to find structural mathematical entries.',
    '   - "strong_dip" (fib_618–fib_786) = PRIME SNIPER ENTRY. This is the golden pocket where smart money sets buy orders.',
    '   - "deep_dip" (fib_786–fib_100) = High risk / high reward. Only valid if bsvolRatio5m > 1.2 OR whaleWallets >= 1.',
    '   - "moderate_dip" (fib_50–fib_618) = Valid entry with BSR confirmation.',
    '   - "shallow_dip" or "near_ath" = WATCH/PASS unless whale accumulation is extreme.',
    '   - "danger" (below swing low) = PASS immediately, no exceptions.',
 
    '5. THE 60% PULLBACK REBIRTH PATTERN: After a powerful initial pump, a drop of 40% to 80% from its 24h high is NOT a dead coin. Historically, this severe pullback acts as a critical consolidation phase where early flippers exit, allowing the coin to gather energy and launch a secondary wave to print a new ATH. Treat tokens in this zone as highly explosive IF holder structures are clean.',
 
    '6. ATS DIVERGENCE CONVICTION: You are given bscountRatio5m (number of retail trades) and bsvolRatio5m (size of whale money). Read them together — they tell you WHO is actually moving the market.',
    '   - PANIC ACCUMULATION (STEALTH): Both ratios < 1.0, BUT bsvolRatio5m > bscountRatio5m. Retail is panic selling small bags while whales quietly vacuum supply at Fibo support. HIGH PROBABILITY BUY.',
    '   - STEALTH ENTRY: bscountRatio5m ~1.0 but bsvolRatio5m > 1.2. Whales building blocks quietly, retail not yet aware. Good entry.',
    '   - RETAIL TRAP: bscountRatio5m > 1.2 AND bscountRatio5m > bsvolRatio5m. Many small buys but whale money is net selling. Lower confidence significantly, lean WATCH/PASS.',
    '   - FRAGILE PUMP: bscountRatio5m > 1.2 but bsvolRatio5m < 1.05. Lots of retail activity but no whale conviction behind it. Pump is fragile and easily reversed. WATCH only.',
 
    '7. FIBONACCI + BSR CONFLUENCE (NEW): The highest conviction entries require BOTH signals to align simultaneously.',
    '   - MAXIMUM CONVICTION: dipSignal is "strong_dip" AND bsvolRatio5m > bscountRatio5m. Structural math + whale accumulation. Drastically scale up confidence.',
    '   - HIGH CONVICTION: dipSignal is "deep_dip" AND bsvolRatio5m > 1.2. Deep dip with real whale money. Valid BUY.',
    '   - NO CONFLUENCE: Good fibo zone but bscountRatio5m > bsvolRatio5m (retail trap). Downgrade to WATCH regardless of fibo.',
    '   - NO CONFLUENCE: Good BSR but fibo dipSignal is "shallow_dip" or "near_ath". Downgrade to WATCH — entry is structurally late.',
 
    '8. WHALE WALLETS: If whaleWallets >= 1 in a prime Fibonacci golden pocket or 40-80% pullback zone, drastically scale up your confidence score.',
 
    '9. VERDICTS & SCORES: BUY requires score >= 70. WATCH is 40-69. PASS is < 40. Never round confidence to multiples of 5.',
 
    '10. ADVISORY HIERARCHY: recent_lessons are strictly advisory. Core limits (Top 20 < 45%, Dynamic Volume If-Else, Max Holder < 15%) always take precedence.',
  ].join(' ');

  const user = {
    task: 'Analyze the candidates on-chain metrics, Ponyin sanity checks, ATS divergence, and Fibo chart context. Pick the absolute safest and most explosive gem, or choose none. Follow the trench rules strictly. YOUR OUTPUT MUST BE 100% VALID JSON. Do not use unescaped double quotes inside strings.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'Strict trench analysis explaining WHY it is a gem or a trap. Justify using ATS Divergence, Fibo timing, and Wash Trading checks. Avoid using double quotes inside this text.',
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