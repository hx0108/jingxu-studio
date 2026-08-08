import { queryPragmaRows, type SqliteDatabase } from '../runtime/sqlite-database';

export type AuditStatus = 'FAIL' | 'NOT_IMPLEMENTED_BY_CURRENT_BUILD' | 'PASS';

export interface AuditFinding {
  readonly evidenceCount: number;
  readonly ruleId: string;
  readonly status: AuditStatus;
}

export interface DatabaseAuditResult {
  readonly findings: readonly AuditFinding[];
  readonly ok: boolean;
}

export interface DatabaseAuditOptions {
  readonly integrityRows?: readonly string[];
}

const hasTable = (database: SqliteDatabase, name: string): boolean =>
  database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) !== undefined;

export const runDatabaseAudit = (
  database: SqliteDatabase,
  options: DatabaseAuditOptions = {},
): DatabaseAuditResult => {
  const integrityRows =
    options.integrityRows ??
    queryPragmaRows(database, 'integrity_check').map(({ integrity_check: result }) =>
      String(result),
    );
  const foreignKeyRows = queryPragmaRows(database, 'foreign_key_check');
  const hasVersionTables =
    hasTable(database, 'shots') && hasTable(database, 'shot_contract_versions');
  const invalidShotPointers = hasVersionTables
    ? (database
        .prepare(
          `SELECT shots.id
           FROM shots
           LEFT JOIN shot_contract_versions
             ON shot_contract_versions.id = shots.current_version_id
            AND shot_contract_versions.shot_id = shots.id
           WHERE shots.current_version_id IS NOT NULL AND shot_contract_versions.id IS NULL`,
        )
        .all() as readonly unknown[])
    : [];
  const hasEpisodeVersionTables =
    hasTable(database, 'episodes') && hasTable(database, 'episode_versions');
  const invalidEpisodePointers = hasEpisodeVersionTables
    ? (database
        .prepare(
          `SELECT episodes.id
           FROM episodes
           LEFT JOIN episode_versions
             ON episode_versions.id = episodes.current_version_id
            AND episode_versions.episode_id = episodes.id
           WHERE episodes.current_version_id IS NOT NULL AND episode_versions.id IS NULL`,
        )
        .all() as readonly unknown[])
    : [];
  const findings: AuditFinding[] = [
    {
      evidenceCount:
        integrityRows[0] === 'ok' && integrityRows.length === 1 ? 0 : integrityRows.length,
      ruleId: 'sqlite.integrity',
      status: integrityRows[0] === 'ok' && integrityRows.length === 1 ? 'PASS' : 'FAIL',
    },
    {
      evidenceCount: foreignKeyRows.length,
      ruleId: 'sqlite.foreign-keys',
      status: foreignKeyRows.length === 0 ? 'PASS' : 'FAIL',
    },
    {
      evidenceCount: invalidShotPointers.length,
      ruleId: 'shots.current-version-owner',
      status: hasVersionTables
        ? invalidShotPointers.length === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidEpisodePointers.length,
      ruleId: 'episodes.current-version-owner',
      status: hasEpisodeVersionTables
        ? invalidEpisodePointers.length === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: 0,
      ruleId: 'contract.document-schema',
      status: 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: 0,
      ruleId: 'contract.lock-path-parity',
      status: 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
  ];
  return { findings, ok: findings.every(({ status }) => status !== 'FAIL') };
};
