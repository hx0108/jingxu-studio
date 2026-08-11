import type { SchemaManifestRepositoryPort } from './schema-manifest-repository-port';

/** 由 Application 拥有的 Schema manifest 短事务边界。 */
export interface SchemaManifestUnitOfWorkPort {
  /** 在同一事务内运行回调；回调抛错时必须回滚。 */
  run<T>(work: (repository: SchemaManifestRepositoryPort) => Promise<T>): Promise<T>;
}
