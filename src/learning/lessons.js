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
  
  // AI QUANT SCIENTIST & TRENCH MASTER PROMPT
  const system = [
    "You are Kaffra's chief Quant Scientist and an elite Solana meme coin trench master.",
    "Your task is to conduct a rigorous, multi-dimensional retrospective analysis of recent dry-run trading evidence.",
    "Do not provide shallow, generic, or superficial advice (e.g., 'avoid high market cap').",
    "You must systematically diagnose the underlying market mechanics, structural failures, and operational successes of the trades.",
    "Analyze the exact mathematical correlations between 'byRoute' win rates, fee density, entry Market Cap tiers, exit reasons, and the LLM average confidence scores.",
    "Provide deeply granular, highly precise, and richly detailed operational lessons.",
    "Each lesson must explain the deep chain of logic: WHAT happened, WHY it happened on-chain (e.g., sniper behavior, liquidity traps, developer dumping), and EXACTLY HOW to modify our screening thresholds to fix it.",
    "Return strict JSON matching the requested schema."
  ].join(' ');

  const user = {
    task: 'Perform an exhaustive post-mortem analysis of the provided trading window and generate deep, multi-sentence master screening lessons.',
    output_schema: {
      lessons: [
        { 
          lesson: 'A comprehensive, multi-sentence operational rule combined with its deep causal analysis and concrete data evidence. (Example format: "Restrict route \'smart_money\' strictly to entries below $750k MCap. Data shows our win rate drops to 0% across 6 trades when entering higher, indicating that late-stage buyers on this route are serving exclusively as exit liquidity for snipers. For high MCap tiers, pivot screening to prioritize tokens with developer token burn confirmation and a maximum top-20 holder concentration of 25% to mitigate cabal dumps.").'
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
