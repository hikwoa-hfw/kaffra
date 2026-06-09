import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json, parseWindowMs, formatWindow } from '../utils.js';
import { escapeHtml, fmtPct, fmtUsd, fmtSol, short as shortAddr } from '../format.js';
import { db } from '../db/connection.js';
import { getClosedPositionsWithSnapshots } from '../db/snapshots.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  positionsKeyboard,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, runSmartDegenLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';
import { autoImportWallets, purgeAutoWallets, autoWalletCount } from '../enrichment/smartWalletImport.js';
import { walletMonitorStats } from '../signals/walletMonitor.js';
import { handleChatMessage, clearChatHistory, hasChatHistory } from './chat.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;

  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;

  // Free-form chat — route non-command messages to LLM agent
  if (!text.startsWith('/')) {
    if (!text) return; // ignore empty messages (stickers, photos, etc.)
    await bot.sendChatAction(chatId, 'typing');
    const reply = await handleChatMessage(text, chatId);
    return sendChatReply(chatId, reply);
  }
  if (text.startsWith('/reset')) {
    clearChatHistory(chatId);
    return bot.sendMessage(chatId, '🔄 Chat history cleared. Starting fresh.');
  }
  if (text.startsWith('/ask')) {
    const question = text.slice('/ask'.length).trim();
    if (!question) return bot.sendMessage(chatId, 'Usage: /ask &lt;your question&gt;\n\nOr just type freely without any command.', { parse_mode: 'HTML' });
    await bot.sendChatAction(chatId, 'typing');
    const reply = await handleChatMessage(question, chatId);
    return sendChatReply(chatId, reply);
  }
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/sell')) {
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isFinite(id) || id <= 0) return bot.sendMessage(chatId, 'Usage: /sell <position_id>');
    return closePosition(chatId, id, 'MANUAL');
  }
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen', 'profit_lock'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct, fee_mcap_divisor, migrated_buy_max_ath_distance_pct, volume_to_mcap_min_ratio, profit_lock_enabled, profit_lock_trigger_1_percent, profit_lock_floor_1_percent, profit_lock_trigger_2_percent, profit_lock_floor_2_percent, profit_lock_trigger_3_percent, profit_lock_floor_3_percent, profit_lock_dynamic_drawdown_percent');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd', 'fee_mcap_divisor', 'migrated_buy_max_ath_distance_pct', 'volume_to_mcap_min_ratio', 'profit_lock_trigger_1_percent', 'profit_lock_floor_1_percent', 'profit_lock_trigger_2_percent', 'profit_lock_floor_2_percent', 'profit_lock_trigger_3_percent', 'profit_lock_floor_3_percent', 'profit_lock_dynamic_drawdown_percent', 'min_holder_growth_pct', 'min_holder_growth', 'min_buy_sell_ratio']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim', 'profit_lock_enabled']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
      if (key === 'profit_lock_enabled' && newConfig[key]) {
        newConfig.tp_percent = 999999;
        newConfig.sl_percent = -20;
        newConfig.trailing_enabled = false;
      }
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) {
    const parts = text.split(/\s+/);
    const modeArg = ['dry_run', 'live', 'all'].includes(parts[1]) ? parts[1] : 'all';
    const windowArg = parts[2] || (parts[1] && !['dry_run', 'live', 'all'].includes(parts[1]) ? parts[1] : '12h');
    return sendPnl(chatId, null, modeArg, windowArg);
  }
  if (text.startsWith('/recap')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return sendRecap(chatId, windowArg);
  }
  if (text.startsWith('/learnsmartdegen')) {
    const windowArg = text.split(/\s+/)[1] || '7d';
    return runSmartDegenLearning(chatId, windowArg);
  }
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address, kindArg] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd &lt;label&gt; &lt;address&gt; [smartwallet|kol|ratwallet]', { parse_mode: 'HTML' });
    const validKinds = new Set(['wallet', 'smartwallet', 'kol', 'ratwallet']);
    const kind = validKinds.has(kindArg) ? kindArg : 'wallet';
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms, kind) VALUES (?, ?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address, kind = excluded.kind
    `).run(label, address, now(), kind);
    return bot.sendMessage(chatId, `Saved wallet <b>${escapeHtml(label)}</b> (${kind}).`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/smartimport')) {
    const [, sourceArg, kindArg, limitArg, periodArg, replaceArg] = text.split(/\s+/);
    const source = ['gmgn', 'jupiter'].includes(sourceArg) ? sourceArg : 'gmgn';
    const kind = ['smartwallet', 'kol'].includes(kindArg) ? kindArg : 'smartwallet';
    const limit = Math.min(200, Math.max(1, Number(limitArg) || 50));
    const period = ['1d', '7d', '30d'].includes(periodArg) ? periodArg : '7d';
    const replace = replaceArg === 'replace';
    await bot.sendMessage(chatId, `⏳ Importing ${limit} wallets from <b>${source}</b> as <b>${kind}</b> (period: ${period})…`, { parse_mode: 'HTML' });
    try {
      const result = await autoImportWallets({ source, kind, limit, period, replace });
      return bot.sendMessage(chatId, [
        `✅ <b>Smart Wallet Import</b>`,
        `Source: ${result.source} · Period: ${period}`,
        `New: ${result.imported} · Updated: ${result.updated} · Skipped: ${result.skipped} · Errors: ${result.errors}`,
        `Total from source: ${result.total}`,
        `Auto wallets in DB: ${autoWalletCount()}`,
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Import failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  if (text.startsWith('/walletmonitor')) {
    const parts = text.split(/\s+/);
    const intervalArg = parts[1]; // e.g. "30s", "60s", "off"
    if (intervalArg) {
      let ms = 0;
      if (intervalArg !== 'off') {
        const match = intervalArg.match(/^(\d+)(s|m)?$/);
        if (match) {
          ms = Number(match[1]) * (match[2] === 'm' ? 60000 : 1000);
          ms = Math.max(10_000, ms); // minimum 10s
        } else {
          return bot.sendMessage(chatId, 'Usage: /walletmonitor [30s|60s|5m|off]');
        }
      }
      setSetting('smart_wallet_monitor_ms', String(ms));
      await bot.sendMessage(chatId, ms > 0
        ? `✅ Wallet monitor set to every ${Math.round(ms / 1000)}s.\n<i>Restart bot to apply.</i>`
        : `⏹ Wallet monitor disabled.\n<i>Restart bot to apply.</i>`,
        { parse_mode: 'HTML' }
      );
    }
    const stats = walletMonitorStats();
    const monitorMs = numSetting('smart_wallet_monitor_ms', 0);
    return bot.sendMessage(chatId, [
      `📡 <b>Wallet Buy Monitor</b>`,
      `Status: <b>${monitorMs > 0 ? `active (${Math.round(monitorMs / 1000)}s)` : 'off'}</b>`,
      `Monitoring: ${stats.monitoring} wallets`,
      `Cursors set: ${stats.cursors}`,
      `Seen txns: ${stats.seenTxns}`,
      ``,
      `Use /walletmonitor 30s to enable (min 10s)`,
      `Use /walletmonitor off to disable`,
    ].join('\n'), { parse_mode: 'HTML' });
  }
  if (text.startsWith('/smartpurge')) {
    const kindArg = text.split(/\s+/)[1];
    const kind = ['smartwallet', 'kol'].includes(kindArg) ? kindArg : null;
    const deleted = purgeAutoWallets(kind);
    return bot.sendMessage(chatId, `🗑 Removed ${deleted} auto-imported wallet(s)${kind ? ` (kind: ${kind})` : ''}.`);
  }
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
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
      'fee_mcap_divisor',
      'migrated_buy_max_ath_distance_pct',
      'volume_to_mcap_min_ratio',
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
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  await bot.sendMessage(chatId, positionsText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...positionsKeyboard(),
  });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'ask', description: 'Ask the agent anything (or just type freely)' },
    { command: 'reset', description: 'Clear chat conversation history' },
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show active/inactive positions' },
    { command: 'sell', description: 'Manually sell an open position' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'recap', description: 'Generate trade recap file (12h|1d|7d)' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'learnsmartdegen', description: 'Analyze SmartDegen count correlation with PnL' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL (label address [smartwallet|kol])' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
    { command: 'smartimport', description: 'Auto-import smart wallets [gmgn|jupiter] [smartwallet|kol] [limit] [7d] [replace]' },
    { command: 'smartpurge', description: 'Remove auto-imported wallets [smartwallet|kol]' },
    { command: 'walletmonitor', description: 'Show/set wallet buy monitor interval (30s|60s|5m|off)' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

export async function sendPnl(chatId, query = null, modeFilter = 'all', windowArg = '12h') {
  const windowMs = windowArg === 'all' ? 0 : parseWindowMs(windowArg);
  const windowLabel = windowArg === 'all' ? 'All Time' : formatWindow(windowMs);

  const modeLines = [];
  if (modeFilter === 'all' || modeFilter === 'dry_run') {
    modeLines.push(summarizeModePnl('dry_run', 'Dry-run Trade', windowMs));
  }
  if (modeFilter === 'all' || modeFilter === 'live') {
    modeLines.push(summarizeModePnl('live', 'Live Trade', windowMs));
  }

  const wallets = savedWallets();
  const walletLines = [];
  const chunks = [];
  if (wallets.length) {
    for (const wallet of wallets) {
      const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
      if (!pnl) {
        chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
        continue;
      }
      chunks.push([
        `• <b>${escapeHtml(wallet.label)}</b>`,
        `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
        `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
      ].join('\n'));
    }
    walletLines.push(`<b>Wallet PnL</b>\n${chunks.join('\n\n')}`);
  }
  
  const text = `📊 <b>PnL (${windowLabel})</b>\n\n${modeLines.join('\n\n')}${walletLines.length ? `\n\n${walletLines.join('\n\n')}` : ''}`;
  const pnlKeyboard = navKeyboard([[{ text: '🏆 Top Performance', callback_data: 'menu:toppnl' }]]);
  return query ? editMenuMessage(query, text, pnlKeyboard) : bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...pnlKeyboard });
}

function summarizeModePnl(mode, title, windowMs = 0) {
  const cutoff = windowMs > 0 ? now() - windowMs : 0;
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_positions,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_positions,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_positions,
      SUM(CASE WHEN status = 'closed' AND COALESCE(pnl_percent, 0) > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status = 'closed' THEN COALESCE(pnl_percent, 0) ELSE 0 END) AS total_pnl_percent,
      SUM(CASE WHEN status = 'closed' THEN COALESCE(pnl_sol, 0) ELSE 0 END) AS total_pnl_sol
    FROM dry_run_positions
    WHERE COALESCE(execution_mode, 'dry_run') = ? AND opened_at_ms >= ?
  `).get(mode, cutoff);

  const closed = Number(row?.closed_positions || 0);
  const wins = Number(row?.wins || 0);
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const avgPnl = closed > 0 ? Number(row?.total_pnl_percent || 0) / closed : 0;
  const totalPnlSol = Number(row?.total_pnl_sol || 0);
  const sign = totalPnlSol > 0 ? '+' : '';

  return [
    `<b>${title}</b>`,
    `Positions: ${Number(row?.total_positions || 0)} · Open: ${Number(row?.open_positions || 0)} · Closed: ${closed}`,
    `Win: ${wins}/${closed} (${fmtPct(winRate)})`,
    `Avg closed PnL: ${fmtPct(avgPnl)} · Total closed PnL: <b>${sign}${totalPnlSol.toFixed(4)} SOL</b>`,
  ].join('\n');
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}


function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}

// Send LLM chat reply — try HTML first, fall back to plain text on parse error
async function sendChatReply(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    if (/can't parse entities|parse_mode/i.test(err.message)) {
      // LLM returned unescaped HTML characters — send as plain text
      await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
    } else {
      throw err;
    }
  }
}

// ── /recap command ─────────────────────────────────────────────────────────

async function sendRecap(chatId, windowArg = '12h') {
  const windowMs = parseWindowMs(windowArg);
  const windowLabel = formatWindow(windowMs);
  const positions = getClosedPositionsWithSnapshots(windowMs);

  if (!positions.length) {
    return bot.sendMessage(chatId, `📋 No closed positions in the last ${windowLabel}.`);
  }

  const wins = positions.filter(p => (p.pnl_percent || 0) > 0).length;
  const losses = positions.length - wins;
  const winRate = positions.length > 0 ? (wins / positions.length * 100).toFixed(1) : '0.0';
  const totalPnlSol = positions.reduce((sum, p) => sum + (Number(p.pnl_sol) || 0), 0);
  const avgPnl = positions.length > 0 ? positions.reduce((sum, p) => sum + (Number(p.pnl_percent) || 0), 0) / positions.length : 0;
  const sign = totalPnlSol >= 0 ? '+' : '';

  const lines = [
    `# KAFFRA RECAP — Last ${windowLabel}`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Closed | ${positions.length} |`,
    `| Wins | ${wins} |`,
    `| Losses | ${losses} |`,
    `| Win Rate | ${winRate}% |`,
    `| Avg PnL | ${avgPnl.toFixed(1)}% |`,
    `| Total PnL | ${sign}${totalPnlSol.toFixed(4)} SOL |`,
    '',
  ];

  for (const pos of positions) {
    lines.push(...formatRecapPosition(pos));
  }

  lines.push('', '---', `*End of recap — ${positions.length} position(s)*`);

  const content = lines.join('\n');
  const tmpFile = path.join(os.tmpdir(), `kaffra_recap_${windowLabel}_${Date.now()}.md`);
  fs.writeFileSync(tmpFile, content, 'utf8');

  try {
    await bot.sendDocument(chatId, tmpFile, {
      caption: `📋 Kaffra Recap — ${windowLabel} · ${positions.length} positions · PnL: ${sign}${totalPnlSol.toFixed(4)} SOL`,
    });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function formatRecapPosition(pos) {
  const snapshot = pos.buySnapshot;
  const candidate = snapshot?.candidate || null;
  const decision = snapshot?.decision || null;
  const batchSummary = snapshot?.batchSummary || null;
  const pnl = Number(pos.pnl_percent || 0);
  const pnlSol = Number(pos.pnl_sol || 0);
  const pnlSign = pnl >= 0 ? '+' : '';
  const emoji = pnl >= 0 ? '🟢' : '🔴';
  const holdMs = (pos.closed_at_ms || 0) - (pos.opened_at_ms || 0);
  const holdStr = formatHoldDuration(holdMs);
  const peakPnl = pos.entry_mcap && pos.high_water_mcap ? ((pos.high_water_mcap / pos.entry_mcap) - 1) * 100 : null;
  const lowPnl = pos.entry_mcap && pos.low_water_mcap ? ((pos.low_water_mcap / pos.entry_mcap) - 1) * 100 : null;

  const lines = [
    '---',
    '',
    `### ${emoji} Position #${pos.id} — ${pos.symbol || shortAddr(pos.mint)} (${pnlSign}${pnl.toFixed(1)}%)`,
    '',
    `**Mint:** \`${pos.mint}\``,
    `**Strategy:** ${pos.strategy_id || 'sniper'} · **Mode:** ${pos.execution_mode || 'dry_run'}`,
    `**Hold:** ${holdStr}`,
    '',
    '#### Position Details',
    '',
    `| | Value |`,
    `|---|---|`,
    `| Entry MCap | ${fmtUsd(pos.entry_mcap)} |`,
    `| Exit MCap | ${fmtUsd(pos.exit_mcap)} |`,
    `| High MCap | ${fmtUsd(pos.high_water_mcap)} |`,
    `| Low MCap | ${fmtUsd(pos.low_water_mcap)} |`,
    `| Size | ${fmtSol(pos.size_sol)} SOL |`,
    `| PnL | ${pnlSign}${pnl.toFixed(1)}% (${pnlSign}${pnlSol.toFixed(4)} SOL) |`,
    peakPnl != null ? `| Peak PnL | ${peakPnl >= 0 ? '+' : ''}${peakPnl.toFixed(1)}% |` : null,
    lowPnl != null ? `| Lowest PnL | ${lowPnl >= 0 ? '+' : ''}${lowPnl.toFixed(1)}% |` : null,
    `| TP / SL | +${pos.tp_percent}% / ${pos.sl_percent}% |`,
    `| Trailing | ${pos.trailing_enabled ? `${pos.trailing_percent}%` : 'off'} |`,
    `| Exit Reason | ${pos.exit_reason || 'unknown'} |`,
    pos.entry_signature ? `| Entry TX | ${pos.entry_signature} |` : null,
    pos.exit_signature ? `| Exit TX | ${pos.exit_signature} |` : null,
  ].filter(Boolean);

  // LLM Buy Reasoning section
  if (decision) {
    lines.push(
      '',
      '#### LLM Buy Reasoning',
      '',
      `**Verdict:** ${decision.verdict || '?'} · **Confidence:** ${decision.confidence != null ? decision.confidence + '%' : '?'}`,
    );
    if (batchSummary) {
      lines.push(`**Batch:** #${batchSummary.batchId || '?'} · **Screened:** ${batchSummary.candidatesScreened || '?'} candidates`);
    }
    if (decision.reason) {
      lines.push('', `**Reason:**`, `> ${String(decision.reason).replace(/\n/g, '\n> ')}`);
    }
    const risks = decision.risks || (typeof decision.risks_json === 'string' ? JSON.parse(decision.risks_json || '[]') : []);
    if (risks.length) {
      lines.push('', '**Risks:**');
      for (const risk of risks) {
        lines.push(`- ${risk}`);
      }
    }
    if (decision.suggested_tp_percent || decision.suggested_sl_percent) {
      lines.push(``, `**LLM Suggested:** TP ${decision.suggested_tp_percent || '?'}% · SL ${decision.suggested_sl_percent || '?'}%`);
    }
  } else {
    lines.push('', '#### LLM Buy Reasoning', '', '*No snapshot available (position created before this feature)*');
  }

  // Candidate Data at Buy Time section
  if (candidate) {
    const m = candidate.metrics || {};
    const h = candidate.holders || {};
    const swe = candidate.savedWalletExposure || {};
    const sig = candidate.signals || {};
    const signalLabel = sig.label || [
      sig.hasFeeClaim ? 'fees' : null,
      sig.hasGraduated ? 'graduated' : null,
      sig.hasTrending ? 'trending' : null,
    ].filter(Boolean).join(' + ') || sig.route || 'unknown';

    lines.push(
      '',
      '#### Candidate Data at Buy Time',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Signal | ${signalLabel} |`,
      `| MCap | ${fmtUsd(m.marketCapUsd || m.graduatedMarketCapUsd)} |`,
      `| Liquidity | ${fmtUsd(m.liquidityUsd)} |`,
      `| Holders | ${m.holderCount || '?'} |`,
      `| Top 20 | ${h.top20Percent != null ? h.top20Percent.toFixed(1) + '%' : '?'} |`,
      `| Max Holder | ${h.maxHolderPercent != null ? h.maxHolderPercent.toFixed(1) + '%' : '?'} |`,
      `| Fees | ${fmtSol(m.gmgnTotalFeesSol)} SOL |`,
      `| Grad Volume | ${fmtUsd(m.graduatedVolumeUsd)} |`,
      `| Smart Wallets | ${swe.smartWalletCount || 0}/${swe.checked || 0} |`,
      `| KOLs | ${swe.kolCount || 0} |`,
    );

    if (candidate.feeClaim) {
      lines.push(`| Fee Claim | ${fmtSol(candidate.feeClaim.distributedSol)} SOL |`);
    }

    if (candidate.trending) {
      lines.push(
        `| Trending Rank | #${candidate.trending.rank || '?'} (${candidate.trending.interval || ''}) |`,
        `| Trending Vol | ${fmtUsd(m.trendingVolumeUsd)} |`,
        `| Smart Degen | ${m.trendingSmartDegenCount || 0} |`,
      );
    }

    // Chart context
    const chartWindow = candidate.chart?.windows?.find(w => w.label === 'ath_context_24h_5m' && w.available)
      || candidate.chart?.windows?.find(w => w.label === 'recent_24h_5m' && w.available);
    if (chartWindow) {
      lines.push(
        `| ATH Distance | ${fmtPct(chartWindow.belowHighPercent)} |`,
        `| Range Low | ${fmtPct(chartWindow.aboveLowPercent)} |`,
        `| Top Blast Risk | ${candidate.chart.topBlastRisk ? 'yes' : 'no'} |`,
      );
    }

    if (candidate.devWallet) {
      lines.push(`| Dev | ${candidate.devWallet.isHolding ? 'holding' : 'dumped'}${candidate.devWallet.soldPercent != null ? ` (sold ${candidate.devWallet.soldPercent.toFixed(0)}%)` : ''} |`);
    }
  }

  lines.push('');
  return lines;
}

function formatHoldDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
