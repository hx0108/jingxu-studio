import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProviderProfile } from '@jingxu/application';

import { loadMigrationSet } from '../migrations/migration-loader';
import { applyMigrations } from '../migrations/migration-runner';
import { SqliteTestDatabase as Database } from '../testing/sqlite-test-database';
import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import { SqliteProviderUnitOfWork } from './sqlite-provider-unit-of-work';

const MIGRATION_DIRECTORY = path.resolve(import.meta.dirname, '../../resources/migrations');

/**
 * 凭据安全白名单审计（任务 6.3）。
 *
 * `CredentialAdapter` 把明文 Key 换成不透明 `credentialRef` + 末四位，密文以独立文件落盘
 *（磁盘密文由 `credential-adapter.test.ts` 覆盖）。这里证明**落库侧**：以 ref + last4 写入
 * `provider_profiles` 后，原始明文 Key 字符串不出现在 SQLite 文件字节里，且读回的
 * `ProviderProfile` 只持有 `credentialRef` + `credentialLast4`，结构上不存在明文字段。
 */
const PLAINTEXT_KEY = 'sk-live-plaintext-never-in-db-9999';

const profile = (id = 'provider_audit_01'): ProviderProfile => ({
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  config: { dataProcessingHints: ['no-store'], lastValidatedAt: '2026-08-12T00:00:00Z' },
  // 末四位与 CredentialAdapter 的 plaintext.slice(-4) 派生一致；非明文。
  credentialLast4: PLAINTEXT_KEY.slice(-4),
  // 不透明引用（CredentialAdapter 返回的 id），非 Key 本体。
  credentialRef: 'opaque-ref-audit-001',
  enabled: true,
  id,
  modelId: 'qwen3.7-plus-2026-05-26',
  modelSnapshotDate: '2026-05-26',
  provider: 'QWEN',
  region: 'cn-beijing',
  workspaceId: 'workspace-1',
});

describe('凭据安全白名单审计 — 明文 Key 不入 SQLite（任务 6.3）', () => {
  it('save 后—原始 DB 文件字节不含明文 Key—仅含不透明 ref 与末四位', async () => {
    await withSqliteTestContext(async (context) => {
      const databasePath = path.join(context.root, 'credential-safety.sqlite');
      const database = new Database(databasePath);
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
      const unitOfWork = new SqliteProviderUnitOfWork(database);
      try {
        await unitOfWork.run(async (repositories) => {
          await repositories.profiles.save(profile());
        });
      } finally {
        database.close();
      }

      const fileText = (await readFile(databasePath)).toString('utf8');
      // 明文 Key 不得出现在 DB 文件字节中。
      expect(fileText).not.toContain(PLAINTEXT_KEY);
      // 落库的是脱敏后的不透明 ref 与末四位（证明写入的是 ref/last4 而非 Key）。
      expect(fileText).toContain('opaque-ref-audit-001');
      expect(fileText).toContain('9999');
    });
  });

  it('findById 读回的 ProviderProfile—只持有 ref 与 credentialLast4—序列化无明文 Key', async () => {
    await withSqliteTestContext(async (context) => {
      const database = new Database(path.join(context.root, 'credential-safety.sqlite'));
      applyMigrations(database, await loadMigrationSet(MIGRATION_DIRECTORY), context.clock);
      const unitOfWork = new SqliteProviderUnitOfWork(database);
      try {
        await unitOfWork.run(async (repositories) => {
          await repositories.profiles.save(profile());
        });
        const read = await unitOfWork.run((repositories) =>
          repositories.profiles.findById('provider_audit_01'),
        );
        expect(read).not.toBeNull();
        expect(read?.credentialRef).toBe('opaque-ref-audit-001');
        expect(read?.credentialLast4).toBe('9999');
        // ProviderProfile 结构上不存在明文 Key 字段：整体序列化后亦不含明文。
        expect(JSON.stringify(read)).not.toContain(PLAINTEXT_KEY);
      } finally {
        database.close();
      }
    });
  });
});
