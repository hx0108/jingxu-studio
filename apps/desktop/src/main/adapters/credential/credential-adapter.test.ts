import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialAdapter, CredentialStorageError } from './credential-adapter';

const roots: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingxu-credential-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
);

describe('CredentialAdapter', () => {
  it('safeStorage 不可用—保存—稳定失败且零磁盘明文降级', async () => {
    const root = await createRoot();
    const encryptString = vi.fn();
    const adapter = new CredentialAdapter({
      safeStorage: { decryptString: vi.fn(), encryptString, isEncryptionAvailable: () => false },
      secretsDirectory: root,
    });
    await expect(adapter.saveCredential('fake-credential-value')).rejects.toEqual(
      new CredentialStorageError('CREDENTIAL_STORAGE_UNAVAILABLE'),
    );
    expect(encryptString).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('safeStorage 可用—保存与读取—磁盘仅密文且返回引用只含末四位', async () => {
    const root = await createRoot();
    const plaintext = 'fake-credential-value-7890';
    const encrypted = new TextEncoder().encode('encrypted-payload');
    const adapter = new CredentialAdapter({
      clock: () => '2026-08-12T00:00:00Z',
      createId: () => 'credential-1',
      safeStorage: {
        decryptString: () => plaintext,
        encryptString: () => encrypted,
        isEncryptionAvailable: () => true,
      },
      secretsDirectory: root,
    });
    const ref = await adapter.saveCredential(plaintext);
    expect(ref).toEqual({
      createdAt: '2026-08-12T00:00:00Z',
      id: 'credential-1',
      kind: 'API_KEY',
      last4: '7890',
    });
    const disk = await readFile(path.join(root, 'credential-1.bin'));
    expect(disk.equals(Buffer.from(encrypted))).toBe(true);
    expect(disk.toString('utf8')).not.toContain(plaintext);
    await expect(adapter.loadCredential(ref.id)).resolves.toBe(plaintext);
  });

  it('已有密文—删除—移除独立密文文件', async () => {
    const root = await createRoot();
    const adapter = new CredentialAdapter({
      createId: () => 'credential-1',
      safeStorage: {
        decryptString: vi.fn(),
        encryptString: () => new Uint8Array([1]),
        isEncryptionAvailable: () => true,
      },
      secretsDirectory: root,
    });
    const ref = await adapter.saveCredential('key');
    await adapter.deleteCredential(ref.id);
    expect(await readdir(root)).toEqual([]);
  });

  it('固定 id 轮换矩阵—默认 wx 已存在即失败，overwriteExisting 覆写为新密文且不留孤儿', async () => {
    const root = await createRoot();
    const make = (overwriteExisting: boolean) =>
      new CredentialAdapter({
        createId: () => 'profile-image-primary',
        overwriteExisting,
        safeStorage: {
          decryptString: (bytes) => `decrypted:${new TextDecoder().decode(bytes)}`,
          encryptString: (value) => new TextEncoder().encode(`enc:${value}`),
          isEncryptionAvailable: () => true,
        },
        secretsDirectory: root,
      });
    const exclusive = make(false);
    await exclusive.saveCredential('ark-key-old');
    // wx 独占：同 id 再存即失败（引导路径「已存在不覆盖」语义的底座）。
    await expect(exclusive.saveCredential('ark-key-new')).rejects.toEqual(
      new CredentialStorageError('CREDENTIAL_STORAGE_FAILED'),
    );
    // UI 轮换路径：覆写同一固定引用并读到新值。
    const overwrite = make(true);
    const ref = await overwrite.saveCredential('ark-key-new-9999');
    expect(ref.id).toBe('profile-image-primary');
    expect(ref.last4).toBe('9999');
    await expect(overwrite.loadCredential('profile-image-primary')).resolves.toBe(
      'decrypted:enc:ark-key-new-9999',
    );
    expect(await readdir(root)).toEqual(['profile-image-primary.bin']);
  });

  it('凭据流期间—console 与 stderr 零明文 Key（日志白名单守卫）', async () => {
    const root = await createRoot();
    const plaintext = 'fake-credential-value-7890';
    const adapter = new CredentialAdapter({
      createId: () => 'credential-log',
      safeStorage: {
        decryptString: () => plaintext,
        encryptString: () => new TextEncoder().encode('encrypted-payload'),
        isEncryptionAvailable: () => true,
      },
      secretsDirectory: root,
    });
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const ref = await adapter.saveCredential(plaintext);
      await adapter.loadCredential(ref.id);
      await adapter.deleteCredential(ref.id);
      const captured = [
        ...stderrWrites,
        ...stdoutWrites,
        ...consoleError.mock.calls.map((call) => call.join(' ')),
        ...consoleWarn.mock.calls.map((call) => call.join(' ')),
        ...consoleLog.mock.calls.map((call) => call.join(' ')),
      ].join('\n');
      // 当前实现零日志；此断言为白名单守卫，拦截未来回归（Key 不得进日志/埋点）。
      expect(captured).not.toContain(plaintext);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });
});
