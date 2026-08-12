import { access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withSqliteTestContext } from '../testing/sqlite-test-kit';
import {
  assertManagedRealPaths,
  createManagedDirectories,
  createManagedPaths,
  deriveWindowsProductionRoot,
  resolveManagedBackupPath,
} from './managed-paths';

describe('受管理路径', () => {
  it('Windows LOCALAPPDATA—派生生产根—固定使用 JingxuStudio 而非 Electron userData', () => {
    expect(deriveWindowsProductionRoot('C:\\Users\\alice\\AppData\\Local', 'win32')).toBe(
      'C:\\Users\\alice\\AppData\\Local\\JingxuStudio',
    );
  });

  it.each([
    ['', 'win32'],
    ['relative\\AppData\\Local', 'win32'],
    ['C:\\Users\\alice\\AppData\\Local', 'linux'],
  ])('非法生产根—执行派生—拒绝回退到工作目录', (localAppData, platform) => {
    expect(() => deriveWindowsProductionRoot(localAppData, platform)).toThrow(
      'LOCALAPPDATA_ROOT_INVALID',
    );
  });

  it('注入测试根—创建目录—只在显式临时根内创建数据与备份目录', async () => {
    await withSqliteTestContext(async (context) => {
      const root = path.join(context.root, 'managed');
      const paths = createManagedPaths(root);
      await createManagedDirectories(paths);

      await Promise.all([access(paths.dataDirectory), access(paths.backupDirectory)]);
      expect(await realpath(path.dirname(paths.databasePath))).toBe(
        await realpath(paths.dataDirectory),
      );
      expect(path.dirname(paths.root)).toBe(context.root);
    });
  });

  it('opaque backup id—解析恢复候选—始终位于受管理备份目录', async () => {
    await withSqliteTestContext(async (context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      await mkdir(paths.backupDirectory, { recursive: true });

      expect(resolveManagedBackupPath(paths, 'backup_12345678')).toBe(
        path.join(paths.backupDirectory, 'backup_12345678.sqlite'),
      );
      expect(() => resolveManagedBackupPath(paths, '..\\escape.sqlite')).toThrow(
        'BACKUP_NOT_ALLOWED',
      );
      expect(() => resolveManagedBackupPath(paths, 'C:\\tmp\\backup.sqlite')).toThrow(
        'BACKUP_NOT_ALLOWED',
      );
    });
  });

  it('受管理子目录被符号链接到根外—校验 realpath—拒绝路径逃逸', () => {
    expect(() => {
      assertManagedRealPaths('C:\\managed', ['C:\\managed\\data', 'C:\\outside\\linked-backups']);
    }).toThrow('MANAGED_PATH_INVALID');
  });

  it('凭据密文目录（root/secrets）与诊断目录为并列 sibling—诊断范围无法触及密文（6.3）', async () => {
    await withSqliteTestContext((context) => {
      const paths = createManagedPaths(path.join(context.root, 'managed'));
      // CredentialAdapter 把密文落在 root/secrets（managedRoot/secrets）。
      const secretsDirectory = path.join(paths.root, 'secrets');
      // secrets 是 root 的直接子目录（受管理 sibling），未逃逸出根。
      expect(path.relative(paths.root, secretsDirectory)).toBe('secrets');
      // secrets 与 diagnostics 互为并列：从 diagnostics 出发必须上行（..）才能到 secrets，
      // 即任何以 diagnosticDirectory 为范围的打包/导出都无法触及密文。
      const fromDiagnostics = path.relative(paths.diagnosticDirectory, secretsDirectory);
      expect(fromDiagnostics === '..' || fromDiagnostics.startsWith(`..${path.sep}`)).toBe(true);
    });
  });
});
