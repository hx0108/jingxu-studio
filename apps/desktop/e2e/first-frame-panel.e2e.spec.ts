import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

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

/** 等待面板内全部候选 <img> 真实解码（正向取图：jingxu://media 必须回真字节）。 */
const waitForDecodedImages = async (page: Page, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(
    () => {
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>('#first-frame-panel .candidate-grid img'),
      );
      return images.length > 0 && images.every((image) => image.naturalWidth > 0);
    },
    undefined,
    { timeout },
  );

test('§5.3 逐镜头首帧面板—生成/选择/参考图升版 STALE 与受影响镜头清单（E2E Mock）', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-first-frame-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();

    // 播种：五阶段 READY → 整集分镜 READY → 上传 scene_train 资产 v1（进入当前输入世代）。
    const seeded = await page.evaluate(async (orderedStages) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '首帧闭环',
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

      // 资产 v1：生成前上传，使首轮候选的 generation_input_hash 绑定 v1。
      const assetV1 = await window.jingxu.image.uploadAssetReference({
        assetType: 'SCENE',
        bibleRefId: 'scene_train',
        byteSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
        description: null,
        displayName: '午夜列车',
        mimeType: 'image/png',
        projectId,
        requestId: requestId('asset-v1'),
      });
      if (!assetV1.ok) throw new Error(`asset:${assetV1.error.code}`);
      const firstShot = afterReady.data.storyboard.shots[0];
      if (firstShot === undefined) throw new Error('shot:missing-shots');
      return {
        assetVersionNo: assetV1.data.version.versionNo,
        projectId,
        shotCount: afterReady.data.storyboard.shots.length,
        shotId: firstShot.shotId,
      };
    }, stages);

    expect(seeded.assetVersionNo).toBe(1);
    expect(seeded.shotCount).toBe(6);

    // UI happy path：重载后从项目列表走真实入口进分镜工作区。
    await page.reload();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
    await page.locator('.project-card-main', { hasText: '首帧闭环' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await expect(page.getByRole('heading', { name: '分镜工作台' })).toBeVisible();
    await page.locator('.shot-card', { hasText: '#1' }).click();

    // 首帧面板：READY 整集下可生成；候选经受限取图协议真实解码。
    const panel = page.locator('#first-frame-panel');
    await expect(panel.getByRole('heading', { name: '首帧候选 · 镜头 #1' })).toBeVisible();
    await expect(panel.getByText('该镜头尚未生成首帧候选。')).toBeVisible();
    await panel.getByRole('button', { name: '生成首帧候选' }).click();
    await expect(panel.getByText('任务状态：COMPLETED')).toBeVisible({ timeout: 30_000 });
    await waitForDecodedImages(page);
    await expect(panel.locator('.candidate-card')).toHaveCount(4);
    await expect(panel.locator('.candidate-grid img')).toHaveCount(4);
    await expect(panel.getByText('当前输入世代')).toBeVisible();

    // 当前世代内比较与人工选择。
    await panel.getByRole('button', { name: '设为当前首帧' }).first().click();
    await expect(panel.locator('.selection-badge')).toHaveText('当前首帧');
    await expect(panel.getByRole('button', { name: '设为当前首帧' })).toHaveCount(3);

    // 参考图升版 v2：旧世代候选全员 STALE_INPUT + 受影响镜头清单。
    await page.getByLabel('圣经引用 ID（char_*/scene_*）').fill('scene_train');
    await page.getByLabel('资产显示名称').fill('午夜列车');
    await page.locator('#reference-upload-form input[type="file"]').setInputFiles({
      buffer: Buffer.from([4, 5, 6]),
      mimeType: 'image/png',
      name: 'scene-train-v2.png',
    });
    await page.getByRole('button', { name: '上传参考图' }).click();
    await expect(panel.getByText('参考图已上传为版本 v2')).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('受影响镜头（候选已标记失效，需重新生成）：')).toBeVisible();
    await expect(panel.locator('.affected-shot-list li')).toHaveCount(1);
    await expect(panel.locator('.affected-shot-list li')).toContainText(
      `${seeded.shotId}（4 张候选）`,
    );

    // STALE 展示：历史世代只读追溯、旧选择标注失效、失效候选仍可读图、无选择入口。
    await expect(panel.getByText('历史输入世代（输入已变化，仅供追溯）')).toBeVisible();
    await expect(panel.getByText('当前选择（已失效）')).toBeVisible();
    await expect(panel.getByText('当前输入世代')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '设为当前首帧' })).toHaveCount(0);
    await expect(panel.locator('.candidate-card.candidate-stale')).toHaveCount(4);
    await waitForDecodedImages(page);

    // 红线：API Key 或路径细节不进入 Renderer 页面。
    const html = await page.content();
    expect(html).not.toContain('e2e-mock-key-not-a-real-secret');
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('file://');
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
