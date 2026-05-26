import { db } from './src/db/connection.js';
import { now } from './src/utils.js';

// --- BRUME TOKEN DATA ---
const tokenMint = 'ChtH5GxPAWqFXLYuhrqy82viuMxeWBsvJXcCahT7pump';
const tokenSymbol = 'BRUME';
const entryMcapUsd = 61900;
const peakMcapUsd = 450000;
const trailingPercent = 15;

// --- QUANT MATH ---
// Calculate exit mcap based on the trailing drop from the peak
const exitMcapUsd = peakMcapUsd - (peakMcapUsd * (trailingPercent / 100));
const realizedPercent = ((exitMcapUsd - entryMcapUsd) / entryMcapUsd) * 100;
const peakPercent = ((peakMcapUsd - entryMcapUsd) / entryMcapUsd) * 100;

// Standard size and estimated profit
const entrySizeSol = 0.1;
const realizedSol = entrySizeSol * (realizedPercent / 100);

const currentTime = now();
const openedAt = currentTime - (20 * 60 * 1000); // Backdate open time by 20 mins
const closedAt = currentTime;

console.log(`=== INJECTING BRUME OUTLIER TRADE ===`);
console.log(`Peak: $${peakMcapUsd} (+${peakPercent.toFixed(1)}%)`);
console.log(`Exit: $${exitMcapUsd} (+${realizedPercent.toFixed(1)}%)`);
console.log(`Est Profit: +${realizedSol.toFixed(4)} SOL`);

try {
  // 1. Inject the LLM decision so the bot remembers the reasoning
  const stmtDecision = db.prepare(`
    INSERT INTO llm_decisions (
      candidate_id, mint, created_at_ms, verdict,
      confidence, reason, risks_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const dummyCandidateId = 999999; // Dummy ID to avoid clashing with real candidates
  
  const decisionResult = stmtDecision.run(
    dummyCandidateId,
    tokenMint,
    openedAt,
    'BUY',
    82.0,
    "Tier1 passes. Volume5m 25605 satisfies volume rule. bsVolRatio5m 1.09 indicates buying pressure. Injected manual override.",
    JSON.stringify([]),
    JSON.stringify({ injected: true, type: 'manual_override' })
  );
  
  const llmDecisionId = decisionResult.lastInsertRowid;
  console.log('✅ llm_decisions injected.');

  // 2. Inject the actual position into dry_run_positions (flagged as 'live' execution)
  const stmtPosition = db.prepare(`
    INSERT INTO dry_run_positions (
      candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms,
      size_sol, entry_price, entry_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed,
      exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
      llm_decision_id, execution_mode, snapshot_json, strategy_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmtPosition.run(
    dummyCandidateId, tokenMint, tokenSymbol, 'closed', openedAt, closedAt,
    entrySizeSol, 0.000001, entryMcapUsd, 30.0, -35.0, // Base TP/SL limits
    1, trailingPercent, 1, // trailing_enabled = 1, trailing_armed = 1
    0.000006, exitMcapUsd, 'TRAILING_TP', realizedPercent, realizedSol,
    llmDecisionId, 'live', JSON.stringify({ injected: true }), 'degen'
  );
  console.log('✅ dry_run_positions injected (Live Mode).');

  console.log(`\n🎉 Injection Successful! Brume outlier is now in the DB.`);
} catch (error) {
  console.error("❌ Injection failed:", error.message);
}