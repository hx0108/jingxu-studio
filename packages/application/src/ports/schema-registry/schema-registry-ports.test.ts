import { describe, expectTypeOf, it } from 'vitest';

import type {
  CompiledSchemaRegistry,
  SchemaLockRecord,
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
  SchemaRegistryPort,
  SchemaRegistryStartupPort,
  SchemaResourcePort,
  SchemaValidationResult,
} from './index';

describe('Schema Registry Application Ports', () => {
  it('公开边界—检查 Port 签名—由 Application 持有证据事务和发布顺序', () => {
    expectTypeOf<SchemaResourcePort>().toHaveProperty('readAllLocked');
    expectTypeOf<SchemaRegistryPort>().toHaveProperty('verifyAndCompile');
    expectTypeOf<SchemaRegistryPort>().toHaveProperty('publish');
    expectTypeOf<SchemaManifestRepositoryPort>().toHaveProperty('replaceAll');
    expectTypeOf<SchemaManifestRepositoryPort>().toHaveProperty('findEnabled');
    expectTypeOf<SchemaManifestUnitOfWorkPort>().toHaveProperty('run');
    expectTypeOf<SchemaRegistryStartupPort>().toHaveProperty('prepare');
  });

  it('验证结果—检查公开类型—只包含布尔结果和有界结构化问题', () => {
    expectTypeOf<SchemaValidationResult>().toEqualTypeOf<
      | Readonly<{ schemaId: string; valid: true; issues: readonly [] }>
      | Readonly<{
          schemaId: string;
          valid: false;
          issues: readonly Readonly<{
            instancePath: string;
            keyword: string;
            messageCode: string;
          }>[];
        }>
    >();
  });

  it('锁和编译结果—检查公开类型—不暴露路径、Ajv 或数据库对象', () => {
    expectTypeOf<SchemaLockRecord>().toHaveProperty('schemaId');
    expectTypeOf<CompiledSchemaRegistry>().toHaveProperty('validate');
  });
});
