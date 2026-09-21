import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');

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

test('全新安装默认首页—唯一主操作且不要求先配置服务—无项目起始选择可直达创建', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-creator-home-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    // 默认着陆屏是首页唯一主操作；不出现 JSON/Provider/任务 ID 等工程概念，也不要求先配置。
    await expect(page.getByRole('button', { name: '继续制作本集' })).toBeVisible();
    const homeText = await page.locator('.home-dashboard').textContent();
    expect(homeText).not.toBeNull();
    for (const forbidden of ['JSON', 'Provider', '能力快照', '任务 ID', '哈希']) {
      expect(homeText).not.toContain(forbidden);
    }

    // 无项目时点击主操作 → 起始选择面板（演示入口已随 3.3 启用 + 创建入口）。
    await page.getByRole('button', { name: '继续制作本集' }).click();
    await expect(page.getByRole('button', { name: '创建我的作品' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }),
    ).toBeEnabled();

    await page.getByRole('button', { name: '创建我的作品' }).click();
    await page.getByLabel('项目名称').fill('首页创建的作品');
    await page.getByRole('button', { name: '保存项目' }).click();
    await expect(page.getByRole('heading', { name: '首页创建的作品', exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('多项目按最近更新稳定续作—未初始化项目直达输入故事—不先落到已就绪项目', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-creator-resume-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const seeded = await page.evaluate(async () => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const create = async (name: string): Promise<string> => {
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
        return created.data.id;
      };
      const olderId = await create('较早项目');
      const initialized = await window.jingxu.script.initializeOriginal({
        creativeText: '较早项目已完成故事输入，用于区分续作目标。',
        dataProcessingConsent: true,
        projectId: olderId,
        requestId: requestId('init-older'),
      });
      if (!initialized.ok) throw new Error(initialized.error.code);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const newerId = await create('较新项目');
      return { newerId, olderId };
    });
    expect(seeded).toMatchObject({ newerId: expect.any(String), olderId: expect.any(String) });

    // 点击前重新解析：最新更新的「较新项目」被选中，且因其未初始化输入而直达故事输入。
    await page.getByRole('button', { name: '继续制作本集' }).click();
    await expect(page.getByRole('heading', { name: '输入原创创意' })).toBeVisible();
    await expect(page.getByLabel('创意内容')).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('后台 Job 完成后重定位—首页动作从生成故事概念变为确认故事概念', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-creator-job-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const jobId = await page.evaluate(async () => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '续作重定位',
        requestId: requestId('project'),
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      });
      if (!created.ok) throw new Error(created.error.code);
      const projectId = created.data.id;
      const initialized = await window.jingxu.script.initializeOriginal({
        creativeText: '一名守夜人在旧灯塔发现每一百年亮起一次的信号，决定查明收信人。',
        dataProcessingConsent: true,
        projectId,
        requestId: requestId('initialize'),
      });
      if (!initialized.ok) throw new Error(initialized.error.code);
      const workspace = initialized.data;

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

      const queued = await window.jingxu.job.create({
        episodeId: null,
        expectedInputVersionId: workspace.source.id,
        idempotencyKey: requestId('idem-concept'),
        operationType: 'GENERATE',
        projectId,
        requestId: requestId('job-concept'),
        stage: 'CONCEPT',
      });
      if (!queued.ok) throw new Error(queued.error.code);
      return queued.data.id;
    });
    expect(jobId).toEqual(expect.any(String));

    // 阶段尚无草稿：首页动作指向生成故事概念，点击后直达剧本工作区故事概念阶段。
    await page.getByRole('button', { name: '继续制作本集' }).click();
    await expect(
      page.locator('nav[aria-label="五阶段剧本"]').getByRole('button', { name: '故事概念' }),
    ).toBeVisible();

    // 后台 Mock Job 完成后，回到首页再点击：动作重定位为确认故事概念。
    await expect
      .poll(
        async () => {
          const status = await page.evaluate((id) => window.jingxu.job.get({ jobId: id }), jobId);
          return status.ok ? `${status.data.status}:${status.data.errorCode ?? '-'}` : 'PENDING';
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe('SUCCEEDED:-');
    await page
      .locator('nav[aria-label="全局导航"]')
      .getByRole('button', { name: '首页', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '确认故事概念' })).toBeVisible();
    await page.getByRole('button', { name: '继续制作本集' }).click();
    await expect(
      page.locator('nav[aria-label="五阶段剧本"]').getByRole('button', { name: '故事概念' }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
