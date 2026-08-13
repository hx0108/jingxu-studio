import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { BackupSummaryDto } from '@jingxu/contracts';

import type { MigrationResource } from '../migrations/migration-loader';
import { applyMigrations, inspectMigrationPlan } from '../migrations/migration-runner';
import {
  assertManagedRealPaths,
  resolveManagedBackupPath,
  type ManagedPaths,
} from '../runtime/managed-paths';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import {
  backupSqliteDatabase,
  openSqliteDatabase,
  queryPragmaRows,
  type SqliteDatabase,
} from '../runtime/sqlite-database';

interface BackupManifest {
  readonly backupId: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly databaseFile: string;
  readonly schemaVersion: number;
  readonly sha256: string;
  readonly targetSchemaVersion: number;
}

export interface VerifiedBackup {
  readonly databasePath: string;
  readonly manifest: BackupManifest;
  readonly summary: BackupSummaryDto;
}

export interface CreateOnlineBackupOptions {
  readonly backupDatabase?: (database: SqliteDatabase, destination: string) => Promise<unknown>;
  readonly backupId: string;
  readonly clock: () => string;
  readonly currentVersion: number;
  readonly database: SqliteDatabase;
  readonly paths: ManagedPaths;
  readonly targetVersion?: number;
}

export interface PerformManagedMigrationOptions extends Omit<
  CreateOnlineBackupOptions,
  'currentVersion'
> {
  readonly migrations: readonly MigrationResource[];
}

const hashFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  const chunks = createReadStream(filePath) as AsyncIterable<Buffer>;
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
};

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const manifestPathFor = (paths: ManagedPaths, backupId: string): string =>
  path.join(paths.backupDirectory, `${backupId}.manifest.json`);

const toSummary = (manifest: BackupManifest): BackupSummaryDto => ({
  backupId: manifest.backupId,
  createdAt: manifest.createdAt,
  schemaVersion: manifest.schemaVersion,
  summary: `数据库升级前备份（Schema v${String(manifest.schemaVersion)}）`,
});

const parseManifest = (text: string): BackupManifest => {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('backupId' in value) ||
    !('byteSize' in value) ||
    !('createdAt' in value) ||
    !('databaseFile' in value) ||
    !('schemaVersion' in value) ||
    !('sha256' in value) ||
    !('targetSchemaVersion' in value) ||
    typeof value.backupId !== 'string' ||
    typeof value.byteSize !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.databaseFile !== 'string' ||
    typeof value.schemaVersion !== 'number' ||
    typeof value.sha256 !== 'string' ||
    typeof value.targetSchemaVersion !== 'number' ||
    value.targetSchemaVersion < value.schemaVersion
  ) {
    throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
  }
  return value as BackupManifest;
};

const verifyBackupDatabase = (databasePath: string, expectedVersion: number): void => {
  const backup = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    const integrity = queryPragmaRows(backup, 'integrity_check');
    const foreignKeyRows = queryPragmaRows(backup, 'foreign_key_check');
    const row = backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      readonly version: number | null;
    };
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== 'ok' ||
      foreignKeyRows.length !== 0 ||
      row.version !== expectedVersion
    ) {
      throw new PersistenceRuntimeError('DATABASE_BACKUP_FAILED');
    }
  } finally {
    backup.close();
  }
};

export const createOnlineBackup = async ({
  backupDatabase = backupSqliteDatabase,
  backupId,
  clock,
  currentVersion,
  database,
  paths,
  targetVersion = currentVersion,
}: CreateOnlineBackupOptions): Promise<BackupSummaryDto> => {
  const finalDatabasePath = resolveManagedBackupPath(paths, backupId);
  const finalManifestPath = manifestPathFor(paths, backupId);
  const temporaryDatabasePath = `${finalDatabasePath}.tmp`;
  const temporaryManifestPath = `${finalManifestPath}.tmp`;

  try {
    await Promise.all([
      access(finalDatabasePath).then(
        () => Promise.reject(new Error('backup exists')),
        () => undefined,
      ),
      access(finalManifestPath).then(
        () => Promise.reject(new Error('manifest exists')),
        () => undefined,
      ),
      access(temporaryDatabasePath).then(
        () => Promise.reject(new Error('temporary backup exists')),
        () => undefined,
      ),
      access(temporaryManifestPath).then(
        () => Promise.reject(new Error('temporary manifest exists')),
        () => undefined,
      ),
    ]);
    await backupDatabase(database, temporaryDatabasePath);
    verifyBackupDatabase(temporaryDatabasePath, currentVersion);
    await syncFile(temporaryDatabasePath);
    const fileStat = await stat(temporaryDatabasePath);
    const manifest: BackupManifest = {
      backupId,
      byteSize: fileStat.size,
      createdAt: clock(),
      databaseFile: `${backupId}.sqlite`,
      schemaVersion: currentVersion,
      sha256: await hashFile(temporaryDatabasePath),
      targetSchemaVersion: targetVersion,
    };
    await writeFile(temporaryManifestPath, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await syncFile(temporaryManifestPath);
    await rename(temporaryDatabasePath, finalDatabasePath);
    await rename(temporaryManifestPath, finalManifestPath);
    return toSummary(manifest);
  } catch {
    throw new PersistenceRuntimeError('DATABASE_BACKUP_FAILED');
  }
};

export const getVerifiedBackup = async (
  paths: ManagedPaths,
  backupId: string,
): Promise<VerifiedBackup> => {
  const databasePath = resolveManagedBackupPath(paths, backupId);
  try {
    const manifestPath = manifestPathFor(paths, backupId);
    const [databaseLinkStat, manifestLinkStat] = await Promise.all([
      lstat(databasePath),
      lstat(manifestPath),
    ]);
    if (databaseLinkStat.isSymbolicLink() || manifestLinkStat.isSymbolicLink()) {
      throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
    }
    const backupRoot = await realpath(paths.backupDirectory);
    assertManagedRealPaths(
      backupRoot,
      await Promise.all([realpath(databasePath), realpath(manifestPath)]),
    );
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    if (manifest.backupId !== backupId || manifest.databaseFile !== `${backupId}.sqlite`) {
      throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
    }
    const fileStat = await stat(databasePath);
    if (fileStat.size !== manifest.byteSize || (await hashFile(databasePath)) !== manifest.sha256) {
      throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
    }
    verifyBackupDatabase(databasePath, manifest.schemaVersion);
    return { databasePath, manifest, summary: toSummary(manifest) };
  } catch {
    throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
  }
};

export const listVerifiedBackups = async (
  paths: ManagedPaths,
): Promise<readonly BackupSummaryDto[]> => {
  const entries = await readdir(paths.backupDirectory);
  const backupIds = entries
    .filter((entry) => entry.endsWith('.manifest.json'))
    .map((entry) => entry.slice(0, -'.manifest.json'.length));
  const verified = await Promise.all(
    backupIds.map(async (backupId) => {
      try {
        return (await getVerifiedBackup(paths, backupId)).summary;
      } catch {
        return null;
      }
    }),
  );
  return verified
    .filter((summary): summary is BackupSummaryDto => summary !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};

export const performManagedMigration = async (
  options: PerformManagedMigrationOptions,
): Promise<{ readonly backup: BackupSummaryDto | null }> => {
  const plan = inspectMigrationPlan(options.database, options.migrations);
  const backup =
    plan.currentVersion > 0 && plan.pending.length > 0
      ? await createOnlineBackup({
          ...options,
          currentVersion: plan.currentVersion,
          targetVersion: options.migrations.length,
        })
      : null;
  applyMigrations(options.database, options.migrations, options.clock);
  return { backup };
};
