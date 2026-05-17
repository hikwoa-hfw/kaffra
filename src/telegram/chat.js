import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { activeStrategy, allStrategies, numSetting, boolSetting, setting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { activeLessonsForPrompt } from '../pipeline/llm.js';
import { stripThinking } from '../utils.js';

// Per-chat conversation history (in-memory)
const conversations = new Map();
const MAX_HISTORY_PAIRS = 8;

function buildBotContext() {
  const strat = activeStrategy();
  const all = allStrategies();

  const posStats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END)                              AS open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)                            AS closed_count,
      SUM(CASE WHEN status = 'closed' AND pnl_percent > 0 THEN 1 ELSE 0 END)        AS wins,
      SUM(CASE WHEN status = 'closed' THEN COALESCE(pnl_sol, 0) ELSE 0 END)         AS total_pnl_sol,
      AVG(CASE WHEN status = 'closed' THEN pnl_percent END)                          AS avg_pnl_pct
    FROM dry_run_positions
  `).get();

  const openPositions = db.prepare(`
    SELECT id, symbol, entry_mcap, high_water_mcap, tp_percent, sl_percent,
           trailing_enabled, trailing_percent, opened_at_ms, strategy_id, execution_mode
    FROM dry_run_positions WHERE status = 'open' LIMIT 10
  `).all().map(p => ({
    id: p.id,
    symbol: p.symbol,
    strategy: p.strategy_id,
    mode: p.execution_mode,
    entry_mcap_usd: p.entry_mcap,
    peak_mcap_usd: p.high_water_mcap,
    current_pnl_pct: p.entry_mcap && p.high_water_mcap
      ? ((p.high_water_mcap / p.entry_mcap) - 1) * 100 : null,
    tp: p.tp_percent,
    sl: p.sl_percent,
    trailing: p.trailing_enabled ? p.trailing_percent : 'off',
    age_min: Math.round((Date.now() - p.opened_at_ms) / 60000),
  }));

  const walletStats = db.prepare(
    `SELECT kind, COUNT(*) AS count FROM saved_wallets GROUP BY kind`
  ).all().reduce((acc, r) => { acc[r.kind] = r.count; return acc; }, {});

  const signalActivity = db.prepare(`
    SELECT kind, COUNT(*) AS count
    FROM signal_events WHERE at_ms > ?
    GROUP BY kind
  `).all(Date.now() - 3600000).reduce((acc, r) => { acc[r.kind] = r.count; return acc; }, {});

  const recentCandidates = db.prepare(`
    SELECT mint, status, created_at_ms, filter_result_json
    FROM candidates ORDER BY created_at_ms DESC LIMIT 10
  `).all().map(c => {
    const fr = JSON.parse(c.filter_result_json || '{}');
    return {
      mint: c.mint.slice(0, 8) + '...',
      status: c.status,
      age_min: Math.round((Date.now() - c.created_at_ms) / 60000),
      passed: fr.passed,
      failures: fr.failures?.slice(0, 3),
    };
  });

  return {
    timestamp: new Date().toISOString(),
    trading_mode: setting('trading_mode', 'dry_run'),
    active_strategy: { id: strat.id, name: strat.name, config: strat },
    all_strategies: all.map(s => ({ id: s.id, name: s.name, enabled: s.enabled })),
    positions: {
      open: posStats.open_count || 0,
      closed: posStats.closed_count || 0,
      wins: posStats.wins || 0,
      total_pnl_sol: Number(posStats.total_pnl_sol || 0).toFixed(4),
      avg_pnl_pct: Number(posStats.avg_pnl_pct || 0).toFixed(1),
      open_list: openPositions,
    },
    wallets: walletStats,
    signal_activity_last_1h: signalActivity,
    recent_candidates: recentCandidates,
    global_settings: {
      trending_enabled: boolSetting('trending_enabled', true),
      trending_source: setting('trending_source', 'jupiter'),
      trending_interval: setting('trending_interval', '5m'),
      smart_wallet_monitor_ms: numSetting('smart_wallet_monitor_ms', 0),
      gmgn_request_delay_ms: numSetting('gmgn_request_delay_ms', 2500),
      llm_candidate_pick_count: numSetting('llm_candidate_pick_count', 10),
      max_open_positions: numSetting('max_open_positions', 3),
    },
    active_lessons: activeLessonsForPrompt(5),
  };
}

function getHistory(chatId) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId);
}

function pushHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  // Keep last N pairs (user + assistant)
  const max = MAX_HISTORY_PAIRS * 2;
  if (history.length > max) history.splice(0, history.length - max);
}

export function clearChatHistory(chatId) {
  conversations.delete(chatId);
}

export function hasChatHistory(chatId) {
  return conversations.has(chatId) && conversations.get(chatId).length > 0;
}

export async function handleChatMessage(userMessage, chatId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return [
      '⚠️ LLM belum dikonfigurasi.',
      'Set <code>LLM_API_KEY</code> dan <code>LLM_BASE_URL</code> di file .env untuk menggunakan fitur chat.',
    ].join('\n');
  }

  const context = buildBotContext();

  const systemPrompt = [
    'You are Charon, an intelligent assistant for a Solana meme coin trading bot.',
    'You have full real-time knowledge of the bot\'s current state provided in the context below.',
    'You can help with: strategy evaluation, filter tuning, signal analysis, position review, performance analysis, and general Solana meme coin trading concepts.',
    'When the user asks you to do something that requires a bot command, tell them exactly which command to use.',
    'Available commands: /stratset <id> <key> <value>, /setfilter <key> <value>, /strategy <id>, /walletmonitor <30s|off>, /walletadd, /learn, /positions, /pnl.',
    'Be concise and actionable. Use numbers from the context when relevant.',
    'Respond in the same language the user writes in (Indonesian or English).',
    'Do not invent data not present in the context.',
    '',
    `CURRENT BOT CONTEXT:\n${JSON.stringify(context, null, 2)}`,
  ].join('\n');

  const history = getHistory(chatId);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  try {
    const res = await axios.post(
      `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        model: LLM_MODEL,
        temperature: 0.4,
        max_tokens: 1200,
        messages,
      },
      {
        timeout: LLM_TIMEOUT_MS,
        headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
      },
    );

    const raw = res.data?.choices?.[0]?.message?.content || '';
    const reply = stripThinking(raw).trim() || 'Tidak ada respons.';

    pushHistory(chatId, 'user', userMessage);
    pushHistory(chatId, 'assistant', reply);

    return reply;
  } catch (err) {
    console.log(`[chat] LLM error: ${err.message}`);
    return `❌ LLM error: ${err.message}`;
  }
}
