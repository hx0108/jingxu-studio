import { access, copyFile, mkdir, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getVerifiedBackup } from '../backup/backup-manager';
import type { ManagedPaths } from '../runtime/managed-paths';
import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteConnectionManager } from '../runtime/sqlite-connection';
import {
  backupSqliteDatabase,
  openSqliteDatabase,
  queryPragmaRows,
} from '../runtime/sqlite-database';

export interface RestoreManagedBackupOptions {
  readonly backupId: string;
  readonly beforeReplace?: () => void;
  readonly connectionManager: SqliteConnectionManager;
  readonly operationId: string;
  readonly paths: ManagedPaths;
}

const RESTORE_OPERATION_PATTERN = /^restore_[A-Za-z0-9_-]{8,128}$/u;

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

export const restoreManagedBackup = async ({
  backupId,
  beforeReplace,
  connectionManager,
  operationId,
  paths,
}: RestoreManagedBackupOptions): Promise<void> => {
  const verified = await getVerifiedBackup(paths, backupId);
  if (!RESTORE_OPERATION_PATTERN.test(operationId)) {
    throw new PersistenceRuntimeError('DATABASE_RESTORE_FAILED');
  }

  const operationDirectory = path.join(paths.diagnosticDirectory, operationId);
  const temporaryRestorePath = path.join(paths.dataDirectory, `${operationId}.restore.tmp`);
  const originalLivePath = path.join(operationDirectory, 'original-live.sqlite');
  try {
    await mkdir(operationDirectory, { recursive: false });
    let onlineSnapshotCreated = false;
    try {
      const onlineSnapshotTemporaryPath = path.join(
        operationDirectory,
        'current-online.sqlite.tmp',
      );
      const onlineSnapshotPath = path.join(operationDirectory, 'current-online.sqlite');
      await backupSqliteDatabase(connectionManager.open(), onlineSnapshotTemporaryPath);
      await syncFile(onlineSnapshotTemporaryPath);
      await rename(onlineSnapshotTemporaryPath, onlineSnapshotPath);
      onlineSnapshotCreated = true;
    } catch {
      // A corrupt database may not support online backup; the raw DB/WAL/SHM evidence below is mandatory.
    }
    connectionManager.close();
    const liveArtifacts = [
      paths.databasePath,
      `${paths.databasePath}-wal`,
      `${paths.databasePath}-shm`,
    ];
    for (const artifact of liveArtifacts) {
      if (await exists(artifact)) {
        await copyFile(artifact, path.join(operationDirectory, path.basename(artifact)));
      }
    }
    await writeFile(
      path.join(operationDirectory, 'operation.manifest.json'),
      `${JSON.stringify({ backupId, onlineSnapshotCreated, operationId, state: 'PREPARED' })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await copyFile(verified.databasePath, temporaryRestorePath);
    await syncFile(temporaryRestorePath);
    const candidate = openSqliteDatabase(temporaryRestorePath, { readOnly: true });
    try {
      const integrity = queryPragmaRows(candidate, 'integrity_check');
      if (integrity[0]?.integrity_check !== 'ok') {
        throw new Error('invalid restore candidate');
      }
    } finally {
      candidate.close();
    }
    beforeReplace?.();
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${paths.databasePath}${suffix}`;
      if (await exists(sidecar)) {
        await rename(sidecar, path.join(operationDirectory, `original-live.sqlite${suffix}`));
      }
    }
    await rename(paths.databasePath, originalLivePath);
    try {
      await rename(temporaryRestorePath, paths.databasePath);
    } catch (error) {
      await rename(originalLivePath, paths.databasePath);
      throw error;
    }
    await writeFile(
      path.join(operationDirectory, 'operation.result.json'),
      `${JSON.stringify({ backupId, operationId, state: 'REPLACED' })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    connectionManager.close();
    if (await exists(temporaryRestorePath)) {
      const preservedCandidate = path.join(operationDirectory, 'candidate-not-applied.sqlite');
      if (!(await exists(preservedCandidate)))
        await rename(temporaryRestorePath, preservedCandidate);
    }
    if (error instanceof PersistenceRuntimeError && error.code === 'BACKUP_NOT_ALLOWED')
      throw error;
    throw new PersistenceRuntimeError('DATABASE_RESTORE_FAILED');
  }
};
