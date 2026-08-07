import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface SqliteTestContext {
  readonly clock: () => string;
  readonly createId: (prefix: string) => string;
  readonly root: string;
}

export const FIXED_TEST_TIME = '2026-08-07T00:00:00.000Z';

export const withSqliteTestContext = async <T>(
  operation: (context: SqliteTestContext) => Promise<T> | T,
): Promise<T> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-sqlite-test-'));
  let idSequence = 0;
  const context: SqliteTestContext = {
    clock: () => FIXED_TEST_TIME,
    createId: (prefix) => `${prefix}_${String(++idSequence).padStart(4, '0')}`,
    root,
  };

  try {
    return await operation(context);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
