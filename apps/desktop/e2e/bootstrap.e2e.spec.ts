import { _electron as electron, expect, test } from '@playwright/test';
import path from 'node:path';

const desktopRoot = path.resolve(__dirname, '..');

const getProcessEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

test('启动工程基线—检查 Renderer—显示真实状态且隔离 Node 与业务入口', async () => {
  const packagedExecutable = process.env.JINGXU_E2E_EXECUTABLE;
  const application = await electron.launch({
    args: packagedExecutable === undefined ? [desktopRoot] : [],
    env: {
      ...getProcessEnvironment(),
      JINGXU_E2E: '1',
    },
    ...(packagedExecutable === undefined ? {} : { executablePath: packagedExecutable }),
  });

  try {
    const page = await application.firstWindow();

    await expect(page.getByRole('heading', { name: '镜序 Studio V1 工程基线' })).toBeVisible();
    await expect(
      page.getByText('当前仅包含桌面运行时、进程隔离与工程门禁，不包含业务功能。'),
    ).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);

    const runtimeSurface = await page.evaluate(() => {
      const api: unknown = Reflect.get(globalThis, 'jingxu');
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
      };
    });

    expect(runtimeSurface).toEqual({
      apiFrozen: true,
      apiKeys: [],
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      externalResourceUrls: [],
      hasIpcRenderer: false,
      hasProcess: false,
      hasRequire: false,
      locationProtocol: 'jingxu:',
    });
  } finally {
    await application.close();
  }
});
