import { db } from './src/db/connection.js';

const tablesToCheck = [
  'decision_logs', 
  'llm_decisions', 
  'dry_run_positions', 
  'candidates', 
  'dry_run_trades',
  'decisions',
  'positions'
];

console.log("=== MEMBACA SCHEMA DATABASE KAFFRA ===\n");

tablesToCheck.forEach(tableName => {
  try {
    const result = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
    
    if (result && result.sql) {
      console.log(`-- TABLE: ${tableName} --`);
      console.log(result.sql);
      console.log("\n--------------------------------------------------\n");
    } else {
      console.log(`[!] Table '${tableName}' tidak ditemukan di database.\n`);
    }
  } catch (error) {
    console.error(`Error membaca tabel ${tableName}:`, error.message);
  }
});