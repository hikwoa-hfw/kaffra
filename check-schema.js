import { db } from './src/db/connection.js';

const targetTables = [
  'decision_logs',
  'llm_decisions',
  'dry_run_positions',
  'candidates',
  'dry_run_trades'
];

console.log("=== CHECKING KAFFRA DB SCHEMA ===\n");

for (const tableName of targetTables) {
  try {
    const result = db.prepare(`
      SELECT sql 
      FROM sqlite_master 
      WHERE type='table' AND name = ?
    `).get(tableName);
    
    if (result && result.sql) {
      console.log(`-- TABLE: ${tableName} --`);
      console.log(result.sql);
      console.log("\n--------------------------------------------------\n");
    } else {
      console.log(`[!] Table '${tableName}' not found.\n`);
    }
  } catch (error) {
    console.error(`Failed to read schema for ${tableName}:`, error.message);
  }
}