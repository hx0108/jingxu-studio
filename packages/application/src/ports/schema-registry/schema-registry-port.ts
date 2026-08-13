import type {
  CompiledSchemaRegistry,
  LockedSchemaResource,
  SchemaLockRecord,
} from './schema-registry-types';

/** 离线验证、编译和原子发布正式 Schema Registry 的 Application Port。 */
export interface SchemaRegistryPort {
  /** 发布已验证 Registry；在证据事务成功前不得调用。 */
  publish(registry: CompiledSchemaRegistry): void;
  /** 以静态锁和资源字节构建尚未发布的 Registry。 */
  verifyAndCompile(
    locks: readonly SchemaLockRecord[],
    resources: readonly LockedSchemaResource[],
  ): Promise<CompiledSchemaRegistry>;
}
