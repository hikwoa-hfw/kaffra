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
console.log(`[c] : ${JSON.stringify(c)}`);
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
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
      lpPercent: c.holders?.lpPercent || 0 // <-- Data LP terpisah masuk ke LLM
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

 // TRENCH MASTER SYSTEM PROMPT (WITH SEPARATED LP LOGIC)
  const system = [
    'You are Kaffra, an elite quantitative Solana meme coin analyst.',
    'Return strict JSON only.',
    'You receive up to 10 recently matched candidates. Pick MAXIMUM ONE solid candidate for a high-probability short-term momentum trade, or use WATCH/PASS.',
    'RULES OF THE TRENCH:',
    '1. BALANCED QUANT SNIPER: You are highly selective but pragmatic. Meme coins are chaotic; seek strong statistical confluence rather than demanding absolute perfection.',
    '2. HOLDER DISTRIBUTION: Top 20 holders < 45% is the golden zone. Strictly PASS if a single non-developer wallet (maxHolderPercent) holds > 15%.',
    '3. LIQUIDITY POOL: "lpPercent" is cleanly separated from normal holders. If lpPercent < 25%, the liquidity size is healthy and safe. Do not confuse the LP with a whale or a cabal.', // <-- ATURAN BARU LP
    '4. FEE DENSITY IS KING: "feeDensityMultiplier" is your primary edge. > 1.5x is EXTREMELY BULLISH. < 0.5x is a RED FLAG.',
    '5. BUY THE DIP vs FALLING KNIFE: A pullback of 20%-50% from ATH is a PRIME "Buy the Dip" opportunity AS LONG AS fee density remains high (>1.5x). It is only a "falling knife" if down > 80% with dead volume.',
    '6. SMART MONEY (BONUS MULTIPLIER): Treat "smartWallets" as a confluence booster. If >= 2, increase your bullish conviction. If 0, rely purely on Fee Density and chart momentum.',
    '7. RAT WALLET NOISE: "ratWallets" (1 to 5) are natural parasites. Ignore them. ONLY penalize if ratWallets exceed 10.',
    '8. VERDICTS: Use BUY for prime setups. Use WATCH if it needs consolidation. Use PASS for obvious dumps or dead charts.',
    '9. REDEFINING CONFIDENCE: Confidence (0-100) MUST represent the "Overall Bullish & Safety Score" of the token.',
    '10. EXACT GRANULAR NUMBERS: DO NOT round your confidence scores to multiples of 5 (e.g., use 17, 43, 72, 88).',
    '11. VERDICT ALIGNMENT: If you assign a BUY, the score MUST be >= 70. If WATCH, the score MUST be between 40 and 69. If PASS, the score MUST be < 40.',
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
      suggested_tp_percent: 'positive number (e.g., 10 to 30)',
      suggested_sl_percent: 'negative number (e.g., -30 to -15)',
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