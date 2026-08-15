// §6.4（shot-contract-generation）：新打包产物对 v7 生产库（head=0007）可正常启动。
// 旧产物只含迁移 0001–0003，对 v7 库会在 MIGRATION 阶段报 DATABASE_VERSION_TOO_NEW 进入只读故障；
// 本脚本用打包产物内的 0001–0007 种出 v7 等效库，启动后必须 READY、writeEnabled 且补齐 0008。
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const migrationRoot = path.join(path.dirname(executablePath), 'resources', 'migrations');
const fixedTime = '2026-08-10T00:00:00.000Z';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const getEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );

await access(executablePath);
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'jingxu-package-v7-smoke-'));
const managedRoot = path.join(testRoot, 'managed');
const dataRoot = path.join(managedRoot, 'data');
const databasePath = path.join(dataRoot, 'jingxu.sqlite');
await mkdir(dataRoot, { recursive: true });

// 种出 v7 生产库等效物：按序执行打包产物内 0001–0007 并登记 schema_migrations。
const database = new DatabaseSync(databasePath);
for (const name of [
  '0001_initial.sql',
  '0002_project_command_receipts.sql',
  '0003_script_version_receipts.sql',
  '0004_prompt_templates_v2.sql',
  '0005_prompt_templates_story_bible_v3.sql',
  '0006_model_invocations_profile_ref.sql',
  '0007_snapshot_tables_profile_ref.sql',
]) {
  const bytes = await readFile(path.join(migrationRoot, name));
  database.exec(bytes.toString('utf8'));
  database
    .prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    )
    .run(Number(name.slice(0, 4)), name, sha256(bytes), fixedTime);
}
database.close();

let startup;
let versions;
try {
  const application = await electron.launch({
    args: [`--user-data-dir=${path.join(testRoot, 'electron-user-data')}`],
    env: {
      ...getEnvironment(),
      JINGXU_E2E: '1',
      JINGXU_E2E_DATA_ROOT: managedRoot,
      LOCALAPPDATA: path.join(testRoot, 'local-app-data-trap'),
    },
    executablePath,
  });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.jingxu.runtime !== undefined);
    startup = await page.evaluate(() => window.jingxu.runtime.getStartupStatus());
  } finally {
    await application.close();
  }

  const afterUpgrade = new DatabaseSync(databasePath, { readOnly: true });
  versions = afterUpgrade
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all();
  afterUpgrade.close();

  if (startup.state !== 'READY' || startup.writeEnabled !== true || startup.errorCode !== null) {
    throw new Error(`PACKAGED_V7_UPGRADE_NOT_READY:${JSON.stringify(startup)}`);
  }
  if (
    JSON.stringify(versions.at(-1)) !==
    JSON.stringify({ version: 8, name: '0008_prompt_templates_shot_contract.sql' })
  ) {
    throw new Error(`PACKAGED_V7_UPGRADE_HEAD_INVALID:${JSON.stringify(versions)}`);
  }
} finally {
  await rm(testRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
}

process.stdout.write(
  `${JSON.stringify({
    executablePath,
    migrationsBefore: 7,
    migrationsAfter: versions.length,
    startupState: startup.state,
    writeEnabled: startup.writeEnabled,
  })}\n`,
);
