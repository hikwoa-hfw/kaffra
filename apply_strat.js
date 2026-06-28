/**
 * apply_strat.js
 * Usage: node apply_strat.js <strategyId>
 *
 * Reads strategy from strats/<strategyId>.sqlitestrat and applies it to the local SQLite DB.
 * The strategy will be UPSERTED into the strategies table and set as active.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main() {
  const stratId = process.argv[2];
  if (!stratId) {
    console.error('Usage: node apply_strat.js <strategyId>');
    console.error('Example: node apply_strat.js degen');
    process.exit(1);
  }

  const filePath = join(__dirname, 'strats', `${stratId}.sqlitestrat`);
  let definition;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    definition = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read strategy file: ${filePath}`);
    console.error(err.message);
    process.exit(1);
  }

  if (definition.id !== stratId) {
    console.error(`Strategy ID mismatch: file says "${definition.id}" but argument is "${stratId}"`);
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH || './charon.sqlite';
  const db = new Database(dbPath);

  // UPSERT the strategy row
  const upsert = db.prepare(`
    INSERT INTO strategies (id, name, enabled, config_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      config_json = excluded.config_json
  `);

  upsert.run(
    definition.id,
    definition.name,
    definition.enabled ? 1 : 0,
    JSON.stringify(definition.config),
    Date.now()
  );

  // If this strategy is marked as enabled, disable all others and set this one active
  if (definition.enabled) {
    db.prepare('UPDATE strategies SET enabled = 0').run();
    db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(definition.id);
    console.log(`✅ Strategy "${definition.name}" (${definition.id}) applied and set as ACTIVE.`);
  } else {
    console.log(`📦 Strategy "${definition.name}" (${definition.id}) upserted (not active).`);
  }

  db.close();

  // Print summary of applied config
  const { config } = definition;
  console.log('');
  console.log('── Applied Config ──');
  console.log(`  Entry mode:        ${config.entry_mode}`);
  console.log(`  Use LLM:           ${config.use_llm} (confidence ≥ ${config.llm_min_confidence})`);
  console.log(`  Require fee claim: ${config.require_fee_claim}`);
  console.log(`  MCap range:        $${config.min_mcap_usd} – $${config.max_mcap_usd}`);
  console.log(`  Max top20 holder:  ${config.max_top20_holder_percent}%`);
  console.log(`  Min trench score:  ${config.min_trench_score}`);
  console.log(`  Rug ratio max:     ${config.trending_max_rug_ratio}`);
  console.log(`  Bundler rate max:  ${config.trending_max_bundler_rate}`);
  console.log(`  TP / SL / Trail:   ${config.tp_percent}% / ${config.sl_percent}% / ${config.trailing_percent}%`);
  console.log(`  Position size:     ${config.position_size_sol} SOL`);
  console.log(`  Max positions:     ${config.max_open_positions}`);
  console.log('────────────────────');
}

main();
