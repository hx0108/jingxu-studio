import { describe, expect, it } from 'vitest';

import type { JobRepositoryPort, ModelInvocationRepositoryPort } from '../persistence/job';
import type {
  ScriptJobRepositories,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  SourceInput,
} from './index';

const sourceInput = {
  id: 'source-0001',
  projectId: 'project-0001',
  inputKind: 'CREATIVE',
  fileName: null,
  encoding: null,
  content: '保留原始空白的原创输入',
  charCount: 11,
  sha256: 'a'.repeat(64),
  createdAt: '2026-08-13T00:00:00.000Z',
} satisfies SourceInput;

describe('Script Application Ports', () => {
  it('条件—构造 SourceInput—只暴露领域字段且保留原始内容', () => {
    expect(sourceInput.content).toBe('保留原始空白的原创输入');
    expect(sourceInput).not.toHaveProperty('content_text');
    expect(sourceInput).not.toHaveProperty('row');
    expect(sourceInput).not.toHaveProperty('connection');
  });

  it('条件—组合 Script Job Repository—同一 UoW 回调可访问业务与 Job Port', async () => {
    const repositories = {
      jobs: {} as JobRepositoryPort,
      invocations: {} as ModelInvocationRepositoryPort,
      sourceInputs: {
        findById: () => Promise.resolve(null),
        findCreativeByProjectId: () => Promise.resolve(null),
        insert: () => Promise.resolve(),
      },
      consents: {} as ScriptJobRepositories['consents'],
      episodes: {} as ScriptJobRepositories['episodes'],
      storyBibleVersions: {} as ScriptJobRepositories['storyBibleVersions'],
      scriptVersions: {} as ScriptJobRepositories['scriptVersions'],
      stageHeads: {} as ScriptJobRepositories['stageHeads'],
      dependencies: {} as ScriptJobRepositories['dependencies'],
      audit: {} as ScriptJobRepositories['audit'],
      receipts: {} as ScriptJobRepositories['receipts'],
    } satisfies ScriptJobRepositories;

    const unitOfWork: ScriptUnitOfWorkPort = {
      run: async (work) => work(repositories),
    };

    const result = await unitOfWork.run(async (ports) => {
      await ports.sourceInputs.insert(sourceInput);
      return ports.jobs === repositories.jobs && ports.invocations === repositories.invocations;
    });

    expect(result).toBe(true);
  });

  it('条件—只读工作区查询—返回快照而非 Repository 或连接', async () => {
    const query: ScriptWorkspaceQueryPort = {
      getWorkspace: () => Promise.resolve(null),
      getVersionDocument: () => Promise.resolve(null),
    };

    expect(await query.getWorkspace('project-0001')).toBeNull();
    expect(await query.getVersionDocument('project-0001', 'version-0001')).toBeNull();
  });
});
