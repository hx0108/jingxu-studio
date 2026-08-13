import { createHash } from 'node:crypto';
import path from 'node:path';

import type { ScriptDependency, ScriptVersion, SourceInput } from '@jingxu/application';
import { describe, expect, it } from 'vitest';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTransactionCoordinator } from '../runtime/sqlite-transaction-coordinator';
import { SqliteTestDatabase } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { mapSourceInput } from './script-row-mappers';
import {
  SqliteScriptCommandReceiptRepository,
  SqliteScriptDependencyRepository,
  SqliteScriptVersionRepository,
  SqliteSourceInputRepository,
  SqliteStageHeadRepository,
} from './sqlite-script-repositories';
import { SqliteScriptUnitOfWork } from './sqlite-script-unit-of-work';

const MIGRATIONS = path.resolve(import.meta.dirname, '../../resources/migrations');
const NOW = '2026-08-13T00:00:00.000Z';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const open = async (root: string): Promise<SqliteTestDatabase> => {
  const database = new SqliteTestDatabase(path.join(root, 'script.sqlite'));
  database.pragma('foreign_keys = ON');
  applyMigrations(database, await loadMigrationSet(MIGRATIONS), () => NOW);
  database
    .prepare(
      `INSERT INTO projects
       (id, name, creation_mode, dialogue_render_mode, deployment_mode, data_root_rel, created_at, updated_at)
       VALUES ('project_script', '剧本项目', 'AI_ORIGINAL', 'NARRATION_FIRST', 'LOCAL_DEMO',
               'projects/project_script', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO format_profiles
       (id, project_id, version_no, aspect_ratio, width, height, fps, language,
        subtitle_safe_area_json, is_current, created_at)
       VALUES ('format_script', 'project_script', 1, '9:16', 1080, 1920, 24, 'zh-CN',
               '{"top":5,"right":5,"bottom":10,"left":5}', 1, ?)`,
    )
    .run(NOW);
  return database;
};

const source = (content: string): SourceInput => ({
  charCount: Array.from(content).length,
  content,
  createdAt: NOW,
  encoding: null,
  fileName: null,
  id: 'source_script',
  inputKind: 'CREATIVE',
  projectId: 'project_script',
  sha256: hash(content),
});

const version = (id: string, versionNo: number, parentId: string | null): ScriptVersion => ({
  changeSummary: null,
  createdAt: NOW,
  document: JSON.stringify({ data: { title: id } }),
  documentSha256: hash(id),
  episodeId: null,
  id,
  parentId,
  projectId: 'project_script',
  source: 'USER',
  sourceInputId: 'source_script',
  sourceInvocationId: null,
  stage: 'CONCEPT',
  status: 'DRAFT',
  versionNo,
});

describe('SQLite Script repositories and UnitOfWork', () => {
  it('SourceInput—首尾空白与 emoji—按原始 UTF-8 内容、code point 数和 hash 往返', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const repository = new SqliteSourceInputRepository(database);
        const content = `  ${'创'.repeat(18)}😀  `;
        const value = source(content);
        await repository.insert(value);
        expect(await repository.findById(value.id)).toEqual(value);
        expect(Buffer.from((await repository.findById(value.id))?.content ?? '', 'utf8')).toEqual(
          Buffer.from(content, 'utf8'),
        );
      } finally {
        database.close();
      }
    });
  });

  it('SourceInput—19/20/2000/2001 code points—只接受产品硬边界且不截断', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const repository = new SqliteSourceInputRepository(database);
        await expect(repository.insert(source('创'.repeat(19)))).rejects.toThrow();
        await expect(repository.insert(source('创'.repeat(20)))).resolves.toBeUndefined();
        const upper = { ...source('创'.repeat(2_000)), id: 'source_upper' };
        await expect(repository.insert(upper)).resolves.toBeUndefined();
        await expect(
          repository.insert({ ...source('创'.repeat(2_001)), id: 'source_over' }),
        ).rejects.toThrow();
        expect((await repository.findById(upper.id))?.content).toHaveLength(2_000);
      } finally {
        database.close();
      }
    });
  });

  it('Source Row—机器字段不是初始化约定的 null—边界映射拒绝坏数据', () => {
    expect(() =>
      mapSourceInput({
        char_count: 20,
        content_text: 'x'.repeat(20),
        created_at: NOW,
        encoding: 'utf8',
        file_name: null,
        id: 'source_bad',
        input_kind: 'CREATIVE',
        project_id: 'project_script',
        sha256: 'a'.repeat(64),
      }),
    ).toThrow();
  });

  it('Version/StageHead—有界 keyset 历史与 expected current—稳定分页且冲突不移动头', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        await new SqliteSourceInputRepository(database).insert(source('创'.repeat(20)));
        const versions = new SqliteScriptVersionRepository(database);
        let parent: string | null = null;
        for (let index = 1; index <= 55; index += 1) {
          const id = `script_${String(index).padStart(3, '0')}`;
          await versions.insert(version(id, index, parent));
          parent = id;
        }
        expect(
          (await versions.listHistory('project_script', null, 'CONCEPT', null, 10)).map(
            (v) => v.versionNo,
          ),
        ).toEqual([55, 54, 53, 52, 51, 50, 49, 48, 47, 46]);
        expect(
          (await versions.listHistory('project_script', null, 'CONCEPT', 46, 3)).map(
            (v) => v.versionNo,
          ),
        ).toEqual([45, 44, 43]);

        const heads = new SqliteStageHeadRepository(database);
        expect(
          await heads.upsert(
            {
              currentVersionId: 'script_055',
              currentVersionType: 'SCRIPT_VERSION',
              episodeId: null,
              projectId: 'project_script',
              stage: 'CONCEPT',
              updatedAt: NOW,
            },
            null,
          ),
        ).toBe(true);
        expect(
          await heads.upsert(
            {
              currentVersionId: 'script_054',
              currentVersionType: 'SCRIPT_VERSION',
              episodeId: null,
              projectId: 'project_script',
              stage: 'CONCEPT',
              updatedAt: NOW,
            },
            'script_stale',
          ),
        ).toBe(false);
        expect((await heads.find('project_script', null, 'CONCEPT'))?.currentVersionId).toBe(
          'script_055',
        );
      } finally {
        database.close();
      }
    });
  });

  it('Dependency/Receipt—重复边去重、固定排序且安全引用可回放', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const dependencies = new SqliteScriptDependencyRepository(database);
        const edge: ScriptDependency = {
          id: 'dep_1',
          projectId: 'project_script',
          upstreamType: 'SOURCE_INPUT',
          upstreamId: 'source_script',
          upstreamVersionId: 'source_script',
          downstreamType: 'SCRIPT_VERSION',
          downstreamId: 'script_1',
          downstreamVersionId: 'script_1',
          dependencyType: 'GENERATED_FROM',
          createdAt: NOW,
        };
        await dependencies.insertMany([edge, { ...edge, id: 'dep_duplicate' }]);
        expect(
          await dependencies.listByUpstreamVersionIds('project_script', ['source_script']),
        ).toEqual([edge]);

        const receipts = new SqliteScriptCommandReceiptRepository(database);
        const receipt = {
          commandName: 'INITIALIZE_ORIGINAL',
          committedAt: NOW,
          payloadSha256: 'a'.repeat(64),
          projectId: 'project_script',
          requestId: 'request_script',
          resultRef: { episodeId: 'episode_script', sourceInputId: 'source_script' },
          traceId: 'trace_script',
        } as const;
        await receipts.insert(receipt);
        expect(await receipts.findByRequestId(receipt.requestId)).toEqual(receipt);
      } finally {
        database.close();
      }
    });
  });

  it('Script UoW—任一点抛错—业务版本、阶段头、审计和回执零部分写入', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        database
          .prepare(
            `INSERT INTO provider_profiles
             (id,provider,region,base_url,workspace_id,model_id,model_snapshot_date,
              config_json,credential_ref,enabled)
             VALUES ('provider_script','QWEN','cn-beijing','https://example.invalid','workspace',
                     'model','2026-08-13','{}','credential',1)`,
          )
          .run();
        database
          .prepare(
            `INSERT INTO prompt_templates (id,stage,version,template_text,sha256,active,created_at)
             VALUES ('prompt_script','CONCEPT',1,'prompt',?,1,?)`,
          )
          .run(hash('prompt'), NOW);
        database
          .prepare(
            `INSERT INTO script_stage_jobs
             (id,project_id,episode_id,stage,operation_type,status,idempotency_key,user_operation_id,
              input_versions_json,input_version_set_hash,selection_json,write_set_json,lock_snapshot_hash,
              prompt_template_id,transport_attempts,structure_repair_attempts,created_at)
             VALUES ('job_atomic','project_script',NULL,'CONCEPT','GENERATE','VALIDATING','idem_atomic',
                     'operation_atomic','[]',?,NULL,'[]',?,'prompt_script',0,0,?)`,
          )
          .run(hash('inputs'), hash('locks'), NOW);
        database
          .prepare(
            `INSERT INTO model_invocations
             (id,job_id,status,attempt_kind,transport_attempt,provider_profile_id,model_id,model_version,
              parameters_json,request_snapshot_json,request_sha256,request_sent_at,timeout_at,started_at)
             VALUES ('invocation_atomic','job_atomic','STARTED','INITIAL',1,'provider_script','model',
                     'snapshot','{}','{}',?,?,?,?)`,
          )
          .run(hash('request'), NOW, '2026-08-13T00:02:00.000Z', NOW);
        const unitOfWork = new SqliteScriptUnitOfWork(database);
        await expect(
          unitOfWork.run(async (repositories) => {
            await repositories.invocations.recordResponse({
              inputTokens: 10,
              invocationId: 'invocation_atomic',
              outputTokens: 20,
              providerRequestId: 'provider_request',
              rawResponse: new TextEncoder().encode('{"data":{}}'),
              rawResponseSha256: hash('{"data":{}}'),
              responseCompleteAt: NOW,
            });
            await repositories.invocations.finish('invocation_atomic', 'SUCCEEDED', NOW, null);
            await repositories.sourceInputs.insert(source('创'.repeat(20)));
            await repositories.scriptVersions.insert(version('script_atomic', 1, null));
            await repositories.stageHeads.upsert(
              {
                currentVersionId: 'script_atomic',
                currentVersionType: 'SCRIPT_VERSION',
                episodeId: null,
                projectId: 'project_script',
                stage: 'CONCEPT',
                updatedAt: NOW,
              },
              null,
            );
            await repositories.audit.record({
              action: 'TEST',
              actor: 'SYSTEM',
              afterSha256: hash('after'),
              beforeSha256: null,
              createdAt: NOW,
              id: 'audit_atomic',
              metadata: { safe: true },
              objectId: 'script_atomic',
              objectType: 'SCRIPT_VERSION',
              objectVersionId: 'script_atomic',
              projectId: 'project_script',
              traceId: 'trace_atomic',
            });
            await repositories.dependencies.insertMany([
              {
                createdAt: NOW,
                dependencyType: 'GENERATED_FROM',
                downstreamId: 'script_atomic',
                downstreamType: 'SCRIPT_VERSION',
                downstreamVersionId: 'script_atomic',
                id: 'dependency_atomic',
                projectId: 'project_script',
                upstreamId: 'source_script',
                upstreamType: 'SOURCE_INPUT',
                upstreamVersionId: 'source_script',
              },
            ]);
            await repositories.receipts.insert({
              commandName: 'SAVE_SCRIPT_DRAFT',
              committedAt: NOW,
              payloadSha256: 'b'.repeat(64),
              projectId: 'project_script',
              requestId: 'request_atomic',
              resultRef: { versionId: 'script_atomic' },
              traceId: 'trace_atomic',
            });
            await repositories.jobs.transition({
              errorCode: null,
              errorJson: null,
              expectedStatus: 'VALIDATING',
              finishedAt: NOW,
              jobId: 'job_atomic',
              nextStatus: 'SUCCEEDED',
              structureRepairAttempts: 0,
              transportAttempts: 0,
            });
            throw new Error('injected');
          }),
        ).rejects.toThrow('injected');
        for (const table of [
          'source_inputs',
          'script_versions',
          'stage_heads',
          'audit_events',
          'dependency_edges',
          'command_receipts',
        ]) {
          expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
            count: 0,
          });
        }
        expect(
          database.prepare('SELECT status FROM script_stage_jobs WHERE id=?').get('job_atomic'),
        ).toEqual({ status: 'VALIDATING' });
        expect(
          database
            .prepare(
              'SELECT status, raw_response_blob, response_complete_at FROM model_invocations WHERE id=?',
            )
            .get('invocation_atomic'),
        ).toEqual({ raw_response_blob: null, response_complete_at: null, status: 'STARTED' });
      } finally {
        database.close();
      }
    });
  });

  it('共享 coordinator—首事务失败—释放 FIFO 队列且下一事务可提交', async () => {
    await withSqliteTestContext(async ({ root }) => {
      const database = await open(root);
      try {
        const coordinator = new SqliteTransactionCoordinator(database);
        const first = coordinator.run(() => {
          database
            .prepare("INSERT INTO app_settings (key,value_json,updated_at) VALUES ('first','{}',?)")
            .run(NOW);
          return Promise.reject(new Error('first failed'));
        });
        const second = coordinator.run(() => {
          database
            .prepare(
              "INSERT INTO app_settings (key,value_json,updated_at) VALUES ('second','{}',?)",
            )
            .run(NOW);
          return Promise.resolve('ok');
        });
        await expect(first).rejects.toThrow('first failed');
        await expect(second).resolves.toBe('ok');
        expect(database.prepare('SELECT key FROM app_settings ORDER BY key').all()).toEqual([
          { key: 'second' },
        ]);
      } finally {
        database.close();
      }
    });
  });
});
