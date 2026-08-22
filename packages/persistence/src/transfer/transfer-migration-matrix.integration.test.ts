import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteTransferRecordRepository } from './sqlite-transfer-record-repository';
import {
  buildHarness,
  countOf,
  exportInput,
  fixtureRoot,
  loadMigrationsUpTo,
  MIGRATION_DIRECTORY,
  NOW,
  openMigratedDatabase,
  scalarText,
  seedExportableProject,
  SOURCE_EPISODE_ID,
  SOURCE_EPISODE_VERSION_ID,
  SOURCE_PROJECT_ID,
  withMigratedDatabase,
} from './transfer-test-harness';

const LOWERCASE_HEX64 = 'a'.repeat(64);

/** 0015 旧库的最小外键链：project→episode→bible/format→episode_version。 */
const seedLegacyForeignKeyChain = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel,
        created_at, updated_at)
       VALUES ('project_legacy', '旧库项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_legacy', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES ('episode_legacy', 'project_legacy', '第 1 集', 60, ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
       VALUES ('sbv_legacy', 'project_legacy', 1, '{}', ?, 'READY', 'AI', ?)`,
    )
    .run(LOWERCASE_HEX64, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES ('format_legacy', 'project_legacy', 1, '9:16', 1080, 1920, 30, 'zh-CN',
               '{"top":5,"right":5,"bottom":12,"left":5}', 1, ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, story_bible_version_id, format_profile_id,
        target_duration_sec, shot_set_hash, status, created_at)
       VALUES ('ev_legacy', 'episode_legacy', 1, 'sbv_legacy', 'format_legacy', 60, ?, 'READY', ?)`,
    )
    .run(LOWERCASE_HEX64, NOW);
};

describe('Transfer 迁移与规模矩阵（project-transfer-import-export 3.3）', () => {
  it('空库：NEW_PROJECT 直接导入成功建项；RETURN_TO_ORIGIN 无源项目即冲突', async () => {
    await withMigratedDatabase(async (database: SqliteTestDatabase) => {
      expect(countOf(database, 'projects')).toBe(0);
      // newId 每对象一调（10 次）；常量会使 4 个阶段版本同 id 主键冲突。
      let sequence = 0;
      const harness = buildHarness(database, () => `empty1${String((sequence += 1))}`);

      harness.enqueueRead(new TextEncoder().encode(JSON.stringify(fixtureRoot)));
      const imported = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_empty_new' },
        'trace_1',
      );
      expect(imported.ok, JSON.stringify(imported.ok ? imported.data : imported.error)).toBe(true);
      expect(countOf(database, 'projects')).toBe(1);
      expect(countOf(database, 'stage_heads')).toBe(6);
      expect(countOf(database, 'import_records')).toBe(1);
    });

    await withMigratedDatabase(async (database: SqliteTestDatabase) => {
      const harness = buildHarness(database, () => 'empty2');
      harness.enqueueRead(new TextEncoder().encode(JSON.stringify(fixtureRoot)));
      const conflicted = await harness.service.importProject(
        { importMode: 'RETURN_TO_ORIGIN', requestId: 'req_empty_rto' },
        'trace_1',
      );
      expect(conflicted.ok).toBe(false);
      if (!conflicted.ok) {
        expect(conflicted.error.code).toBe('TRANSFER_PROJECT_CONFLICT');
      }
      // 零业务写入；唯一留痕是 FAILED 证据行（project_id NULL）。
      expect(countOf(database, 'projects')).toBe(0);
      expect(countOf(database, 'import_records')).toBe(1);
      expect(scalarText(database, 'SELECT project_id FROM import_records')).toBeNull();
    });
  });

  it('0015 旧库→0016 升级：历史 Transfer 行零损（request_id/result_json 保持 NULL）—升级后新写入走 requestId 幂等', async () => {
    await withSqliteTestContext(async (context) => {
      // ① 只迁移到 0015，按旧列集写入历史行（无 request_id/result_json）。
      const database = await openMigratedDatabase(
        context.root,
        'transfer-0015.sqlite',
        await loadMigrationsUpTo(15),
      );
      try {
        seedLegacyForeignKeyChain(database);
        database
          .prepare(
            `INSERT INTO export_records
             (id, project_id, episode_id, episode_version_id, export_type, status, target_path,
              temp_path, overwrite_policy, payload_sha256, byte_size, schema_version,
              lineage_completeness, warning_overrides_json, file_ready_at, created_at,
              finished_at, error_code)
             VALUES ('export_legacy', 'project_legacy', 'episode_legacy', 'ev_legacy',
                     'MARKDOWN', 'SUCCEEDED', 'legacy/path.md', NULL, 'REJECT', ?, 123,
                     '0.3.0', 'COMPLETE', '[]', ?, ?, ?, NULL)`,
          )
          .run(LOWERCASE_HEX64, NOW, NOW, NOW);
        database
          .prepare(
            `INSERT INTO import_records
             (id, project_id, import_mode, source_path, source_sha256, status,
              validation_errors_json, id_mapping_json, created_at, finished_at)
             VALUES ('import_legacy', 'project_legacy', 'NEW_PROJECT', 'legacy/source.json',
                     ?, 'SUCCEEDED', NULL, NULL, ?, ?)`,
          )
          .run(LOWERCASE_HEX64, NOW, NOW);

        // ② 升级到 0016：追加迁移不触碰历史行。
        applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), () => NOW);
        expect(
          database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
        ).toHaveLength(17);
        const legacyExport = database
          .prepare(
            'SELECT request_id, result_json, payload_sha256 FROM export_records WHERE id = ?',
          )
          .get('export_legacy') as unknown as {
          readonly request_id: string | null;
          readonly result_json: string | null;
          readonly payload_sha256: string;
        };
        expect(legacyExport.request_id).toBeNull();
        expect(legacyExport.result_json).toBeNull();
        expect(legacyExport.payload_sha256).toBe(LOWERCASE_HEX64);
        const legacyImport = database
          .prepare('SELECT request_id, result_json, source_path FROM import_records WHERE id = ?')
          .get('import_legacy') as unknown as {
          readonly request_id: string | null;
          readonly result_json: string | null;
          readonly source_path: string;
        };
        expect(legacyImport.request_id).toBeNull();
        expect(legacyImport.result_json).toBeNull();
        expect(legacyImport.source_path).toBe('legacy/source.json');

        // ③ 升级后的库：Transfer 仓储新写入/回放照常（0016 列参与幂等）。
        const repository = new SqliteTransferRecordRepository(database);
        await repository.insertExport({
          byteSize: 2048,
          createdAt: NOW,
          errorCode: null,
          episodeId: 'episode_legacy',
          episodeVersionId: 'ev_legacy',
          finishedAt: NOW,
          id: 'export_new',
          overwritePolicy: 'REJECT',
          payloadSha256: 'b'.repeat(64),
          projectId: 'project_legacy',
          requestId: 'req_after_upgrade',
          resultSummary: { inputFingerprint: 'fp-1', warningCodes: ['TRANSFER_CURRENT_ONLY'] },
          status: 'SUCCEEDED',
          targetRef: 'opaque-after-upgrade',
        });
        const replayed = await repository.findExportByRequestId('req_after_upgrade');
        expect(replayed?.id).toBe('export_new');
        expect(countOf(database, 'export_records')).toBe(2);
      } finally {
        database.close();
      }
    });
  });

  it(
    '100+ 历史版本：RETURN_TO_ORIGIN 追加不冲突—新版本号 = max+1（圣经/阶段/整集）',
    { timeout: 60_000 },
    async () => {
      await withMigratedDatabase(async (database: SqliteTestDatabase) => {
        seedExportableProject(database);
        // 堆历史：CONCEPT 阶段 v2..v101 + 整集 v2..v101（头不动，仍指向种子当前版本）。
        const insertScript = database.prepare(
          `INSERT INTO script_versions
         (id, project_id, episode_id, stage, version_no, parent_id, source_input_id,
          document_json, document_sha256, status, change_summary, source, created_at)
         VALUES (?, ?, NULL, 'CONCEPT', ?, ?, NULL, '{}', ?, 'READY', NULL, 'USER', ?)`,
        );
        const insertEpisodeVersion = database.prepare(
          `INSERT INTO episode_versions
         (id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id,
          target_duration_sec, shot_set_hash, status, created_at)
         VALUES (?, ?, ?, NULL, 'story_bible_v1', 'format_vertical_1080p', 90, ?, 'READY', ?)`,
        );
        for (let versionNo = 2; versionNo <= 101; versionNo += 1) {
          const parentId =
            versionNo === 2 ? 'script_concept_v1' : `script_concept_hist_${String(versionNo - 1)}`;
          insertScript.run(
            `script_concept_hist_${String(versionNo)}`,
            SOURCE_PROJECT_ID,
            versionNo,
            parentId,
            LOWERCASE_HEX64,
            NOW,
          );
          insertEpisodeVersion.run(
            `ev_hist_${String(versionNo)}`,
            SOURCE_EPISODE_ID,
            versionNo,
            LOWERCASE_HEX64,
            NOW,
          );
        }
        expect(
          database
            .prepare("SELECT COUNT(*) AS total FROM script_versions WHERE stage = 'CONCEPT'")
            .get(),
        ).toEqual({ total: 101 });
        expect(countOf(database, 'episode_versions')).toBe(101);

        let sequence = 0;
        const harness = buildHarness(database, () => `m${String((sequence += 1))}`);
        const exported = await harness.service.exportProject(
          exportInput('req_hist_export'),
          'trace_1',
        );
        expect(exported.ok).toBe(true);

        harness.enqueueRead(harness.firstWritten.bytes);
        const restored = await harness.service.importProject(
          { importMode: 'RETURN_TO_ORIGIN', requestId: 'req_hist_rto' },
          'trace_2',
        );
        expect(restored.ok).toBe(true);

        // 追加版本号接续历史最大值：CONCEPT 101→102、整集 101→102；历史行原样。
        expect(
          database
            .prepare("SELECT COUNT(*) AS total FROM script_versions WHERE stage = 'CONCEPT'")
            .get(),
        ).toEqual({ total: 102 });
        expect(
          database
            .prepare(
              "SELECT version_no FROM script_versions WHERE stage = 'CONCEPT' ORDER BY version_no DESC LIMIT 1",
            )
            .get(),
        ).toEqual({ version_no: 102 });
        expect(countOf(database, 'episode_versions')).toBe(102);
        expect(
          database
            .prepare('SELECT version_no FROM episode_versions ORDER BY version_no DESC LIMIT 1')
            .get(),
        ).toEqual({ version_no: 102 });
        expect(
          database
            .prepare('SELECT COUNT(*) AS total FROM script_versions WHERE id = ?')
            .get('script_concept_hist_50'),
        ).toEqual({ total: 1 });
        // 头推进到新整集（非种子、非历史版本）。
        expect(
          scalarText(
            database,
            `SELECT current_version_id FROM stage_heads WHERE project_id = '${SOURCE_PROJECT_ID}' AND stage = 'SHOT_CONTRACT'`,
          ),
        ).not.toBe(SOURCE_EPISODE_VERSION_ID);
      });
    },
  );

  it('重复导入（不同 requestId）：两次 NEW_PROJECT 各自成项—ID Mapping 与项目 id 均不同', async () => {
    await withMigratedDatabase(async (database: SqliteTestDatabase) => {
      seedExportableProject(database);
      const bundleBytes = new TextEncoder().encode(JSON.stringify(fixtureRoot));
      let sequence = 0;
      const harness = buildHarness(database, () => `d${String((sequence += 1))}`);

      harness.enqueueRead(bundleBytes);
      const first = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_dup_1' },
        'trace_1',
      );
      expect(first.ok).toBe(true);
      harness.enqueueRead(bundleBytes);
      const second = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_dup_2' },
        'trace_2',
      );
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.data.projectId).not.toBe(second.data.projectId);
      }

      // 两个全新项目 + 两条 SUCCEEDED 记录；源项目未受影响。
      expect(countOf(database, 'projects')).toBe(3);
      expect(
        database
          .prepare("SELECT COUNT(*) AS total FROM import_records WHERE status = 'SUCCEEDED'")
          .get(),
      ).toEqual({ total: 2 });
      const mappings = database
        .prepare(
          "SELECT id_mapping_json FROM import_records WHERE status = 'SUCCEEDED' ORDER BY created_at",
        )
        .all() as unknown as readonly { readonly id_mapping_json: string }[];
      const firstMapping = JSON.parse(mappings[0]?.id_mapping_json ?? '{}') as Record<
        string,
        string
      >;
      const secondMapping = JSON.parse(mappings[1]?.id_mapping_json ?? '{}') as Record<
        string,
        string
      >;
      expect(firstMapping[SOURCE_PROJECT_ID]).not.toBe(secondMapping[SOURCE_PROJECT_ID]);
    });
  });
});
