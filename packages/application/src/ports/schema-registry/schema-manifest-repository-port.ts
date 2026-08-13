import type { SchemaManifestRecord } from './schema-registry-types';

/** 仅在所属 Schema manifest UnitOfWork 回调内有效的事务内 Repository。 */
export interface SchemaManifestRepositoryPort {
  /** 返回全部启用证据，按 schemaId 稳定排序。 */
  findEnabled(): Promise<readonly SchemaManifestRecord[]>;
  /** 恰好替换本构建的全部 manifest 证据；不自行提交。 */
  replaceAll(records: readonly SchemaManifestRecord[]): Promise<void>;
}
