import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now } from '../utils.js';
import { numSetting, boolSetting, setSetting, setActiveStrategy, activeStrategy, updateStrategyConfig } from '../db/settings.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  walletsKeyboard,
  positionsText,
  positionsKeyboard,
  historyTradeText,
  historyTradeKeyboard,
  candidateButtons,
  sendTpSlDefaults,
  strategyMenuText,
  strategyKeyboard,
  topPnlText,
  topPnlKeyboard,
} from './menus.js';
import { autoImportWallets, purgeAutoWallets } from '../enrichment/smartWalletImport.js';
import { sendTelegram, sendBatch, sendPositionOpen, sendTradeIntent } from './send.js';
import { candidateSummary } from './format.js';
import { candidateById, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import { createDryRunPosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { saveBuySnapshot } from '../db/snapshots.js';
import { executeLiveBuy, executeConfirmedIntent, rejectIntent } from '../execution/router.js';
import { sendCandidate, sendPosition, closePosition, updatePositionRule, toggleTrailing, sendPnl } from './commands.js';
import { requestNumericFilterInput, requestStrategyNumericInput } from './input.js';

export async function handleCallback(query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  await answerCallback(query);
  if (!data.startsWith('input:') && !data.startsWith('stratinput:')) {
    const { pendingNumericInputs } = await import('./input.js');
    pendingNumericInputs.delete(String(chatId));
  }

  if (data === 'menu:main') return editMenuMessage(query, mainMenuText(), menuKeyboard());
  if (data === 'noop') return null;
  if (data === 'menu:agent') {
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:agent') {
    setSetting('agent_enabled', boolSetting('agent_enabled', true) ? 'false' : 'true');
    return editMenuMessage(query, agentText(), agentKeyboard());
  }
  if (data === 'toggle:trending_enabled' || data === 'toggle:trending_allow_degen' || data === 'toggle:dex_paid') {
    const key = data.replace('toggle:', '');
    setSetting(key, boolSetting(key, key === 'trending_enabled') ? 'false' : 'true');
    return editMenuMessage(query, filtersText(), filtersKeyboard());
  }
  if (data === 'menu:filters') return editMenuMessage(query, filtersText(), filtersKeyboard());
  if (data === 'menu:strategy') return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  if (data === 'menu:wallets') return editMenuMessage(query, walletsText(), walletsKeyboard());
  if (data === 'menu:positions') {
    return editMenuMessage(query, positionsText(), positionsKeyboard());
  }
  if (data === 'menu:historytrade') {
    return editMenuMessage(query, historyTradeText(), historyTradeKeyboard());
  }
  if (data === 'menu:pnl') return sendPnl(chatId, query);
  if (data === 'menu:toppnl') return editMenuMessage(query, topPnlText('pnl_percent', 'all', '30d'), topPnlKeyboard('pnl_percent', 'all', '30d'));
  if (data === 'walletmonitor:status') {
    const { walletMonitorStats } = await import('../signals/walletMonitor.js');
    const stats = walletMonitorStats();
    const { numSetting: ns } = await import('../db/settings.js');
    const monitorMs = ns('smart_wallet_monitor_ms', 0);
    return bot.sendMessage(chatId, [
      `📡 <b>Wallet Buy Monitor</b>`,
      `Status: <b>${monitorMs > 0 ? `active (every ${Math.round(monitorMs / 1000)}s)` : 'off'}</b>`,
      `Watching: ${stats.monitoring} wallets · Cursors: ${stats.cursors}`,
      ``,
      `To enable: /walletmonitor 30s`,
      `To disable: /walletmonitor off`,
    ].join('\n'), { parse_mode: 'HTML' });
  }
  if (data.startsWith('smartimport:')) {
    const [, source, kind, limitStr, period] = data.split(':');
    await bot.answerCallbackQuery(query.id, { text: `Importing ${source} ${kind}…` }).catch(() => {});
    try {
      const result = await autoImportWallets({ source, kind, limit: Number(limitStr) || 50, period: period || '7d' });
      await bot.sendMessage(chatId, [
        `✅ <b>Import done</b> — ${source} ${kind} (${period})`,
        `New: ${result.imported} · Updated: ${result.updated} · Skipped: ${result.skipped} · Errors: ${result.errors}`,
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Import failed: ${err.message}`);
    }
    return editMenuMessage(query, walletsText(), walletsKeyboard());
  }
  if (data.startsWith('smartpurge:')) {
    const kind = data.split(':')[1];
    const deleted = purgeAutoWallets(['smartwallet', 'kol'].includes(kind) ? kind : null);
    await bot.sendMessage(chatId, `🗑 Removed ${deleted} auto-imported wallet(s).`);
    return editMenuMessage(query, walletsText(), walletsKeyboard());
  }
  if (data.startsWith('toppnl:')) {
    const parts = data.split(':');
    const [, orderBy, mode, window] = parts;
    return editMenuMessage(query, topPnlText(orderBy, mode, window), topPnlKeyboard(orderBy, mode, window));
  }
  if (data === 'menu:learn') {
    const text = [
      '🧠 <b>Learning</b>',
      '',
      'Generate lessons from your trade history:',
      '• <code>/learn 7d</code> — general learning from dry-run outcomes',
      '• <code>/learnsmartdegen 7d</code> — correlate SmartDegen count with PnL to tune <code>min_smart_degen_count</code>',
      '• <code>/lessons</code> — view active lessons',
    ].join('\n');
    return editMenuMessage(query, text, navKeyboard([
      [
        { text: '🧠 Learn (12h)', callback_data: 'learn:run:12h' },
        { text: '🎰 SmartDegen (7d)', callback_data: 'learn:smartdegen:7d' },
      ],
    ]));
  }
  if (data.startsWith('learn:run:')) {
    const windowArg = data.split(':')[2] || '12h';
    const { runLearning } = await import('../learning/commands.js');
    await runLearning(chatId, windowArg);
    return null;
  }
  if (data.startsWith('learn:smartdegen:')) {
    const windowArg = data.split(':')[2] || '7d';
    const { runSmartDegenLearning } = await import('../learning/commands.js');
    await runSmartDegenLearning(chatId, windowArg);
    return null;
  }
  if (data === 'menu:settings') return editMenuMessage(query, `${agentText()}\n\n${filtersText()}`, navKeyboard([
    [
      { text: 'Agent', callback_data: 'menu:agent' },
      { text: 'Filters', callback_data: 'menu:filters' },
    ],
  ]));

  if (data.startsWith('strategy:select:')) {
    const strategyId = data.replace('strategy:select:', '');
    setActiveStrategy(strategyId);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }
  if (data.startsWith('stratcfg:')) {
    const key = data.replace('stratcfg:', '');
    return handleStratConfig(query, chatId, key);
  }
  if (data.startsWith('stratinput:')) {
    const key = data.replace('stratinput:', '');
    return requestStrategyNumericInput(query, key);
  }

  const [kind, id, value] = data.split(':');
  if (kind === 'input') return requestNumericFilterInput(query, id);
  if (kind === 'set') return updateSettingFromButton(query, id, value);
  if (kind === 'batch') return sendBatch(chatId, Number(id));
  if (kind === 'intent') {
    if (value === 'confirm') return executeConfirmedIntent(chatId, Number(id));
    if (value === 'reject') return rejectIntent(chatId, Number(id));
  }
  if (kind === 'cand') return sendCandidate(chatId, Number(id));
  if (kind === 'ign') {
    updateCandidateStatus(Number(id), 'ignored');
    return bot.sendMessage(chatId, 'Ignored candidate.');
  }
  if (kind === 'buy') {
    const row = candidateById(Number(id));
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    if (!canOpenMorePositions()) {
      return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}). Close one first or raise the limit.`);
    }
    const candidate = row.candidate;
    const decision = { verdict: 'BUY', confidence: 100, reason: 'Manual dry buy', risks: [], suggested_tp_percent: numSetting('default_tp_percent', 50), suggested_sl_percent: numSetting('default_sl_percent', -25) };
    const decisionId = storeDecision(row.id, candidate, decision);
    decision.id = decisionId;
    if (tradingMode() === 'live') {
      await executeLiveBuy(row, decision, 'manual', [row], row.id);
      return;
    }
    const positionId = await createDryRunPosition(row.id, candidate, decision, 'manual_buy');
    saveBuySnapshot(positionId, row, decision, 'manual', [row]);
    logDecisionEvent({
      batchId: 'manual',
      triggerCandidateId: row.id,
      selectedRow: row,
      rows: [row],
      decision,
      mode: tradingMode(),
      action: 'manual_dry_run_entry',
      execution: { positionId },
    });
    return sendPositionOpen(positionId);
  }
  if (kind === 'tpsl') return sendTpSlDefaults(chatId, query);
  if (kind === 'pos') return sendPosition(chatId, Number(id), query);
  if (kind === 'sell') return closePosition(chatId, Number(id), 'MANUAL');
  if (kind === 'tp') return updatePositionRule(chatId, Number(id), 'tp_percent', Number(value), query);
  if (kind === 'sl') return updatePositionRule(chatId, Number(id), 'sl_percent', Number(value), query);
  if (kind === 'trail') return toggleTrailing(chatId, Number(id), query);
  return null;
}

async function answerCallback(query, text = '') {
  await bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
}

export async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}

const STRAT_PRESETS = {
  tp_percent: [25, 50, 75, 100, 150, 200],
  sl_percent: [-10, -15, -20, -25, -30, -40],
  position_size_sol: [0.02, 0.05, 0.1, 0.2, 0.5],
  max_open_positions: [1, 2, 3, 5, 10],
  min_mcap_usd: [0, 5000, 10000, 25000, 50000, 100000],
  max_mcap_usd: [0, 50000, 100000, 200000, 500000, 1000000],
  trailing_percent: [10, 15, 20, 25, 30],
  min_source_count: [1, 2, 3, 4],
  min_holders: [0, 100, 500, 1000, 2000, 5000],
  llm_min_confidence: [0, 30, 50, 60, 70, 80, 90],
  partial_tp_at_percent: [25, 50, 75, 100, 150, 200],
  partial_tp_sell_percent: [25, 33, 50, 75],
  max_hold_ms: [0, 1800000, 3600000, 7200000, 14400000, 28800000, 86400000],
  min_fee_claim_sol: [0, 0.5, 1, 2, 5, 10],
  min_gmgn_total_fee_sol: [0, 3, 5, 10, 20],
  max_ath_distance_pct: [0, -20, -30, -40, -50, -60],
  token_age_max_ms: [0, 1800000, 3600000],
  min_holder_growth_pct: [0, 10, 25, 50, 100, 200],
  min_buy_sell_ratio: [0, 1, 1.2, 1.5, 2, 3],
  min_smart_wallet_holders: [0, 1, 2, 3, 5],
  min_kol_holders: [0, 1, 2, 3, 5],
  min_smart_degen_count: [0, 1, 2, 3, 5, 10],
  max_dev_sold_pct: [0, 20, 30, 50, 70, 90],
};

function formatStratValue(key, value) {
  if (key === 'max_hold_ms' || key === 'token_age_max_ms') {
    return value > 0 ? `${Math.round(value / 60000)}m` : 'off';
  }
  if (key.includes('percent') || key.includes('pct')) return `${value}%`;
  if (key.includes('sol')) return `${value} SOL`;
  if (key.includes('usd')) return value > 0 ? `$${value.toLocaleString()}` : 'off';
  return String(value);
}

async function handleStratConfig(query, chatId, key) {
  const strat = activeStrategy();
  const newConfig = { ...strat };
  delete newConfig.id;
  delete newConfig.name;

  // Boolean toggles
  const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'profit_lock_enabled', 'require_dev_holding']);
  if (boolKeys.has(key)) {
    newConfig[key] = !strat[key];
    if (key === 'profit_lock_enabled' && newConfig[key]) {
      newConfig.tp_percent = 999999;
      newConfig.sl_percent = -20;
      newConfig.trailing_enabled = false;
    }
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Cycle through presets
  const presets = STRAT_PRESETS[key];
  if (presets) {
    const current = Number(strat[key] ?? 0);
    const idx = presets.indexOf(current);
    const next = idx >= 0 ? presets[(idx + 1) % presets.length] : presets[0];
    newConfig[key] = next;
    updateStrategyConfig(strat.id, newConfig);
    return editMenuMessage(query, strategyMenuText(), strategyKeyboard());
  }

  // Fallback: show current value
  return bot.sendMessage(chatId, `Current ${key}: ${formatStratValue(key, strat[key])}\nUse /stratset ${strat.id} ${key} <value> to change.`);
}

async function updateSettingFromButton(query, key, value) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const valid = new Set([
    'min_fee_claim_sol',
    'min_mcap_usd',
    'max_mcap_usd',
    'min_gmgn_total_fee_sol',
    'min_graduated_volume_usd',
    'max_top20_holder_percent',
    'min_saved_wallet_holders',
    'trending_enabled',
    'trending_source',
    'trending_allow_degen',
    'trending_interval',
    'trending_limit',
    'trending_order_by',
    'trending_min_volume_usd',
    'trending_min_swaps',
    'trending_max_rug_ratio',
    'trending_max_bundler_rate',
    'trading_mode',
    'llm_min_confidence',
    'llm_candidate_pick_count',
    'llm_candidate_max_age_ms',
    'max_open_positions',
    'dry_run_buy_sol',
    'default_tp_percent',
    'default_sl_percent',
    'default_trailing_enabled',
    'default_trailing_percent',
  ]);
  if (!valid.has(key) || value == null) return bot.sendMessage(chatId, 'Unknown setting.');
  setSetting(key, value);
  const text = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentText()
    : filtersText();
  const extra = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentKeyboard()
    : filtersKeyboard();
  return editMenuMessage(query, text, extra);
}
