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

test('dirty 离开取消与 Script 白名单—不丢输入且不暴露通用 IPC', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-script-safety-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创建第一个项目' }).click();
    await page.getByLabel('项目名称').fill('剧本安全路径');
    await page.getByRole('button', { name: '保存项目' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page
      .getByLabel('创意内容')
      .fill('这是一段用于验证刷新、取消和离开保护的原创漫剧创意，长度满足产品边界。');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '项目', exact: true }).click();
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
      keys: ['confirmVersion', 'getWorkspace', 'initializeOriginal', 'restoreVersion', 'saveDraft'],
    });
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
