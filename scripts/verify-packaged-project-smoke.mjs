import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _electron as electron } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
const schemaRoot = path.join(resourcesRoot, 'schemas', 'v1');
const fixtureRoot = path.join(workspaceRoot, 'packages', 'test-fixtures', 'src', 'fixtures', 'v1');
const fixedTime = '2026-08-10T00:00:00.000Z';
const schemaLocks = [
  {
    resourceName: 'ScriptStageOutput.schema.json',
    schemaId: 'https://jingxu.studio/schemas/script-stage-output/1.0.0',
    semanticVersion: '1.0.0',
    sha256: '128e7a49e1d5829c4b0c9cf89fc5e6fd883746f022e9759c157f70176309971f',
  },
  {
    resourceName: 'ShotContract.schema.json',
    schemaId: 'https://jingxu.studio/schemas/shot-contract/1.1.0',
    semanticVersion: '1.1.0',
    sha256: '3fa77aa85152ad2500fcc1c07da5bec697da8810c572d1c378b0bf432f437e4b',
  },
  {
    resourceName: 'EpisodeStoryboardExport.schema.json',
    schemaId: 'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
    semanticVersion: '1.1.0',
    sha256: '55238d1958aae25341d137192cf544946b9d8b8767648a98a3956e01798fcb13',
  },
  {
    resourceName: 'ProjectTransferBundle.schema.json',
    schemaId: 'https://jingxu.studio/schemas/project-transfer-bundle/1.0.0',
    semanticVersion: '1.0.0',
    sha256: '9736ee2421fa8b8febe683c6e41e3cae47665df5d7afe85592a25e4fa4fbabbb',
  },
];

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
const schemaEntries = await readdir(schemaRoot, { withFileTypes: true });
if (
  schemaEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
  JSON.stringify(schemaEntries.map((entry) => entry.name).sort()) !==
    JSON.stringify(schemaLocks.map((lock) => lock.resourceName).sort())
) {
  throw new Error('PACKAGED_SCHEMA_RESOURCE_SET_INVALID');
}
const schemaDocuments = [];
for (const lock of schemaLocks) {
  const bytes = await readFile(path.join(schemaRoot, lock.resourceName));
  const document = JSON.parse(bytes.toString('utf8'));
  if (
    sha256(bytes) !== lock.sha256 ||
    document.$id !== lock.schemaId ||
    document.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    document.properties?.schema_version?.const !== lock.semanticVersion
  ) {
    throw new Error(`PACKAGED_SCHEMA_LOCK_MISMATCH:${lock.resourceName}`);
  }
  schemaDocuments.push(document);
}
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  strictTypes: false,
  useDefaults: false,
  validateFormats: true,
});
addFormats(ajv);
for (const [index, document] of schemaDocuments.entries()) {
  ajv.addSchema(document, schemaLocks[index].schemaId);
}
for (const [schemaId, fixtureName] of [
  [
    'https://jingxu.studio/schemas/episode-storyboard-export/1.1.0',
    'episode-storyboard-export.valid.json',
  ],
  [
    'https://jingxu.studio/schemas/project-transfer-bundle/1.0.0',
    'project-transfer-bundle.valid.json',
  ],
]) {
  const validator = ajv.getSchema(schemaId);
  const fixture = JSON.parse(await readFile(path.join(fixtureRoot, fixtureName), 'utf8'));
  if (validator === undefined || !validator(fixture)) {
    throw new Error(`PACKAGED_SCHEMA_REFERENCE_CHAIN_INVALID:${schemaId}`);
  }
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
    schemaManifest: afterFirstRun
      .prepare(
        `SELECT schema_id, semantic_version, resource_path, sha256, enabled
         FROM schema_registry_manifest
         ORDER BY schema_id ASC`,
      )
      .all(),
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
  const expectedManifest = schemaLocks
    .map((lock) => ({
      enabled: 1,
      resource_path: lock.resourceName,
      schema_id: lock.schemaId,
      semantic_version: lock.semanticVersion,
      sha256: lock.sha256,
    }))
    .sort((left, right) =>
      left.schema_id < right.schema_id ? -1 : left.schema_id > right.schema_id ? 1 : 0,
    );
  const manifestMatches =
    evidence.schemaManifest.length === expectedManifest.length &&
    evidence.schemaManifest.every((actual, index) => {
      const expected = expectedManifest[index];
      return (
        expected !== undefined &&
        actual.enabled === expected.enabled &&
        actual.resource_path === expected.resource_path &&
        actual.schema_id === expected.schema_id &&
        actual.semantic_version === expected.semantic_version &&
        actual.sha256 === expected.sha256
      );
    });
  if (!manifestMatches) {
    throw new Error(`PACKAGED_SCHEMA_MANIFEST_INVALID:${JSON.stringify(evidence.schemaManifest)}`);
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
      schemaHashes: schemaLocks.map((lock) => lock.sha256),
      schemaIds: schemaLocks.map((lock) => lock.schemaId),
      schemaReferenceChains: ['episode-to-shot', 'transfer-to-script'],
      userManagedRootAccessed: false,
    })}\n`,
  );
} finally {
  await rm(testRoot, { force: true, recursive: true });
}
