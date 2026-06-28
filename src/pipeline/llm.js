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
    momentum_trend: c.metrics?.momentum_trend || null,
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

  // SIMPLIFIED PROMPT (V22 — FOCUS ON ACCUMULATION VS DISTRIBUTION)
  const system = [
    'You are Kaffra, an elite Solana quant analyst. Your mission: detect accumulation vs distribution.',
    'Return strict JSON only. Pick MAXIMUM ONE candidate or output WATCH/PASS.',
    '',
    '--- RULES (read in order) ---',
    '1. DISTRIBUTION DETECTION (DO NOT BUY):',
    '   - bsVolRatio5m < 1.0 means SELL volume > BUY volume = distribution. PASS.',
    '   - bsCountRatio5m > bsVolRatio5m = many small buy txns but low buy volume = retail buying the top. PASS.',
    '   - Strong volume (>$4000) + bsVolRatio < 1.0 = whales dumping into retail. PASS.',
    '',
    '2. ACCUMULATION DETECTION (GOOD SIGNS):',
    '   - bsVolRatio5m > 1.5 = strong buying pressure. Bullish.',
    '   - Deep dip (>75% from ATH) + bsVolRatio > 2.0 = phoenix reversal setup. Score HIGH (85-95%).',
    '   - Moderate dip (25-50%) + bsVolRatio > 1.2 = healthy pullback entry. Score (75-84%).',
    '',
    '3. PRICE POSITION (entry timing):',
    '   - Near ATH / range high = exit liquidity risk. Be extremely cautious.',
    '   - Deep dip from ATH = potential bargain IF accumulation is confirmed.',
    '',
    '4. HOLDER HEALTH (quick check):',
    '   - maxHolderPercent > 15% = too concentrated. PASS.',
    '',
    '5. SCORING:',
    '   BUY 85-95%: Phoenix (deep dip + extreme accumulation).',
    '   BUY 70-84%: Healthy dip + strong buying.',
    '   WATCH 40-69%: Mixed signals, distribution starting, or stratosphere zone.',
    '   PASS < 40%: Clear distribution or bad holder metrics.',
    '',
    'Recent lessons below are advisory. Rules 1-4 take precedence.'
  ].join(' ');

  const user = {
    task: 'Analyze the candidates on-chain metrics. Pick the absolute safest and most explosive gem, or choose none. YOUR OUTPUT MUST BE 100% VALID JSON. Do not use unescaped double quotes inside strings. Use pure DIGITS for numbers, NEVER use English words (e.g., write 30, never "thirty").',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'Strict trench analysis explaining WHY it is a gem or a trap. Justify using Volume, Holders, and ATS Divergence. Do NOT mention Fibo or RSI if the data is missing or unavailable. Avoid using double quotes inside this text.',
      risks: ['Risk 1', 'Risk 2', 'Risk 3'],
      suggested_tp_percent: 'positive number (e.g., 10 to 50)',
      suggested_sl_percent: '-15',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.11,
      // stream: false,
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
    const status = err.response?.status || 'N/A';
    const detail = JSON.stringify(err.response?.data || {}).slice(0, 300);
    console.log(`[llm] batch failed (${status}): ${err.message} | detail: ${detail}`);
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