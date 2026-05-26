import { db } from './src/db/connection.js';
import { now } from './src/utils.js';

// --- DATA KOIN BRUME ---
const tokenMint = 'ChtH5GxPAWqFXLYuhrqy82viuMxeWBsvJXcCahT7pump';
const tokenName = 'Brume';
const entryMcapUsd = 61900; // Masuk di MCap $61.9K
const peakMcapUsd = 450000; // Puncak di MCap $450K
const trailingPercent = 15; // Trailing -15% (sesuai setting kita)

// --- KALKULASI QUANTITATIF ---
// Harga Keluar = Harga Puncak dikurangi persentase Trailing (15%)
const exitMcapUsd = peakMcapUsd - (peakMcapUsd * (trailingPercent / 100)); // $382,500
// Profit Terealisasi = (Harga Keluar - Harga Masuk) / Harga Masuk
const realizedPercent = ((exitMcapUsd - entryMcapUsd) / entryMcapUsd) * 100;
// Peak Percent = (Harga Puncak - Harga Masuk) / Harga Masuk
const peakPercent = ((peakMcapUsd - entryMcapUsd) / entryMcapUsd) * 100;

// Ukuran modal masuk (Standar 0.1 SOL)
const entrySizeSol = 0.1;
// Estimasi SOL Profit (Asumsi PnL persentase setara dengan PnL SOL)
const realizedSol = entrySizeSol * (realizedPercent / 100);

const currentTime = now();
// Asumsi trade terjadi sekitar 20 menit (1.200.000 ms)
const openedAt = currentTime - 1200000; 
const closedAt = currentTime;

console.log(`=== INJECTING BRUME OUTLIER TRADE ===`);
console.log(`Peak: $${peakMcapUsd} (+${peakPercent.toFixed(1)}%)`);
console.log(`Exit: $${exitMcapUsd} (+${realizedPercent.toFixed(1)}%)`);
console.log(`Estimated Profit: +${realizedSol.toFixed(4)} SOL`);

try {
  // 1. INJEKSI KE TABEL DECISIONS (Agar LLM History ingat)
  const stmtDecision = db.prepare(`
    INSERT INTO decision_logs (
      mint, name, timestamp_ms, decision_type,
      confidence, score, reason, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmtDecision.run(
    tokenMint,
    tokenName,
    openedAt,
    'BUY',
    82.0, // Confidence sesuai log LLM Anda
    82,
    "Tier1 passes. Volume5m 25605 satisfies volume rule. bsVolRatio5m 1.09 indicates buying pressure. Injected manual override.",
    JSON.stringify({ injected: true, type: 'manual_override' })
  );
  console.log('✅ Decision injected.');

  // 2. INJEKSI KE TABEL POSITIONS (Live Trades)
  const stmtLive = db.prepare(`
    INSERT INTO positions (
      mint, name, strategy, mode,
      entry_mcap_usd, entry_size_sol, entry_price_native, 
      tp_percent, sl_percent, trail_percent,
      status, peak_percent, max_mcap_usd,
      realized_pnl_percent, realized_pnl_sol,
      exit_mcap_usd, exit_price_native, exit_reason,
      opened_at_ms, closed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmtLive.run(
    tokenMint, tokenName, 'degen', 'live',
    entryMcapUsd, entrySizeSol, 0.000001, // Mock entry price
    30.0, -35.0, trailingPercent,
    'closed', peakPercent, peakMcapUsd,
    realizedPercent, realizedSol,
    exitMcapUsd, 0.000006, 'TRAILING_TP', // Mock exit price
    openedAt, closedAt
  );
  console.log('✅ Live Position injected.');

  // 3. INJEKSI KE TABEL DRY_RUN_POSITIONS (Dry Run Trades - agar laporan nyambung)
  const stmtDry = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, name, strategy, mode,
      entry_mcap_usd, entry_size_sol, entry_price_native, 
      tp_percent, sl_percent, trail_percent,
      status, peak_percent, max_mcap_usd,
      realized_pnl_percent, realized_pnl_sol,
      exit_mcap_usd, exit_price_native, exit_reason,
      opened_at_ms, closed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmtDry.run(
    tokenMint, tokenName, 'degen', 'dry_run',
    entryMcapUsd, entrySizeSol, 0.000001, 
    30.0, -35.0, trailingPercent,
    'closed', peakPercent, peakMcapUsd,
    realizedPercent, realizedSol,
    exitMcapUsd, 0.000006, 'TRAILING_TP',
    openedAt, closedAt
  );
  console.log('✅ Dry-Run Position injected.');

  console.log(`\n🎉 Injeksi Sukses! Brume sekarang ada di database Anda.`);
} catch (error) {
  console.error("❌ Gagal menginjeksi:", error.message);
}