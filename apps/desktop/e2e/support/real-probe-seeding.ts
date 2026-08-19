import type { Page } from '@playwright/test';

/** 真实联调播种失败：step 命名首个失败环节，stageResults 携带逐阶段取证。 */
export interface RealProbeSeedFailure {
  readonly errorCode: string | null;
  readonly stageResults: unknown[];
  readonly step: string;
}

/** 真实联调播种成功：整集分镜 READY，shotIds 按分镜顺序排列。 */
export interface RealProbeSeedSuccess {
  readonly jobIds: string[];
  readonly projectId: string;
  readonly readyStatus: string | null;
  readonly shotCount: number;
  readonly shotIds: string[];
  readonly stageResults: unknown[];
}

export type RealProbeSeedResult = RealProbeSeedFailure | RealProbeSeedSuccess;

export interface RealProbeSeedInput {
  readonly apiKey: string;
  readonly projectName: string;
  /** JINGXU_REAL_REFRESH_CREDENTIAL=1：进程内重存文本凭据（safeStorage 随 userData 隔离的规避）。 */
  readonly refreshCredential: boolean;
  readonly workspaceId: string;
}

/**
 * 真实凭据播种至整集分镜 READY：真实 Qwen 五阶段确认 + SHOT_CONTRACT 生成确认
 * （失败作业不写版本、输入未变 → 同项目重提交，SHOT_CONTRACT 至多 3 次）。与
 * real-qwen/real-seedream 探针内联逻辑同源；抽此共享供后续真实探针复用
 * （两个旧探针暂保留各自内联副本，待下次触碰时迁移）。
 */
export const seedRealStoryboardReady = async (
  page: Page,
  input: RealProbeSeedInput,
): Promise<RealProbeSeedResult> =>
  page.evaluate(async (seed: RealProbeSeedInput) => {
    const stages = [
      'CONCEPT',
      'STORY_BIBLE',
      'EPISODE_OUTLINE',
      'BEAT_SHEET',
      'SCENE_SCRIPT',
    ] as const;
    const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
    const created = await window.jingxu.project.create({
      aspectRatio: '9:16',
      creationMode: 'AI_ORIGINAL',
      dialogueRenderMode: 'NARRATION_FIRST',
      genre: '悬疑',
      name: seed.projectName,
      requestId: requestId('project'),
      style: '二维漫剧',
      subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
    });
    if (!created.ok)
      return { errorCode: created.error.code, stageResults: [], step: 'project.create' };
    const projectId = created.data.id;
    const initialized = await window.jingxu.script.initializeOriginal({
      creativeText: '一名失忆侦探在午夜列车醒来，必须在终点前找出偷走所有乘客记忆的人。',
      dataProcessingConsent: true,
      projectId,
      requestId: requestId('initialize'),
    });
    if (!initialized.ok) {
      return {
        errorCode: initialized.error.code,
        stageResults: [],
        step: 'script.initializeOriginal',
      };
    }
    let workspace = initialized.data;
    const profile = await window.jingxu.provider.getProfile({
      profileId: 'profile_qwen_primary',
    });
    if (!profile.ok) {
      return { errorCode: profile.error.code, stageResults: [], step: 'provider.getProfile' };
    }
    if (!profile.data.configured || seed.refreshCredential) {
      const savedCredential = await window.jingxu.provider.saveCredential({
        apiKey: seed.apiKey,
        expectedVersionId: profile.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-key'),
      });
      if (!savedCredential.ok) {
        return {
          errorCode: savedCredential.error.code,
          stageResults: [],
          step: 'provider.saveCredential',
        };
      }
      const savedWorkspace = await window.jingxu.provider.saveProfile({
        enabled: true,
        expectedVersionId: savedCredential.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-profile'),
        workspaceId: seed.workspaceId,
      });
      if (!savedWorkspace.ok) {
        return {
          errorCode: savedWorkspace.error.code,
          stageResults: [],
          step: 'provider.saveProfile',
        };
      }
      const tested = await window.jingxu.provider.testCredential({
        expectedVersionId: savedWorkspace.data.versionId,
        profileId: 'profile_qwen_primary',
        requestId: requestId('provider-test'),
      });
      if (!tested.ok) {
        return {
          errorCode: tested.error.code,
          stageResults: [],
          step: 'provider.testCredential',
        };
      }
    }

    const readyIds: Record<string, string> = {};
    const jobIds: string[] = [];
    const stageResults: unknown[] = [];
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
      if (expectedInputVersionId === undefined) {
        stageResults.push({ stage, error: 'missing-input' });
        break;
      }
      const queued = await window.jingxu.job.create({
        episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
        expectedInputVersionId,
        idempotencyKey: requestId(`idem-${stage}`),
        operationType: 'GENERATE',
        projectId,
        requestId: requestId(`job-${stage}`),
        stage,
      });
      if (!queued.ok) {
        stageResults.push({ stage, errorCode: queued.error.code });
        break;
      }
      jobIds.push(queued.data.id);
      let finalStatus = 'TIMEOUT_POLL';
      let errorCode: string | undefined;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = await window.jingxu.job.get({ jobId: queued.data.id });
        if (!status.ok) {
          finalStatus = `job.get:${status.error.code}`;
          break;
        }
        if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
          finalStatus = status.data.status;
          errorCode = status.data.errorCode ?? undefined;
          break;
        }
        if (status.data.status === 'SUCCEEDED') {
          finalStatus = status.data.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const refreshed = await window.jingxu.script.getWorkspace({ projectId });
      if (!refreshed.ok) {
        stageResults.push({ stage, finalStatus, errorCode, error: refreshed.error.code });
        break;
      }
      workspace = refreshed.data;
      const draft = workspace.stages.find((candidate) => candidate.stage === stage)?.current;
      stageResults.push({
        stage,
        finalStatus,
        errorCode,
        draftStatus: draft?.status ?? null,
      });
      if (finalStatus !== 'SUCCEEDED' || draft?.status !== 'DRAFT') break;
      const confirmed = await window.jingxu.script.confirmVersion({
        episodeId: stage === 'CONCEPT' || stage === 'STORY_BIBLE' ? null : workspace.episode.id,
        expectedVersionId: draft.id,
        projectId,
        requestId: requestId(`confirm-${stage}`),
        stage,
        versionId: draft.id,
      });
      if (!confirmed.ok) {
        stageResults.push({ stage, error: `confirm:${confirmed.error.code}` });
        break;
      }
      readyIds[stage] = confirmed.data.id;
      const afterConfirm = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterConfirm.ok) break;
      workspace = afterConfirm.data;
    }

    const sceneReadyId = readyIds.SCENE_SCRIPT;
    if (sceneReadyId === undefined) {
      return {
        errorCode: 'SCENE_SCRIPT_NOT_READY',
        stageResults,
        step: 'seed-stages',
      };
    }
    // SHOT_CONTRACT 是最重阶段，120s 调用上限在真实网络下高频超时/偶发契约校验失败
    // （2026-08-17 联调实录）；失败作业不写版本，输入未变 → 同一项目内重新提交即可。
    let shotStatus = 'TIMEOUT_POLL';
    let shotError: string | undefined;
    for (let shotAttempt = 0; shotAttempt < 3 && shotStatus !== 'SUCCEEDED'; shotAttempt++) {
      const queuedShot = await window.jingxu.job.create({
        episodeId: workspace.episode.id,
        expectedInputVersionId: sceneReadyId,
        idempotencyKey: requestId(`idem-shot-contract-${String(shotAttempt)}`),
        operationType: 'GENERATE',
        projectId,
        requestId: requestId(`job-shot-contract-${String(shotAttempt)}`),
        stage: 'SHOT_CONTRACT',
      });
      if (!queuedShot.ok) {
        return {
          errorCode: queuedShot.error.code,
          stageResults,
          step: 'job.create-shot',
        };
      }
      jobIds.push(queuedShot.data.id);
      shotStatus = 'TIMEOUT_POLL';
      shotError = undefined;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const status = await window.jingxu.job.get({ jobId: queuedShot.data.id });
        if (!status.ok) {
          shotStatus = `job.get:${status.error.code}`;
          break;
        }
        if (status.data.status === 'FAILED' || status.data.status === 'CANCELLED') {
          shotStatus = status.data.status;
          shotError = status.data.errorCode ?? undefined;
          break;
        }
        if (status.data.status === 'SUCCEEDED') {
          shotStatus = status.data.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    const shotWorkspace = await window.jingxu.script.getWorkspace({ projectId });
    const storyboard = shotWorkspace.ok ? shotWorkspace.data.storyboard : null;
    stageResults.push({
      stage: 'SHOT_CONTRACT',
      draftStatus: storyboard?.current?.status ?? null,
      errorCode: shotError,
      finalStatus: shotStatus,
      shotCount: storyboard?.shots.length ?? null,
    });
    if (shotStatus !== 'SUCCEEDED' || storyboard?.current?.status !== 'DRAFT') {
      return { errorCode: shotError ?? shotStatus, stageResults, step: 'seed-shot' };
    }
    const confirmedShot = await window.jingxu.script.confirmVersion({
      episodeId: workspace.episode.id,
      expectedVersionId: storyboard.current.id,
      projectId,
      requestId: requestId('confirm-shot-contract'),
      stage: 'SHOT_CONTRACT',
      versionId: storyboard.current.id,
    });
    if (!confirmedShot.ok) {
      return { errorCode: confirmedShot.error.code, stageResults, step: 'confirm-shot' };
    }
    const afterShot = await window.jingxu.script.getWorkspace({ projectId });
    return {
      jobIds,
      projectId,
      readyStatus: afterShot.ok ? (afterShot.data.storyboard.current?.status ?? null) : null,
      shotCount: afterShot.ok ? afterShot.data.storyboard.shots.length : 0,
      shotIds: afterShot.ok ? afterShot.data.storyboard.shots.map((shot) => shot.shotId) : [],
      stageResults,
    };
  }, input);
