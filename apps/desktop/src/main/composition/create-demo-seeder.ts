import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createOriginalInitializationService,
  createScriptVersionService,
  createStoryboardVersionService,
  type CreatorDemoSeederPort,
  type ScriptUnitOfWorkPort,
} from '@jingxu/application';
import { E2eScriptTextModelAdapter } from '../adapters/e2e-script-text-model-adapter';
import type { AppResultDto, CreatorDemoResultDto } from '@jingxu/contracts';
import { createFormatProfileSpec } from '@jingxu/domain';
import { createDesktopScriptGenerationRuntime } from './create-script-generation-runtime';
import { demoProjectRegistry } from './demo-project-registry';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

const SCRIPT_STAGE_OUTPUT_SCHEMA_ID = 'https://jingxu.studio/schemas/script-stage-output/1.0.0';
const STAGES = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;
const DEMO_NAME = '示例·灯塔最后一封信';
const SEED_TIMEOUT_MS = 120_000;
const JOB_POLL_INTERVAL_MS = 100;

const sha256Text = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const sha256Payload = (value: Readonly<Record<string, unknown>>): string =>
  sha256Text(JSON.stringify(value));
const nowIso = (): string => new Date().toISOString();

interface DemoStoryFixture {
  readonly fixtureVersion: string;
  readonly projectDefaults: {
    readonly aspectRatio: string;
    readonly dialogueRenderMode: string;
    readonly targetDurationSec: number;
  };
  readonly stages: readonly {
    readonly data: Readonly<Record<string, unknown>>;
    readonly stage: string;
  }[];
  readonly title: string;
}

const failure = (
  traceId: string,
  message: string,
  userAction: string,
): AppResultDto<CreatorDemoResultDto> => ({
  ok: false,
  error: {
    code: 'DEMO_INITIALIZATION_FAILED',
    fieldErrors: null,
    message,
    retryable: true,
    traceId,
    userAction,
  },
});

/** 读随包 Fixture（打包后位于进程资源目录；开发/E2E 位于源码目录）。 */
const resolveDemoRoot = (): string => {
  const electronResourcesPath = Reflect.get(process, 'resourcesPath');
  const resourcesRoot =
    typeof electronResourcesPath === 'string'
      ? path.join(electronResourcesPath, 'demo')
      : path.resolve(import.meta.dirname, '../../../resources/demo');
  return resourcesRoot;
};

/**
 * 五分钟体验种子（simplify-first-run-creator-experience 3.3）。
 *
 * 幂等语义：任一时刻至多一个 ACTIVE 演示项目——种子前在同一事务内检查
 * `experience_mode='DEMO'` 的活动项目，命中即恢复返回（不复制）。
 * 脚本侧五阶段+分镜经「私有 Mock 文本运行时」走真实任务管线（提交→完成→确认），
 * 全部落库不变量（版本链/头/依赖/Schema 校验）由既有实现保证，零手工直写。
 * 媒体不走种子：演示项目随后的画面/视频/配音由用户在界面触发，经组合根
 * resolveModel 按项目路由到 Mock 适配器（见 register-*-features）。
 * 失败补偿：任一步骤失败即软删新演示项目（回收站语义），下次调用重新种子。
 */
export const createDemoSeeder = (options: {
  readonly persistenceRuntime: DesktopPersistenceRuntime;
}): CreatorDemoSeederPort => {
  const { persistenceRuntime } = options;

  /** 补偿清理（回收站语义）：演示半成品对用户不可见，下次种子重新创建。 */
  const softDeleteDemo = async (
    projectUnitOfWork: NonNullable<ReturnType<DesktopPersistenceRuntime['getProjectUnitOfWork']>>,
    demoProjectId: string,
  ): Promise<void> => {
    await projectUnitOfWork.run(async ({ projects }) => {
      const project = await projects.findById(demoProjectId, 'ACTIVE');
      if (project === null) return;
      await projects.update(
        { ...project, deletedAt: nowIso(), updatedAt: nowIso() },
        project.updatedAt,
      );
    });
  };

  const waitForJob = async (
    jobId: string,
    unitOfWork: ScriptUnitOfWorkPort,
    deadlineMs: number,
  ): Promise<'SUCCEEDED' | 'FAILED'> => {
    for (;;) {
      const outcome = await unitOfWork.run(async ({ jobs }) => {
        const job = await jobs.findById(jobId);
        if (job === null) throw new Error('DEMO_JOB_MISSING');
        return job.status;
      });
      if (outcome === 'SUCCEEDED' || outcome === 'FAILED' || outcome === 'CANCELLED') {
        return outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
      }
      if (Date.now() > deadlineMs) throw new Error('DEMO_SEED_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
    }
  };

  return {
    async seed(requestId) {
      const traceId = `trace_demo_seed_${randomUUID()}`;
      const projectUnitOfWork = persistenceRuntime.getProjectUnitOfWork();
      const scriptUnitOfWork = persistenceRuntime.getScriptUnitOfWork();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (
        projectUnitOfWork === null ||
        scriptUnitOfWork === null ||
        workspaceQuery === null ||
        registry === null
      ) {
        return failure(traceId, '应用尚未完成启动检查', '请处理启动故障后重试');
      }

      // —— 幂等检查 + 项目创建（同一事务；唯一 ACTIVE 演示项目）——
      const projectId = `project_demo_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const created = await projectUnitOfWork.run(async ({ formatProfiles, projects }) => {
        const page = await projects.listPage({
          after: null,
          limit: 100,
          scope: 'ACTIVE',
        });
        const existingDemo = page.items.find((item) => item.project.experienceMode === 'DEMO');
        if (existingDemo !== undefined)
          return { projectId: existingDemo.project.id, created: false };
        const at = nowIso();
        await projects.insert({
          createdAt: at,
          creationMode: 'AI_ORIGINAL',
          deletedAt: null,
          deploymentMode: 'LOCAL_DEMO',
          dialogueRenderMode: 'NARRATION_FIRST',
          experienceMode: 'DEMO',
          genre: '温情奇幻',
          id: projectId,
          name: DEMO_NAME,
          style: '二维漫剧',
          updatedAt: at,
        });
        await formatProfiles.insert({
          createdAt: at,
          id: `fmt_demo_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          isCurrent: true,
          parentId: null,
          projectId,
          spec: createFormatProfileSpec('9:16', { bottom: 12, left: 5, right: 5, top: 5 }),
          versionNo: 1,
        });
        return { projectId, created: true };
      });

      demoProjectRegistry.set(created.projectId);
      if (!created.created) {
        return {
          ok: true,
          data: {
            isDemo: true,
            projectId: created.projectId,
            resumed: true,
            summary: '示例已就绪，继续即可。',
          },
        };
      }

      // —— Fixture 加载（hash 校验随包资源）——
      let creativeText: string;
      try {
        const demoRoot = resolveDemoRoot();
        const [manifestBytes, storyBytes] = await Promise.all([
          readFile(path.join(demoRoot, 'demo-manifest.json'), 'utf8'),
          readFile(path.join(demoRoot, 'demo-story.json'), 'utf8'),
        ]);
        const manifest = JSON.parse(manifestBytes) as { readonly files: Record<string, string> };
        const expected = manifest.files['demo-story.json'];
        if (expected !== undefined && sha256Text(storyBytes) !== expected) {
          throw new Error('DEMO_FIXTURE_HASH_MISMATCH');
        }
        const story = JSON.parse(storyBytes) as DemoStoryFixture;
        const synopsisStage = story.stages.find((stage) => stage.stage === 'CONCEPT');
        const synopsis = synopsisStage?.data.synopsis;
        creativeText =
          typeof synopsis === 'string' ? synopsis : '一名守塔少女在风暴夜送出一封迟到了十年的信。';
      } catch {
        await softDeleteDemo(projectUnitOfWork, created.projectId);
        return failure(traceId, '示例内容损坏', '重新安装应用，或联系支持后重试。');
      }

      // —— 与生产完全一致的初始化/确认服务（正式 Schema 校验）——
      const getProjectDefaults = (): Promise<{ targetDurationSec: number } | null> =>
        Promise.resolve({ targetDurationSec: 60 });
      const initialization = createOriginalInitializationService({
        getProjectDefaults,
        hashPayload: sha256Payload,
        hashText: sha256Text,
        newId: randomUUID,
        now: nowIso,
        unitOfWork: scriptUnitOfWork,
        workspaceQuery,
      });
      const versions = createScriptVersionService({
        hashPayload: sha256Payload,
        newId: randomUUID,
        now: nowIso,
        unitOfWork: scriptUnitOfWork,
        validateDocument: (document) =>
          registry.validate(SCRIPT_STAGE_OUTPUT_SCHEMA_ID, document).valid,
      });
      const storyboard = createStoryboardVersionService({
        hashPayload: sha256Payload,
        hashText: sha256Text,
        newId: randomUUID,
        now: nowIso,
        unitOfWork: scriptUnitOfWork,
      });

      try {
        const initialized = await initialization.initialize(
          {
            creativeText,
            dataProcessingConsent: true,
            projectId,
            requestId: `${requestId}_init`,
          },
          traceId,
        );
        if (!initialized.ok) throw new Error(`DEMO_INIT:${initialized.error.code}`);
        const seededWorkspace = initialized.data;
        if (seededWorkspace.sourceInput === null || seededWorkspace.episode === null) {
          throw new Error('DEMO_INIT_INCOMPLETE');
        }

        // —— 私有 Mock 文本运行时：真实管线，确定性产物，零网络零凭据 ——
        const runtime = createDesktopScriptGenerationRuntime({
          clock: () => new Date().toISOString(),
          registry,
          textModel: new E2eScriptTextModelAdapter(null),
          unitOfWork: scriptUnitOfWork,
        });
        // 恢复完成后 onQueued 才会踢调度器：种子提交前必须 start。
        await runtime.start();
        try {
          let workspace = seededWorkspace;
          const sourceInputId = seededWorkspace.sourceInput.id;
          const episodeId = seededWorkspace.episode.id;
          const readyIds: Record<string, string> = {};
          const deadline = Date.now() + SEED_TIMEOUT_MS;
          for (const stage of STAGES) {
            const expectedInputVersionId =
              stage === 'CONCEPT'
                ? sourceInputId
                : stage === 'STORY_BIBLE'
                  ? readyIds.CONCEPT
                  : stage === 'EPISODE_OUTLINE'
                    ? readyIds.STORY_BIBLE
                    : stage === 'BEAT_SHEET'
                      ? readyIds.EPISODE_OUTLINE
                      : readyIds.BEAT_SHEET;
            if (expectedInputVersionId === undefined) throw new Error('DEMO_CHAIN_BROKEN');
            const job = await runtime.submission.submit(
              {
                episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : episodeId,
                expectedInputVersionId,
                idempotencyKey: `${requestId}_${stage}`,
                operationType: 'GENERATE',
                projectId,
                requestId: `${requestId}_${stage}_job`,
                stage,
              },
              traceId,
            );
            const outcome = await waitForJob(job.id, scriptUnitOfWork, deadline);
            if (outcome === 'FAILED') throw new Error(`DEMO_JOB_FAILED:${stage}`);
            const refreshed = await workspaceQuery.getWorkspace(projectId);
            if (refreshed === null) throw new Error('DEMO_WORKSPACE_MISSING');
            workspace = refreshed;
            const draft = workspace.stages.find((item) => item.stage === stage)?.current;
            if (draft?.status !== 'DRAFT') throw new Error(`DEMO_DRAFT_MISSING:${stage}`);
            const confirmed = await versions.confirmVersion(
              {
                episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : episodeId,
                expectedVersionId: draft.id,
                projectId,
                requestId: `${requestId}_${stage}_confirm`,
                stage,
                versionId: draft.id,
              },
              traceId,
            );
            if (!confirmed.ok) throw new Error(`DEMO_CONFIRM:${stage}:${confirmed.error.code}`);
            readyIds[stage] = confirmed.data.id;
          }

          // 分镜：与五阶段同管线（SHOT_CONTRACT 由同一提交/确认语义承载）。
          const sceneReadyId = readyIds.SCENE_SCRIPT;
          if (sceneReadyId === undefined) throw new Error('DEMO_CHAIN_BROKEN:SCENE_SCRIPT');
          const storyboardJob = await runtime.submission.submit(
            {
              episodeId: episodeId,
              expectedInputVersionId: sceneReadyId,
              idempotencyKey: `${requestId}_SHOT_CONTRACT`,
              operationType: 'GENERATE',
              projectId,
              requestId: `${requestId}_shot_job`,
              stage: 'SHOT_CONTRACT',
            },
            traceId,
          );
          if ((await waitForJob(storyboardJob.id, scriptUnitOfWork, deadline)) === 'FAILED') {
            throw new Error('DEMO_JOB_FAILED:SHOT_CONTRACT');
          }
          const afterStoryboard = await workspaceQuery.getWorkspace(projectId);
          if (afterStoryboard === null) throw new Error('DEMO_WORKSPACE_MISSING');
          const storyboardDraft = afterStoryboard.storyboard.current;
          if (storyboardDraft?.status !== 'DRAFT') throw new Error('DEMO_STORYBOARD_DRAFT_MISSING');
          const storyboardConfirmed = await storyboard.confirmStoryboard(
            {
              episodeId: episodeId,
              expectedVersionId: storyboardDraft.id,
              projectId,
              requestId: `${requestId}_shot_confirm`,
            },
            traceId,
          );
          if (!storyboardConfirmed.ok) {
            throw new Error(`DEMO_CONFIRM:SHOT_CONTRACT:${storyboardConfirmed.error.code}`);
          }
        } finally {
          void runtime.stop();
        }

        return {
          ok: true,
          data: {
            isDemo: true,
            projectId,
            resumed: false,
            summary: '示例剧本与分镜已就绪，接下来生成画面。',
          },
        };
      } catch (error) {
        await softDeleteDemo(projectUnitOfWork, created.projectId);
        const reason = error instanceof Error ? error.message : 'unknown';
        return failure(
          traceId,
          '示例创建未完成',
          `重试即可，不会留下半成品。(${reason.slice(0, 40)})`,
        );
      }
    },
  };
};
