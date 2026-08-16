import type { Page } from '@playwright/test';

export interface StoryboardSeedResult {
  readonly projectId: string;
  readonly shotCount: number;
  readonly shotId: string;
}

/**
 * 经 `window.jingxu` 真实 IPC 播种至整集分镜 READY（五阶段确认 + SHOT_CONTRACT
 * 生成确认）。供 dev E2E 与 packaged smoke 共用；只依赖 script/job/provider/project
 * 通道（v8 起即存在），不触碰 image 通道——旧构建也能执行同一播种。
 */
export const seedStoryboardReady = async (
  page: Page,
  projectName: string,
): Promise<StoryboardSeedResult> =>
  page.evaluate(async (name: string) => {
    const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
    const created = await window.jingxu.project.create({
      aspectRatio: '9:16',
      creationMode: 'AI_ORIGINAL',
      dialogueRenderMode: 'NARRATION_FIRST',
      genre: '悬疑',
      name,
      requestId: requestId('project'),
      style: '二维漫剧',
      subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    });
    if (!created.ok) throw new Error(created.error.code);
    const projectId = created.data.id;
    const initialized = await window.jingxu.script.initializeOriginal({
      creativeText: '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客记忆的人。',
      dataProcessingConsent: true,
      projectId,
      requestId: requestId('initialize'),
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
    return {
      projectId,
      shotCount: afterReady.data.storyboard.shots.length,
      shotId: firstShot.shotId,
    };
  }, projectName);
