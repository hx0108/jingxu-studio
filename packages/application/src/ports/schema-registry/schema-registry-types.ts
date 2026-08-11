import type { StartupErrorCode } from '@jingxu/contracts';

export interface SchemaLockRecord {
  readonly draft: string;
  readonly resourceName: string;
  readonly schemaId: string;
  readonly semanticVersion: string;
  readonly sha256: string;
}

/** Main 读取的受控 Schema 资源；只读数字序列避免跨层暴露可变 Buffer。 */
export interface LockedSchemaResource {
  readonly bytes: readonly number[];
  readonly resourceName: string;
}

export interface SchemaManifestRecord {
  readonly enabled: boolean;
  readonly resourceName: string;
  readonly schemaId: string;
  readonly semanticVersion: string;
  readonly sha256: string;
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly messageCode: string;
}

export type SchemaValidationResult =
  | Readonly<{ schemaId: string; valid: true; issues: readonly [] }>
  | Readonly<{ schemaId: string; valid: false; issues: readonly SchemaValidationIssue[] }>;

/** 已完整编译但尚未发布的不可变 Registry 能力。 */
export interface CompiledSchemaRegistry {
  readonly schemaIds: readonly string[];
  validate(schemaId: string, value: unknown): SchemaValidationResult;
}

export type SchemaStartupErrorCode = Extract<StartupErrorCode, `SCHEMA_${string}`>;

export interface SchemaStartupFailure {
  readonly allowedActions: readonly ['RETRY'];
  readonly errorCode: SchemaStartupErrorCode;
  readonly phase: 'SCHEMA_REGISTRY';
  readonly retryable: true;
  readonly summary: string;
}

export type SchemaRegistryCheckResult =
  | Readonly<{
      manifest: readonly SchemaManifestRecord[];
      ok: true;
    }>
  | Readonly<{
      failure: SchemaStartupFailure;
      ok: false;
    }>;
