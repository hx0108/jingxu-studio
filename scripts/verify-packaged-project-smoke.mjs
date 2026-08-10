import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron } from '@playwright/test';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const defaultExecutable = path.join(
  workspaceRoot,
  'apps',
  'desktop',
  'out',
  '镜序 Studio-win32-x64',
  'jingxu-studio.exe',
);
const executablePath = path.resolve(process.argv[2] ?? defaultExecutable);
const packageRoot = path.dirname(executablePath);
const resourcesRoot = path.join(packageRoot, 'resources');
const migrationRoot = path.join(resourcesRoot, 'migrations');
const fixedTime = '2026-08-10T00:00:00.000Z';

const listFiles = async (root) => {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(target)));
    else found.push(target);
  }
  return found;
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const getEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));

const launch = async (managedRoot, localAppDataTrap, userDataRoot) =>
  electron.launch({
    args: [`--user-data-dir=${userDataRoot}`],
    env: {
      ...getEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      LOCALAPPDATA: localAppDataTrap,
    },
    executablePath,
  });

const safeArea = { top: 5, right: 5, bottom: 12, left: 5 };

await access(executablePath);
const migrationOne = await readFile(path.join(migrationRoot, '0001_initial.sql'));
const migrationTwo = await readFile(path.join(migrationRoot, '0002_project_command_receipts.sql'));
if (!migrationOne.includes(Buffer.from('CREATE TABLE projects'))) {
  throw new Error('PACKAGED_MIGRATION_0001_INVALID');
}
if (!migrationTwo.includes(Buffer.from('CREATE TABLE command_receipts'))) {
  throw new Error('PACKAGED_MIGRATION_0002_INVALID');
}
const nativeAddons = (await listFiles(packageRoot)).filter((file) => file.endsWith('.node'));
if (nativeAddons.length > 0) {
  throw new Error(`EXTERNAL_SQLITE_NATIVE_ADDON_FOUND:${nativeAddons.join(',')}`);
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'jingxu-package-project-smoke-'));
const managedRoot = path.join(testRoot, 'managed');
const dataRoot = path.join(managedRoot, 'data');
const databasePath = path.join(dataRoot, 'jingxu.sqlite');
const localAppDataTrap = path.join(testRoot, 'local-app-data-trap');
const userDataRoot = path.join(testRoot, 'electron-user-data');
await mkdir(dataRoot, { recursive: true });

// Seed a genuine version-1 database. The packaged runtime must apply only 0002 on first launch.
const versionOne = new DatabaseSync(databasePath);
versionOne.exec(migrationOne.toString('utf8'));
versionOne
  .prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )
  .run(1, '0001_initial.sql', sha256(migrationOne), fixedTime);
versionOne.close();

let created;
let deleted;
try {
  const first = await launch(managedRoot, localAppDataTrap, userDataRoot);
  try {
    const page = await first.firstWindow();
    await page.waitForFunction(() => window.jingxu.runtime !== undefined);
    const startup = await page.evaluate(() => window.jingxu.runtime.getStartupStatus());
    if (startup.state !== 'READY' || startup.writeEnabled !== true) {
      throw new Error(`PACKAGED_STARTUP_NOT_READY:${JSON.stringify(startup)}`);
    }
    created = await page.evaluate(
      async (area) =>
        window.jingxu.project.create({
          requestId: 'package-create-0001',
          name: '打包验证项目',
          genre: '测试',
          style: null,
          creationMode: 'AI_ORIGINAL',
          dialogueRenderMode: 'NARRATION_FIRST',
          aspectRatio: '9:16',
          subtitleSafeArea: area,
        }),
      safeArea,
    );
    if (!created.ok) throw new Error(`PACKAGED_CREATE_FAILED:${created.error.code}`);
    const updated = await page.evaluate(
      async ({ detail, area }) =>
        window.jingxu.project.update({
          requestId: 'package-update-0001',
          projectId: detail.id,
          expectedUpdatedAt: detail.updatedAt,
          name: '打包验证项目-已更新',
          genre: detail.genre,
          style: '横屏',
          dialogueRenderMode: detail.dialogueRenderMode,
          aspectRatio: '16:9',
          subtitleSafeArea: area,
        }),
      { detail: created.data, area: safeArea },
    );
    if (!updated.ok || updated.data.currentFormatProfile.versionNo !== 2) {
      throw new Error('PACKAGED_UPDATE_FAILED');
    }
    deleted = await page.evaluate(
      async (detail) =>
        window.jingxu.project.delete({
          requestId: 'package-delete-0001',
          projectId: detail.id,
          expectedUpdatedAt: detail.updatedAt,
        }),
      updated.data,
    );
    if (!deleted.ok || deleted.data.deletedAt === null) {
      throw new Error('PACKAGED_DELETE_FAILED');
    }
  } finally {
    await first.close();
  }

  const afterFirstRun = new DatabaseSync(databasePath, { readOnly: true });
  const applied = afterFirstRun
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all();
  const evidence = {
    auditCount: afterFirstRun.prepare('SELECT COUNT(*) AS total FROM audit_events').get().total,
    formatProfileCount: afterFirstRun.prepare('SELECT COUNT(*) AS total FROM format_profiles').get()
      .total,
    receiptCount: afterFirstRun.prepare('SELECT COUNT(*) AS total FROM command_receipts').get()
      .total,
  };
  afterFirstRun.close();
  if (
    JSON.stringify(applied) !==
    JSON.stringify([
      { version: 1, name: '0001_initial.sql' },
      { version: 2, name: '0002_project_command_receipts.sql' },
    ])
  ) {
    throw new Error(`PACKAGED_MIGRATION_SET_INVALID:${JSON.stringify(applied)}`);
  }
  if (evidence.formatProfileCount !== 2 || evidence.receiptCount !== 3 || evidence.auditCount < 4) {
    throw new Error(`PACKAGED_PROJECT_EVIDENCE_INVALID:${JSON.stringify(evidence)}`);
  }

  const second = await launch(managedRoot, localAppDataTrap, userDataRoot);
  try {
    const page = await second.firstWindow();
    const restored = await page.evaluate(async (detail) => {
      const found = await window.jingxu.project.get({ projectId: detail.id, scope: 'DELETED' });
      if (!found.ok) return found;
      return window.jingxu.project.restore({
        requestId: 'package-restore-0001',
        projectId: found.data.id,
        expectedUpdatedAt: found.data.updatedAt,
      });
    }, deleted.data);
    if (!restored.ok || restored.data.deletedAt !== null) {
      throw new Error('PACKAGED_RESTART_RESTORE_FAILED');
    }
  } finally {
    await second.close();
  }

  try {
    await access(path.join(localAppDataTrap, 'JingxuStudio'));
    throw new Error('REAL_USER_MANAGED_ROOT_WAS_ACCESSED');
  } catch (error) {
    if (error instanceof Error && error.message === 'REAL_USER_MANAGED_ROOT_WAS_ACCESSED') {
      throw error;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      executablePath,
      migrationVersions: [1, 2],
      nativeAddonCount: nativeAddons.length,
      projectLifecycle: ['create', 'update', 'delete', 'restart', 'restore'],
      userManagedRootAccessed: false,
    })}\n`,
  );
} finally {
  await rm(testRoot, { force: true, recursive: true });
}
