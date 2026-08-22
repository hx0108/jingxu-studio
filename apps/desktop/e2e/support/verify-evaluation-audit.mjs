import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const index = args.indexOf('--db');
const databasePath = index < 0 ? '' : (args[index + 1] ?? '');
if (databasePath === '') {
  console.error('usage: node verify-evaluation-audit.mjs --db <sqlite path>');
  process.exit(2);
}

const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });
try {
  const seeds = database
    .prepare(
      "SELECT COUNT(*) AS total FROM evaluation_samples WHERE authorization_status = 'SYNTHETIC'",
    )
    .get();
  const actions = database
    .prepare(
      "SELECT action, COUNT(*) AS total FROM audit_events WHERE action LIKE 'EVALUATION_%' GROUP BY action",
    )
    .all();
  const actionNames = new Set(actions.map((row) => row.action));
  const violations = [];
  if (seeds?.total < 24) violations.push(`SEEDS:${String(seeds?.total)}`);
  for (const expected of [
    'EVALUATION_SAMPLE_CREATED',
    'EVALUATION_ANNOTATION_ADDED',
    'EVALUATION_SAMPLE_DELETED',
    'EVALUATION_BATCH_IMPORTED',
  ]) {
    if (!actionNames.has(expected)) violations.push(`AUDIT:${expected}`);
  }
  const latest = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  if (latest?.version !== 17) violations.push(`MIGRATION:${String(latest?.version)}`);
  if (violations.length > 0) throw new Error(violations.join(','));
  console.log(
    `EVALUATION_AUDIT_OK ${JSON.stringify({ evaluationAudits: actions, seeds: seeds?.total })}`,
  );
} finally {
  database.close();
}
