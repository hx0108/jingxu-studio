// §6.2 v8 升级（shot-first-frame-image-generation）：旧打包产物（head=0008）播种真实 v8 库，
// 当前产物同根启动必须自动迁移 8→9（先落 v8 备份）且既有数据完好可读。
// 用法：node scripts/verify-packaged-v8-upgrade-smoke.mjs [v8ExePath] [currentExePath]
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron } from '@playwright/test';
import { createJiti } from 'jiti';

const { seedStoryboardReady } = await createJiti(import.meta.url).import(
  '../apps/desktop/e2e/support/storyboard-seeding.ts',
);

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const v8ExecutablePath = path.resolve(
  process.argv[2] ?? 'D:\\jingxu-smoke-v8\\win32-x64\\jingxu-studio.exe',
);
const currentExecutablePath = path.resolve(
  process.argv[3] ??
    path.join(
      workspaceRoot,
      'apps',
      'desktop',
      'out',
      '镜序 Studio-win32-x64',
      'jingxu-studio.exe',
    ),
);

const getEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

const launch = (executablePath, managedRoot, userDataDir) =>
  electron.launch({
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...getEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      LOCALAPPDATA: path.join(path.dirname(userDataDir), 'local-app-data-trap'),
    },
    executablePath,
  });

const queryScalar = (databaseFile, sql) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database.prepare(sql).get();
    return Number(Object.values(row ?? { value: null })[0] ?? 0);
  } finally {
    database.close();
  }
};

for (const candidate of [v8ExecutablePath, currentExecutablePath]) {
  if (!existsSync(candidate)) {
    throw new Error(
      `PACKAGED_EXE_MISSING:${candidate}（head-8 旧产物需自行提供，可从对应提交重打包）`,
    );
  }
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'jingxu-package-v8-smoke-'));
const managedRoot = path.join(testRoot, 'managed');
const databaseFile = path.join(managedRoot, 'data', 'jingxu.sqlite');
let summary;
try {
  // 阶段一：旧版（head 8）产物播种真实 v8 库（只走 v8 已有的通道，不触碰 image）。
  let seeded;
  {
    const application = await launch(
      v8ExecutablePath,
      managedRoot,
      path.join(testRoot, 'electron-user-data-v8'),
    );
    try {
      const page = await application.firstWindow();
      await page
        .getByRole('heading', { name: '镜序 Studio', exact: true })
        .waitFor({ timeout: 30_000 });
      seeded = await seedStoryboardReady(page, 'v8 升级项目');
    } finally {
      await application.close();
    }
  }
  const headAfterSeed = queryScalar(
    databaseFile,
    'SELECT MAX(version) AS value FROM schema_migrations',
  );
  if (headAfterSeed !== 8) throw new Error(`V8_SEED_HEAD:${headAfterSeed}`);
  if (seeded.shotCount !== 6) throw new Error(`V8_SEED_SHOTS:${seeded.shotCount}`);

  // 阶段二：当前产物同根启动 → 自动迁移 8→9（先落 v8 备份），既有数据完好可读。
  {
    const application = await launch(
      currentExecutablePath,
      managedRoot,
      path.join(testRoot, 'electron-user-data'),
    );
    try {
      const page = await application.firstWindow();
      try {
        await page
          .getByRole('heading', { name: '镜序 Studio', exact: true })
          .waitFor({ timeout: 30_000 });
      } catch (error) {
        // 诊断留证：启动失败时输出窗口实际内容与启动状态再抛出。
        const diagnostics = await page
          .evaluate(() => ({
            href: location.href,
            startup: window.jingxu?.runtime?.getStartupStatus?.() ?? 'no-runtime',
            text: document.body.innerText.slice(0, 400),
          }))
          .catch((reason) => `evaluate-failed:${String(reason)}`);
        process.stderr.write(`PHASE2_BOOT_DIAGNOSTICS:${JSON.stringify(diagnostics)}\n`);
        throw error;
      }
      const ready = await page.evaluate(async (projectId) => {
        const workspace = await window.jingxu.script.getWorkspace({ projectId });
        if (!workspace.ok) return `error:${workspace.error.code}`;
        return workspace.data.storyboard.current?.status ?? 'none';
      }, seeded.projectId);
      if (ready !== 'READY') throw new Error(`UPGRADED_DATA_NOT_READY:${ready}`);
    } finally {
      await application.close();
    }
  }

  const headAfterUpgrade = queryScalar(
    databaseFile,
    'SELECT MAX(version) AS value FROM schema_migrations',
  );
  const projectRows = queryScalar(
    databaseFile,
    'SELECT COUNT(*) AS value FROM projects WHERE deleted_at IS NULL',
  );
  if (headAfterUpgrade !== 9) throw new Error(`UPGRADE_HEAD:${headAfterUpgrade}`);
  if (projectRows !== 1) throw new Error(`UPGRADE_PROJECTS:${projectRows}`);

  // 升级前备份恰好一份，且备份本身停留在 v8。
  const backups = (await readdir(path.join(managedRoot, 'backups'))).filter((name) =>
    name.endsWith('.sqlite'),
  );
  if (backups.length !== 1) throw new Error(`BACKUP_COUNT:${backups.length}`);
  const backupHead = queryScalar(
    path.join(managedRoot, 'backups', backups[0]),
    'SELECT MAX(version) AS value FROM schema_migrations',
  );
  if (backupHead !== 8) throw new Error(`BACKUP_HEAD:${backupHead}`);

  summary = {
    currentExecutablePath,
    v8ExecutablePath,
    headAfterSeed,
    headAfterUpgrade,
    projectRows,
    backups: backups.length,
    backupHead,
  };
} finally {
  await rm(testRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
