import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PersistenceRuntimeError } from '../runtime/persistence-error';

const MIGRATION_FILE_PATTERN = /^(?<version>\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export interface MigrationResource {
  readonly name: string;
  readonly rawBytes: Uint8Array;
  readonly sha256: string;
  readonly sql: string;
  readonly version: number;
}

const invalidSet = (): never => {
  throw new PersistenceRuntimeError('MIGRATION_SEQUENCE_INVALID');
};

export const loadMigrationSet = async (
  directory: string,
): Promise<readonly MigrationResource[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return invalidSet();
  }

  const parsed = entries.map((entry) => {
    if (!entry.isFile()) return invalidSet();
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match?.groups?.version === undefined) return invalidSet();
    return { name: entry.name, version: Number.parseInt(match.groups.version, 10) };
  });
  parsed.sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
  if (
    parsed.length === 0 ||
    parsed.some(({ version }, index) => version !== index + 1) ||
    new Set(parsed.map(({ version }) => version)).size !== parsed.length
  ) {
    return invalidSet();
  }

  return Promise.all(
    parsed.map(async ({ name, version }) => {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(path.join(directory, name));
      } catch {
        return invalidSet();
      }
      if (bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
        return invalidSet();
      }

      let sql: string;
      try {
        sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return invalidSet();
      }
      return {
        name,
        rawBytes: bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sql,
        version,
      } satisfies MigrationResource;
    }),
  );
};
