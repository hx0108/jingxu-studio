import type { LockedSchemaResource } from './schema-registry-types';

/** 读取由 Main 固定目录派生的全部 V1 Schema 资源。 */
export interface SchemaResourcePort {
  /** 返回全新的只读资源快照；调用方不能指定路径或资源名。 */
  readAllLocked(): Promise<readonly LockedSchemaResource[]>;
}
