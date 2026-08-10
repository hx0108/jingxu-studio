import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  SchemaRegistryConfigurationError,
  V1_SCHEMA_IDS,
  assertValidSchemaLocks,
} from './schema-locks';

import type { ErrorObject, ValidateFunction } from 'ajv';
import type { V1SchemaId, V1SchemaLock } from './schema-locks';

const MAX_VALIDATION_ISSUES = 50;

export type SchemaRegistryBuildErrorCode =
  | 'SCHEMA_RESOURCE_MISSING'
  | 'SCHEMA_RESOURCE_INVALID_JSON'
  | 'SCHEMA_HASH_MISMATCH'
  | 'SCHEMA_ID_MISMATCH'
  | 'SCHEMA_DRAFT_MISMATCH'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'SCHEMA_MANIFEST_INVALID'
  | 'SCHEMA_REFERENCE_UNRESOLVED'
  | 'SCHEMA_COMPILE_FAILED';

export class SchemaRegistryBuildError extends Error {
  public readonly code: SchemaRegistryBuildErrorCode;

  public constructor(code: SchemaRegistryBuildErrorCode) {
    super('Schema Registry initialization failed.');
    this.name = 'SchemaRegistryBuildError';
    this.code = code;
  }
}

export interface LockedSchemaResource {
  readonly resourceName: string;
  readonly bytes: Uint8Array;
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly messageCode: string;
}

export type SchemaValidationResult =
  | Readonly<{ valid: true; issues: readonly [] }>
  | Readonly<{ valid: false; issues: readonly SchemaValidationIssue[] }>;

export interface SchemaRegistry {
  readonly schemaIds: readonly V1SchemaId[];
  validate(schemaId: string, value: unknown): SchemaValidationResult;
}

interface ParsedSchema {
  readonly lock: V1SchemaLock;
  readonly document: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const calculateSha256 = async (bytes: Uint8Array): Promise<string> => {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', stableBytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseDocument = (bytes: Uint8Array): Readonly<Record<string, unknown>> => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    if (!isRecord(document)) throw new Error('Schema document is not an object.');
    return document;
  } catch {
    throw new SchemaRegistryBuildError('SCHEMA_RESOURCE_INVALID_JSON');
  }
};

const readSchemaVersion = (document: Readonly<Record<string, unknown>>): unknown => {
  const properties = document.properties;
  if (!isRecord(properties)) return undefined;
  const schemaVersion = properties.schema_version;
  return isRecord(schemaVersion) ? schemaVersion.const : undefined;
};

const collectExternalReferences = (value: unknown, references: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectExternalReferences(item, references);
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (key === '$ref' && typeof nested === 'string' && !nested.startsWith('#')) {
      references.add(nested.split('#', 1)[0] ?? nested);
    } else {
      collectExternalReferences(nested, references);
    }
  }
};

const normalizeMessageCode = (keyword: string): string =>
  `SCHEMA_VALIDATION_${keyword.replace(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`;

const compareIssues = (left: SchemaValidationIssue, right: SchemaValidationIssue): number => {
  const leftKey = `${left.instancePath}\u0000${left.keyword}\u0000${left.messageCode}`;
  const rightKey = `${right.instancePath}\u0000${right.keyword}\u0000${right.messageCode}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

const mapValidationIssues = (errors: readonly ErrorObject[] | null | undefined) =>
  Object.freeze(
    (errors ?? [])
      .map((error) =>
        Object.freeze({
          instancePath: error.instancePath,
          keyword: error.keyword,
          messageCode: normalizeMessageCode(error.keyword),
        }),
      )
      .sort(compareIssues)
      .slice(0, MAX_VALIDATION_ISSUES),
  );

const createPublishedRegistry = (
  validators: ReadonlyMap<V1SchemaId, ValidateFunction>,
): SchemaRegistry => {
  const schemaIds = Object.freeze(Object.values(V1_SCHEMA_IDS));
  return Object.freeze({
    schemaIds,
    validate(schemaId: string, value: unknown): SchemaValidationResult {
      const validator = validators.get(schemaId as V1SchemaId);
      if (validator === undefined) {
        throw new SchemaRegistryConfigurationError('SCHEMA_ID_NOT_REGISTERED');
      }
      if (validator(value)) {
        const issues: readonly [] = Object.freeze([]);
        return Object.freeze({ valid: true, issues });
      }
      return Object.freeze({ valid: false, issues: mapValidationIssues(validator.errors) });
    },
  });
};

export const buildSchemaRegistry = async (
  locks: readonly V1SchemaLock[],
  resources: readonly LockedSchemaResource[],
): Promise<SchemaRegistry> => {
  try {
    assertValidSchemaLocks(locks);
  } catch {
    throw new SchemaRegistryBuildError('SCHEMA_MANIFEST_INVALID');
  }

  const resourceByName = new Map<string, Uint8Array>();
  for (const resource of resources) {
    if (resourceByName.has(resource.resourceName)) {
      throw new SchemaRegistryBuildError('SCHEMA_MANIFEST_INVALID');
    }
    resourceByName.set(resource.resourceName, Uint8Array.from(resource.bytes));
  }
  if (resourceByName.size !== locks.length) {
    const missing = locks.some((lock) => !resourceByName.has(lock.resourceName));
    throw new SchemaRegistryBuildError(
      missing ? 'SCHEMA_RESOURCE_MISSING' : 'SCHEMA_MANIFEST_INVALID',
    );
  }

  const parsed: ParsedSchema[] = [];
  for (const lock of locks) {
    const bytes = resourceByName.get(lock.resourceName);
    if (bytes === undefined) throw new SchemaRegistryBuildError('SCHEMA_RESOURCE_MISSING');
    const document = parseDocument(bytes);
    parsed.push({ lock, document });
  }

  const documentIds = parsed.map(({ document }) => document.$id);
  if (
    documentIds.some((schemaId) => typeof schemaId !== 'string') ||
    new Set(documentIds).size !== documentIds.length
  ) {
    throw new SchemaRegistryBuildError('SCHEMA_MANIFEST_INVALID');
  }

  for (const { lock, document } of parsed) {
    if (document.$id !== lock.schemaId) {
      throw new SchemaRegistryBuildError('SCHEMA_ID_MISMATCH');
    }
    if (document.$schema !== lock.draft) {
      throw new SchemaRegistryBuildError('SCHEMA_DRAFT_MISMATCH');
    }
    if (readSchemaVersion(document) !== lock.semanticVersion) {
      throw new SchemaRegistryBuildError('SCHEMA_VERSION_MISMATCH');
    }
    const bytes = resourceByName.get(lock.resourceName);
    if (bytes === undefined || (await calculateSha256(bytes)) !== lock.sha256) {
      throw new SchemaRegistryBuildError('SCHEMA_HASH_MISMATCH');
    }
  }

  const registeredIds = new Set(locks.map((lock) => lock.schemaId));
  for (const { document } of parsed) {
    const references = new Set<string>();
    collectExternalReferences(document, references);
    if ([...references].some((reference) => !registeredIds.has(reference as V1SchemaId))) {
      throw new SchemaRegistryBuildError('SCHEMA_REFERENCE_UNRESOLVED');
    }
  }

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      // The locked schemas use valid conditional subschemas that omit redundant `type` keywords.
      // Disabling this compile-time lint does not relax any runtime JSON Schema assertion.
      strictTypes: false,
      useDefaults: false,
      validateFormats: true,
    });
    addFormats(ajv);
    for (const { lock, document } of parsed) ajv.addSchema(document, lock.schemaId);

    const validators = new Map<V1SchemaId, ValidateFunction>();
    for (const schemaId of Object.values(V1_SCHEMA_IDS)) {
      const validator = ajv.getSchema(schemaId);
      if (validator === undefined) throw new Error('Schema compiler did not return a validator.');
      validators.set(schemaId, validator);
    }
    return createPublishedRegistry(validators);
  } catch {
    throw new SchemaRegistryBuildError('SCHEMA_COMPILE_FAILED');
  }
};
