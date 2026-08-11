import type { SchemaRegistryCheckResult } from './schema-registry-types';

/** StartupService 调用的完整 Schema 自检阶段。 */
export interface SchemaRegistryStartupPort {
  /** 从资源读取开始执行完整自检，并返回有界结果。 */
  prepare(): Promise<SchemaRegistryCheckResult>;
}
