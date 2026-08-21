import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { computeShotSetHash, createTransferService, stableTransferJson } from '@jingxu/application';
import type { TransferFilePort, TransferFileSnapshot, TransferService } from '@jingxu/application';

import { loadMigrationSet, type MigrationResource } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import type { SqliteDatabase } from '../runtime/sqlite-database';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteTransferUnitOfWork } from './sqlite-transfer-unit-of-work';

/** Transfer 集成测试共用基建：真实迁移库 + fixture 种子 + 文件 Port 捕获桩。 */
export const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '../../../test-fixtures/src/fixtures/v1/project-transfer-bundle.valid.json',
);
export const NOW = '2026-08-21T08:00:00.000Z';

export const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');
export const hashText = sha256;
export const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  sha256(stableTransferJson(value));

type MutableJson = Record<string, unknown>;
const asJson = (value: unknown): MutableJson => value as MutableJson;

/** 种子事实全部取自 schema 合法 fixture：文档天然满足 ProjectTransferBundle 1.0.0。 */
export const fixtureRoot = asJson(JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as unknown);
const fixtureStoryboard = asJson(fixtureRoot.episode_storyboard);
const fixtureShots = fixtureStoryboard.shot_contracts as MutableJson[];
const fixtureFirstShot = asJson(fixtureShots[0]);
const fixtureStages = fixtureRoot.script_stage_outputs as MutableJson[];
const fixtureBibleOutput = asJson(asJson(fixtureRoot.story_bible).output);
if (fixtureShots.length !== 1 || fixtureStages.length !== 4) {
  throw new Error('fixture 形状与测试假设不符（1 镜头 + 4 阶段）');
}

export const SOURCE_PROJECT_ID = 'project_rain_station';
export const SOURCE_EPISODE_ID = 'episode_01';
const SOURCE_FORMAT_ID = 'format_vertical_1080p';
const SOURCE_BIBLE_VERSION_ID = 'story_bible_v1';
export const SOURCE_SHOT_ID = 'shot_ep01_001';
export const SOURCE_SHOT_VERSION_ID = 'scv_shot_ep01_001_v1';
export const SOURCE_EPISODE_VERSION_ID = 'ev_seed';

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

/** 加载迁移集（可截断到指定版本，用于 0015 旧库→0016 升级路径测试）。 */
export const loadMigrationsUpTo = async (
  upToVersion: number,
): Promise<readonly MigrationResource[]> => {
  const all = await loadMigrationSet(MIGRATION_DIRECTORY);
  return all.slice(0, upToVersion);
};

export const openMigratedDatabase = async (
  root: string,
  filename = 'transfer-service.sqlite',
  migrations?: readonly MigrationResource[],
): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, filename));
  try {
    database.pragma('foreign_keys = ON');
    applyMigrations(
      database,
      migrations ?? (await loadMigrationSet(MIGRATION_DIRECTORY)),
      () => NOW,
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const withMigratedDatabase = async <T>(
  operation: (database: SqliteTestDatabase) => T | Promise<T>,
  options?: Readonly<{
    /** 截断迁移集（如 15 = 0015 旧库）；缺省全量。 */
    readonly migrations?: readonly MigrationResource[];
  }>,
): Promise<T> =>
  withSqliteTestContext(async (context) => {
    const database = await openMigratedDatabase(
      context.root,
      'transfer-service.sqlite',
      options?.migrations,
    );
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  });

/** 可导出完整快照的源项目：project→episode/format/bible→4 阶段→整集 READY→镜头链→头×6。 */
export const seedExportableProject = (database: SqliteDatabase): void => {
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
  insertHead.run(
    SOURCE_PROJECT_ID,
    null,
    'STORY_BIBLE',
    'STORY_BIBLE_VERSION',
    SOURCE_BIBLE_VERSION_ID,
    NOW,
  );
  insertHead.run(SOURCE_PROJECT_ID, null, 'CONCEPT', 'SCRIPT_VERSION', 'script_concept_v1', NOW);
  insertHead.run(
    SOURCE_PROJECT_ID,
    SOURCE_EPISODE_ID,
    'EPISODE_OUTLINE',
    'SCRIPT_VERSION',
    'script_outline_v1',
    NOW,
  );
  insertHead.run(
    SOURCE_PROJECT_ID,
    SOURCE_EPISODE_ID,
    'BEAT_SHEET',
    'SCRIPT_VERSION',
    'script_beats_v1',
    NOW,
  );
  insertHead.run(
    SOURCE_PROJECT_ID,
    SOURCE_EPISODE_ID,
    'SCENE_SCRIPT',
    'SCRIPT_VERSION',
    'script_scene_v1',
    NOW,
  );
  insertHead.run(
    SOURCE_PROJECT_ID,
    SOURCE_EPISODE_ID,
    'SHOT_CONTRACT',
    'EPISODE_VERSION',
    SOURCE_EPISODE_VERSION_ID,
    NOW,
  );
};

export const countOf = (database: SqliteDatabase, table: string): number =>
  (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total;

/** 单列标量查询：取结果行第一个字段的字符串值（列名由调用方 SQL 决定）。 */
export const scalarText = (database: SqliteDatabase, sql: string): string | null => {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const value: unknown = Object.values(row)[0];
  return typeof value === 'string' ? value : null;
};

export interface Harness {
  readonly enqueueRead: (bytes: Uint8Array) => void;
  readonly firstWritten: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly service: TransferService;
}

export const buildHarness = (database: SqliteDatabase, newId: () => string): Harness => {
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
  // Schema 正式校验由 contracts fixtures 契约测试与 4.1 组合根接线覆盖；集成测试注入恒真
  // 校验器，聚焦事务与残留目标（种子文档本身取自合法 fixture）。
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

export const exportInput = (requestId: string) => ({
  episodeId: SOURCE_EPISODE_ID,
  expectedVersionId: SOURCE_EPISODE_VERSION_ID,
  overwriteConfirmed: false,
  projectId: SOURCE_PROJECT_ID,
  requestId,
});
