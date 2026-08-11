import { describe, expect, it } from 'vitest';

import type {
  CompiledSchemaRegistry,
  LockedSchemaResource,
  SchemaLockRecord,
  SchemaManifestRecord,
  SchemaManifestRepositoryPort,
  SchemaManifestUnitOfWorkPort,
  SchemaRegistryPort,
  SchemaResourcePort,
} from '../ports/schema-registry';
import { SchemaRegistryOperationError } from '../ports/schema-registry/schema-registry-operation-error';
import { SchemaRegistryStartupService } from './schema-registry-startup-service';

const LOCKS: readonly SchemaLockRecord[] = Object.freeze(
  ['a', 'b', 'c', 'd'].map((name) =>
    Object.freeze({
      draft: 'https://json-schema.org/draft/2020-12/schema',
      resourceName: `${name}.schema.json`,
      schemaId: `https://jingxu.studio/schemas/${name}/1.0.0`,
      semanticVersion: '1.0.0',
      sha256: name.repeat(64),
    }),
  ),
);

const RESOURCES: readonly LockedSchemaResource[] = LOCKS.map((lock) => ({
  bytes: Object.freeze([123, 125]),
  resourceName: lock.resourceName,
}));

class FakeResourcePort implements SchemaResourcePort {
  public error: Error | undefined;
  public readonly events: string[];

  public constructor(events: string[]) {
    this.events = events;
  }

  public readAllLocked(): Promise<readonly LockedSchemaResource[]> {
    this.events.push('resources.read');
    return this.error === undefined ? Promise.resolve(RESOURCES) : Promise.reject(this.error);
  }
}

class FakeRegistryPort implements SchemaRegistryPort {
  public compileError: Error | undefined;
  public publishCalls = 0;
  public readonly events: string[];
  readonly #compiled: CompiledSchemaRegistry = {
    schemaIds: LOCKS.map((lock) => lock.schemaId),
    validate: (schemaId) => ({ issues: [], schemaId, valid: true }),
  };

  public constructor(events: string[]) {
    this.events = events;
  }

  public publish(registry: CompiledSchemaRegistry): void {
    expect(registry).toBe(this.#compiled);
    this.events.push('registry.publish');
    this.publishCalls += 1;
  }

  public verifyAndCompile(): Promise<CompiledSchemaRegistry> {
    this.events.push('registry.verify');
    return this.compileError === undefined
      ? Promise.resolve(this.#compiled)
      : Promise.reject(this.compileError);
  }
}

class FakeManifestRepository implements SchemaManifestRepositoryPort {
  public findError: Error | undefined;
  public replaceError: Error | undefined;
  public rows: readonly SchemaManifestRecord[] = [];
  public readonly events: string[];

  public constructor(events: string[]) {
    this.events = events;
  }

  public findEnabled(): Promise<readonly SchemaManifestRecord[]> {
    this.events.push('manifest.find');
    return this.findError === undefined
      ? Promise.resolve(this.rows)
      : Promise.reject(this.findError);
  }

  public replaceAll(records: readonly SchemaManifestRecord[]): Promise<void> {
    this.events.push('manifest.replace');
    if (this.replaceError !== undefined) return Promise.reject(this.replaceError);
    this.rows = records.map((record) => ({ ...record }));
    return Promise.resolve();
  }
}

class FakeManifestUnitOfWork implements SchemaManifestUnitOfWorkPort {
  public readonly events: string[];
  public readonly repository: FakeManifestRepository;

  public constructor(events: string[], repository: FakeManifestRepository) {
    this.events = events;
    this.repository = repository;
  }

  public async run<T>(work: (repository: SchemaManifestRepositoryPort) => Promise<T>): Promise<T> {
    this.events.push('uow.begin');
    const result = await work(this.repository);
    this.events.push('uow.commit');
    return result;
  }
}

const setup = () => {
  const events: string[] = [];
  const resources = new FakeResourcePort(events);
  const registry = new FakeRegistryPort(events);
  const repository = new FakeManifestRepository(events);
  const unitOfWork = new FakeManifestUnitOfWork(events, repository);
  const service = new SchemaRegistryStartupService({
    locks: LOCKS,
    manifestUnitOfWork: unitOfWork,
    registry,
    resources,
  });
  return { events, registry, repository, resources, service };
};

describe('SchemaRegistryStartupService', () => {
  it('四资源有效—执行完整启动阶段—证据提交后才发布 Registry', async () => {
    const { events, repository, service } = setup();

    await expect(service.prepare()).resolves.toMatchObject({ ok: true });

    expect(events).toEqual([
      'resources.read',
      'registry.verify',
      'uow.begin',
      'manifest.replace',
      'manifest.find',
      'uow.commit',
      'registry.publish',
    ]);
    expect(repository.rows).toHaveLength(4);
    expect(repository.rows.every((row) => row.enabled)).toBe(true);
  });

  it.each([
    ['resource', new SchemaRegistryOperationError('SCHEMA_HASH_MISMATCH')],
    ['compile', new SchemaRegistryOperationError('SCHEMA_REFERENCE_UNRESOLVED')],
    ['replace', new Error('C:\\secret\\database.sqlite SQL INSERT failed')],
    ['readback', new Error('raw row leaked')],
  ] as const)('%s 阶段失败—执行启动阶段—不发布且返回安全稳定错误', async (stage, error) => {
    const { registry, repository, resources, service } = setup();
    if (stage === 'resource') resources.error = error;
    if (stage === 'compile') registry.compileError = error;
    if (stage === 'replace') repository.replaceError = error;
    if (stage === 'readback') repository.findError = error;

    const result = await service.prepare();

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.failure.allowedActions).toEqual(['RETRY']);
      expect(result.failure.phase).toBe('SCHEMA_REGISTRY');
      expect(result.failure.summary).not.toContain('secret');
      expect(result.failure.summary).not.toContain('SQL');
    }
    expect(registry.publishCalls).toBe(0);
  });

  it('证据读回缺少一条—核对静态清单—拒绝发布并归一化为证据写入失败', async () => {
    const { registry, repository, service } = setup();
    const originalFind = repository.findEnabled.bind(repository);
    repository.findEnabled = async () => (await originalFind()).slice(0, 3);

    await expect(service.prepare()).resolves.toMatchObject({
      failure: { errorCode: 'SCHEMA_EVIDENCE_WRITE_FAILED' },
      ok: false,
    });
    expect(registry.publishCalls).toBe(0);
  });

  it('相同锁与资源重复运行—完成启动阶段—提交完全相同的确定性 manifest', async () => {
    const first = setup();
    const second = setup();

    const [firstResult, secondResult] = await Promise.all([
      first.service.prepare(),
      second.service.prepare(),
    ]);

    expect(firstResult).toEqual(secondResult);
    expect(first.repository.rows).toEqual(second.repository.rows);
  });
});
