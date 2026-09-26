import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

const launch = async (
  managedRoot: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<ElectronApplication> =>
  electron.launch({
    args: [desktopRoot],
    env: {
      ...environment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      ...extraEnvironment,
    },
  });

test('全新安装默认首页—唯一主操作且不要求先配置服务—无项目起始选择可直达创建', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-creator-home-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    // 默认着陆屏是首页唯一主操作；不出现 JSON/Provider/任务 ID 等工程概念，也不要求先配置。
    await expect(page.getByRole('button', { name: '开始创作', exact: true })).toBeVisible();
    const homeText = await page.locator('.home-dashboard').textContent();
    expect(homeText).not.toBeNull();
    for (const forbidden of ['JSON', 'Provider', '能力快照', '任务 ID', '哈希']) {
      expect(homeText).not.toContain(forbidden);
    }

    // 无项目时点击主操作 → 起始选择面板（演示入口已随 3.3 启用 + 创建入口）。
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建我的作品' })).toBeVisible();
    await expect(page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' })).toBeEnabled();

    await page.getByRole('button', { name: '创建我的作品' }).click();
    await page.getByLabel('项目名称').fill('首页创建的作品');
    await page.getByRole('button', { name: '保存项目' }).click();
    await expect(page.getByRole('heading', { name: '首页创建的作品', exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('窄窗首页保留唯一主要操作—设置按生成服务分组且不展示联调信息', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-creator-settings-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ height: 680, width: 900 });
    const primaryAction = page.getByRole('button', { name: '开始创作', exact: true });
    await expect(primaryAction).toBeVisible();
    const bounds = await primaryAction.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(680);

    // 设置分组独立在桌面宽度验收；窄窗断言只验证首页核心操作不被遮挡。
    await page.setViewportSize({ height: 800, width: 1280 });
    await page
      .locator('nav[aria-label="全局导航"]')
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    for (const group of ['文字创作服务', '画面生成服务', '视频生成服务', '语音与配乐服务']) {
      await expect(page.getByText(group, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('联调模拟（Mock）')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('真实项目准备条件不足—不会把演示 Mock 伪装为可生成结果', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-real-preparation-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    const result = await page.evaluate(async () => {
      const requestId = `real-preparation_${crypto.randomUUID()}`;
      const created = await window.jingxu.project.create({
        aspectRatio: '9:16',
        creationMode: 'AI_ORIGINAL',
        dialogueRenderMode: 'NARRATION_FIRST',
        genre: '悬疑',
        name: '真实准备检查边界',
        requestId,
        style: '二维漫剧',
        subtitleSafeArea: { bottom: 12, left: 5, right: 5, top: 5 },
      });
      if (!created.ok) throw new Error(created.error.code);
      return window.jingxu.creatorGuide.getPreparation({
        episodeId: null,
        operation: 'IMAGE',
        projectId: created.data.id,
        shotIds: [],
      });
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CREATOR_GUIDE_PROJECT_NOT_FOUND');
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('全新用户无网络无凭据—启动五分钟体验—内置剧本分镜与参考图就绪且生成前明确零费用', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-five-minute-demo-'));
  await mkdir(path.join(root, 'exports'), { recursive: true });
  const application = await launch(path.join(root, 'managed'), {
    JINGXU_E2E_EXPORT_DIR: path.join(root, 'exports'),
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();

    await expect(page.getByText(/演示结果.*不会产生真实费用/u)).toBeVisible({ timeout: 90_000 });
    await page.locator('.media-advanced-actions > summary').click();
    await page.locator('button[name="export-episode"]').click();
    await expect(page.getByText(/导出成功：export_/u)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '为整集生成首帧' })).toBeEnabled();
    await page.getByRole('button', { name: '为整集生成首帧' }).click();
    await expect(page.getByRole('heading', { name: '确认本次生成准备' })).toBeVisible();
    await expect(page.getByText('参考成本：零真实费用')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认并开始' })).toBeEnabled();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('体验初始化一次失败—首页给出重试—第二次创建完整示例', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-demo-retry-'));
  const application = await launch(path.join(root, 'managed'), {
    JINGXU_E2E_DEMO_FAIL_ONCE_AT: 'STAGE_READY:STORY_BIBLE',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();
    await expect(page.getByText('重试即可，不会留下可见的半成品。')).toBeVisible({
      timeout: 90_000,
    });
    await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();
    await expect(page.getByText(/演示结果.*不会产生真实费用/u)).toBeVisible({ timeout: 90_000 });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('演示剧本默认结构化表单—高级编辑按需出现且不暴露系统信封字段', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-structured-form-'));
  const application = await launch(path.join(root, 'managed'));
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '开始创作', exact: true }).click();
    await page.getByRole('button', { name: '5 分钟体验（免配置·零费用）' }).click();
    await expect(page.getByText(/演示结果.*不会产生真实费用/u)).toBeVisible({ timeout: 90_000 });
    const creatorNavigation = page.locator('nav[aria-label="六步创作流程"]');
    await creatorNavigation.getByRole('button', { name: '故事构思' }).click();
    await expect(page.getByRole('button', { name: '表单编辑' })).toBeVisible();
    for (const stageName of ['故事圣经', '单集大纲', '节拍表', '场景剧本']) {
      await creatorNavigation.getByRole('button', { name: '剧本完善' }).click();
      await page
        .locator('nav[aria-label="剧本完善环节"]')
        .getByRole('button', { name: stageName })
        .click();
      await expect(page.getByRole('button', { name: '表单编辑' })).toBeVisible();
      const stageText = await page.locator('#script-stage-editor').textContent();
      expect(stageText).not.toContain('schema_version');
      expect(stageText).not.toContain('project_id');
    }
    await creatorNavigation.getByRole('button', { name: '故事构思' }).click();
    const formText = await page.locator('#script-stage-editor').textContent();
    expect(formText).not.toContain('schema_version');
    expect(formText).not.toContain('project_id');
    await page.getByLabel('作品名').fill('灯塔最后一封信（体验编辑）');
    await page.getByRole('button', { name: '暂存', exact: true }).click();
    const confirmStage = page
      .locator('#script-stage-editor')
      .getByRole('button', { name: '保存并继续' });
    await expect(confirmStage).toBeEnabled();
    page.once('dialog', (dialog) => dialog.accept());
    await confirmStage.click();
    await page.getByRole('button', { name: '高级编辑' }).click();
    await expect(page.getByLabel('高级内容')).toBeVisible();
    const advancedText = await page.getByLabel('高级内容').inputValue();
    expect(advancedText).not.toContain('schema_version');
    expect(advancedText).not.toContain('project_id');
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
    await page.reload();
    await page.getByRole('button', { name: '继续', exact: true }).click();
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
    await page.reload();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.getByRole('heading', { name: '创作故事梗概' })).toBeVisible();
    await expect(
      page.locator('nav[aria-label="六步创作流程"]').getByRole('button', { name: '故事构思' }),
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
    await page.getByRole('button', { name: '返回作品' }).click();
    await page.getByRole('button', { name: '返回镜序首页' }).click();
    await expect(page.getByText('当前任务：确认故事概念')).toBeVisible();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.getByRole('heading', { name: '创作故事梗概' })).toBeVisible();
    await expect(
      page.locator('nav[aria-label="六步创作流程"]').getByRole('button', { name: '故事构思' }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
