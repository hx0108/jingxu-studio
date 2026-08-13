import { describe, expect, it, vi } from 'vitest';

import type { ScriptJobRepositories } from '../ports/script/index';
import { createScriptJobScheduler } from './script-job-scheduler';

describe('ScriptJobScheduler', () => {
  it('条件—重复 kick—singleflight 串行排空持久化 QUEUED', async () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const repositories = {
      jobs: { listByStatuses: () => Promise.resolve(jobs.slice(0, 1)) },
    } as unknown as ScriptJobRepositories;
    const run = vi.fn((_jobId: string) => {
      jobs.shift();
      return Promise.resolve({ status: 'SUCCEEDED' as const });
    });
    const scheduler = createScriptJobScheduler(
      { run: (work) => work(repositories) },
      { cancel: () => Promise.resolve({ status: 'NOT_CANCELLED' }), run },
    );
    scheduler.kick();
    scheduler.kick();
    await scheduler.whenIdle();
    expect(run.mock.calls.map(([jobId]) => jobId)).toEqual(['job-1', 'job-2']);
  });
});
