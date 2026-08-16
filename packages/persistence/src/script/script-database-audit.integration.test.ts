import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runDatabaseAudit } from '../audit/database-audit';
import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-13T00:00:00.000Z';

const seedBase = (database: SqliteTestDatabase): void => {
  database
    .prepare(
      `INSERT INTO projects
       (id,name,creation_mode,dialogue_render_mode,deployment_mode,data_root_rel,created_at,updated_at)
       VALUES ('project_audit','审计项目','AI_ORIGINAL','NARRATION_FIRST','LOCAL_DEMO',
               'projects/project_audit',?,?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id,project_id,version_no,aspect_ratio,width,height,fps,language,subtitle_safe_area_json,is_current,created_at)
       VALUES ('format_audit','project_audit',1,'9:16',1080,1920,24,'zh-CN','{}',1,?)`,
    )
    .run(NOW);
};

describe('Script database invariant audit', () => {
  it('合法旧库—没有 Script 工作区数据—新增规则全部放行', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'legacy.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedBase(database);
        const scriptFindings = runDatabaseAudit(database).findings.filter(({ ruleId }) =>
          ruleId.startsWith('script.'),
        );
        expect(scriptFindings).toHaveLength(4);
        expect(scriptFindings.every(({ status }) => status === 'PASS')).toBe(true);
      } finally {
        database.close();
      }
    });
  });

  it('StageHead 指向跨聚合版本—启动审计—返回稳定 FAIL 证据', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'bad-head.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedBase(database);
        database
          .prepare(
            `INSERT INTO stage_heads
             (project_id,episode_id,stage,current_version_type,current_version_id,updated_at)
             VALUES ('project_audit',NULL,'CONCEPT','SCRIPT_VERSION','missing_version',?)`,
          )
          .run(NOW);
        expect(
          runDatabaseAudit(database).findings.find(
            ({ ruleId }) => ruleId === 'script.stage-head-resolves',
          ),
        ).toMatchObject({ evidenceCount: 1, status: 'FAIL' });
      } finally {
        database.close();
      }
    });
  });

  it('Script receipt 安全引用可解析—初始化结果存在—回执规则 PASS', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'receipt.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedBase(database);
        database
          .prepare(
            `INSERT INTO source_inputs
             (id,project_id,input_kind,content_text,char_count,sha256,created_at)
             VALUES ('source_audit','project_audit','CREATIVE',?,20,?,?)`,
          )
          .run('创'.repeat(20), 'a'.repeat(64), NOW);
        database
          .prepare(
            `INSERT INTO episodes (id,project_id,title,target_duration_sec,created_at,updated_at)
             VALUES ('episode_audit','project_audit','第1集',90,?,?)`,
          )
          .run(NOW, NOW);
        database
          .prepare(
            `INSERT INTO command_receipts
             (request_id,command_name,payload_sha256,project_id,result_ref_json,trace_id,committed_at)
             VALUES ('request_audit','INITIALIZE_ORIGINAL',?,'project_audit',?,'trace_audit',?)`,
          )
          .run('b'.repeat(64), '{"sourceInputId":"source_audit","episodeId":"episode_audit"}', NOW);
        expect(
          runDatabaseAudit(database).findings.find(
            ({ ruleId }) => ruleId === 'command-receipts.references-resolve',
          ),
        ).toMatchObject({ evidenceCount: 0, status: 'PASS' });
      } finally {
        database.close();
      }
    });
  });

  it('SHOT_CONTRACT 确认回执—versionId 指向分镜集合 episode 版本—回执规则放行', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = new SqliteTestDatabase(path.join(root, 'storyboard-receipt.sqlite'));
      try {
        database.pragma('foreign_keys = ON');
        applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
        seedBase(database);
        // 分镜契约确认（v8 起）落 episode_versions（分镜集合版本），回执 versionId 指向它。
        // 若审计只解析 script/story_bible 两表，下次启动会把合法库误判只读故障
        // （6.2 升级冒烟实证）。
        database
          .prepare(
            `INSERT INTO story_bible_versions
             (id,project_id,version_no,document_json,document_sha256,status,source,created_at)
             VALUES ('bible_audit','project_audit',1,'{}',?,'READY','AI',?)`,
          )
          .run('c'.repeat(64), NOW);
        database
          .prepare(
            `INSERT INTO episodes (id,project_id,title,target_duration_sec,created_at,updated_at)
             VALUES ('episode_audit','project_audit','第1集',90,?,?)`,
          )
          .run(NOW, NOW);
        database
          .prepare(
            `INSERT INTO episode_versions
             (id,episode_id,version_no,story_bible_version_id,format_profile_id,
              target_duration_sec,shot_set_hash,status,created_at)
             VALUES ('episode_version_audit','episode_audit',1,'bible_audit','format_audit',
                     90,?,'READY',?)`,
          )
          .run('d'.repeat(64), NOW);
        database
          .prepare(
            `INSERT INTO command_receipts
             (request_id,command_name,payload_sha256,project_id,result_ref_json,trace_id,committed_at)
             VALUES ('request_storyboard','CONFIRM_SCRIPT_VERSION',?,'project_audit',?,
                     'trace_audit',?)`,
          )
          .run('e'.repeat(64), '{"versionId":"episode_version_audit"}', NOW);
        expect(
          runDatabaseAudit(database).findings.find(
            ({ ruleId }) => ruleId === 'command-receipts.references-resolve',
          ),
        ).toMatchObject({ evidenceCount: 0, status: 'PASS' });
      } finally {
        database.close();
      }
    });
  });
});
