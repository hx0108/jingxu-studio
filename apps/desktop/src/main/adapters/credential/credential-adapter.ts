import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CredentialPort, CredentialRef } from '@jingxu/application';

export interface SafeStorageFacade {
  decryptString(encrypted: Uint8Array): string;
  encryptString(plaintext: string): Uint8Array;
  isEncryptionAvailable(): boolean;
}

export interface CredentialAdapterOptions {
  readonly clock?: () => string;
  readonly createId?: () => string;
  readonly safeStorage: SafeStorageFacade;
  readonly secretsDirectory: string;
}

export class CredentialStorageError extends Error {
  public constructor(
    public readonly code:
      'CREDENTIAL_NOT_FOUND' | 'CREDENTIAL_STORAGE_FAILED' | 'CREDENTIAL_STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'CredentialStorageError';
  }
}

const CREDENTIAL_ID = /^[a-zA-Z0-9-]+$/u;

/** Main-only safeStorage Adapter；磁盘仅持有密文，公开 DTO 仅含不透明引用与末四位。 */
export class CredentialAdapter implements CredentialPort {
  readonly #clock: () => string;
  readonly #createId: () => string;
  readonly #safeStorage: SafeStorageFacade;
  readonly #secretsDirectory: string;

  public constructor(options: CredentialAdapterOptions) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#safeStorage = options.safeStorage;
    this.#secretsDirectory = path.resolve(options.secretsDirectory);
  }

  public isAvailable(): boolean {
    return this.#safeStorage.isEncryptionAvailable();
  }

  public async saveCredential(plaintext: string): Promise<CredentialRef> {
    if (!this.isAvailable()) throw new CredentialStorageError('CREDENTIAL_STORAGE_UNAVAILABLE');
    const id = this.#createId();
    if (!CREDENTIAL_ID.test(id)) throw new CredentialStorageError('CREDENTIAL_STORAGE_FAILED');
    try {
      const encrypted = this.#safeStorage.encryptString(plaintext);
      await mkdir(this.#secretsDirectory, { recursive: true });
      await writeFile(this.#pathFor(id), encrypted, { flag: 'wx', mode: 0o600 });
      return { createdAt: this.#clock(), id, kind: 'API_KEY', last4: plaintext.slice(-4) || null };
    } catch (error) {
      if (error instanceof CredentialStorageError) throw error;
      throw new CredentialStorageError('CREDENTIAL_STORAGE_FAILED');
    }
  }

  public async loadCredential(id: string): Promise<string> {
    try {
      return this.#safeStorage.decryptString(await readFile(this.#pathFor(id)));
    } catch {
      throw new CredentialStorageError('CREDENTIAL_NOT_FOUND');
    }
  }

  public async deleteCredential(id: string): Promise<void> {
    try {
      await rm(this.#pathFor(id), { force: true });
    } catch {
      throw new CredentialStorageError('CREDENTIAL_STORAGE_FAILED');
    }
  }

  #pathFor(id: string): string {
    if (!CREDENTIAL_ID.test(id)) throw new CredentialStorageError('CREDENTIAL_NOT_FOUND');
    return path.join(this.#secretsDirectory, `${id}.bin`);
  }
}
