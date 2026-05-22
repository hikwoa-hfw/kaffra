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
    organicBuyer5m: c.trending?.stats5m?.numOrganicBuyers,
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
      fibo: c.fibonacci,
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

  // TRENCH MASTER SYSTEM PROMPT (V17 - DENGAN RSI)
  const system = [
    'You are Kaffra, an elite quantitative Solana analyst. Your core philosophy is based on Ponyin: "No token is perfectly flawless. Evaluate the aggregate weight. Do not miss explosive momentum, but NEVER buy the retail top."',
    'Return strict JSON only.',
    'Pick MAXIMUM ONE candidate for a high-probability trade, or output WATCH/PASS.',

    '--- TIER 1: THE HARD RULES (NON-NEGOTIABLE) ---',
    '1. STRICT HOLDER GUARD: Top 20 holders < 45%. Max human holder < 15%. (Remember: LP is already extracted). If these exceed limits, instantly PASS.',
    '2. DYNAMIC LIQUIDITY: lpPercent < 45% (MCap < 40k) or < 25% (MCap > 40k) is healthy.',
    '3. PONYIN IF-ELSE VOLUME: Avoid wash trading/dead coins.',
    '   - MCap < $60k: volume5m MUST be >= $1000.',
    '   - MCap > $60k: volume5m MUST be >= $2000.',
    '   - If volume is below threshold, downgrade to WATCH/PASS.',

    '--- TIER 2: THE CORE MOMENTUM (HEAVY WEIGHT) ---',
    '4. NUCLEAR VOLUME OVERRIDE & EXHAUSTION GUARD: If volume5m is extraordinarily high (e.g., > $5000 in 5 mins) AND Tier 1 rules pass, this is a MASSIVE MOMENTUM BUY. HOWEVER, there is ONE CRITICAL CAVEAT:',
    '   - EXHAUSTION TOP WARNING: If this nuclear volume is paired with extreme retail FOMO (bscountRatio5m > 1.3 AND bsvolRatio5m < 1.05), it means retail is buying the absolute top while smart money is taking profit. This is a blow-off top. DO NOT BUY. Score it 50-65% (WATCH) to wait for the inevitable flush/pullback to a cheaper entry.',
    '5. THE 60% PULLBACK REBIRTH: A drop of 40-80% from ATH is a prime consolidation phase. Extremely explosive if holder structure is clean.',

    '--- TIER 3: THE TECHNICAL ENHANCERS (SOFT RULES / BONUSES) ---',
    '6. FIBONACCI & RSI TIMING (OPTIONAL): Check "chart.fibo.confluence". If it shows "max_conviction" or "high_conviction" (Golden Pocket + RSI Oversold), it is an excellent enhancer. However, if Fibo/RSI data is missing or null, DO NOT penalize the token and DO NOT mention it in your reason.',
    '7. ATS DIVERGENCE (OPTIONAL): Evaluate bscountRatio5m vs bsvolRatio5m.',
    '   - Panic Accumulation (Vol > Count, both < 1) or Stealth Entry (Vol > 1.2) are great BONUSES.',
    '   - Retail Trap (Count significantly outpaces Vol) is a warning. If volume5m is normal/low, downgrade. If volume is nuclear, rely on the Exhaustion Guard (Rule 4).',

    '--- TIER 4: THE SCORING MATRIX ---',
    '8. SCORING LOGIC:',
    '   - [BUY 75-95%]: Tier 1 passes + Massive Volume5m + Strong Narrative + Healthy/Stealth ATS. Trigger BUY immediately.',
    '   - [BUY 70-80%]: The Technical Sniper. Tier 1 passes + Normal volume + max_conviction confluence + Whale Accumulation.',
    '   - [WATCH 40-69%]: Good token, but lacks explosive volume, OR it triggered the Exhaustion Top Warning (waiting for a dip).',
    '   - [PASS < 40%]: Fails Tier 1 Hard Rules.',

    '9. WHALE WALLETS: If >= 1, scale up confidence.',
    '10. ADVISORY: recent_lessons are advisory. Tier 1 and Tier 2 rules take precedence.'
  ].join(' ');

  const user = {
    task: 'Analyze the candidates on-chain metrics, Ponyin sanity checks, ATS divergence, and Fibo chart context. Pick the absolute safest and most explosive gem, or choose none. Follow the trench rules strictly. YOUR OUTPUT MUST BE 100% VALID JSON. Do not use unescaped double quotes inside strings. Use pure DIGITS for numbers, NEVER use English words (e.g., write 30, never "thirty").',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'Strict trench analysis explaining WHY it is a gem or a trap. Justify using Volume, Holders, and ATS Divergence. Do NOT mention Fibo or RSI if the data is missing or unavailable. Avoid using double quotes inside this text.',
      risks: ['Risk 1', 'Risk 2', 'Risk 3'],
      suggested_tp_percent: 'positive number (e.g., 10 to 50)',
      suggested_sl_percent: '-35',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };
  console.log(`candidate: ${JSON.stringify(rows.map(compactCandidateForLlm))}`)

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