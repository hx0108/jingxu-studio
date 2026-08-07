import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { PersistenceRuntimeError } from './persistence-error';

const BACKUP_ID_PATTERN = /^backup_[A-Za-z0-9_-]{8,128}$/u;

export interface ManagedPaths {
  readonly backupDirectory: string;
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly diagnosticDirectory: string;
  readonly root: string;
}

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

export const assertManagedRealPaths = (
  rootRealPath: string,
  childRealPaths: readonly string[],
): void => {
  if (childRealPaths.some((candidate) => !isWithin(rootRealPath, candidate))) {
    throw new PersistenceRuntimeError('MANAGED_PATH_INVALID');
  }
};

export const deriveWindowsProductionRoot = (localAppData: string, platform: string): string => {
  if (platform !== 'win32' || localAppData.trim() === '' || !path.win32.isAbsolute(localAppData)) {
    throw new PersistenceRuntimeError('LOCALAPPDATA_ROOT_INVALID');
  }

  return path.win32.join(path.win32.normalize(localAppData), 'JingxuStudio');
};

export const createManagedPaths = (root: string): ManagedPaths => {
  if (root.trim() === '' || !path.isAbsolute(root)) {
    throw new PersistenceRuntimeError('MANAGED_PATH_INVALID');
  }

  const normalizedRoot = path.resolve(root);
  const dataDirectory = path.join(normalizedRoot, 'data');
  return {
    backupDirectory: path.join(normalizedRoot, 'backups'),
    dataDirectory,
    databasePath: path.join(dataDirectory, 'jingxu.sqlite'),
    diagnosticDirectory: path.join(normalizedRoot, 'diagnostics'),
    root: normalizedRoot,
  };
};

export const createManagedDirectories = async (paths: ManagedPaths): Promise<void> => {
  await mkdir(paths.root, { recursive: true });
  await Promise.all(
    [paths.dataDirectory, paths.backupDirectory, paths.diagnosticDirectory].map(async (directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const rootRealPath = await realpath(paths.root);
  const childRealPaths = await Promise.all(
    [paths.dataDirectory, paths.backupDirectory, paths.diagnosticDirectory].map(async (directory) =>
      realpath(directory),
    ),
  );
  assertManagedRealPaths(rootRealPath, childRealPaths);
};

export const resolveManagedBackupPath = (paths: ManagedPaths, backupId: string): string => {
  if (!BACKUP_ID_PATTERN.test(backupId)) {
    throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
  }

  const candidate = path.resolve(paths.backupDirectory, `${backupId}.sqlite`);
  if (!isWithin(paths.backupDirectory, candidate)) {
    throw new PersistenceRuntimeError('BACKUP_NOT_ALLOWED');
  }
  return candidate;
};
