import { describe, expect, it, vi } from 'vitest';

import type { ModelInvocation, ScriptStageJob } from '../ports/persistence/job/index';
import type { ScriptJobRepositories } from '../ports/script/index';
import { createScriptRecoveryRevalidator } from './script-job-recovery';

describe('Script recovery revalidator', () => {
  it('条件—VALIDATING 有完整响应—不调用 Provider并确定性提交一次', async () => {
    const job = {
      id: 'job-00000001',
      projectId: 'project-0001',
      stage: 'CONCEPT',
      status: 'VALIDATING',
      structureRepairAttempts: 0,
      transportAttempts: 0,
    } as ScriptStageJob;
    const invocation = {
      id: 'invocation-0001',
      rawResponse: new TextEncoder().encode('{"data":{"title":"候选"}}'),
    } as ModelInvocation;
    const commit = vi.fn(() => Promise.resolve());
    const transition = vi.fn(() => Promise.resolve(true));
    const repositories = {
      jobs: { findById: () => Promise.resolve(job), transition },
    } as unknown as ScriptJobRepositories;
    const revalidate = createScriptRecoveryRevalidator({
      buildContract: () =>
        Promise.resolve({
          injectSystemFields: (candidate: unknown) => candidate,
          validateCandidate: () => ({ valid: true }),
          validateCollection: () => ({ valid: true }),
          validateFinal: () => ({ valid: true }),
        }),
      commitHandler: { commit },
      now: () => '2026-08-13T00:00:00.000Z',
      unitOfWork: { run: (work) => work(repositories) },
    });
    await revalidate(job, invocation);
    expect(commit).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'SUCCEEDED' }));
  });
});
