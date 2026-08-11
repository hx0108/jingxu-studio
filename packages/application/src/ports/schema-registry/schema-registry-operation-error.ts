import type { SchemaStartupErrorCode } from './schema-registry-types';

const SAFE_SUMMARIES: Readonly<Record<SchemaStartupErrorCode, string>> = Object.freeze({
  SCHEMA_COMPILE_FAILED: 'Schema 编译未通过，请检查内置资源后重试。',
  SCHEMA_DRAFT_MISMATCH: 'Schema Draft 与当前构建不一致，请修复资源后重试。',
  SCHEMA_EVIDENCE_WRITE_FAILED: 'Schema 核验凭据未能提交，请重试启动检查。',
  SCHEMA_HASH_MISMATCH: 'Schema 资源完整性检查未通过，请修复资源后重试。',
  SCHEMA_ID_MISMATCH: 'Schema 标识与当前构建不一致，请修复资源后重试。',
  SCHEMA_MANIFEST_INVALID: 'Schema 清单无效，请修复当前构建后重试。',
  SCHEMA_REFERENCE_UNRESOLVED: 'Schema 引用无法在离线清单中解析，请修复资源后重试。',
  SCHEMA_RESOURCE_INVALID_JSON: 'Schema 资源格式无效，请修复资源后重试。',
  SCHEMA_RESOURCE_MISSING: 'Schema 资源缺失，请修复安装后重试。',
  SCHEMA_VERSION_MISMATCH: 'Schema 版本与当前构建不一致，请修复资源后重试。',
});

/** Adapter 用于向 Application 传递稳定分类的安全 Schema 启动错误。 */
export class SchemaRegistryOperationError extends Error {
  public readonly code: SchemaStartupErrorCode;

  public constructor(code: SchemaStartupErrorCode) {
    super(SAFE_SUMMARIES[code]);
    this.name = 'SchemaRegistryOperationError';
    this.code = code;
  }
}
