// §6.2 clean（shot-first-frame-image-generation）：Windows x64 打包产物全新受管理根冒烟。
// 打包 exe 自行完成迁移 1–9 → 离线 Mock 图片闭环（资产 v1 → 4 候选 COMPLETED → 人工选择
// → 升版 v2 → 旧世代全员 STALE_INPUT）→ UI 经 jingxu://media 受限协议真实解码 →
// 凭据哨兵泄漏扫描（受管理根 + 用户数据 + LOCALAPPDATA 陷阱，项目 SQLite/WAL/SHM 除外）。
// 用法：node scripts/verify-packaged-image-smoke.mjs [exePath]
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron } from '@playwright/test';
import { createJiti } from 'jiti';

const { seedStoryboardReady } = await createJiti(import.meta.url).import(
  '../apps/desktop/e2e/support/storyboard-seeding.ts',
);

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const executablePath = path.resolve(
  process.argv[2] ??
    path.join(
      workspaceRoot,
      'apps',
      'desktop',
      'out',
      '镜序 Studio-win32-x64',
      'jingxu-studio.exe',
    ),
);
const CREDENTIAL_SENTINEL = 'e2e-mock-key-not-a-real-secret';

const getEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

const queryScalar = (databaseFile, sql) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database.prepare(sql).get();
    return Number(Object.values(row ?? { value: null })[0] ?? 0);
  } finally {
    database.close();
  }
};

const listFiles = async (directory) => {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...(await listFiles(full)));
    else if (entry.isFile()) collected.push(full);
  }
  return collected;
};

/** 凭据哨兵明文扫描：项目 SQLite/WAL/SHM 之外的任何字节（图片/资产/诊断/用户数据）都不得命中。 */
const scanForSentinel = async (directories) => {
  const needle = Buffer.from(CREDENTIAL_SENTINEL, 'utf8');
  const offenders = [];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const file of await listFiles(directory)) {
      if (/\.(sqlite|sqlite-wal|sqlite-shm)$/u.test(file)) continue;
      const bytes = await readFile(file);
      if (bytes.includes(needle)) offenders.push(file);
    }
  }
  return offenders;
};

if (!existsSync(executablePath)) {
  throw new Error(`PACKAGED_EXE_MISSING:${executablePath}（先执行打包）`);
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'jingxu-package-image-smoke-'));
const managedRoot = path.join(testRoot, 'managed');
const userDataDir = path.join(testRoot, 'electron-user-data');
let summary;
try {
  const application = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...getEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      LOCALAPPDATA: path.join(testRoot, 'local-app-data-trap'),
    },
    executablePath,
  });
  let html;
  let seeded;
  let loop;
  try {
    const page = await application.firstWindow();
    await page
      .getByRole('heading', { name: '镜序 Studio', exact: true })
      .waitFor({ timeout: 30_000 });

    // 打包态 JINGXU_E2E=1：文本与图片均走离线 Mock 适配器。
    seeded = await seedStoryboardReady(page, '首帧打包冒烟');

    // Mock 图片闭环：资产 v1 → 生成 4 候选 COMPLETED → 选择 → 升版 v2 → 全员 STALE。
    loop = await page.evaluate(
      async ({ projectId, shotId }) => {
        const requestId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
        const upload = (bytes, version) =>
          window.jingxu.image.uploadAssetReference({
            assetType: 'SCENE',
            bibleRefId: 'scene_train',
            byteSize: bytes.length,
            bytes: Uint8Array.from(bytes),
            description: null,
            displayName: '午夜列车',
            mimeType: 'image/png',
            projectId,
            requestId: requestId(version),
          });
        const v1 = await upload([1, 2, 3], 'asset-v1');
        if (!v1.ok) throw new Error(`v1:${v1.error.code}`);
        const generated = await window.jingxu.image.generateCandidates({
          projectId,
          requestId: requestId('generate'),
          shotId,
        });
        if (!generated.ok) throw new Error(`generate:${generated.error.code}`);
        let phase = generated.data.phase;
        for (let attempt = 0; attempt < 600 && phase !== 'COMPLETED'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const task = await window.jingxu.image.getMediaTask({
            projectId,
            taskId: generated.data.id,
          });
          if (!task.ok) throw new Error(`poll:${task.error.code}`);
          phase = task.data.phase;
          if (phase === 'FAILED') throw new Error(`task:${task.data.errorCode}`);
        }
        if (phase !== 'COMPLETED') throw new Error(`task:terminal-${phase}`);
        const candidates = await window.jingxu.image.listCandidates({ projectId, shotId });
        if (!candidates.ok) throw new Error(`list:${candidates.error.code}`);
        const succeeded = candidates.data.filter((candidate) => candidate.status === 'SUCCEEDED');
        if (succeeded.length !== 4) throw new Error(`candidates:${succeeded.length}`);
        if (!succeeded.every((candidate) => candidate.mediaUrl?.startsWith('jingxu://media/'))) {
          throw new Error('mediaUrl-prefix');
        }
        const first = succeeded[0];
        if (first === undefined) throw new Error('candidates:empty');
        const selected = await window.jingxu.image.selectCandidate({
          candidateId: first.id,
          projectId,
          requestId: requestId('select'),
        });
        if (!selected.ok) throw new Error(`select:${selected.error.code}`);
        if (selected.data.every((candidate) => candidate.selectedAt === null)) {
          throw new Error('select:not-reflected');
        }
        const v2 = await upload([4, 5, 6], 'asset-v2');
        if (!v2.ok) throw new Error(`v2:${v2.error.code}`);
        // 升版后重新拉取：旧世代候选应全员 STALE_INPUT。
        const restaled = await window.jingxu.image.listCandidates({ projectId, shotId });
        if (!restaled.ok) throw new Error(`restale:${restaled.error.code}`);
        return {
          affectedShots: v2.data.affectedShots.length,
          staleCount: restaled.data.filter((candidate) => candidate.status === 'STALE_INPUT')
            .length,
          versionNo: v2.data.version.versionNo,
        };
      },
      { projectId: seeded.projectId, shotId: seeded.shotId },
    );

    // UI 取图闭环：打包态 jingxu://media 受限协议必须回真实可解码字节。
    await page.reload();
    await page.locator('.project-card-main', { hasText: '首帧打包冒烟' }).click();
    await page.getByRole('button', { name: '进入剧本工作区' }).click();
    await page.getByRole('heading', { name: '分镜工作台' }).waitFor();
    await page.locator('.shot-card', { hasText: '#1' }).click();
    await page.getByRole('heading', { name: '首帧候选 · 镜头 #1' }).waitFor();
    await page.waitForFunction(
      () => {
        const images = Array.from(
          document.querySelectorAll('#first-frame-panel .candidate-grid img'),
        );
        return images.length > 0 && images.every((image) => image.naturalWidth > 0);
      },
      undefined,
      { timeout: 30_000 },
    );

    // 红线：Key 不入 Renderer 页面。
    html = await page.content();
  } finally {
    await application.close();
  }

  if (seeded.shotCount !== 6) throw new Error(`SHOT_COUNT:${seeded.shotCount}`);
  if (loop.versionNo !== 2 || loop.affectedShots !== 1 || loop.staleCount !== 4) {
    throw new Error(`IMAGE_LOOP:${JSON.stringify(loop)}`);
  }
  if (html.includes(CREDENTIAL_SENTINEL) || html.includes('sk-')) {
    throw new Error('SENTINEL_IN_RENDERER_HTML');
  }

  // 打包 exe 自行完成的迁移与媒体事实落库。
  const databaseFile = path.join(managedRoot, 'data', 'jingxu.sqlite');
  const migrations = queryScalar(
    databaseFile,
    'SELECT MAX(version) AS value FROM schema_migrations',
  );
  const staleRows = queryScalar(
    databaseFile,
    "SELECT COUNT(*) AS value FROM image_candidates WHERE status = 'STALE_INPUT'",
  );
  const selectedRows = queryScalar(
    databaseFile,
    'SELECT COUNT(*) AS value FROM image_candidates WHERE selected_at IS NOT NULL',
  );
  const assetVersions = queryScalar(databaseFile, 'SELECT COUNT(*) AS value FROM asset_versions');
  if (migrations !== 9) throw new Error(`MIGRATION_HEAD:${migrations}`);
  if (staleRows !== 4 || selectedRows !== 1 || assetVersions !== 2) {
    throw new Error(
      `MEDIA_FACTS:stale=${staleRows},selected=${selectedRows},assets=${assetVersions}`,
    );
  }

  // 凭据哨兵泄漏扫描：受管理根（资产/图片字节、诊断、secrets）+ 用户数据 + LOCALAPPDATA 陷阱。
  const offenders = await scanForSentinel([
    managedRoot,
    userDataDir,
    path.join(testRoot, 'local-app-data-trap'),
  ]);
  if (offenders.length > 0) throw new Error(`SENTINEL_LEAK:${offenders.join(',')}`);

  summary = { executablePath, migrations, staleRows, selectedRows, assetVersions, offenders: 0 };
} finally {
  await rm(testRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
