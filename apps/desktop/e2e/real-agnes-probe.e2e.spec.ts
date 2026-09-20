import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, test, type ElectronApplication } from '@playwright/test';

// 临时调试探针：仅 Agnes 档 saveCredential→testCredential，捕获主进程 stderr。
const desktopRoot = path.resolve(__dirname, '..');
const agnesKeyFile = process.env.JINGXU_AGNES_KEY_FILE ?? '';

test('Agnes 腿调试', async () => {
  test.setTimeout(120_000);
  test.skip(agnesKeyFile === '', '需要 key 文件');
  const apiKey = (await readFile(agnesKeyFile, 'utf8')).replace(/\s+/g, '');
  const isolatedData = await mkdtemp(path.join(os.tmpdir(), 'jingxu-agnes-dbg-'));
  test.setTimeout(120_000);
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [desktopRoot, '--no-proxy-server'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name, value]) => value !== undefined && name !== 'ELECTRON_RUN_AS_NODE',
          ),
        ),
        LOCALAPPDATA: process.env.JINGXU_DATA_ROOT_OVERRIDE ?? isolatedData,
      },
    });
    application.process().stderr?.on('data', (chunk: Buffer) => { console.log(`[main-err] ${String(chunk)}`); });
    application.process().stdout?.on('data', (chunk: Buffer) => { console.log(`[main-out] ${String(chunk)}`); });
    const page = await application.firstWindow();
    const debugProjectId = process.env.JINGXU_DEBUG_PROJECT_ID ?? '';
    const debugShotIds = (process.env.JINGXU_DEBUG_SHOT_IDS ?? '')
      .split(',')
      .filter(Boolean);
    const result = await page.evaluate(
      async ({ key, preflightProject, preflightShotIds }) => {
      const requestId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;
      const profile = await window.jingxu.provider.getProfile({
        profileId: 'profile-video-agnes-primary',
      });
      if (!profile.ok) return `getProfile:${profile.error.code}`;
      const saved = await window.jingxu.provider.saveCredential({
        apiKey: key,
        expectedVersionId: profile.data.versionId,
        profileId: 'profile-video-agnes-primary',
        requestId: requestId('key'),
      });
      if (!saved.ok) return `saveCredential:${saved.error.code}`;
      const tested = await window.jingxu.provider.testCredential({
        expectedVersionId: saved.data.versionId,
        profileId: 'profile-video-agnes-primary',
        requestId: requestId('test'),
      });
      const reread = await window.jingxu.provider.getProfile({
        profileId: 'profile-video-agnes-primary',
      });
      const legA = {
        saveVersionId: saved.data.versionId,
        testedOk: tested.ok,
        testedError: tested.ok ? null : tested.error,
        reread: reread.ok ? reread.data : `reread:${reread.error.code}`,
      };
      // 对保留库复现 preflight（full-chain 失败现场：project_11f70bda…）
      const preflightProjectLocal = preflightProject;
      const preflightShotIdsLocal = preflightShotIds;
      let preflightResult: unknown = 'skipped (no debug ids)';
      if (preflightProject !== '' && preflightShotIds.length > 0) {
        const pf = await window.jingxu.image.getConsistencyPreflight({
          projectId: preflightProjectLocal,
          shotIds: preflightShotIdsLocal,
        });
        preflightResult = pf.ok ? pf.data : pf.error;
      }
        return { legA, preflightResult };
      },
      { key: apiKey, preflightProject: debugProjectId, preflightShotIds: debugShotIds },
    );
    console.log(`AGNES_DBG_RESULT ${JSON.stringify(result)}`);
  } finally {
    await application?.close();
    await rm(isolatedData, { force: true, recursive: true }).catch(() => undefined);
  }
});
