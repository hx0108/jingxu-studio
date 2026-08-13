import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { StartupStatusDto } from '@jingxu/contracts';

import { StartupGate } from './StartupGate';
import { createQueryClient } from './lib/query-client';

const status = (overrides: Partial<StartupStatusDto>): StartupStatusDto => ({
  allowedActions: [],
  backups: [],
  completedPhases: [],
  currentPhase: null,
  errorCode: null,
  retryable: false,
  revision: 0,
  state: 'BOOTING',
  summary: null,
  writeEnabled: false,
  ...overrides,
});

describe('StartupGate', () => {
  it('启动检查进行中—渲染页面—显示阶段反馈且不渲染正常工作区', () => {
    const markup = renderToStaticMarkup(
      <StartupGate
        onRestore={vi.fn()}
        onRetry={vi.fn()}
        pendingAction={false}
        status={status({ currentPhase: 'MIGRATION', state: 'CHECKING' })}
      />,
    );

    expect(markup).toContain('正在检查本地数据库');
    expect(markup).toContain('MIGRATION');
    expect(markup).not.toContain('workspace-ready');
  });

  it('启动自检失败且存在备份—渲染页面—显示脱敏故障、动作和备份但阻断正常工作区', () => {
    const markup = renderToStaticMarkup(
      <StartupGate
        onRestore={vi.fn()}
        onRetry={vi.fn()}
        pendingAction={false}
        status={status({
          allowedActions: ['RETRY', 'RESTORE'],
          backups: [
            {
              backupId: 'backup_12345678',
              createdAt: '2026-08-08T00:00:00.000Z',
              schemaVersion: 1,
              summary: '数据库升级前备份（Schema v1）',
            },
          ],
          currentPhase: 'DATABASE_AUDIT',
          errorCode: 'DATABASE_INVARIANT_FAILED',
          retryable: true,
          state: 'READ_ONLY_FAULT',
          summary: '数据库自检未通过，当前仅允许只读恢复操作。',
        })}
      />,
    );

    expect(markup).toContain('只读故障');
    expect(markup).toContain('DATABASE_INVARIANT_FAILED');
    expect(markup).toContain('DATABASE_AUDIT');
    expect(markup).toContain('重新检查');
    expect(markup).toContain('从此备份恢复');
    expect(markup).not.toContain('workspace-ready');
  });

  it('Schema 自检失败—渲染故障页—显示阶段与稳定错误且只提供重试', () => {
    const markup = renderToStaticMarkup(
      <StartupGate
        onRestore={vi.fn()}
        onRetry={vi.fn()}
        pendingAction={false}
        status={status({
          allowedActions: ['RETRY'],
          currentPhase: 'SCHEMA_REGISTRY',
          errorCode: 'SCHEMA_HASH_MISMATCH',
          retryable: true,
          state: 'READ_ONLY_FAULT',
          summary: 'Schema 资源完整性检查未通过，请修复资源后重试。',
        })}
      />,
    );

    expect(markup).toContain('Schema 契约只读故障');
    expect(markup).toContain('SCHEMA_REGISTRY');
    expect(markup).toContain('SCHEMA_HASH_MISMATCH');
    expect(markup).toContain('重新检查');
    expect(markup).not.toContain('从此备份恢复');
    expect(markup).not.toContain('workspace-ready');
  });

  it('全部阶段通过—渲染页面—只显示 READY 工程基线', () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={createQueryClient()}>
        <StartupGate
          onRestore={vi.fn()}
          onRetry={vi.fn()}
          pendingAction={false}
          status={status({ state: 'READY', writeEnabled: true })}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('workspace-ready');
    expect(markup).toContain('镜序 Studio');
    expect(markup).not.toContain('只读故障');
  });
});
import { QueryClientProvider } from '@tanstack/react-query';
