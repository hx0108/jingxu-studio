import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeShotSetHash,
  createTransferService,
  stableTransferJson,
} from '@jingxu/application';
import type {
  TransferFilePort,
  TransferFileSnapshot,
  TransferService,
} from '@jingxu/application';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteTransferUnitOfWork } from './sqlite-transfer-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '../../../test-fixtures/src/fixtures/v1/project-transfer-bundle.valid.json',
);
const NOW = '2026-08-21T08:00:00.000Z';

const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
const hashText = sha256;
const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  sha256(stableTransferJson(value));

type MutableJson = Record<string, unknown>;
const asJson = (value: unknown): MutableJson => value as MutableJson;

/** 种子事实全部取自 schema 合法 fixture：文档天然满足 ProjectTransferBundle 1.0.0。 */
const fixtureRoot = asJson(JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as unknown);
const fixtureStoryboard = asJson(fixtureRoot.episode_storyboard);
const fixtureShots = fixtureStoryboard.shot_contracts as MutableJson[];
const fixtureFirstShot = asJson(fixtureShots[0]);
const fixtureStages = fixtureRoot.script_stage_outputs as MutableJson[];
const fixtureBibleOutput = asJson(asJson(fixtureRoot.story_bible).output);
if (fixtureShots.length !== 1 || fixtureStages.length !== 4) {
  throw new Error('fixture 形状与测试假设不符（1 镜头 + 4 阶段）');
}

const SOURCE_PROJECT_ID = 'project_rain_station';
const SOURCE_EPISODE_ID = 'episode_01';
const SOURCE_FORMAT_ID = 'format_vertical_1080p';
const SOURCE_BIBLE_VERSION_ID = 'story_bible_v1';
const SOURCE_SHOT_ID = 'shot_ep01_001';
const SOURCE_SHOT_VERSION_ID = 'scv_shot_ep01_001_v1';
const SOURCE_EPISODE_VERSION_ID = 'ev_seed';

const seededShotSetHash = computeShotSetHash(
  [
    {
      documentSha256: hashPayload(fixtureFirstShot),
      sequence: 1,
      shotId: SOURCE_SHOT_ID,
      shotVersionId: SOURCE_SHOT_VERSION_ID,
    },
  ],
  hashText,
);

const openMigratedDatabase = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'transfer-service.sqlite'));
  try {
    database.pragma('foreign_keys = ON');
    applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), () => NOW);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const withMigratedDatabase = async <T>(
  operation: (database: SqliteTestDatabase) => T | Promise<T>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = await openMigratedDatabase(context.root);
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  });

/** 可导出完整快照的源项目：project→episode/format/bible→4 阶段→整集 READY→镜头链→头×6。 */
const seedExportableProject = (database: SqliteDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel,
        created_at, updated_at)
       VALUES (?, '雨夜旧车站', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/${SOURCE_PROJECT_ID}', ?, ?)`,
    )
    .run(SOURCE_PROJECT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO episodes (id, project_id, title, target_duration_sec, created_at, updated_at)
       VALUES (?, ?, '第 1 集', 90, ?, ?)`,
    )
    .run(SOURCE_EPISODE_ID, SOURCE_PROJECT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO story_bible_versions
       (id, project_id, version_no, document_json, document_sha256, status, source, created_at)
       VALUES (?, ?, 1, ?, ?, 'READY', 'AI', ?)`,
    )
    .run(
      SOURCE_BIBLE_VERSION_ID,
      SOURCE_PROJECT_ID,
      JSON.stringify(fixtureBibleOutput),
      hashPayload(fixtureBibleOutput),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES (?, ?, 1, '9:16', 1080, 1920, 30, 'zh-CN',
               '{"top":5,"right":5,"bottom":12,"left":5}', 1, ?)`,
    )
    .run(SOURCE_FORMAT_ID, SOURCE_PROJECT_ID, NOW);
  for (const entry of fixtureStages) {
    const output = asJson(entry.output);
    const stage = String(output.stage);
    const episodeId = output.episode_id === null ? null : SOURCE_EPISODE_ID;
    database
      .prepare(
        `INSERT INTO script_versions
         (id, project_id, episode_id, stage, version_no, parent_id, source_input_id,
          document_json, document_sha256, status, change_summary, source, created_at)
         VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?, 'READY', NULL, 'AI', ?)`,
      )
      .run(
        String(entry.version_id),
        SOURCE_PROJECT_ID,
        episodeId,
        stage,
        JSON.stringify(output),
        hashPayload(output),
        NOW,
      );
  }
  database
    .prepare(
      `INSERT INTO shots
       (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', ?, ?, ?)`,
    )
    .run(SOURCE_SHOT_ID, SOURCE_EPISODE_ID, SOURCE_SHOT_VERSION_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO shot_contract_versions
       (id, shot_id, version_no, parent_id, external_parent_version_id,
        lineage_resolution_status, sequence, version_status, format_profile_id,
        target_duration_sec, dialogue_render_mode, document_json, document_sha256,
        source_invocation_id, created_at)
       VALUES (?, ?, 1, NULL, NULL, 'ROOT', 1, 'READY', ?, 6, 'NARRATION_FIRST', ?, ?,
               NULL, ?)`,
    )
    .run(
      SOURCE_SHOT_VERSION_ID,
      SOURCE_SHOT_ID,
      SOURCE_FORMAT_ID,
      JSON.stringify(fixtureFirstShot),
      hashPayload(fixtureFirstShot),
      NOW,
    );
  database
    .prepare(
      `INSERT INTO episode_versions
       (id, episode_id, version_no, parent_id, story_bible_version_id, format_profile_id,
        target_duration_sec, shot_set_hash, status, created_at)
       VALUES (?, ?, 1, NULL, ?, ?, 90, ?, 'READY', ?)`,
    )
    .run(
      SOURCE_EPISODE_VERSION_ID,
      SOURCE_EPISODE_ID,
      SOURCE_BIBLE_VERSION_ID,
      SOURCE_FORMAT_ID,
      seededShotSetHash,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO episode_version_shots (episode_version_id, shot_id, shot_version_id, sequence)
       VALUES (?, ?, ?, 1)`,
    )
    .run(SOURCE_EPISODE_VERSION_ID, SOURCE_SHOT_ID, SOURCE_SHOT_VERSION_ID);
  const insertHead = database.prepare(
    `INSERT INTO stage_heads
     (project_id, episode_id, stage, current_version_type, current_version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertHead.run(SOURCE_PROJECT_ID, null, 'STORY_BIBLE', 'STORY_BIBLE_VERSION', SOURCE_BIBLE_VERSION_ID, NOW);
  insertHead.run(SOURCE_PROJECT_ID, null, 'CONCEPT', 'SCRIPT_VERSION', 'script_concept_v1', NOW);
  insertHead.run(SOURCE_PROJECT_ID, SOURCE_EPISODE_ID, 'EPISODE_OUTLINE', 'SCRIPT_VERSION', 'script_outline_v1', NOW);
  insertHead.run(SOURCE_PROJECT_ID, SOURCE_EPISODE_ID, 'BEAT_SHEET', 'SCRIPT_VERSION', 'script_beats_v1', NOW);
  insertHead.run(SOURCE_PROJECT_ID, SOURCE_EPISODE_ID, 'SCENE_SCRIPT', 'SCRIPT_VERSION', 'script_scene_v1', NOW);
  insertHead.run(SOURCE_PROJECT_ID, SOURCE_EPISODE_ID, 'SHOT_CONTRACT', 'EPISODE_VERSION', SOURCE_EPISODE_VERSION_ID, NOW);
};

const countOf = (database: SqliteDatabase, table: string): number =>
  (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;

/** 单列标量查询：取结果行第一个字段的字符串值（列名由调用方 SQL 决定）。 */
const scalarText = (database: SqliteDatabase, sql: string): string | null => {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const value: unknown = Object.values(row)[0];
  return typeof value === 'string' ? value : null;
};

interface Harness {
  readonly enqueueRead: (bytes: Uint8Array) => void;
  readonly firstWritten: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly service: TransferService;
}

const buildHarness = (database: SqliteDatabase, newId: () => string): Harness => {
  const written: { bytes: Uint8Array; sha256: string }[] = [];
  let nextRead: TransferFileSnapshot | null = null;
  const file: TransferFilePort = {
    readSelectedJson: () => Promise.resolve(nextRead),
    writeJsonAtomically: (_defaultFileName, bytes, _overwriteConfirmed) => {
      const text = new TextDecoder().decode(bytes);
      const sha = hashText(text);
      written.push({ bytes, sha256: sha });
      return Promise.resolve({
        byteSize: bytes.byteLength,
        outcome: 'written',
        sha256: sha,
        targetRef: `sink_ref_${String(written.length)}`,
      });
    },
  };
  // Schema 正式校验由 contracts fixtures 契约测试与 4.1 组合根接线覆盖；本文件注入恒真
  // 校验器，聚焦 3.2 目标：同一事务 + 中途故障零残留（种子文档本身取自合法 fixture）。
  const alwaysValid = () => ({ valid: true }) as const;
  return {
    enqueueRead: (bytes) => {
      nextRead = {
        bytes,
        sha256: hashText(new TextDecoder().decode(bytes)),
        sourceRef: 'source_ref_1',
      };
    },
    firstWritten: {
      get bytes(): Uint8Array {
        const first = written[0];
        if (first === undefined) throw new Error('sink 未写入导出文件');
        return first.bytes;
      },
      get sha256(): string {
        const first = written[0];
        if (first === undefined) throw new Error('sink 未写入导出文件');
        return first.sha256;
      },
    },
    service: createTransferService({
      file,
      hashPayload,
      hashText,
      newId,
      now: () => NOW,
      unitOfWork: new SqliteTransferUnitOfWork(database),
      validateBundleSchema: alwaysValid,
      validateStoryboardEnvelope: alwaysValid,
    }),
  };
};

const exportInput = (requestId: string) => ({
  episodeId: SOURCE_EPISODE_ID,
  expectedVersionId: SOURCE_EPISODE_VERSION_ID,
  overwriteConfirmed: false,
  projectId: SOURCE_PROJECT_ID,
  requestId,
});

describe('Transfer 服务级全链路（project-transfer-import-export 3.2）', () => {
  it('NEW_PROJECT：导出→导入→重放/冲突幂等—新项目全 ID 重写且 IMPORTED_SNAPSHOT 无 source_inputs', async () => {
    await withMigratedDatabase(async (database) => {
      seedExportableProject(database);
      let sequence = 0;
      const harness = buildHarness(database, () => `s${String((sequence += 1))}`);

      // 导出：三段式全链路（读事务组装→落盘→SUCCEEDED 记录）。
      const exported = await harness.service.exportProject(exportInput('req_export_1'), 'trace_1');
      expect(exported.ok).toBe(true);
      if (exported.ok) {
        expect(exported.data.fileSha256).toBe(harness.firstWritten.sha256);
        expect(exported.data.warningCodes).toEqual(['TRANSFER_CURRENT_ONLY']);
      }
      // 导出重放：同 requestId 返回原摘要；不同载荷拒绝。
      const replayedExport = await harness.service.exportProject(
        exportInput('req_export_1'),
        'trace_1',
      );
      expect(replayedExport.ok && replayedExport.data.exportId).toBe(
        exported.ok ? exported.data.exportId : null,
      );
      const conflictingExport = await harness.service.exportProject(
        { ...exportInput('req_export_1'), expectedVersionId: 'ev_other' },
        'trace_1',
      );
      expect(conflictingExport.ok).toBe(false);
      if (!conflictingExport.ok) {
        expect(conflictingExport.error.code).toBe('TRANSFER_IDEMPOTENCY_CONFLICT');
      }

      // 导入（NEW_PROJECT）：读入刚导出的字节。
      harness.enqueueRead(harness.firstWritten.bytes);
      const imported = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_import_1' },
        'trace_2',
      );
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      const newProjectId = imported.data.projectId;
      expect(newProjectId).not.toBe(SOURCE_PROJECT_ID);
      expect(newProjectId.startsWith('project_')).toBe(true);
      expect(imported.data.sourceProjectId).toBe(SOURCE_PROJECT_ID);
      expect(imported.data.warningCodes).toEqual([
        'TRANSFER_CURRENT_ONLY',
        'TRANSFER_IMPORTED_SNAPSHOT_REQUIRES_SOURCE',
      ]);
      // 4(project/format/episode/import 关联基数) + 4 阶段 + 1 镜头 + 1 镜头版本 + 6 头
      // + 5 依赖边 + 1 整集 = 22。
      expect(imported.data.createdObjectCount).toBe(22);

      // DB：新项目 6 头就位、原始行未被触碰、IMPORTED_SNAPSHOT（零 source_inputs）。
      expect(countOf(database, 'projects')).toBe(2);
      expect(countOf(database, 'source_inputs')).toBe(0);
      const newHeads = database
        .prepare('SELECT stage, current_version_type FROM stage_heads WHERE project_id = ?')
        .all(newProjectId) as unknown as readonly { readonly stage: string; readonly current_version_type: string }[];
      expect(newHeads).toHaveLength(6);
      const storyboardHead = newHeads.find((head) => head.stage === 'SHOT_CONTRACT');
      expect(storyboardHead?.current_version_type).toBe('EPISODE_VERSION');
      expect(countOf(database, 'dependency_edges')).toBe(5);
      expect(
        database
          .prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'PROJECT_IMPORTED'")
          .get(),
      ).toEqual({ total: 1 });

      // import_records：SUCCEEDED + 10 键确定性 ID Mapping（1 镜头：1+1+1+1+4+1+1）。
      const importRow = database
        .prepare('SELECT status, id_mapping_json FROM import_records WHERE request_id = ?')
        .get('req_import_1') as unknown as { readonly status: string; readonly id_mapping_json: string };
      expect(importRow.status).toBe('SUCCEEDED');
      const mapping = JSON.parse(importRow.id_mapping_json) as Record<string, string>;
      expect(Object.keys(mapping)).toHaveLength(10);
      expect(mapping[SOURCE_PROJECT_ID]).toBe(newProjectId);
      expect(mapping[SOURCE_SHOT_ID]).not.toBe(SOURCE_SHOT_ID);

      // 同 requestId 同载荷同模式重放：返回原 resultSummary，不重复写入。
      harness.enqueueRead(harness.firstWritten.bytes);
      const replayedImport = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_import_1' },
        'trace_3',
      );
      expect(replayedImport.ok).toBe(true);
      if (replayedImport.ok) {
        expect(replayedImport.data.importId).toBe(imported.data.importId);
        expect(replayedImport.data.createdObjectCount).toBe(imported.data.createdObjectCount);
      }
      expect(countOf(database, 'projects')).toBe(2);
      expect(
        database
          .prepare("SELECT COUNT(*) AS total FROM import_records WHERE status = 'SUCCEEDED'")
          .get(),
      ).toEqual({ total: 1 });

      // 同 requestId 不同模式 → IDEMPOTENCY_CONFLICT，留 FAILED 证据行。
      harness.enqueueRead(harness.firstWritten.bytes);
      const conflictingImport = await harness.service.importProject(
        { importMode: 'RETURN_TO_ORIGIN', requestId: 'req_import_1' },
        'trace_4',
      );
      expect(conflictingImport.ok).toBe(false);
      if (!conflictingImport.ok) {
        expect(conflictingImport.error.code).toBe('TRANSFER_IDEMPOTENCY_CONFLICT');
      }
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS total FROM import_records WHERE status = 'FAILED' AND validation_errors_json LIKE '%TRANSFER_IDEMPOTENCY_CONFLICT%'",
          )
          .get(),
      ).toEqual({ total: 1 });
    });
  });

  it('NEW_PROJECT 中途故障（镜头行主键冲突）—同事务全量回滚零残留—仅留 FAILED 证据', async () => {
    await withMigratedDatabase(async (database) => {
      seedExportableProject(database);
      let sequence = 0;
      const harness = buildHarness(database, () => `t${String((sequence += 1))}`);
      // mapping 生成顺序固定：project(1) episode(2) format(3) bible(4) 阶段×4(5-8)
      // shot(9) shotVersion(10)，值带 kind 前缀（写入器与 buildTransferIdMapping 约定）。
      // 预置 shot_shot_t9 主键使写入器在镜头行步骤中途失败（此时 project/format/episode/
      // bible/4 阶段均已插入）。
      database
        .prepare(
          `INSERT INTO shots (id, episode_id, lifecycle_status, current_version_id, created_at, updated_at)
           VALUES ('shot_shot_t9', ?, 'ACTIVE', NULL, ?, ?)`,
        )
        .run(SOURCE_EPISODE_ID, NOW, NOW);
      const before = {
        audit: countOf(database, 'audit_events'),
        dependencies: countOf(database, 'dependency_edges'),
        episodes: countOf(database, 'episodes'),
        formats: countOf(database, 'format_profiles'),
        heads: countOf(database, 'stage_heads'),
        projects: countOf(database, 'projects'),
        scriptVersions: countOf(database, 'script_versions'),
        shotContractVersions: countOf(database, 'shot_contract_versions'),
        shotVersionLinks: countOf(database, 'episode_version_shots'),
        shots: countOf(database, 'shots'),
        storyBibles: countOf(database, 'story_bible_versions'),
      };

      harness.enqueueRead(new TextEncoder().encode(JSON.stringify(fixtureRoot)));
      const failed = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_import_boom' },
        'trace_boom',
      );
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error.code).toBe('TRANSFER_PERSISTENCE_FAILED');
      }

      // 零残留：所有业务表计数与故障前完全一致。
      expect(countOf(database, 'audit_events')).toBe(before.audit);
      expect(countOf(database, 'dependency_edges')).toBe(before.dependencies);
      expect(countOf(database, 'episodes')).toBe(before.episodes);
      expect(countOf(database, 'format_profiles')).toBe(before.formats);
      expect(countOf(database, 'stage_heads')).toBe(before.heads);
      expect(countOf(database, 'projects')).toBe(before.projects);
      expect(countOf(database, 'script_versions')).toBe(before.scriptVersions);
      expect(countOf(database, 'shot_contract_versions')).toBe(before.shotContractVersions);
      expect(countOf(database, 'episode_version_shots')).toBe(before.shotVersionLinks);
      expect(countOf(database, 'shots')).toBe(before.shots);
      expect(countOf(database, 'story_bible_versions')).toBe(before.storyBibles);
      expect(countOf(database, 'episode_versions')).toBe(1);
      // 唯一允许的残留：FAILED 证据行（可重复留证，不受 SUCCEEDED 唯一约束）。
      expect(countOf(database, 'import_records')).toBe(1);
      expect(
        scalarText(
          database,
          "SELECT status FROM import_records WHERE request_id = 'req_import_boom'",
        ),
      ).toBe('FAILED');
      expect(
        scalarText(
          database,
          "SELECT validation_errors_json FROM import_records WHERE request_id = 'req_import_boom'",
        ),
      ).toContain('TRANSFER_PERSISTENCE_FAILED');
    });
  });

  it('RETURN_TO_ORIGIN：基线匹配成功恢复—全部新版本不可变追加—旧行与审计留痕', async () => {
    await withMigratedDatabase(async (database) => {
      seedExportableProject(database);
      let sequence = 0;
      const harness = buildHarness(database, () => `r${String((sequence += 1))}`);
      const exported = await harness.service.exportProject(exportInput('req_rto_export'), 'trace_1');
      expect(exported.ok).toBe(true);

      harness.enqueueRead(harness.firstWritten.bytes);
      const restored = await harness.service.importProject(
        { importMode: 'RETURN_TO_ORIGIN', requestId: 'req_rto_1' },
        'trace_2',
      );
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expect(restored.data.projectId).toBe(SOURCE_PROJECT_ID);
        expect(restored.data.warningCodes).toEqual(['TRANSFER_CURRENT_ONLY']);
      }

      // 不可变追加：圣经 1→2、四阶段 4→8、整集 1→2、镜头版本 1→2；旧行原样保留。
      expect(countOf(database, 'story_bible_versions')).toBe(2);
      expect(countOf(database, 'script_versions')).toBe(8);
      expect(countOf(database, 'episode_versions')).toBe(2);
      expect(countOf(database, 'shot_contract_versions')).toBe(2);
      expect(countOf(database, 'projects')).toBe(1);
      expect(
        database
          .prepare('SELECT COUNT(*) AS total FROM script_versions WHERE id = ? AND version_no = 1')
          .get('script_concept_v1'),
      ).toEqual({ total: 1 });

      // 头推进：SHOT_CONTRACT → 新整集；镜头指针 → 新镜头版本。
      const headRow = database
        .prepare(
          "SELECT current_version_id FROM stage_heads WHERE project_id = ? AND stage = 'SHOT_CONTRACT'",
        )
        .get(SOURCE_PROJECT_ID) as unknown as { readonly current_version_id: string };
      expect(headRow.current_version_id).not.toBe(SOURCE_EPISODE_VERSION_ID);
      const newEpisodeVersion = database
        .prepare('SELECT parent_id, version_no FROM episode_versions WHERE id = ?')
        .get(headRow.current_version_id) as unknown as
        { readonly parent_id: string | null; readonly version_no: number };
      expect(newEpisodeVersion.parent_id).toBe(SOURCE_EPISODE_VERSION_ID);
      expect(newEpisodeVersion.version_no).toBe(2);
      const shotPointer = database
        .prepare('SELECT current_version_id FROM shots WHERE id = ?')
        .get(SOURCE_SHOT_ID) as unknown as { readonly current_version_id: string };
      expect(shotPointer.current_version_id).not.toBe(SOURCE_SHOT_VERSION_ID);

      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'PROJECT_RESTORED_FROM_BUNDLE'",
          )
          .get(),
      ).toEqual({ total: 1 });
      expect(
        scalarText(database, "SELECT status FROM import_records WHERE request_id = 'req_rto_1'"),
      ).toBe('SUCCEEDED');
    });
  });

  it('RETURN_TO_ORIGIN：项目名漂移→TRANSFER_PROJECT_CONFLICT 完全回滚—原始状态不变', async () => {
    await withMigratedDatabase(async (database) => {
      seedExportableProject(database);
      let sequence = 0;
      const harness = buildHarness(database, () => `c${String((sequence += 1))}`);
      const exported = await harness.service.exportProject(exportInput('req_conflict_export'), 'trace_1');
      expect(exported.ok).toBe(true);

      // 导出后项目名被修改：基线失配。
      database
        .prepare("UPDATE projects SET name = '改名后的项目', updated_at = ? WHERE id = ?")
        .run(NOW, SOURCE_PROJECT_ID);

      harness.enqueueRead(harness.firstWritten.bytes);
      const conflicted = await harness.service.importProject(
        { importMode: 'RETURN_TO_ORIGIN', requestId: 'req_conflict_1' },
        'trace_2',
      );
      expect(conflicted.ok).toBe(false);
      if (!conflicted.ok) {
        expect(conflicted.error.code).toBe('TRANSFER_PROJECT_CONFLICT');
      }

      // 完全回滚：版本计数、头指针与导入前一致。
      expect(countOf(database, 'story_bible_versions')).toBe(1);
      expect(countOf(database, 'script_versions')).toBe(4);
      expect(countOf(database, 'episode_versions')).toBe(1);
      expect(countOf(database, 'shot_contract_versions')).toBe(1);
      expect(countOf(database, 'audit_events')).toBe(0);
      expect(countOf(database, 'dependency_edges')).toBe(0);
      expect(
        scalarText(
          database,
          `SELECT current_version_id FROM stage_heads WHERE project_id = '${SOURCE_PROJECT_ID}' AND stage = 'SHOT_CONTRACT'`,
        ),
      ).toBe(SOURCE_EPISODE_VERSION_ID);
      expect(countOf(database, 'import_records')).toBe(1);
      expect(
        scalarText(database, "SELECT status FROM import_records WHERE request_id = 'req_conflict_1'"),
      ).toBe('FAILED');
    });
  });

  it('staging 失败（损坏 JSON）—目标库零改动—FAILED 证据含 TRANSFER_BUNDLE_INVALID', async () => {
    await withMigratedDatabase(async (database) => {
      seedExportableProject(database);
      const harness = buildHarness(database, () => 'x1');
      harness.enqueueRead(new TextEncoder().encode('{"schema_version": '));
      const rejected = await harness.service.importProject(
        { importMode: 'NEW_PROJECT', requestId: 'req_bad_json' },
        'trace_1',
      );
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('TRANSFER_BUNDLE_INVALID');
      }
      expect(countOf(database, 'projects')).toBe(1);
      expect(countOf(database, 'script_versions')).toBe(4);
      expect(countOf(database, 'import_records')).toBe(1);
      expect(
        scalarText(database, "SELECT status FROM import_records WHERE request_id = 'req_bad_json'"),
      ).toBe('FAILED');
      expect(
        scalarText(
          database,
          "SELECT validation_errors_json FROM import_records WHERE request_id = 'req_bad_json'",
        ),
      ).toContain('TRANSFER_BUNDLE_INVALID');
    });
  });
});
