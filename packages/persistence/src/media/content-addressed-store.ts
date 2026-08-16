import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { PersistenceRuntimeError } from '../runtime/persistence-error';

/** 媒体命名空间：生成候选图与资产参考图共用同一内容寻址布局（design D3）。 */
export type MediaNamespace = 'images' | 'assets';

export interface StoredMediaFile {
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256: string;
  /** 持久化形态恒为 POSIX 分隔符（跨平台稳定），解析时再按平台拼接。 */
  readonly storageRelPath: string;
}

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

/** storage_rel_path 的规范形态；白名单字符集本身排除 `..` 与分隔符注入。 */
const STORAGE_REL_PATH_PATTERN =
  /^projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(images|assets)\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpg|webp)$/u;

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const toAbsolutePath = (managedRoot: string, storageRelPath: string): string =>
  path.join(managedRoot, ...storageRelPath.split('/'));

const syncFile = async (filePath: string): Promise<void> => {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export interface ContentAddressedStore {
  /** 写入字节：内存哈希 → 临时文件落盘+fsync → 复算校验 → 原子 rename → 登记描述符。 */
  readonly write: (input: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly namespace: MediaNamespace;
    readonly projectId: string;
  }) => Promise<StoredMediaFile>;
  /** 读回字节并按文件名哈希复算校验（损坏即抛错，不静默返回脏数据）。 */
  readonly read: (storageRelPath: string) => Promise<Uint8Array>;
  /** 供受限协议处理器解析绝对路径：拒绝符号链接与 projects 根逃逸。 */
  readonly resolvePathWithinProjects: (storageRelPath: string) => Promise<string>;
}

export interface ContentAddressedStoreOptions {
  /** 测试注入点：替换底层字节写入以模拟校验失败（沿 backupDatabase 注入模式）。 */
  readonly writeFileImpl?: (filePath: string, bytes: Uint8Array) => Promise<void>;
}

/** 由 (projectId, namespace, sha256, mimeType) 派生规范相对路径；非法输入抛稳定错误。 */
export const deriveMediaStorageRelPath = (input: {
  readonly fileSha256: string;
  readonly mimeType: string;
  readonly namespace: MediaNamespace;
  readonly projectId: string;
}): string => {
  const extension = MIME_TO_EXTENSION[input.mimeType];
  if (extension === undefined) {
    throw new PersistenceRuntimeError('MEDIA_STORE_MIME_UNSUPPORTED');
  }
  if (!PROJECT_ID_PATTERN.test(input.projectId)) {
    throw new PersistenceRuntimeError('MEDIA_STORE_PROJECT_INVALID');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.fileSha256)) {
    throw new PersistenceRuntimeError('MEDIA_STORE_INVALID_PATH');
  }
  return `projects/${input.projectId}/${input.namespace}/${input.fileSha256.slice(0, 2)}/${input.fileSha256}.${extension}`;
};

export const createContentAddressedStore = (
  managedRoot: string,
  options: ContentAddressedStoreOptions = {},
): ContentAddressedStore => {
  const projectsRoot = path.resolve(managedRoot, 'projects');
  const writeFileImpl = options.writeFileImpl ?? writeFile;

  const validateStorageRelPath = (storageRelPath: string): string => {
    if (!STORAGE_REL_PATH_PATTERN.test(storageRelPath)) {
      throw new PersistenceRuntimeError('MEDIA_STORE_INVALID_PATH');
    }
    return storageRelPath;
  };

  const assertNoEscape = async (absolutePath: string): Promise<string> => {
    let linkStat;
    try {
      linkStat = await lstat(absolutePath);
    } catch {
      throw new PersistenceRuntimeError('MEDIA_STORE_PATH_ESCAPE');
    }
    if (linkStat.isSymbolicLink()) {
      throw new PersistenceRuntimeError('MEDIA_STORE_PATH_ESCAPE');
    }
    const [projectsRealPath, targetRealPath] = await Promise.all([
      realpath(projectsRoot),
      realpath(path.dirname(absolutePath)).then((directory) =>
        realpath(path.join(directory, path.basename(absolutePath))),
      ),
    ]);
    if (!isWithin(projectsRealPath, targetRealPath)) {
      throw new PersistenceRuntimeError('MEDIA_STORE_PATH_ESCAPE');
    }
    return targetRealPath;
  };

  return {
    write: async ({ bytes, mimeType, namespace, projectId }) => {
      const sha256 = sha256Of(bytes);
      const storageRelPath = deriveMediaStorageRelPath({
        fileSha256: sha256,
        mimeType,
        namespace,
        projectId,
      });
      const absoluteFinal = toAbsolutePath(managedRoot, storageRelPath);
      if (!isWithin(projectsRoot, absoluteFinal)) {
        throw new PersistenceRuntimeError('MEDIA_STORE_INVALID_PATH');
      }
      const temporaryPath = `${absoluteFinal}.tmp`;
      try {
        // 已存在即同字节去重（内容寻址文件名保证）；校验现存文件未损坏后直接返回。
        if (
          await access(absoluteFinal).then(
            () => true,
            () => false,
          )
        ) {
          const existing = await readFile(absoluteFinal);
          if (sha256Of(existing) !== sha256) {
            throw new PersistenceRuntimeError('MEDIA_STORE_CHECKSUM_MISMATCH');
          }
          return { byteSize: bytes.byteLength, mimeType, sha256, storageRelPath };
        }
        await mkdir(path.dirname(absoluteFinal), { recursive: true });
        await writeFileImpl(temporaryPath, bytes);
        await syncFile(temporaryPath);
        const persisted = await readFile(temporaryPath);
        if (sha256Of(persisted) !== sha256) {
          throw new PersistenceRuntimeError('MEDIA_STORE_CHECKSUM_MISMATCH');
        }
        // rename 前再查一次：并发同内容写入已落位时不重复登记。
        if (
          await access(absoluteFinal).then(
            () => true,
            () => false,
          )
        ) {
          await rm(temporaryPath, { force: true });
          return { byteSize: bytes.byteLength, mimeType, sha256, storageRelPath };
        }
        await rename(temporaryPath, absoluteFinal);
        return { byteSize: bytes.byteLength, mimeType, sha256, storageRelPath };
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof PersistenceRuntimeError) {
          throw error;
        }
        throw new PersistenceRuntimeError('MEDIA_STORE_WRITE_FAILED');
      }
    },

    read: async (storageRelPath) => {
      const absolutePath = toAbsolutePath(managedRoot, validateStorageRelPath(storageRelPath));
      const realPath = await assertNoEscape(absolutePath);
      const bytes = await readFile(realPath);
      const expected = STORAGE_REL_PATH_PATTERN.exec(storageRelPath)?.[4];
      if (expected === undefined || sha256Of(bytes) !== expected) {
        throw new PersistenceRuntimeError('MEDIA_STORE_CHECKSUM_MISMATCH');
      }
      return bytes;
    },

    resolvePathWithinProjects: async (storageRelPath) => {
      const absolutePath = toAbsolutePath(managedRoot, validateStorageRelPath(storageRelPath));
      return assertNoEscape(absolutePath);
    },
  };
};
