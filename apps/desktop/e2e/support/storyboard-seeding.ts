import type { Page } from '@playwright/test';

export interface StoryboardSeedResult {
  readonly projectId: string;
  readonly shotCount: number;
  readonly shotId: string;
}

export interface ExistingScriptSeedInput {
  readonly authorizationSource: string | null;
  readonly authorizationStatement: string | null;
  readonly content: string;
  readonly creationMode: 'AI_OPTIMIZATION' | 'AUTHORIZED_ADAPTATION';
  readonly fileName: string | null;
  readonly inputKind: 'TXT' | 'MARKDOWN';
}

/**
 * 为已存在且分镜已就绪的 DEMO 项目生成可查询的图片、视频与时间线状态。
 * 全部操作只经过公开 Preload API，适用于开发构建与 packaged smoke。
 */
export const prepareDemoMediaTimeline = async (page: Page, projectId: string): Promise<void> => {
  await page.evaluate(async (pid) => {
    const waitForImageTask = async (taskId: string): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const task = await window.jingxu.image.getMediaTask({ projectId: pid, taskId });
        if (!task.ok) throw new Error(task.error.code);
        if (task.data.phase === 'COMPLETED') return;
        if (task.data.phase === 'FAILED' || task.data.phase === 'CANCELLED') {
          throw new Error(task.data.errorCode ?? task.data.phase);
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw new Error('DEMO_IMAGE_TASK_TIMEOUT');
    };

    const workspace = await window.jingxu.script.getWorkspace({ projectId: pid });
    if (!workspace.ok || workspace.data.storyboard.current === null) {
      throw new Error('DEMO_STORYBOARD_NOT_READY');
    }
    const shotIds = workspace.data.storyboard.shots.map((shot) => shot.shotId);
    for (const shotId of shotIds) {
      const generated = await window.jingxu.image.generateCandidates({
        projectId: pid,
        requestId: `visual_image_${crypto.randomUUID()}`,
        shotId,
      });
      if (!generated.ok) throw new Error(generated.error.code);
      await waitForImageTask(generated.data.id);
      const candidates = await window.jingxu.image.listCandidates({ projectId: pid, shotId });
      if (!candidates.ok) throw new Error(candidates.error.code);
      const candidate = candidates.data.find((item) => item.status === 'SUCCEEDED');
      if (candidate === undefined) throw new Error('DEMO_IMAGE_CANDIDATE_MISSING');
      const selected = await window.jingxu.image.selectCandidate({
        candidateId: candidate.id,
        projectId: pid,
        requestId: `visual_image_select_${crypto.randomUUID()}`,
      });
      if (!selected.ok) throw new Error(selected.error.code);
    }

    const videoBatch = await window.jingxu.video.generateVideosForShots({
      projectId: pid,
      requestId: `visual_video_batch_${crypto.randomUUID()}`,
      shotIds,
    });
    if (!videoBatch.ok) throw new Error(videoBatch.error.code);
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const state = await window.jingxu.video.listStoryboardVideoStates({ projectId: pid });
      if (!state.ok) throw new Error(state.error.code);
      const batch = state.data.batches.find((item) => item.batchId === videoBatch.data.batchId);
      if (batch?.status === 'COMPLETED') break;
      if (batch?.status === 'CANCELLED') throw new Error('DEMO_VIDEO_BATCH_CANCELLED');
      if (attempt === 239) throw new Error('DEMO_VIDEO_BATCH_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const shotId of shotIds) {
      const candidates = await window.jingxu.video.listVideoCandidates({
        projectId: pid,
        shotId,
      });
      if (!candidates.ok) throw new Error(candidates.error.code);
      const candidate = candidates.data.find((item) => item.status === 'SUCCEEDED');
      if (candidate === undefined) throw new Error('DEMO_VIDEO_CANDIDATE_MISSING');
      const selected = await window.jingxu.video.selectVideoCandidate({
        candidateId: candidate.id,
        projectId: pid,
        requestId: `visual_video_select_${crypto.randomUUID()}`,
      });
      if (!selected.ok) throw new Error(selected.error.code);
    }

    const timeline = await window.jingxu.video.createTimeline({
      episodeId: workspace.data.episode.id,
      expectedEpisodeVersionId: workspace.data.storyboard.current.id,
      projectId: pid,
      requestId: `visual_timeline_${crypto.randomUUID()}`,
    });
    if (!timeline.ok) throw new Error(timeline.error.code);
  }, projectId);
};

/**
 * 经 `window.jingxu` 真实 IPC 播种至整集分镜 READY（五阶段确认 + SHOT_CONTRACT
 * 生成确认）。供 dev E2E 与 packaged smoke 共用；只依赖 script/job/provider/project
 * 通道（v8 起即存在），不触碰 image 通道——旧构建也能执行同一播种。
 */
export const seedStoryboardReady = async (
  page: Page,
  projectName: string,
  existingInput?: ExistingScriptSeedInput,
  options?: {
    readonly consistencyAssets?: boolean;
    readonly imageProvider?: boolean;
    readonly videoProvider?: boolean;
  },
): Promise<StoryboardSeedResult> =>
  page.evaluate(
    async (input: {
      readonly existing: ExistingScriptSeedInput | null;
      readonly name: string;
      readonly options: {
        readonly consistencyAssets: boolean;
        readonly imageProvider: boolean;
        readonly videoProvider: boolean;
      } | null;
    }) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: input.existing?.creationMode ?? 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: input.name,
        requestId: requestId('project'),
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      });
      if (!created.ok) throw new Error(created.error.code);
      const projectId = created.data.id;
      const initialized =
        input.existing === null
          ? await window.jingxu.script.initializeOriginal({
              creativeText:
                '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客被偷走的记忆。',
              dataProcessingConsent: true,
              projectId,
              requestId: requestId('initialize'),
            })
          : await window.jingxu.script.initializeInput({
              authorizationSource: input.existing.authorizationSource,
              authorizationStatement: input.existing.authorizationStatement,
              content: input.existing.content,
              creationMode: input.existing.creationMode,
              dataProcessingConsent: true,
              fileName: input.existing.fileName,
              inputKind: input.existing.inputKind,
              projectId,
              requestId: requestId('initialize-input'),
            });
      if (!initialized.ok) throw new Error(initialized.error.code);
      let workspace = initialized.data;

      const configure = await window.jingxu.provider.getProfile({
        profileId: 'profile_qwen_primary',
      });
      if (!configure.ok) throw new Error(configure.error.code);
      const savedCredential = await window.jingxu.provider.saveCredential({
        apiKey: 'e2e-mock-key-not-a-real-secret',
        expectedVersionId: configure.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-key'),
      });
      if (!savedCredential.ok) throw new Error(savedCredential.error.code);
      const savedWorkspace = await window.jingxu.provider.saveProfile({
        enabled: true,
        expectedVersionId: savedCredential.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-profile'),
        workspaceId: 'jingxu-e2e',
      });
      if (!savedWorkspace.ok) throw new Error(savedWorkspace.error.code);
      const tested = await window.jingxu.provider.testCredential({
        expectedVersionId: savedWorkspace.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-test'),
      });
      if (!tested.ok) throw new Error(tested.error.code);

      // 仅由需要真实通过“生成前检查”的媒体 E2E 显式启用。保留默认关闭，
      // 让凭据缺失、阻断态及设置页测试仍能从未配置状态开始。
      if (input.options?.imageProvider === true) {
        const imageProfileId = 'profile-image-agnes-primary';
        const imageProfile = await window.jingxu.provider.getProfile({
          profileId: imageProfileId,
        });
        if (!imageProfile.ok) throw new Error(imageProfile.error.code);
        const imageCredential = await window.jingxu.provider.saveCredential({
          apiKey: 'e2e-image-key-not-a-real-secret',
          expectedVersionId: imageProfile.data.versionId,
          profileId: imageProfileId,
          requestId: requestId('image-provider-key'),
        });
        if (!imageCredential.ok) throw new Error(imageCredential.error.code);
        const imageTested = await window.jingxu.provider.testCredential({
          expectedVersionId: imageCredential.data.versionId,
          profileId: imageProfileId,
          requestId: requestId('image-provider-test'),
        });
        if (!imageTested.ok) throw new Error(imageTested.error.code);
      }

      if (input.options?.videoProvider === true) {
        const videoProfileId = 'profile-video-primary';
        const videoProfile = await window.jingxu.provider.getProfile({
          profileId: videoProfileId,
        });
        if (!videoProfile.ok) throw new Error(videoProfile.error.code);
        const videoCredential = await window.jingxu.provider.saveCredential({
          apiKey: 'e2e-video-key-not-a-real-secret',
          expectedVersionId: videoProfile.data.versionId,
          profileId: videoProfileId,
          requestId: requestId('video-provider-key'),
        });
        if (!videoCredential.ok) throw new Error(videoCredential.error.code);
        const videoTested = await window.jingxu.provider.testCredential({
          expectedVersionId: videoCredential.data.versionId,
          profileId: videoProfileId,
          requestId: requestId('video-provider-test'),
        });
        if (!videoTested.ok) throw new Error(videoTested.error.code);
      }

      const stages = [
        'CONCEPT',
        'STORY_BIBLE',
        'EPISODE_OUTLINE',
        'BEAT_SHEET',
        'SCENE_SCRIPT',
      ] as const;
      const readyIds: Record<string, string> = {};
      for (const stage of stages) {
        const expectedInputVersionId =
          stage === 'CONCEPT'
            ? workspace.source.id
            : stage === 'STORY_BIBLE'
              ? readyIds.CONCEPT
              : stage === 'EPISODE_OUTLINE'
                ? readyIds.STORY_BIBLE
                : stage === 'BEAT_SHEET'
                  ? readyIds.EPISODE_OUTLINE
                  : readyIds.BEAT_SHEET;
        if (expectedInputVersionId === undefined) throw new Error(`missing-input-${stage}`);
        const queued = await window.jingxu.job.create({
          episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
          expectedInputVersionId,
          idempotencyKey: requestId(`idem-${stage}`),
          operationType: 'GENERATE',
          projectId,
          requestId: requestId(`job-${stage}`),
          stage,
        });
        if (!queued.ok) throw new Error(`${stage}:${queued.error.code}`);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const status = await window.jingxu.job.get({ jobId: queued.data.id });
          if (!status.ok) throw new Error(status.error.code);
          if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
            throw new Error(`${stage}:${status.data.errorCode ?? status.data.status}`);
          }
          if (status.data.status === 'SUCCEEDED') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const refreshed = await window.jingxu.script.getWorkspace({ projectId });
        if (!refreshed.ok) throw new Error(refreshed.error.code);
        workspace = refreshed.data;
        const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
        if (draft?.status !== 'DRAFT') throw new Error(`${stage}:missing-draft`);
        const confirmed = await window.jingxu.script.confirmVersion({
          episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
          expectedVersionId: draft.id,
          projectId,
          requestId: requestId(`confirm-${stage}`),
          stage,
          versionId: draft.id,
        });
        if (!confirmed.ok) throw new Error(`${stage}:${confirmed.error.code}`);
        readyIds[stage] = confirmed.data.id;
        const afterConfirm = await window.jingxu.script.getWorkspace({ projectId });
        if (!afterConfirm.ok) throw new Error(afterConfirm.error.code);
        workspace = afterConfirm.data;
      }

      const sceneReadyId = readyIds.SCENE_SCRIPT;
      if (sceneReadyId === undefined) throw new Error('missing-input-SHOT_CONTRACT');
      const shotJob = await window.jingxu.job.create({
        episodeId: workspace.episode.id,
        expectedInputVersionId: sceneReadyId,
        idempotencyKey: requestId('idem-shot-contract'),
        operationType: 'GENERATE',
        projectId,
        requestId: requestId('job-shot-contract'),
        stage: 'SHOT_CONTRACT',
      });
      if (!shotJob.ok) throw new Error(`shot:${shotJob.error.code}`);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await window.jingxu.job.get({ jobId: shotJob.data.id });
        if (!status.ok) throw new Error(status.error.code);
        if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
          throw new Error(`shot:${status.data.errorCode ?? status.data.status}`);
        }
        if (status.data.status === 'SUCCEEDED') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const afterGenerate = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterGenerate.ok) throw new Error(afterGenerate.error.code);
      const draftStoryboard = afterGenerate.data.storyboard;
      if (draftStoryboard.current?.status !== 'DRAFT') throw new Error('shot:missing-draft-set');
      const shotConfirmed = await window.jingxu.script.confirmVersion({
        episodeId: workspace.episode.id,
        expectedVersionId: draftStoryboard.current.id,
        projectId,
        requestId: requestId('confirm-shot-contract'),
        stage: 'SHOT_CONTRACT',
        versionId: draftStoryboard.current.id,
      });
      if (!shotConfirmed.ok) throw new Error(`shot:${shotConfirmed.error.code}`);
      const afterReady = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterReady.ok) throw new Error(afterReady.error.code);
      if (afterReady.data.storyboard.current?.status !== 'READY') {
        throw new Error('shot:missing-ready');
      }
      const firstShot = afterReady.data.storyboard.shots[0];
      if (firstShot === undefined) throw new Error('shot:missing-shots');

      // 一致性门禁（enforce-character-style-consistency）：为整集生成补齐
      // STYLE 画风锚点与全部出场角色参考图；可经 options.consistencyAssets 关闭
      // 以复现阻断态。沿用 image 上传通道，风格与真实 UI 上传一致。
      if (input.options?.consistencyAssets ?? true) {
        const characterIds = new Set<string>();
        for (const shot of afterReady.data.storyboard.shots) {
          const ids = (shot.document as { content?: { character_ids?: unknown } }).content
            ?.character_ids;
          if (Array.isArray(ids)) {
            for (const id of ids) {
              if (typeof id === 'string' && id.length > 0) characterIds.add(id);
            }
          }
        }
        const styleUpload = await window.jingxu.image.uploadAssetReference({
          assetType: 'STYLE',
          bibleRefId: 'project-style',
          byteSize: 3,
          bytes: new Uint8Array([1, 2, 3]),
          description: 'E2E 画风锚点：冷青水墨风',
          displayName: '项目画风',
          mimeType: 'image/png',
          projectId,
          requestId: requestId('asset-style'),
        });
        if (!styleUpload.ok) throw new Error(`style-asset:${styleUpload.error.code}`);
        for (const characterId of characterIds) {
          const upload = await window.jingxu.image.uploadAssetReference({
            assetType: 'CHARACTER',
            bibleRefId: characterId,
            byteSize: 3,
            bytes: new Uint8Array([1, 2, 3]),
            description: null,
            displayName: characterId,
            mimeType: 'image/png',
            projectId,
            requestId: requestId(`asset-${characterId}`),
          });
          if (!upload.ok) throw new Error(`char-asset:${characterId}:${upload.error.code}`);
        }
      }

      return {
        projectId,
        shotCount: afterReady.data.storyboard.shots.length,
        shotId: firstShot.shotId,
      };
    },
    {
      existing: existingInput ?? null,
      name: projectName,
      options:
        options === undefined
          ? null
          : {
              consistencyAssets: options.consistencyAssets ?? true,
              imageProvider: options.imageProvider ?? false,
              videoProvider: options.videoProvider ?? false,
            },
    },
  );
