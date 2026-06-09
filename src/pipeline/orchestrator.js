import { now, pruneSeen, log, logError } from '../utils.js';
import { saveBuySnapshot } from '../db/snapshots.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode, openPositions } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent, sendPositionExit } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution, forceClosePosition } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  try {
    return await _processCandidateFromSignals(signals);
  } catch (err) {
    logError('agent', `processCandidateFromSignals unhandled error for ${signals?.mint?.slice(0, 8) ?? '?'}: ${err.message}`);
  }
}

async function _processCandidateFromSignals(signals) {
  const currentOpenPositions = openPositions();
  const isAlreadyOpen = currentOpenPositions.some(p => p.mint === signals.mint);
  if (isAlreadyOpen) {
    log('agent', `Position already open for ${signals.mint.slice(0, 8)}, skipping to prevent DCA.`);
    return;
  }

  if (!canOpenMorePositions()) {
    const strat = activeStrategy();
    const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
    log('agent', `max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    log('candidate', `filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    
    if (!rows.find(r => r.id === candidateId)) {
      const selfRow = candidateById(candidateId);
      if (selfRow) {
        rows.unshift(selfRow); 
      }
    }

    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const agentEnabled = boolSetting('agent_enabled', true);
  const configuredConfidenceThreshold = Number(strat.llm_min_confidence ?? numSetting('llm_min_confidence', 75));
  const confidenceThreshold = Number.isFinite(configuredConfidenceThreshold) ? configuredConfidenceThreshold : 75;
  const maxOpenPositions = strat.max_open_positions ?? numSetting('max_open_positions', 3);

  if (selectedRow && agentEnabled && batchDecision.verdict === 'BUY' && batchDecision.confidence >= confidenceThreshold) {
    if (!canOpenMorePositions()) {
      log('agent', `max open positions reached (${openPositionCount()}/${maxOpenPositions}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled,
        verdict: batchDecision.verdict,
        confidence: batchDecision.confidence,
        confidenceThreshold,
        openPositions: openPositionCount(),
        maxOpenPositions,
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const strat = activeStrategy();
  const maxOpenPositions = strat.max_open_positions ?? numSetting('max_open_positions', 3);
 const freshSelectedRow = await refreshCandidateForExecution(selectedRow);

  // --- start injection THE EXECUTION BUFFER GUARD (25% TOLERANCE) ---
  let isApproved = freshSelectedRow.candidate.filters?.passed;
  let currentFailures = freshSelectedRow.candidate.filters?.failures || [];

  if (!isApproved) {
    const mcapFailures = currentFailures.filter(f => f.toLowerCase().includes('market cap') && f.includes('>'));
    const nonMcapFailures = currentFailures.filter(f => !(f.toLowerCase().includes('market cap') && f.includes('>')));

    if (mcapFailures.length > 0 && nonMcapFailures.length === 0) {
      const oldMcap = Number(selectedRow.candidate.metrics?.marketCapUsd || selectedRow.candidate.metrics?.graduatedMarketCapUsd || 0);
      const newMcap = Number(freshSelectedRow.candidate.metrics?.marketCapUsd || freshSelectedRow.candidate.metrics?.graduatedMarketCapUsd || 0);
      
      const maxAllowedMcap = oldMcap > 0 ? oldMcap * 1.25 : 60000 * 1.25; 

      if (newMcap > 0 && newMcap <= maxAllowedMcap) {
        isApproved = true; // OVERRIDE! Kita loloskan.
        freshSelectedRow.candidate.filters.passed = true;
        freshSelectedRow.candidate.filters.failures = []; // Bersihkan status error
        console.log(`[Execution Buffer] Overriding MCap spike! Old: $${oldMcap.toFixed(0)}, New: $${newMcap.toFixed(0)}. Proceeding to BUY.`);
      }
    }
  }
  // --- end of injection execution buffer

  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  
  if (!isApproved) { 
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    try {
      const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
      saveBuySnapshot(positionId, freshSelectedRow, decision, batchId, executionRows);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'dry_run_entry',
        guardrails: { maxOpenPositions, openPositions: openPositionCount() },
        execution: { positionId },
      });
      await sendPositionOpen(positionId);
    } catch (err) {
      logError('agent', `dry_run entry failed for ${freshSelectedRow.candidate.token.mint.slice(0, 8)}: ${err.message}`);
    }
    return;
  }

  if (mode === 'confirm') {
    try {
      const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'confirm_intent_created',
        guardrails: { maxOpenPositions, openPositions: openPositionCount() },
        execution: { intentId },
      });
      await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    } catch (err) {
      logError('agent', `confirm intent failed for ${freshSelectedRow.candidate.token.mint.slice(0, 8)}: ${err.message}`);
    }
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions, openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function handleSmartWalletSell({ mint, wallet }) {
  const positions = openPositions().filter(p => p.mint === mint);
  if (!positions.length) return;
  log('agent', `${wallet.kind} ${wallet.label} sold ${mint.slice(0, 8)} — force-closing ${positions.length} position(s)`);
  for (const position of positions) {
    try {
      const exitReason = `SMART_WALLET_SELL:${wallet.label}`;
      const result = await forceClosePosition(position.id, exitReason);
      if (result) {
        await sendPositionExit(result);
        await sendTelegram(
          `📤 <b>Smart wallet exit</b> — <b>${escapeHtml(wallet.kind)}</b> <code>${escapeHtml(wallet.label)}</code> sold\n` +
          `Position #${position.id} ${escapeHtml(position.symbol || short(mint))} closed at ${result.pnlPercent >= 0 ? '+' : ''}${result.pnlPercent?.toFixed(1)}%`
        );
      }
    } catch (err) {
      logError('agent', `smart wallet sell exit pos ${position.id}: ${err.message}`);
    }
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
