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
         WHERE cr.project_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = cr.project_id)
            OR CASE
              WHEN cr.command_name IN ('CREATE_PROJECT','UPDATE_PROJECT','DELETE_PROJECT','RESTORE_PROJECT') THEN
                json_type(cr.result_ref_json, '$.projectId') <> 'text'
                OR json_extract(cr.result_ref_json, '$.projectId') <> cr.project_id
                OR json_type(cr.result_ref_json, '$.formatProfileId') <> 'text'
                OR json_type(cr.result_ref_json, '$.updatedAt') <> 'text'
                OR json_type(cr.result_ref_json, '$.changed') NOT IN ('true', 'false')
                OR EXISTS (SELECT 1 FROM json_each(cr.result_ref_json)
                           WHERE key NOT IN ('projectId','formatProfileId','updatedAt','changed'))
                OR NOT EXISTS (
                  SELECT 1 FROM format_profiles fp
                  WHERE fp.id=json_extract(cr.result_ref_json,'$.formatProfileId')
                    AND fp.project_id=cr.project_id)
              WHEN cr.command_name = 'INITIALIZE_ORIGINAL' THEN
                json_type(cr.result_ref_json, '$.sourceInputId') <> 'text'
                OR json_type(cr.result_ref_json, '$.episodeId') <> 'text'
                OR EXISTS (SELECT 1 FROM json_each(cr.result_ref_json)
                           WHERE key NOT IN ('sourceInputId','episodeId'))
                OR NOT EXISTS (SELECT 1 FROM source_inputs s
                               WHERE s.id=json_extract(cr.result_ref_json,'$.sourceInputId')
                                 AND s.project_id=cr.project_id)
                OR NOT EXISTS (SELECT 1 FROM episodes e
                               WHERE e.id=json_extract(cr.result_ref_json,'$.episodeId')
                                 AND e.project_id=cr.project_id)
              WHEN cr.command_name IN ('SAVE_SCRIPT_DRAFT','CONFIRM_SCRIPT_VERSION','RESTORE_SCRIPT_VERSION') THEN
                json_type(cr.result_ref_json, '$.versionId') <> 'text'
                OR EXISTS (SELECT 1 FROM json_each(cr.result_ref_json) WHERE key <> 'versionId')
                OR NOT EXISTS (
                  SELECT 1 FROM script_versions sv
                  WHERE sv.id=json_extract(cr.result_ref_json,'$.versionId') AND sv.project_id=cr.project_id
                  UNION ALL
                  SELECT 1 FROM story_bible_versions sb
                  WHERE sb.id=json_extract(cr.result_ref_json,'$.versionId') AND sb.project_id=cr.project_id
                  UNION ALL
                  -- SHOT_CONTRACT 确认/恢复的 versionId 指向分镜集合版本（episode_versions）。
                  SELECT 1 FROM episode_versions ev
                  WHERE ev.id=json_extract(cr.result_ref_json,'$.versionId')
                    AND ev.episode_id IN (SELECT e.id FROM episodes e WHERE e.project_id=cr.project_id))
              ELSE 1
            END`,
      )
    : 0;
  const hasScriptTables =
    hasTable(database, 'script_versions') &&
    hasTable(database, 'story_bible_versions') &&
    hasTable(database, 'stage_heads');
  const duplicateProjectScriptVersions = hasScriptTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count FROM (
           SELECT project_id, stage, version_no
           FROM script_versions WHERE episode_id IS NULL
           GROUP BY project_id, stage, version_no HAVING COUNT(*) <> 1
         )`,
      )
    : 0;
  const invalidScriptParents = hasScriptTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count FROM (
           SELECT child.id FROM script_versions child
           LEFT JOIN script_versions parent ON parent.id=child.parent_id
           WHERE (child.version_no=1 AND child.parent_id IS NOT NULL)
              OR (child.version_no>1 AND (
                    parent.id IS NULL OR parent.project_id<>child.project_id
                    OR parent.episode_id IS NOT child.episode_id OR parent.stage<>child.stage
                    OR parent.version_no<>child.version_no-1))
           UNION ALL
           SELECT child.id FROM story_bible_versions child
           LEFT JOIN story_bible_versions parent ON parent.id=child.parent_id
           WHERE (child.version_no=1 AND child.parent_id IS NOT NULL)
              OR (child.version_no>1 AND (
                    parent.id IS NULL OR parent.project_id<>child.project_id
                    OR parent.version_no<>child.version_no-1))
         )`,
      )
    : 0;
  const invalidStageHeads = hasScriptTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count FROM stage_heads h
         WHERE h.stage IN ('CONCEPT','STORY_BIBLE','EPISODE_OUTLINE','BEAT_SHEET','SCENE_SCRIPT')
           AND NOT (
             (h.current_version_type='STORY_BIBLE_VERSION' AND h.stage='STORY_BIBLE'
              AND h.episode_id IS NULL AND EXISTS (
                SELECT 1 FROM story_bible_versions v
                WHERE v.id=h.current_version_id AND v.project_id=h.project_id))
             OR
             (h.current_version_type='SCRIPT_VERSION' AND h.stage<>'STORY_BIBLE'
              AND EXISTS (SELECT 1 FROM script_versions v
                WHERE v.id=h.current_version_id AND v.project_id=h.project_id
                  AND v.episode_id IS h.episode_id AND v.stage=h.stage))
           )`,
      )
    : 0;
  const mismatchedScriptDocuments = hasScriptTables
    ? queryCount(
        database,
        `SELECT COUNT(*) AS evidence_count FROM (
           SELECT id FROM script_versions
           WHERE (json_type(document_json,'$.project_id')='text'
                  AND json_extract(document_json,'$.project_id')<>project_id)
              OR (json_type(document_json,'$.stage')='text'
                  AND json_extract(document_json,'$.stage')<>stage)
              OR (json_type(document_json,'$.episode_id') IN ('text','null')
                  AND json_extract(document_json,'$.episode_id') IS NOT episode_id)
           UNION ALL
           SELECT id FROM story_bible_versions
           WHERE (json_type(document_json,'$.project_id')='text'
                  AND json_extract(document_json,'$.project_id')<>project_id)
              OR (json_type(document_json,'$.stage')='text'
                  AND json_extract(document_json,'$.stage')<>'STORY_BIBLE')
              OR (json_type(document_json,'$.episode_id') IS NOT NULL
                  AND json_type(document_json,'$.episode_id')<>'null')
         )`,
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
      evidenceCount: duplicateProjectScriptVersions,
      ruleId: 'script.project-version-unique',
      status: hasScriptTables
        ? duplicateProjectScriptVersions === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidScriptParents,
      ruleId: 'script.parent-chain-owner',
      status: hasScriptTables
        ? invalidScriptParents === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: invalidStageHeads,
      ruleId: 'script.stage-head-resolves',
      status: hasScriptTables
        ? invalidStageHeads === 0
          ? 'PASS'
          : 'FAIL'
        : 'NOT_IMPLEMENTED_BY_CURRENT_BUILD',
    },
    {
      evidenceCount: mismatchedScriptDocuments,
      ruleId: 'script.document-relations-match',
      status: hasScriptTables
        ? mismatchedScriptDocuments === 0
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
