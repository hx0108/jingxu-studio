import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

// Throwaway packaged-binary smoke. Launches the built jingxu-studio.exe and asserts it boots
// to the project UI (heading visible) rather than a READ_ONLY_FAULT page. Run only when the
// package exists at apps/desktop/out/.

const exePath = path.resolve(__dirname, '..', 'out', '镜序 Studio-win32-x64', 'jingxu-studio.exe');

const environment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

test('packaged smoke—jingxu-studio.exe boots to project UI', async () => {
  test.skip(!existsSync(exePath), 'packaged exe not built (run package:win first)');
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-pkg-smoke-'));
  try {
    const application = await electron.launch({
      executablePath: exePath,
      env: { ...environment(), JINGXU_E2E: '1', JINGXU_E2E_DATA_ROOT: path.join(root, 'managed') },
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await application.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
