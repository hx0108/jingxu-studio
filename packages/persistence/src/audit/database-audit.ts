import { queryPragmaRows, type SqliteDatabase } from '../runtime/sqlite-database';
import { normalizeNameKey } from '@jingxu/domain';
import { mapSchemaManifestRow } from '../schema-manifest/row-mapper';

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

const queryCount = (database: SqliteDatabase, sql: string): number => {
  const row = database.prepare(sql).get();
  const value = row?.evidence_count;
  return typeof value === 'number' ? value : Number(value ?? 0);
};

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
  const hasProjectTables = hasTable(database, 'projects') && hasTable(database, 'format_profiles');
  const projectWithoutSingleCurrent = hasProjectTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count
         FROM projects p
         WHERE (SELECT COUNT(*) FROM format_profiles fp
                WHERE fp.project_id = p.id AND fp.is_current = 1) <> 1`,
      )
    : 0;
  const invalidFormatProfileChain = hasProjectTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count
         FROM format_profiles fp
         LEFT JOIN format_profiles parent ON parent.id = fp.parent_id
         WHERE (fp.version_no = 1 AND fp.parent_id IS NOT NULL)
            OR (fp.version_no > 1 AND (
                 parent.id IS NULL
                 OR parent.project_id <> fp.project_id
                 OR parent.version_no <> fp.version_no - 1
               ))
            OR (fp.is_current = 1 AND EXISTS (
                 SELECT 1 FROM format_profiles newer
                 WHERE newer.project_id = fp.project_id
                   AND newer.version_no > fp.version_no
               ))`,
      )
    : 0;
  const activeNameRows = hasProjectTables
    ? database.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL').all()
    : [];
  const seenNameKeys = new Set<string>();
  let duplicateActiveNames = 0;
  for (const row of activeNameRows) {
    if (typeof row.name !== 'string') {
      duplicateActiveNames += 1;
      continue;
    }
    const key = normalizeNameKey(row.name);
    if (seenNameKeys.has(key)) duplicateActiveNames += 1;
    else seenNameKeys.add(key);
  }
  const hasReceiptTables = hasProjectTables && hasTable(database, 'command_receipts');
  const invalidReceiptReferences = hasReceiptTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count
         FROM command_receipts cr
         LEFT JOIN projects p
           ON p.id = cr.project_id
          AND p.id = json_extract(cr.result_ref_json, '$.projectId')
         LEFT JOIN format_profiles fp
           ON fp.id = json_extract(cr.result_ref_json, '$.formatProfileId')
          AND fp.project_id = json_extract(cr.result_ref_json, '$.projectId')
         WHERE cr.project_id IS NULL
            OR json_type(cr.result_ref_json, '$.projectId') <> 'text'
            OR json_type(cr.result_ref_json, '$.formatProfileId') <> 'text'
            OR json_type(cr.result_ref_json, '$.updatedAt') <> 'text'
            OR json_type(cr.result_ref_json, '$.changed') NOT IN ('true', 'false')
            OR EXISTS (
                 SELECT 1 FROM json_each(cr.result_ref_json)
                 WHERE key NOT IN ('projectId', 'formatProfileId', 'updatedAt', 'changed')
               )
            OR p.id IS NULL
            OR fp.id IS NULL`,
      )
    : 0;
  const hasSchemaManifest = hasTable(database, 'schema_registry_manifest');
  const invalidSchemaManifestRows = hasSchemaManifest
    ? database
        .prepare(
          `SELECT schema_id, semantic_version, resource_path, sha256, enabled
           FROM schema_registry_manifest`,
        )
        .all()
        .reduce((count, row) => {
          try {
            mapSchemaManifestRow(row);
            return count;
          } catch {
            return count + 1;
          }
        }, 0)
    : 1;
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
      evidenceCount: projectWithoutSingleCurrent,
      ruleId: 'projects.one-current-format-profile',
      status: hasProjectTables
        ? projectWithoutSingleCurrent === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidFormatProfileChain,
      ruleId: 'format-profiles.version-chain',
      status: hasProjectTables
        ? invalidFormatProfileChain === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: duplicateActiveNames,
      ruleId: 'projects.active-name-unique',
      status: hasProjectTables
        ? duplicateActiveNames === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidReceiptReferences,
      ruleId: 'command-receipts.references-resolve',
      status: hasReceiptTables
        ? invalidReceiptReferences === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidSchemaManifestRows,
      ruleId: 'schema-manifest.row-shape',
      status: hasSchemaManifest && invalidSchemaManifestRows === 0 ? 'PASS' : 'FAIL',
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
