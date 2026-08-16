import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Page } from '@playwright/test';

const desktopRoot = path.resolve(__dirname, '..');

const getProcessEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

const launchApplication = async (managedRoot: string) =>
  electron.launch({
    args: process.env.JINGXU_E2E_EXECUTABLE === undefined ? [desktopRoot] : [],
    env: {
      ...getProcessEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
    },
    ...(process.env.JINGXU_E2E_EXECUTABLE === undefined
      ? {}
      : { executablePath: process.env.JINGXU_E2E_EXECUTABLE }),
  });

/** Renderer 侧探针：img 加载结局（CSP 与 404 都落 error，不进 load）。 */
const probeImageOutcomes = async (page: Page, sources: readonly string[]) =>
  page.evaluate(async (urls: readonly string[]) => {
    const outcome = (src: string) =>
      new Promise<{ readonly outcome: string; readonly src: string }>((resolve) => {
        const image = new Image();
        image.onload = () => {
          resolve({ outcome: 'loaded', src });
        };
        image.onerror = () => {
          resolve({ outcome: 'errored', src });
        };
        image.src = src;
        window.setTimeout(() => {
          resolve({ outcome: 'timeout', src });
        }, 8_000);
      });
    return Promise.all(urls.map(outcome));
  }, sources);

test('§5.2 受限取图协议—越权标识一律拒绝—CSP 阻止外部图源', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-e2e-media-protocol-'));
  const managedRoot = path.join(root, 'managed');
  const application = await launchApplication(managedRoot);

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '镜序 Studio', exact: true })).toBeVisible();

    // 越权标识：短 id、路径注入、格式合法但未落盘的随机 id、未知资源段——全部 error。
    const denied = await probeImageOutcomes(page, [
      'jingxu://media/candidate/short',
      'jingxu://media/candidate/0123456789abcdef/../../secret',
      'jingxu://media/candidate/3f2a9c1e-7b44-4d16-9f0a-8c2d5e6b7a91',
      'jingxu://media/asset-version/3f2a9c1e-7b44-4d16-9f0a-8c2d5e6b7a91',
      'jingxu://media/unknown-kind/3f2a9c1e-7b44-4d16-9f0a-8c2d5e6b7a91',
      'jingxu://evil/candidate/3f2a9c1e-7b44-4d16-9f0a-8c2d5e6b7a91',
    ]);
    for (const probe of denied) {
      expect(probe.outcome, probe.src).not.toBe('loaded');
      expect(probe.outcome, probe.src).toBe('errored');
    }

    // CSP：img-src 仅 jingxu:——外部 https 图源触发 securitypolicyviolation（img-src）。
    const violation = await page.evaluate(async () => {
      const reported = new Promise<{ readonly directive: string; readonly uri: string }>(
        (resolve) => {
          document.addEventListener(
            'securitypolicyviolation',
            (event) => {
              resolve({
                directive: event.violatedDirective,
                uri: event.blockedURI,
              });
            },
            { once: true },
          );
        },
      );
      const image = new Image();
      image.src = 'https://external.invalid/csp-probe.png';
      return reported;
    });
    expect(violation).toMatchObject({
      directive: 'img-src',
      uri: 'https://external.invalid/csp-probe.png',
    });

    const policy = await page.evaluate(() =>
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    );
    expect(policy).toContain('img-src jingxu:');
    expect(policy).not.toMatch(/img-src[^;]*https?/u);
  } finally {
    await application.close();
    await rm(root, { force: true, recursive: true });
  }
});
