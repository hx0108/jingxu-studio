import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');
const stages = ['CONCEPT', 'STORY_BIBLE', 'EPISODE_OUTLINE', 'BEAT_SHEET', 'SCENE_SCRIPT'] as const;

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launch = async (managedRoot: string): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
    },
  });

test('AI 原创五阶段闭环—DRAFT/READY、编辑恢复及上游 STALE_INPUT 均来自持久化事实', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-script-loop-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async (orderedStages) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '五阶段闭环',
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

      const readyIds: Record<string, string> = {};
      for (const stage of orderedStages) {
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

      const scene = workspace.stages.find((item) => item.stage === 'SCENE_SCRIPT')?.current;
      if (scene === null || scene === undefined) throw new Error('missing-scene');
      const saved = await window.jingxu.script.saveDraft({
        data: scene.document.data,
        episodeId: workspace.episode.id,
        expectedVersionId: scene.id,
        projectId,
        requestId: requestId('save-scene'),
        stage: 'SCENE_SCRIPT',
      });
      if (!saved.ok) throw new Error(saved.error.code);
      const restored = await window.jingxu.script.restoreVersion({
        episodeId: workspace.episode.id,
        expectedVersionId: saved.data.id,
        projectId,
        requestId: requestId('restore-scene'),
        stage: 'SCENE_SCRIPT',
        versionId: scene.id,
      });
      if (!restored.ok) throw new Error(restored.error.code);

      const concept = workspace.stages.find((item) => item.stage === 'CONCEPT')?.current;
      if (concept === null || concept === undefined) throw new Error('missing-concept');
      const conceptDraft = await window.jingxu.script.saveDraft({
        data: concept.document.data,
        episodeId: null,
        expectedVersionId: concept.id,
        projectId,
        requestId: requestId('save-concept'),
        stage: 'CONCEPT',
      });
      if (!conceptDraft.ok) throw new Error(conceptDraft.error.code);
      const reconfirmed = await window.jingxu.script.confirmVersion({
        episodeId: null,
        expectedVersionId: conceptDraft.data.id,
        projectId,
        requestId: requestId('reconfirm-concept'),
        stage: 'CONCEPT',
        versionId: conceptDraft.data.id,
      });
      if (!reconfirmed.ok) throw new Error(reconfirmed.error.code);
      const finalWorkspace = await window.jingxu.script.getWorkspace({ projectId });
      if (!finalWorkspace.ok) throw new Error(finalWorkspace.error.code);
      return {
        finalStatuses: Object.fromEntries(
          finalWorkspace.data.stages.map((item) => [item.stage, item.current?.status ?? null]),
        ),
        restoredParent: restored.data.parentId,
        savedId: saved.data.id,
      };
    }, stages);

    expect(result.restoredParent).toBe(result.savedId);
    expect(result.finalStatuses).toMatchObject({
      BEAT_SHEET: 'STALE_INPUT',
      EPISODE_OUTLINE: 'STALE_INPUT',
      SCENE_SCRIPT: 'STALE_INPUT',
      STORY_BIBLE: 'STALE_INPUT',
    });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('分镜整集闭环—生成 DRAFT/确认 READY/上游再确认整集 STALE/恢复历史集合（§6.1）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-storyboard-loop-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async (orderedStages) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '分镜闭环',
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

      const readyIds: Record<string, string> = {};
      for (const stage of orderedStages) {
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

      // 1) 生成整集分镜：DRAFT episode_version + 6 镜头（E2E mock：6 × 15s = 90s）。
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

      // 2) 确认整集：READY episode_version，shot_set_hash 对 READY 镜头集合重算。
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
      const readyStoryboard = afterReady.data.storyboard;
      const readyEntry = readyStoryboard.history.find((entry) => entry.status === 'READY');
      if (readyEntry === undefined) throw new Error('shot:missing-ready-history');

      // 3) 上游 SCENE_SCRIPT 再确认：整集只插一行 STALE_INPUT，镜头快照沿用。
      const scene = afterReady.data.stages.find((item) => item.stage === 'SCENE_SCRIPT')?.current;
      if (scene === null || scene === undefined) throw new Error('missing-scene');
      const sceneDraft = await window.jingxu.script.saveDraft({
        data: scene.document.data,
        episodeId: workspace.episode.id,
        expectedVersionId: scene.id,
        projectId,
        requestId: requestId('save-scene-stale'),
        stage: 'SCENE_SCRIPT',
      });
      if (!sceneDraft.ok) throw new Error(sceneDraft.error.code);
      const sceneReconfirmed = await window.jingxu.script.confirmVersion({
        episodeId: workspace.episode.id,
        expectedVersionId: sceneDraft.data.id,
        projectId,
        requestId: requestId('reconfirm-scene-stale'),
        stage: 'SCENE_SCRIPT',
        versionId: sceneDraft.data.id,
      });
      if (!sceneReconfirmed.ok) throw new Error(sceneReconfirmed.error.code);
      const afterStale = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterStale.ok) throw new Error(afterStale.error.code);
      const staleStoryboard = afterStale.data.storyboard;
      if (staleStoryboard.current === null) throw new Error('shot:missing-stale-head');

      // 4) 恢复历史 READY 集合：新 DRAFT 整集。
      const restored = await window.jingxu.script.restoreVersion({
        episodeId: workspace.episode.id,
        expectedVersionId: staleStoryboard.current.id,
        projectId,
        requestId: requestId('restore-shot-contract'),
        stage: 'SHOT_CONTRACT',
        versionId: readyEntry.id,
      });
      if (!restored.ok) throw new Error(`shot:${restored.error.code}`);
      const afterRestore = await window.jingxu.script.getWorkspace({ projectId });
      if (!afterRestore.ok) throw new Error(afterRestore.error.code);

      return {
        draftShots: draftStoryboard.shots.map((shot) => shot.shotId),
        draftShotSetHash: draftStoryboard.current.shotSetHash,
        draftStatus: draftStoryboard.current.status,
        readyShotSetHash: readyStoryboard.current?.shotSetHash ?? null,
        readyShotIds: readyStoryboard.shots.map((shot) => shot.shotId),
        readyStatus: readyStoryboard.current?.status ?? null,
        restoredShotIds: afterRestore.data.storyboard.shots.map((shot) => shot.shotId),
        restoredStatus: afterRestore.data.storyboard.current?.status ?? null,
        staleShotIds: staleStoryboard.shots.map((shot) => shot.shotId),
        staleStatus: staleStoryboard.current.status,
        totalDurationSec: draftStoryboard.totalDurationSec,
      };
    }, stages);

    expect(result.draftStatus).toBe('DRAFT');
    expect(result.draftShots).toHaveLength(6);
    expect(result.totalDurationSec).toBe(90);
    expect(result.readyStatus).toBe('READY');
    // 确认后集合哈希对 READY 镜头版本重算，与 DRAFT 集合不同。
    expect(result.readyShotSetHash).not.toBe(result.draftShotSetHash);
    // 上游再确认：整集 STALE 且快照沿用（同一批镜头 id）。
    expect(result.staleStatus).toBe('STALE_INPUT');
    expect(result.staleShotIds).toEqual(result.readyShotIds);
    // 恢复历史集合：回到 DRAFT，镜头集合一致。
    expect(result.restoredStatus).toBe('DRAFT');
    expect(result.restoredShotIds).toEqual(result.readyShotIds);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('dirty 离开取消与 Script 白名单—不丢输入且不暴露通用 IPC', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-script-safety-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创建第一个项目' }).click();
    await page.getByLabel('项目名称').fill('剧本安全路径');
    await page.getByRole('button', { name: '保存项目' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    const initializeButton = page.getByRole('button', { name: '创建剧本工作区' });
    await expect(initializeButton).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('还需输入 20 个 Unicode 字符');
    await page
      .getByLabel('创意内容')
      .fill('这是一段用于验证刷新、取消和离开保护的原创漫剧创意，长度满足产品边界。');
    await page.getByRole('checkbox').check();
    await expect(initializeButton).toBeEnabled();
    await page.getByRole('button', { name: '我的项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByLabel('创意内容')).toHaveValue(/刷新、取消和离开保护/u);

    const scriptSurface = await page.evaluate(() => {
      const api = window.jingxu.script as unknown as Record<string, unknown>;
      return {
        frozen: Object.isFrozen(api),
        generic: ['send', 'on', 'invoke'].some((key) => Reflect.has(api, key)),
        keys: Object.keys(api).sort(),
      };
    });
    expect(scriptSurface).toEqual({
      frozen: true,
      generic: false,
      keys: [
        'confirmVersion',
        'getWorkspace',
        'importInput',
        'initializeInput',
        'initializeOriginal',
        'listLocks',
        'lockPath',
        'restoreVersion',
        'rewriteSelection',
        'saveDraft',
      ],
    });
    await page.getByRole('button', { name: '我的项目', exact: true }).click();
    const leaveDialog = page.getByRole('dialog');
    await expect(leaveDialog).toBeVisible();
    await leaveDialog.getByRole('button', { name: '放弃修改' }).click();
    await expect(leaveDialog).toBeHidden();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
