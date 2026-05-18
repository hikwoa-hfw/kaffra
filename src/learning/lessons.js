import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  
 // AI QUANT SCIENTIST PROMPT (CONCISE BUT CONTEXTUAL)
  const system = [
    "You are Kaffra's Quant.",
    "Diagnose trading data to find failure patterns and mathematical correlations.",
    "CRITICAL: Strike a balance. Do not write long essays, but provide enough context so the logic is clear. Aim for 1-2 clear sentences per section.",
    "Format strictly: 'RULE: [Precise operational action] | WHY: [The exact on-chain/math logic backing it]'.",
    "Do NOT create rules that contradict core metrics (e.g., do not ban Top 20 holders if they are < 45%). Focus on specific route combinations, MCap tiers, or ratio anomalies.",
    "Return strict JSON."
  ].join(' ');

  const user = {
    task: 'Generate up to 4 concise, data-backed screening rules.',
    output_schema: {
      lessons: [
        { 
          lesson: 'RULE: Restrict fee_trending route >$80k MCap unless whaleWallets >= 1. | WHY: 0% win-rate across 3 trades shows late buyers act as exit liquidity without stealth accumulation support.' 
        }
      ],
    },
    summary,
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });

    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({
          lesson: String(item.lesson || '').slice(0, 1000), 
          evidence: {}, 
        })).filter(item => item.lesson.trim().length > 0)
      : [];

    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] Deep-dive LLM analysis failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}
export async function generateSmartDegenLessons(summary) {
  const { bucketStats, correlation, totalClosed } = summary;
  const fallback = [];

  const best = bucketStats[0];
  const worst = bucketStats[bucketStats.length - 1];

  if (best && best.count >= 2 && best.avgPnlPercent > 0) {
    fallback.push({
      lesson: `Positions with ${best.label} smart degens averaged ${fmtPct(best.avgPnlPercent)} PnL (${best.count} trades, ${fmtPct(best.winRate)} win rate). Consider setting min_smart_degen_count to ${best.min}.`,
      evidence: best,
    });
  }
  if (worst && worst.count >= 2 && worst.avgPnlPercent < 0 && worst.label !== best?.label) {
    fallback.push({
      lesson: `Positions with ${worst.label} smart degens underperformed at ${fmtPct(worst.avgPnlPercent)} avg PnL. Avoid or filter out this degen bucket.`,
      evidence: worst,
    });
  }
  const hi = correlation.highDegen;
  const lo = correlation.lowDegen;
  if (hi.count >= 2 && lo.count >= 2 && hi.avgPnl != null && lo.avgPnl != null) {
    const diff = hi.avgPnl - lo.avgPnl;
    if (Math.abs(diff) > 5) {
      fallback.push({
        lesson: diff > 0
          ? `High smart degen (≥3) outperformed low degen by ${fmtPct(diff)} avg PnL. Setting min_smart_degen_count ≥ 3 likely improves results.`
          : `Low smart degen (<3) outperformed high degen by ${fmtPct(Math.abs(diff))} avg PnL. Smart degen count may not be predictive for this setup.`,
        evidence: { hi, lo, diff },
      });
    }
  }
  if (!fallback.length) {
    fallback.push({
      lesson: `Not enough data (${totalClosed} closed) to determine optimal min_smart_degen_count. Keep collecting trades.`,
      evidence: { totalClosed },
    });
  }

  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: 'You are Charon analyzing smart degen correlation data from meme coin dry-run trades. Return strict JSON only. Be specific and actionable.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze how smart degen count correlates with PnL outcomes. Produce up to 4 concise lessons that help tune min_smart_degen_count filter.',
            output_schema: { lessons: [{ lesson: 'short actionable rule', evidence: 'supporting data' }] },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({ lesson: String(item.lesson || '').slice(0, 500), evidence: item.evidence ?? {} })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 4) : fallback };
  } catch (err) {
    console.log(`[learn-smartdegen] LLM failed: ${err.message}`);
    return { lessons: fallback };
  }
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, 'active', ?, ?)
  `);
  for (const item of lessons) insert.run(runId, now(), item.lesson, json(item.evidence || {}));
  return runId;
}
