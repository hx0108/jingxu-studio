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
});
