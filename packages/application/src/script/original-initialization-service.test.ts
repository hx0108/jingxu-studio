import { describe, expect, it } from 'vitest';

import type { ScriptJobRepositories, ScriptWorkspaceSnapshot } from '../ports/script/index';
import { createOriginalInitializationService } from './original-initialization-service';

const createHarness = () => {
  const inserted: string[] = [];
  const repositories = {
    audit: { record: () => Promise.resolve(void inserted.push('audit')) },
    consents: {
      findDataProcessingBySourceInputId: () => Promise.resolve(null),
      insert: () => Promise.resolve(void inserted.push('consent')),
    },
    dependencies: {
      insertMany: () => Promise.resolve(),
      listByUpstreamVersionIds: () => Promise.resolve([]),
    },
    episodes: {
      findActiveByProjectId: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      insert: () => Promise.resolve(void inserted.push('episode')),
    },
    invocations: {},
    jobs: {},
    receipts: {
      findByRequestId: () => Promise.resolve(null),
      insert: () => Promise.resolve(void inserted.push('receipt')),
    },
    scriptVersions: {},
    sourceInputs: {
      findById: () => Promise.resolve(null),
      findCreativeByProjectId: () => Promise.resolve(null),
      insert: () => {
        inserted.push('source');
        return Promise.resolve();
      },
    },
    stageHeads: {},
    storyBibleVersions: {},
  } as unknown as ScriptJobRepositories;
  const snapshot = { projectId: 'project-0001' } as ScriptWorkspaceSnapshot;
  const ids = ['source-0001', 'consent-0001', 'episode-0001', 'audit-0001'];
  const service = createOriginalInitializationService({
    getProjectDefaults: () => Promise.resolve({ targetDurationSec: 90 }),
    hashPayload: () => 'a'.repeat(64),
    hashText: (text) => String(Array.from(text).length).padStart(64, '0'),
    newId: () => ids.shift() ?? 'unexpected-id',
    now: () => '2026-08-13T00:00:00.000Z',
    unitOfWork: { run: async (work) => work(repositories) },
    workspaceQuery: {
      getVersionDocument: () => Promise.resolve(null),
      getWorkspace: () => Promise.resolve(snapshot),
    },
  });
  return { inserted, service };
};

describe('OriginalInitializationService', () => {
  it.each([19, 2_001])('条件—输入 %i 个字符—拒绝且零写入', async (length) => {
    const harness = createHarness();
    const result = await harness.service.initialize(
      {
        creativeText: '字'.repeat(length),
        dataProcessingConsent: true,
        projectId: 'project-0001',
        requestId: 'request-0001',
      },
      'trace-0001',
    );
    expect(result.ok).toBe(false);
    expect(harness.inserted).toEqual([]);
  });

  it.each([20, 2_000])('条件—输入 %i 个字符—原子写入初始化聚合', async (length) => {
    const harness = createHarness();
    const text = `  ${'字'.repeat(length - 4)}  `;
    const result = await harness.service.initialize(
      {
        creativeText: text,
        dataProcessingConsent: true,
        projectId: 'project-0001',
        requestId: 'request-0001',
      },
      'trace-0001',
    );
    expect(result.ok).toBe(true);
    expect(harness.inserted).toEqual(['source', 'consent', 'episode', 'audit', 'receipt']);
  });

  it('条件—未确认数据处理—返回稳定错误且不写入', async () => {
    const harness = createHarness();
    const result = await harness.service.initialize(
      {
        creativeText: '字'.repeat(20),
        dataProcessingConsent: false,
        projectId: 'project-0001',
        requestId: 'request-0001',
      },
      'trace-0001',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'SCRIPT_INPUT_CONSENT_REQUIRED' } });
    expect(harness.inserted).toEqual([]);
  });
});
