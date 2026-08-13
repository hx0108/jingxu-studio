import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { SchemaRegistryOperationError } from '@jingxu/application';

import type { LockedSchemaResource, SchemaResourcePort } from '@jingxu/application';

const REQUIRED_RESOURCE_COUNT = 4;
const LOGICAL_RESOURCE_NAME = /^[A-Za-z][A-Za-z0-9]*\.schema\.json$/u;

export type SchemaResourceAdapterErrorCode = 'SCHEMA_MANIFEST_INVALID' | 'SCHEMA_RESOURCE_MISSING';

/** Main 资源边界的稳定脱敏错误，不携带本地路径或底层文件系统信息。 */
export class SchemaResourceAdapterError extends SchemaRegistryOperationError {
  public constructor(code: SchemaResourceAdapterErrorCode) {
    super(code);
    this.name = 'SchemaResourceAdapterError';
  }
}

interface SchemaResourceDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface SchemaResourceStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SchemaResourceFilesystem {
  lstat(target: string): Promise<SchemaResourceStats>;
  readDirectory(directory: string): Promise<readonly SchemaResourceDirectoryEntry[]>;
  readBytes(target: string): Promise<Uint8Array>;
  realpath(target: string): Promise<string>;
}

const nodeFilesystem: SchemaResourceFilesystem = {
  lstat: (target) => lstat(target),
  readDirectory: (directory) => readdir(directory, { withFileTypes: true }),
  readBytes: (target) => readFile(target),
  realpath: (target) => realpath(target),
};

export interface SchemaResourceAdapterOptions {
  /** 只允许 Main 从构建配置派生后注入；不得来自 Renderer、环境变量或用户输入。 */
  readonly resourceDirectory: string;
  /** 来自静态 V1 锁清单的四个 ASCII 逻辑资源名。 */
  readonly resourceNames: readonly string[];
  readonly filesystem?: SchemaResourceFilesystem;
}

export interface SchemaResourceEnvironment {
  /** Electron `app.getAppPath()` 的返回值。 */
  readonly appPath: string;
  /** Electron `app.isPackaged` 的返回值。 */
  readonly isPackaged: boolean;
  /** Electron `process.resourcesPath` 的返回值。 */
  readonly resourcesPath: string;
}

/**
 * 由 Electron 的受信运行时位置派生固定 Schema 目录；不读取环境变量或任意外部路径配置。
 */
export const deriveSchemaResourceDirectory = ({
  appPath,
  isPackaged,
  resourcesPath,
}: SchemaResourceEnvironment): string =>
  isPackaged
    ? path.join(path.resolve(resourcesPath), 'schemas', 'v1')
    : path.resolve(appPath, '../../packages/validation/resources/schemas/v1');

const isContainedBy = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const isValidResourceNames = (resourceNames: readonly string[]): boolean =>
  resourceNames.length === REQUIRED_RESOURCE_COUNT &&
  new Set(resourceNames).size === REQUIRED_RESOURCE_COUNT &&
  resourceNames.every(
    (resourceName) =>
      LOGICAL_RESOURCE_NAME.test(resourceName) && path.basename(resourceName) === resourceName,
  );

const invalidManifest = (): SchemaResourceAdapterError =>
  new SchemaResourceAdapterError('SCHEMA_MANIFEST_INVALID');

const resourceMissing = (): SchemaResourceAdapterError =>
  new SchemaResourceAdapterError('SCHEMA_RESOURCE_MISSING');

/**
 * 从 Main 注入的固定目录读取恰好四份锁定 Schema。调用方不能传入路径或单个资源名，且每次
 * 调用都返回新的冻结数字序列，避免跨层暴露可变 Buffer。
 */
export class SchemaResourceAdapter implements SchemaResourcePort {
  readonly #filesystem: SchemaResourceFilesystem;
  readonly #resourceDirectory: string;
  readonly #resourceNames: readonly string[];

  public constructor({
    filesystem = nodeFilesystem,
    resourceDirectory,
    resourceNames,
  }: SchemaResourceAdapterOptions) {
    if (!isValidResourceNames(resourceNames)) throw invalidManifest();
    this.#filesystem = filesystem;
    this.#resourceDirectory = path.resolve(resourceDirectory);
    this.#resourceNames = Object.freeze([...resourceNames]);
  }

  public async readAllLocked(): Promise<readonly LockedSchemaResource[]> {
    try {
      const rootStats = await this.#filesystem.lstat(this.#resourceDirectory);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw invalidManifest();

      const entries = await this.#filesystem.readDirectory(this.#resourceDirectory);
      const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
      if (this.#resourceNames.some((resourceName) => !entriesByName.has(resourceName))) {
        throw resourceMissing();
      }
      if (entries.length !== this.#resourceNames.length) throw invalidManifest();

      const realRoot = await this.#filesystem.realpath(this.#resourceDirectory);
      const resources = await Promise.all(
        this.#resourceNames.map(async (resourceName): Promise<LockedSchemaResource> => {
          const entry = entriesByName.get(resourceName);
          if (
            entry === undefined ||
            !entry.isFile() ||
            entry.isDirectory() ||
            entry.isSymbolicLink()
          ) {
            throw invalidManifest();
          }

          const target = path.join(this.#resourceDirectory, resourceName);
          if (!isContainedBy(this.#resourceDirectory, target)) throw invalidManifest();
          const targetStats = await this.#filesystem.lstat(target);
          if (!targetStats.isFile() || targetStats.isSymbolicLink()) throw invalidManifest();
          const realTarget = await this.#filesystem.realpath(target);
          if (!isContainedBy(realRoot, realTarget)) throw invalidManifest();

          const bytes = Object.freeze(Array.from(await this.#filesystem.readBytes(target)));
          return Object.freeze({ bytes, resourceName });
        }),
      );
      return Object.freeze(resources);
    } catch (error) {
      if (error instanceof SchemaResourceAdapterError) throw error;
      throw resourceMissing();
    }
  }
}
