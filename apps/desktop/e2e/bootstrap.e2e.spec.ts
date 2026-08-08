import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');

const getProcessEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const launchApplication = async (managedRoot: string) => {
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

test('正常临时根—启动 Electron—数据库 READY 且 Renderer 保持隔离', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-ready-'));
  const application = await launchApplication(path.join(root, 'managed'));

  try {
    const page = await application.firstWindow();

    await expect(page.getByRole('heading', { name: '镜序 Studio V1 工程基线' })).toBeVisible();
    const runtimeSurface = await page.evaluate(async () => {
      const api: unknown = Reflect.get(globalThis, 'jingxu');
      const runtime: unknown =
        typeof api === 'object' && api !== null ? Reflect.get(api, 'runtime') : undefined;
      const status = await window.jingxu.runtime.getStartupStatus();
      const contentSecurityPolicy = document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content');
      const externalResourceUrls = performance
        .getEntriesByType('resource')
        .map(({ name }) => name)
        .filter((url) => /^https?:/u.test(url));

      return {
        apiFrozen: typeof api === 'object' && api !== null && Object.isFrozen(api),
        apiKeys: typeof api === 'object' && api !== null ? Object.keys(api) : null,
        contentSecurityPolicy,
        externalResourceUrls,
        hasIpcRenderer: Reflect.has(globalThis, 'ipcRenderer'),
        hasProcess: Reflect.has(globalThis, 'process'),
        hasRequire: Reflect.has(globalThis, 'require'),
        locationProtocol: globalThis.location.protocol,
        runtimeFrozen: typeof runtime === 'object' && runtime !== null && Object.isFrozen(runtime),
        runtimeKeys:
          typeof runtime === 'object' && runtime !== null ? Object.keys(runtime).sort() : null,
        status,
      };
    });

    expect(runtimeSurface).toEqual({
      apiFrozen: true,
      apiKeys: ['runtime'],
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      externalResourceUrls: [],
      hasIpcRenderer: false,
      hasProcess: false,
      hasRequire: false,
      locationProtocol: 'jingxu:',
      runtimeFrozen: true,
      runtimeKeys: ['getStartupStatus', 'restoreBackup', 'retryStartup'],
      status: expect.objectContaining({ state: 'READY', writeEnabled: true }),
    });
  } finally {
    await application.close();
  }

  const databaseFile = await readFile(path.join(root, 'managed', 'data', 'jingxu.sqlite'));
  expect(databaseFile.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
  await rm(root, { force: true, recursive: true });
});

test('损坏库临时根—启动 Electron—进入只读故障页并拒绝伪造恢复源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-fault-'));
  const managedRoot = path.join(root, 'managed');
  await mkdir(path.join(managedRoot, 'data'), { recursive: true });
  await writeFile(path.join(managedRoot, 'data', 'jingxu.sqlite'), 'corrupt database fixture');
  const application = await launchApplication(managedRoot);

  try {
    const page = await application.firstWindow();

    await expect(page.getByRole('heading', { name: '数据库只读故障' })).toBeVisible();
    await expect(page.getByTestId('workspace-ready')).toHaveCount(0);
    await expect(page.getByText(/DATABASE_(OPEN|PRAGMA)_FAILED/u)).toBeVisible();
    const result = await page.evaluate(async () => {
      const current = await window.jingxu.runtime.getStartupStatus();
      return window.jingxu.runtime.restoreBackup({
        backupId: 'backup_12345678',
        expectedRevision: current.revision,
        requestId: 'request-e2e-restore-0001',
      });
    });
    expect(result).toMatchObject({
      errorCode: 'BACKUP_NOT_ALLOWED',
      state: 'READ_ONLY_FAULT',
      writeEnabled: false,
    });
    const rendererEscapeSurface = await page.evaluate(() => ({
      hasBetterSqlite3: Reflect.has(globalThis, 'betterSqlite3'),
      hasIpcRenderer: Reflect.has(globalThis, 'ipcRenderer'),
      hasProcess: Reflect.has(globalThis, 'process'),
      hasRequire: Reflect.has(globalThis, 'require'),
      hasSend: Reflect.has(window.jingxu, 'send') || Reflect.has(window.jingxu.runtime, 'send'),
    }));
    expect(rendererEscapeSurface).toEqual({
      hasBetterSqlite3: false,
      hasIpcRenderer: false,
      hasProcess: false,
      hasRequire: false,
      hasSend: false,
    });
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
