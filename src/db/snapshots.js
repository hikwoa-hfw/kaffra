import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

/**
 * Save an immutable snapshot of the candidate data and LLM decision
 * at the moment a position is opened. This preserves the "why" for
 * each buy, even if the same token is bought/closed/bought again.
 */
export function saveBuySnapshot(positionId, candidateRow, decision, batchId, rows = []) {
  const candidate = candidateRow?.candidate || candidateRow;
  const mint = candidate?.token?.mint || '';
  const symbol = candidate?.token?.symbol || null;

  const batchSummary = {
    batchId: batchId || null,
    candidatesScreened: rows.length,
    candidateIds: rows.map(r => r?.id).filter(Boolean),
    triggerCandidateId: decision?.trigger_candidate_id || null,
  };

  try {
    db.prepare(`
      INSERT OR IGNORE INTO position_buy_snapshots (
        position_id, candidate_id, batch_id, mint, symbol, created_at_ms,
        candidate_json, decision_json, batch_summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      positionId,
      candidateRow?.id || null,
      batchId || null,
      mint,
      symbol,
      now(),
      json(candidate),
      json(decision),
      json(batchSummary),
    );
  } catch (err) {
    // Log but don't break the buy flow — snapshot is non-critical
    console.log(`[snapshot] save failed for position ${positionId}: ${err.message}`);
  }
}

/**
 * Retrieve the buy snapshot for a given position.
 */
export function getBuySnapshot(positionId) {
  const row = db.prepare('SELECT * FROM position_buy_snapshots WHERE position_id = ?').get(positionId);
  if (!row) return null;
  return {
    ...row,
    candidate: safeJson(row.candidate_json, null),
    decision: safeJson(row.decision_json, null),
    batchSummary: safeJson(row.batch_summary_json, null),
  };
}

/**
 * Get closed positions within a time window, with their buy snapshots.
 */
export function getClosedPositionsWithSnapshots(windowMs) {
  const cutoff = windowMs > 0 ? now() - windowMs : 0;
  const positions = db.prepare(`
    SELECT p.*, s.candidate_json, s.decision_json, s.batch_summary_json
    FROM dry_run_positions p
    LEFT JOIN position_buy_snapshots s ON s.position_id = p.id
    WHERE p.status = 'closed' AND p.closed_at_ms >= ?
    ORDER BY p.closed_at_ms DESC
  `).all(cutoff);

  return positions.map(row => ({
    ...row,
    buySnapshot: row.candidate_json ? {
      candidate: safeJson(row.candidate_json, null),
      decision: safeJson(row.decision_json, null),
      batchSummary: safeJson(row.batch_summary_json, null),
    } : null,
  }));
}
