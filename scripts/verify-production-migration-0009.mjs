// 7.2 生产库迁移 0009 留证（shot-first-frame-image-generation）：
// 以含审计 episode_versions 解析修复的重打包产物、无 JINGXU_E2E 启动一次，
// 生产数据根 %LOCALAPPDATA%\JingxuStudio 的库必须 8→9 且生成升级前备份。
// 备份自身 head=8；启动审计通过（writeEnabled）同时实证审计修复对真实生产库成立。
// 注：dev 入口 .vite/build 已在磁盘治理中删除，故走打包产物（也更贴近真实升级路径）。
import { _electron as electron } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const executablePath =
  process.argv[2] ??
  path.resolve(
    import.meta.dirname,
    '..',
    'apps',
    'desktop',
    'out',
    '镜序 Studio-win32-x64',
    'jingxu-studio.exe',
  );
const productionData = path.join(process.env.LOCALAPPDATA ?? '', 'JingxuStudio', 'data');
const productionBackups = path.join(
  process.env.LOCALAPPDATA ?? '',
  'JingxuStudio',
  'backups',
);
const databasePath = path.join(productionData, 'jingxu.sqlite');

const headOf = (file) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  } finally {
    database.close();
  }
};

const headBefore = headOf(databasePath);
const backupsBefore = readdirSync(productionBackups).filter((name) => name.endsWith('.sqlite'));

const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry) =>
        entry[1] !== undefined &&
        entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
        entry[0] !== 'ELECTRON_FORCE_IS_PACKAGED',
    ),
  );

const application = await electron.launch({
  args: [`--user-data-dir=${path.join(mkdtempSync(path.join(tmpdir(), 'jingxu-mig-')))}`],
  env: environment(),
  executablePath,
});
try {
  const page = await application.firstWindow();
  await page
    .getByRole('heading', { name: '镜序 Studio', exact: true })
    .waitFor({ timeout: 30_000 });
  const startup = await page.evaluate(() =>
    window.jingxu?.runtime?.getStartupStatus?.() ?? null,
  );
  const writeEnabled = startup === null ? null : startup.writeEnabled;
  if (writeEnabled !== true) {
    throw new Error(`STARTUP_NOT_WRITABLE:${JSON.stringify(startup)}`);
  }
} finally {
  await application.close();
}

const headAfter = headOf(databasePath);
const backupsAfter = readdirSync(productionBackups).filter((name) => name.endsWith('.sqlite'));
const newBackups = backupsAfter.filter((name) => !backupsBefore.includes(name));
if (headAfter !== 9) throw new Error(`HEAD_AFTER:${String(headAfter)}`);
if (headBefore === 8 && newBackups.length !== 1) {
  throw new Error(`NEW_BACKUPS:${String(newBackups.length)}`);
}
const newBackupHead =
  newBackups.length === 1 ? headOf(path.join(productionBackups, newBackups[0])) : null;

console.log(
  JSON.stringify({
    backupsAfter: backupsAfter.length,
    backupsBefore: backupsBefore.length,
    headAfter,
    headBefore,
    newBackupHead,
    writeEnabled: true,
  }),
);
