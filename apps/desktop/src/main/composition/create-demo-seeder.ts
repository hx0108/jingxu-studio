import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
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
import { PROJECT_STYLE_BIBLE_REF_ID } from '@jingxu/contracts';
import { createFormatProfileSpec } from '@jingxu/domain';
import { createContentAddressedStore } from '@jingxu/persistence';
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

const demoStoryboardCandidate = (): Readonly<Record<string, unknown>> => {
  const shots = [
    {
      characters: ['char_acheng'],
      purpose: '灯塔广播响起，阿澄在灯室发现旧信',
      scene: 'scene_lighthouse',
    },
    { characters: ['char_acheng'], purpose: '阿澄握紧旧信冲入风暴', scene: 'scene_lighthouse' },
    { characters: [], purpose: '雨中的离岛码头与即将收起的跳板', scene: 'scene_pier' },
    {
      characters: ['char_acheng', 'char_zhouye'],
      purpose: '阿澄高举提灯呼喊周野',
      scene: 'scene_pier',
    },
    {
      characters: ['char_acheng', 'char_zhouye'],
      purpose: '周野回身接住迟到十年的信',
      scene: 'scene_pier',
    },
    { characters: [], purpose: '渡船离岛，熄灭的灯塔最后亮起', scene: 'scene_pier' },
  ] as const;
  return {
    shots: shots.map(({ characters, purpose, scene }, index) => ({
      acceptance: { must_include: ['风暴海岛与暖色提灯'], must_not_include: ['文字水印'] },
      cinematography: {
        camera_angle: 'EYE_LEVEL',
        camera_motion: index % 2 === 0 ? 'STATIC' : 'DOLLY',
        composition: '竖屏中景，主体清晰',
        focus: '人物与提灯清晰',
        frontal_face: characters.length > 0,
        mouth_visible: index === 3 || index === 4,
        shot_size: index === 2 || index === 5 ? 'LONG' : 'MEDIUM',
      },
      content: {
        action: `镜 ${String(index + 1)}：${purpose}`,
        character_ids: characters,
        emotion: index >= 4 ? '释然' : '急切',
        prop_ids: index === 0 || index === 4 ? ['prop_letter'] : ['prop_lantern'],
        scene_id: scene,
        spoken_text:
          index === 3
            ? '这封信晚了十年，但我不想让它再错过今晚。'
            : index === 4
              ? '有些信，只要抵达就不算太晚。'
              : '',
      },
      continuity: {
        continuity_mode: index === 1 || index === 4 ? 'CONTINUOUS_ACTION' : 'SCENE_CHANGE',
        first_frame_requirement: `${purpose}起帧`,
        last_frame_requirement: `${purpose}止帧`,
        previous_shot_id: null,
      },
      dialogue: {
        dialogue_render_mode: 'NARRATION_FIRST',
        estimated_speech_duration_sec: index === 3 || index === 4 ? 4 : 0,
        speaker_id: index === 3 ? 'char_acheng' : index === 4 ? 'char_zhouye' : null,
      },
      generation_constraints: {
        capability_requirements: [{ capability: 'FIRST_FRAME', required: true }],
        image_prompt: '温暖手绘二维漫剧，青蓝风暴夜，琥珀提灯，竖屏构图',
        negative_constraints: ['文字水印'],
        video_prompt: '风雨与衣摆自然运动，镜头稳定推进',
      },
      narrative_purpose: purpose,
      target_duration_sec: 10,
    })),
  };
};

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
const resolveDemoRoot = (configuredRoot?: string): string => {
  if (configuredRoot !== undefined) return configuredRoot;
  const electronResourcesPath = Reflect.get(process, 'resourcesPath');
  const packagedRoot =
    typeof electronResourcesPath === 'string' ? path.join(electronResourcesPath, 'demo') : null;
  // 开发态 Electron 同样有 resourcesPath，但它指向 Electron 自身资源；仅当 demo 已随包复制才采用。
  if (packagedRoot !== null && existsSync(packagedRoot)) return packagedRoot;
  // Vitest 直接执行 src/main/composition 时前者成立；Vite 产物位于 .vite/build 时，
  // 后者才指向 apps/desktop/resources/demo。两者均只允许应用内固定资源路径。
  const sourceRoot = path.resolve(import.meta.dirname, '../../../resources/demo');
  if (existsSync(sourceRoot)) return sourceRoot;
  return path.resolve(import.meta.dirname, '../../resources/demo');
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
 * 失败补偿：任一步骤失败即通过受限持久层入口沿外键图清除新演示项目及全部后代，
 * 不进入回收站；同一 requestId 可安全重新种子。
 */
export const createDemoSeeder = (options: {
  readonly demoResourceRoot?: string;
  readonly managedRoot: string;
  readonly onProgress?:
    | ((
        event: 'PROJECT_CREATED' | `STAGE_READY:${(typeof STAGES)[number]}` | 'STORYBOARD_READY',
      ) => Promise<void>)
    | undefined;
  readonly persistenceRuntime: DesktopPersistenceRuntime;
}): CreatorDemoSeederPort => {
  const { managedRoot, persistenceRuntime } = options;

  /** 只清除本次新建演示项目的受管文件夹，绝不接受 Renderer 路径。 */
  const discardCreatedDemo = async (projectId: string): Promise<void> => {
    await persistenceRuntime.discardIncompleteDemoProject(projectId);
    const projectsRoot = path.resolve(managedRoot, 'projects');
    const projectRoot = path.resolve(projectsRoot, projectId);
    if (!projectRoot.startsWith(`${projectsRoot}${path.sep}`)) {
      throw new Error('DEMO_PROJECT_PATH_OUTSIDE_MANAGED_ROOT');
    }
    await rm(projectRoot, { force: true, recursive: true });
    demoProjectRegistry.remove(projectId);
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
      const mediaUnitOfWork = persistenceRuntime.getMediaUnitOfWork();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (
        projectUnitOfWork === null ||
        scriptUnitOfWork === null ||
        mediaUnitOfWork === null ||
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

      demoProjectRegistry.add(created.projectId);
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
      let fixtureCandidates: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
      let referenceFixtures: readonly {
        readonly assetType: 'STYLE' | 'CHARACTER';
        readonly bibleRefId: string;
        readonly bytes: Uint8Array;
        readonly description: string;
        readonly displayName: string;
      }[];
      try {
        const demoRoot = resolveDemoRoot(options.demoResourceRoot);
        const [manifestBytes, storyBytes, styleBytes, achengBytes, zhouyeBytes] = await Promise.all(
          [
            readFile(path.join(demoRoot, 'demo-manifest.json'), 'utf8'),
            readFile(path.join(demoRoot, 'demo-story.json'), 'utf8'),
            readFile(path.join(demoRoot, 'style-reference.png')),
            readFile(path.join(demoRoot, 'character-acheng.png')),
            readFile(path.join(demoRoot, 'character-zhouye.png')),
          ],
        );
        const manifest = JSON.parse(manifestBytes) as { readonly files: Record<string, string> };
        for (const [name, bytes] of [
          ['demo-story.json', Buffer.from(storyBytes)],
          ['style-reference.png', styleBytes],
          ['character-acheng.png', achengBytes],
          ['character-zhouye.png', zhouyeBytes],
        ] as const) {
          const expected = manifest.files[name];
          if (
            expected === undefined ||
            createHash('sha256').update(bytes).digest('hex') !== expected
          ) {
            throw new Error('DEMO_FIXTURE_HASH_MISMATCH');
          }
        }
        const story = JSON.parse(storyBytes) as DemoStoryFixture;
        fixtureCandidates = new Map(story.stages.map((stage) => [stage.stage, stage.data]));
        const synopsisStage = story.stages.find((stage) => stage.stage === 'CONCEPT');
        const synopsis = synopsisStage?.data.synopsis;
        creativeText =
          typeof synopsis === 'string' ? synopsis : '一名守塔少女在风暴夜送出一封迟到了十年的信。';
        referenceFixtures = [
          {
            assetType: 'STYLE',
            bibleRefId: PROJECT_STYLE_BIBLE_REF_ID,
            bytes: styleBytes,
            description: '温暖手绘二维漫剧，青蓝风暴夜与琥珀灯光形成冷暖对比。',
            displayName: '示例画风',
          },
          {
            assetType: 'CHARACTER',
            bibleRefId: 'char_acheng',
            bytes: achengBytes,
            description: '阿澄标准角色参考图：短黑发、黄色旧雨衣、铜制提灯。',
            displayName: '阿澄',
          },
          {
            assetType: 'CHARACTER',
            bibleRefId: 'char_zhouye',
            bytes: zhouyeBytes,
            description: '周野标准角色参考图：深蓝邮差外套、旧帆布邮包。',
            displayName: '周野',
          },
        ];
      } catch {
        await discardCreatedDemo(created.projectId);
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
        await options.onProgress?.('PROJECT_CREATED');
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
          textModel: new E2eScriptTextModelAdapter(null, (stage) => {
            if (stage === 'SHOT_CONTRACT') return demoStoryboardCandidate();
            const fixture = fixtureCandidates.get(stage);
            if (fixture === undefined) throw new Error(`DEMO_STAGE_FIXTURE_MISSING:${stage}`);
            return fixture;
          }),
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
            await options.onProgress?.(`STAGE_READY:${stage}`);
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
          await options.onProgress?.('STORYBOARD_READY');

          // 参考资产先进入 CAS，再在一个媒体事务内登记；体验项目无需用户另行上传。
          const store = createContentAddressedStore(managedRoot);
          const storedReferences = await Promise.all(
            referenceFixtures.map(async (reference) => ({
              ...reference,
              stored: await store.write({
                bytes: reference.bytes,
                mimeType: 'image/png',
                namespace: 'assets',
                projectId,
              }),
            })),
          );
          await mediaUnitOfWork.run(async ({ media }) => {
            for (const reference of storedReferences) {
              const existing = await media.findAssetByIdentity(
                projectId,
                reference.assetType,
                reference.bibleRefId,
              );
              const asset =
                existing ??
                (await media.createAsset({
                  assetType: reference.assetType,
                  bibleRefId: reference.bibleRefId,
                  displayName: reference.displayName,
                  id: `asset_demo_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
                  projectId,
                }));
              if (existing === null) {
                await media.appendAssetVersion({
                  assetId: asset.id,
                  byteSize: reference.stored.byteSize,
                  description: reference.description,
                  fileSha256: reference.stored.sha256,
                  height: null,
                  id: `assetv_demo_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
                  mimeType: reference.stored.mimeType,
                  width: null,
                });
              }
            }
          });
        } finally {
          await runtime.stop();
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
      } catch {
        await discardCreatedDemo(created.projectId);
        return failure(traceId, '示例创建未完成', '重试即可，不会留下可见的半成品。');
      }
    },
  };
};
