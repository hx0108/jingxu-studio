import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const schemaResourcePath = path.resolve(
  desktopRoot,
  '../../packages/validation/resources/schemas/v1/ShotContract.schema.json',
);
const schemaResourceBackupPath = path.resolve(
  desktopRoot,
  '../../packages/validation/resources/schemas/.ShotContract.schema.json.e2e-backup',
);

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const restoreSchemaResourceIfNeeded = async (): Promise<void> => {
  if (!(await pathExists(schemaResourceBackupPath))) return;
  await rm(schemaResourcePath, { force: true });
  await rename(schemaResourceBackupPath, schemaResourcePath);
};

const getProcessEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launchApplication = async (managedRoot: string): Promise<ElectronApplication> => {
  const packagedExecutable = process.env.JINGXU_E2E_EXECUTABLE;
  return electron.launch({
    args: packagedExecutable === undefined ? [desktopRoot] : [],
    env: {
      ...getProcessEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
    },
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
  });
};

const createProjectThroughUi = async (
  page: Page,
  name: string,
  aspectRatio: '9:16' | '16:9',
): Promise<void> => {
  const firstAction = page.getByRole('button', { name: '创建第一个项目' });
  if (await firstAction.isVisible()) await firstAction.click();
  else await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByLabel('项目名称').fill(name);
  if (aspectRatio === '16:9') await page.getByLabel('横屏 16:9').check();
  await page.getByRole('button', { name: '保存项目' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
};

test('§9.1 临时根—创建 9:16/16:9 项目并重启—列表详情稳定且 Renderer 隔离', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-projects-'));
  const managedRoot = path.join(root, 'managed');
  let application = await launchApplication(managedRoot);

  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
    await createProjectThroughUi(page, '竖屏项目', '9:16');
    await expect(page.getByText('1080×1920')).toBeVisible();
    await expect(page.getByText('当前版本 v1')).toBeVisible();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await createProjectThroughUi(page, '横屏项目', '16:9');
    await expect(page.getByText('1920×1080')).toBeVisible();
    await application.close();

    application = await launchApplication(managedRoot);
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: /竖屏项目/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /横屏项目/u })).toBeVisible();
    await page.getByRole('button', { name: /横屏项目/u }).click();
    await expect(page.getByRole('heading', { name: '横屏项目', exact: true })).toBeVisible();
    await expect(page.getByText('16:9')).toBeVisible();
    await expect(page.getByRole('button', { name: '进入剧本工作区' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '分镜工作台' })).toBeDisabled();
    await expect(page.getByText(/分镜能力在剧本工作区内提供/u)).toHaveCount(1);

    const surface = await page.evaluate(async () => {
      const api: unknown = Reflect.get(globalThis, 'jingxu');
      const project: unknown =
        typeof api === 'object' && api !== null ? Reflect.get(api, 'project') : undefined;
      const runtime: unknown =
        typeof api === 'object' && api !== null ? Reflect.get(api, 'runtime') : undefined;
      const list = await window.jingxu.project.list({
        scope: 'ACTIVE',
        limit: 20,
        cursor: null,
        search: null,
      });
      const status = await window.jingxu.runtime.getStartupStatus();
      const serialized = JSON.stringify(list);
      return {
        apiFrozen: typeof api === 'object' && api !== null && Object.isFrozen(api),
        apiKeys: typeof api === 'object' && api !== null ? Object.keys(api).sort() : null,
        contentSecurityPolicy: document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content'),
        externalResourceUrls: performance
          .getEntriesByType('resource')
          .map(({ name: resourceUrl }) => resourceUrl)
          .filter((resourceUrl) => /^https?:/u.test(resourceUrl)),
        hasIpcRenderer: Reflect.has(globalThis, 'ipcRenderer'),
        hasProcess: Reflect.has(globalThis, 'process'),
        hasRequire: Reflect.has(globalThis, 'require'),
        leaksPathOrSql:
          serialized.includes('dataRoot') ||
          serialized.includes('sqlite') ||
          serialized.includes('SELECT'),
        projectFrozen: typeof project === 'object' && project !== null && Object.isFrozen(project),
        projectKeys:
          typeof project === 'object' && project !== null ? Object.keys(project).sort() : null,
        runtimeFrozen: typeof runtime === 'object' && runtime !== null && Object.isFrozen(runtime),
        runtimeKeys:
          typeof runtime === 'object' && runtime !== null ? Object.keys(runtime).sort() : null,
        rootHasGenericIpc:
          typeof api === 'object' &&
          api !== null &&
          ['send', 'on', 'invoke'].some((key) => Reflect.has(api, key)),
        projectHasGenericIpc:
          typeof project === 'object' &&
          project !== null &&
          ['send', 'on', 'invoke'].some((key) => Reflect.has(project, key)),
        status,
      };
    });
    expect(surface).toEqual({
      apiFrozen: true,
      apiKeys: ['events', 'job', 'project', 'provider', 'runtime', 'script'],
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      externalResourceUrls: [],
      hasIpcRenderer: false,
      hasProcess: false,
      hasRequire: false,
      leaksPathOrSql: false,
      projectFrozen: true,
      projectKeys: ['create', 'delete', 'get', 'list', 'restore', 'update'],
      runtimeFrozen: true,
      runtimeKeys: ['getStartupStatus', 'restoreBackup', 'retryStartup'],
      rootHasGenericIpc: false,
      projectHasGenericIpc: false,
      status: expect.objectContaining({ state: 'READY', writeEnabled: true }),
    });
    const databaseFile = await readFile(path.join(managedRoot, 'data', 'jingxu.sqlite'));
    expect(databaseFile.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§9.2 临时根—失败、并发、软删恢复与 dirty 三选项—无部分业务结果', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-workflow-'));
  const managedRoot = path.join(root, 'managed');
  const application = await launchApplication(managedRoot);

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '创建第一个项目' })).toBeVisible();

    await page.getByRole('button', { name: '创建第一个项目' }).click();
    await page.getByLabel('项目名称').fill(' 前导空白');
    await page.getByRole('button', { name: '保存项目' }).click();
    await expect(page.getByText(/提交内容无法验证/u)).toBeVisible();
    await expect(page.getByLabel('项目名称')).toHaveValue(' 前导空白');
    const afterFieldFailure = await page.evaluate(() =>
      window.jingxu.project.list({ scope: 'ACTIVE', limit: 20, cursor: null, search: null }),
    );
    expect(afterFieldFailure).toMatchObject({ ok: true, data: { items: [] } });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '创作设定尚未保存' })).toBeVisible();
    await page.getByRole('button', { name: '放弃修改' }).click();

    await createProjectThroughUi(page, '并发基准项目', '9:16');
    const staleResult = await page.evaluate(async () => {
      const listed = await window.jingxu.project.list({
        scope: 'ACTIVE',
        limit: 20,
        cursor: null,
        search: null,
      });
      if (!listed.ok || listed.data.items[0] === undefined) throw new Error('missing project');
      const initial = await window.jingxu.project.get({
        projectId: listed.data.items[0].id,
        scope: 'ACTIVE',
      });
      if (!initial.ok) throw new Error(initial.error.code);
      const base = initial.data;
      const first = await window.jingxu.project.update({
        requestId: `update_${crypto.randomUUID()}`,
        projectId: base.id,
        expectedUpdatedAt: base.updatedAt,
        name: '并发基准项目新版',
        genre: base.genre,
        style: base.style,
        dialogueRenderMode: base.dialogueRenderMode,
        aspectRatio: base.currentFormatProfile.aspectRatio,
        subtitleSafeArea: base.currentFormatProfile.subtitleSafeArea,
      });
      const stale = await window.jingxu.project.update({
        requestId: `update_${crypto.randomUUID()}`,
        projectId: base.id,
        expectedUpdatedAt: base.updatedAt,
        name: '陈旧覆盖不应成功',
        genre: base.genre,
        style: base.style,
        dialogueRenderMode: base.dialogueRenderMode,
        aspectRatio: base.currentFormatProfile.aspectRatio,
        subtitleSafeArea: base.currentFormatProfile.subtitleSafeArea,
      });
      const current = await window.jingxu.project.get({ projectId: base.id, scope: 'ACTIVE' });
      return { first, stale, current };
    });
    expect(staleResult.first).toMatchObject({ ok: true });
    expect(staleResult.stale).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_VERSION_CONFLICT' },
    });
    expect(staleResult.current).toMatchObject({ ok: true, data: { name: '并发基准项目新版' } });

    await page.reload();
    await page.getByRole('button', { name: /并发基准项目新版/u }).click();
    await page.getByRole('button', { name: '移入回收站' }).click();
    await expect(page.getByText(/不会删除 Provider 侧数据/u)).toBeVisible();
    await page
      .getByRole('dialog', { name: '将项目移入回收站？' })
      .getByRole('button', { name: '取消' })
      .click();
    await expect(page.getByRole('button', { name: '移入回收站' })).toBeVisible();
    const afterDeleteCancellation = await page.evaluate(() =>
      window.jingxu.project.list({ scope: 'ACTIVE', limit: 20, cursor: null, search: null }),
    );
    expect(afterDeleteCancellation).toMatchObject({
      ok: true,
      data: { items: [expect.objectContaining({ name: '并发基准项目新版', deletedAt: null })] },
    });
    await page.getByRole('button', { name: '移入回收站' }).click();
    await page.getByRole('button', { name: '确认移入回收站' }).click();
    await page.getByRole('button', { name: '回收站' }).click();
    await expect(page.getByRole('button', { name: /并发基准项目新版/u })).toBeVisible();
    await page.getByRole('button', { name: '恢复项目' }).click();
    await page.getByRole('button', { name: '确认恢复' }).click();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: /并发基准项目新版/u }).click();

    await page.getByRole('button', { name: '编辑创作设定' }).click();
    await page.getByLabel('项目名称').fill('dirty 取消保留');
    const refreshWasBlocked = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      return !globalThis.dispatchEvent(event);
    });
    expect(refreshWasBlocked).toBe(true);
    await expect(page.getByRole('dialog', { name: '创作设定尚未保存' })).toBeVisible();
    await page
      .getByRole('dialog', { name: '创作设定尚未保存' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await expect(page.getByLabel('项目名称')).toHaveValue('dirty 取消保留');
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page
      .getByRole('dialog', { name: '创作设定尚未保存' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    await expect(page.getByLabel('项目名称')).toHaveValue('dirty 取消保留');
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改' }).click();
    await expect(page.getByRole('button', { name: /并发基准项目新版/u })).toBeVisible();

    await page.getByRole('button', { name: /并发基准项目新版/u }).click();
    await page.getByRole('button', { name: '编辑创作设定' }).click();
    await page.getByLabel('项目名称').fill('dirty 保存成功');
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.getByRole('button', { name: '保存并离开' }).click();
    await expect(page.getByRole('button', { name: /dirty 保存成功/u })).toBeVisible();

    const restoreConflict = await page.evaluate(async () => {
      const create = async (name: string) =>
        window.jingxu.project.create({
          requestId: `create_${crypto.randomUUID()}`,
          name,
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        });
      const victim = await create('恢复冲突');
      if (!victim.ok) throw new Error(victim.error.code);
      const deleted = await window.jingxu.project.delete({
        requestId: `delete_${crypto.randomUUID()}`,
        projectId: victim.data.id,
        expectedUpdatedAt: victim.data.updatedAt,
      });
      if (!deleted.ok) throw new Error(deleted.error.code);
      const occupant = await create('恢复冲突');
      if (!occupant.ok) throw new Error(occupant.error.code);
      const restore = await window.jingxu.project.restore({
        requestId: `restore_${crypto.randomUUID()}`,
        projectId: deleted.data.id,
        expectedUpdatedAt: deleted.data.updatedAt,
      });
      const recycle = await window.jingxu.project.list({
        scope: 'DELETED',
        limit: 20,
        cursor: null,
        search: '恢复冲突',
      });
      return { restore, recycle };
    });
    expect(restoreConflict.restore).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_NAME_CONFLICT' },
    });
    expect(restoreConflict.recycle).toMatchObject({
      ok: true,
      data: { items: [{ name: '恢复冲突' }] },
    });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('§9.3 损坏库临时根—只读故障页—写命令和 Renderer 越界能力均被阻断', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-fault-'));
  const managedRoot = path.join(root, 'managed');
  const databasePath = path.join(managedRoot, 'data', 'jingxu.sqlite');
  const corruptFixture = 'corrupt database fixture';
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, corruptFixture);
  const application = await launchApplication(managedRoot);

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '数据库只读故障' })).toBeVisible();
    await expect(page.getByTestId('workspace-ready')).toHaveCount(0);
    await expect(page.getByText(/DATABASE_(OPEN|PRAGMA)_FAILED/u)).toBeVisible();

    const boundary = await page.evaluate(async () => {
      const current = await window.jingxu.runtime.getStartupStatus();
      const invalidMachineField = await window.jingxu.project
        .create({
          requestId: 'request_fault_invalid',
          name: '不应创建',
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
          dataRootRel: 'C:\\Users\\ASUS\\secret',
        } as never)
        .then(
          () => 'resolved',
          () => 'rejected',
        );
      const commands = await Promise.all([
        window.jingxu.project.create({
          requestId: 'request_fault_create',
          name: '不应创建',
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        }),
        window.jingxu.project.update({
          requestId: 'request_fault_update',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-10T01:00:00.000Z',
          name: '不应更新',
          genre: null,
          style: null,
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        }),
        window.jingxu.project.delete({
          requestId: 'request_fault_delete',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-10T01:00:00.000Z',
        }),
        window.jingxu.project.restore({
          requestId: 'request_fault_restore',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-10T01:00:00.000Z',
        }),
      ]);
      const project = window.jingxu.project as unknown as Record<string, unknown>;
      const restore = await window.jingxu.runtime.restoreBackup({
        backupId: 'backup_12345678',
        expectedRevision: current.revision,
        requestId: 'request-e2e-restore-0001',
      });
      return {
        commandErrors: commands.map((result) => (result.ok ? null : result.error.code)),
        hasIpcRenderer: Reflect.has(globalThis, 'ipcRenderer'),
        hasProcess: Reflect.has(globalThis, 'process'),
        hasRequire: Reflect.has(globalThis, 'require'),
        invalidMachineField,
        projectHasGenericIpc: ['send', 'on', 'invoke'].some((key) => Reflect.has(project, key)),
        restore,
      };
    });
    expect(boundary).toMatchObject({
      commandErrors: [
        'STARTUP_WRITE_BLOCKED',
        'STARTUP_WRITE_BLOCKED',
        'STARTUP_WRITE_BLOCKED',
        'STARTUP_WRITE_BLOCKED',
      ],
      hasIpcRenderer: false,
      hasProcess: false,
      hasRequire: false,
      invalidMachineField: 'rejected',
      projectHasGenericIpc: false,
      restore: {
        errorCode: 'BACKUP_NOT_ALLOWED',
        state: 'READ_ONLY_FAULT',
        writeEnabled: false,
      },
    });
    expect(await readFile(databasePath, 'utf8')).toBe(corruptFixture);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('Schema 资源缺失—只读故障阻断四个写命令—原位修复后同窗口重试恢复 READY', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-schema-fault-'));
  const managedRoot = path.join(root, 'managed');
  await restoreSchemaResourceIfNeeded();
  await rename(schemaResourcePath, schemaResourceBackupPath);
  const application = await launchApplication(managedRoot);

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Schema 契约只读故障' })).toBeVisible();
    await expect(page.getByText('SCHEMA_RESOURCE_MISSING')).toBeVisible();
    await expect(page.getByText('SCHEMA_REGISTRY', { exact: true })).toBeVisible();
    await expect(page.getByTestId('workspace-ready')).toHaveCount(0);

    const commandErrors = await page.evaluate(async () => {
      const results = await Promise.all([
        window.jingxu.project.create({
          requestId: 'request_schema_fault_create',
          name: '不应创建',
          genre: null,
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        }),
        window.jingxu.project.update({
          requestId: 'request_schema_fault_update',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-11T00:00:00.000Z',
          name: '不应更新',
          genre: null,
          style: null,
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: { top: 5, right: 5, bottom: 12, left: 5 },
        }),
        window.jingxu.project.delete({
          requestId: 'request_schema_fault_delete',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-11T00:00:00.000Z',
        }),
        window.jingxu.project.restore({
          requestId: 'request_schema_fault_restore',
          projectId: 'project_12345678',
          expectedUpdatedAt: '2026-08-11T00:00:00.000Z',
        }),
      ]);
      return results.map((result) => (result.ok ? null : result.error.code));
    });
    expect(commandErrors).toEqual([
      'STARTUP_WRITE_BLOCKED',
      'STARTUP_WRITE_BLOCKED',
      'STARTUP_WRITE_BLOCKED',
      'STARTUP_WRITE_BLOCKED',
    ]);

    await restoreSchemaResourceIfNeeded();
    await page.getByRole('button', { name: '重新检查' }).click();
    await expect(page.getByTestId('workspace-ready')).toBeVisible();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => window.jingxu.runtime.getStartupStatus()))
      .toMatchObject({
        completedPhases: expect.arrayContaining(['SCHEMA_REGISTRY']),
        errorCode: null,
        state: 'READY',
        writeEnabled: true,
      });
  } finally {
    await application.close();
    await restoreSchemaResourceIfNeeded();
    await rm(root, { force: true, recursive: true });
  }
});
