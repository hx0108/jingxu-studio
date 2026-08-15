import { createHash } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PersistenceRuntimeError } from '../runtime/persistence-error';
import { createContentAddressedStore } from './content-addressed-store';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OTHER_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

const withRoot = async <T>(operation: (root: string) => Promise<T> | T): Promise<T> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-media-store-'));
  try {
    return await operation(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

/** Windows 无开发者模式时 symlink 需要特权；能力探测失败则跳过相关断言并显式注明。 */
const canCreateSymlinks = async (root: string): Promise<boolean> => {
  const target = path.join(root, 'target.bin');
  const link = path.join(root, 'link.bin');
  await writeFile(target, 'x');
  try {
    await symlink(target, link);
    return true;
  } catch {
    return false;
  }
};

describe('createContentAddressedStore', () => {
  it('写入—读取回环：路径形态/描述符/字节一致', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root);
      const stored = await store.write({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        namespace: 'images',
        projectId: 'project_media',
      });
      expect(stored.storageRelPath).toMatch(
        /^projects\/project_media\/images\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/u,
      );
      expect(stored.byteSize).toBe(PNG_BYTES.byteLength);
      expect(stored.mimeType).toBe('image/png');
      expect(new Uint8Array(await store.read(stored.storageRelPath))).toEqual(PNG_BYTES);
      // 文件确实落在 managed root 内的规范相对路径上。
      const expectedAbsolute = path.join(root, ...stored.storageRelPath.split('/'));
      await expect(store.resolvePathWithinProjects(stored.storageRelPath)).resolves.toBe(
        await realpath(expectedAbsolute),
      );
    });
  });

  it('同字节去重、异字节分址：永不覆盖既有内容', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root);
      const first = await store.write({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        namespace: 'images',
        projectId: 'project_media',
      });
      const again = await store.write({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        namespace: 'images',
        projectId: 'project_media',
      });
      expect(again.storageRelPath).toBe(first.storageRelPath);
      const other = await store.write({
        bytes: OTHER_PNG_BYTES,
        mimeType: 'image/png',
        namespace: 'images',
        projectId: 'project_media',
      });
      expect(other.storageRelPath).not.toBe(first.storageRelPath);
      // 资产命名空间与 mime 扩展映射。
      const asset = await store.write({
        bytes: OTHER_PNG_BYTES,
        mimeType: 'image/webp',
        namespace: 'assets',
        projectId: 'project_media',
      });
      expect(asset.storageRelPath).toMatch(/\/assets\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/u);
    });
  });

  it('临时文件校验失败—清理残留并以稳定错误码失败', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root, {
        // 注入损坏写入：落盘字节与内存哈希不一致。
        writeFileImpl: async (filePath, bytes) => {
          const corrupted = new Uint8Array(bytes);
          const lastIndex = bytes.length - 1;
          corrupted.set([(bytes[lastIndex] ?? 0) ^ 0xff], lastIndex);
          await writeFile(filePath, corrupted);
        },
      });
      await expect(
        store.write({
          bytes: PNG_BYTES,
          mimeType: 'image/png',
          namespace: 'images',
          projectId: 'project_media',
        }),
      ).rejects.toMatchObject({ code: 'MEDIA_STORE_CHECKSUM_MISMATCH' });
      // 失败清理：分片目录保留，但其中不残留 .tmp，也未登记最终文件。
      const shard = createHash('sha256').update(PNG_BYTES).digest('hex').slice(0, 2);
      expect(await readdir(path.join(root, 'projects', 'project_media', 'images', shard))).toEqual(
        [],
      );
    });
  });

  it('非法输入—mime 不支持或 projectId 形态非法—稳定错误码拒绝', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root);
      await expect(
        store.write({
          bytes: PNG_BYTES,
          mimeType: 'image/gif',
          namespace: 'images',
          projectId: 'project_media',
        }),
      ).rejects.toMatchObject({ code: 'MEDIA_STORE_MIME_UNSUPPORTED' });
      for (const projectId of ['../evil', 'a b', '', '.hidden']) {
        await expect(
          store.write({
            bytes: PNG_BYTES,
            mimeType: 'image/png',
            namespace: 'images',
            projectId,
          }),
        ).rejects.toMatchObject({ code: 'MEDIA_STORE_PROJECT_INVALID' });
      }
    });
  });

  it('读取路径—越界/绝对路径/形态非法—稳定错误码拒绝', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root);
      for (const badPath of [
        'projects/../secrets/key.bin',
        `projects/project_media/images/${'a'.repeat(64)}.png`,
        'images/ab/hash.png',
        path.join(root, 'projects', 'project_media', 'images', 'ab', `${'a'.repeat(64)}.png`),
        'projects/project_media/images/ab/short.png',
      ]) {
        await expect(store.read(badPath), badPath).rejects.toBeInstanceOf(PersistenceRuntimeError);
        await expect(store.resolvePathWithinProjects(badPath), badPath).rejects.toBeInstanceOf(
          PersistenceRuntimeError,
        );
      }
    });
  });

  it('符号链接逃逸—终节点或中间目录指向 projects 根外—PATH_ESCAPE 拒绝', async () => {
    await withRoot(async (root) => {
      if (!(await canCreateSymlinks(root))) {
        // Windows 无特权时无法创建符号链接，无法在本机验证该防线；跳过必须显式可见
        // 而非静默通过（CI/Linux 环境会执行完整断言）。
        console.info('symlink privilege unavailable — MEDIA_STORE_PATH_ESCAPE assertions skipped');
        return;
      }
      const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'jingxu-media-outside-'));
      try {
        const store = createContentAddressedStore(root);
        const stored = await store.write({
          bytes: PNG_BYTES,
          mimeType: 'image/png',
          namespace: 'images',
          projectId: 'project_media',
        });
        const absoluteFinal = path.join(root, ...stored.storageRelPath.split('/'));
        const outsideFile = path.join(outsideRoot, 'evil.png');
        await writeFile(outsideFile, PNG_BYTES);
        // 终节点符号链接指向根外。
        await rm(absoluteFinal);
        await symlink(outsideFile, absoluteFinal);
        await expect(store.read(stored.storageRelPath)).rejects.toMatchObject({
          code: 'MEDIA_STORE_PATH_ESCAPE',
        });
        await expect(store.resolvePathWithinProjects(stored.storageRelPath)).rejects.toMatchObject({
          code: 'MEDIA_STORE_PATH_ESCAPE',
        });
        // 中间目录符号链接指向根外。
        await rm(absoluteFinal);
        const namespaceDirectory = path.dirname(path.dirname(absoluteFinal));
        await rm(namespaceDirectory, { force: true, recursive: true });
        await symlink(outsideRoot, namespaceDirectory);
        await expect(store.read(stored.storageRelPath)).rejects.toMatchObject({
          code: 'MEDIA_STORE_PATH_ESCAPE',
        });
      } finally {
        await rm(outsideRoot, { force: true, recursive: true });
      }
    });
  });

  it('磁盘上现存文件被篡改—读取按文件名哈希复算—CHECKSUM_MISMATCH 拒绝', async () => {
    await withRoot(async (root) => {
      const store = createContentAddressedStore(root);
      const stored = await store.write({
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        namespace: 'images',
        projectId: 'project_media',
      });
      const absoluteFinal = path.join(root, ...stored.storageRelPath.split('/'));
      await writeFile(absoluteFinal, new Uint8Array([1, 2, 3]));
      await expect(store.read(stored.storageRelPath)).rejects.toMatchObject({
        code: 'MEDIA_STORE_CHECKSUM_MISMATCH',
      });
      // 再次写入同字节：现存损坏文件被识别，不允许静默去重通过。
      await expect(
        store.write({
          bytes: PNG_BYTES,
          mimeType: 'image/png',
          namespace: 'images',
          projectId: 'project_media',
        }),
      ).rejects.toMatchObject({ code: 'MEDIA_STORE_CHECKSUM_MISMATCH' });
    });
  });
});
