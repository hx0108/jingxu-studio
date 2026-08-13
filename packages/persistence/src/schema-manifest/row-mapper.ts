import type { SchemaManifestRecord } from '@jingxu/application';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import type { SqliteOutputValue } from '../runtime/sqlite-database';

export type SchemaManifestRow = Readonly<Record<string, SqliteOutputValue>>;

const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const LOGICAL_RESOURCE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.schema\.json$/u;

const invalidRow = (): never => {
  throw new PersistenceRuntimeError('SCHEMA_MANIFEST_ROW_INVALID');
};

const requiredString = (value: SqliteOutputValue | undefined): string =>
  typeof value === 'string' && value.length > 0 ? value : invalidRow();

/** Maps a persistence-internal SQLite row to the bounded Application manifest record. */
export const mapSchemaManifestRow = (row: SchemaManifestRow): SchemaManifestRecord => {
  const schemaId = requiredString(row.schema_id);
  const semanticVersion = requiredString(row.semantic_version);
  const resourceName = requiredString(row.resource_path);
  const sha256 = requiredString(row.sha256);
  const enabled = row.enabled;

  if (!schemaId.startsWith('https://jingxu.studio/schemas/')) invalidRow();
  if (!SEMANTIC_VERSION.test(semanticVersion)) invalidRow();
  if (!LOGICAL_RESOURCE_NAME.test(resourceName)) invalidRow();
  if (!LOWERCASE_SHA256.test(sha256)) invalidRow();
  if (enabled !== 0 && enabled !== 1) invalidRow();

  return {
    enabled: enabled === 1,
    resourceName,
    schemaId,
    semanticVersion,
    sha256,
  };
};
