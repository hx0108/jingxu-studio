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

  it('条件—stop 在当前 Job 运行中触发—等待当前任务收口且不领取下一项', async () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const repositories = {
      jobs: { listByStatuses: () => Promise.resolve(jobs.slice(0, 1)) },
    } as unknown as ScriptJobRepositories;
    let finish: (() => void) | undefined;
    const run = vi.fn((_jobId: string) => {
      jobs.shift();
      return new Promise<Readonly<{ status: 'SUCCEEDED' }>>((resolve) => {
        finish = () => {
          resolve({ status: 'SUCCEEDED' });
        };
      });
    });
    const scheduler = createScriptJobScheduler(
      { run: (work) => work(repositories) },
      { cancel: () => Promise.resolve({ status: 'NOT_CANCELLED' }), run },
    );

    scheduler.kick();
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledWith('job-1');
    });
    const stopped = scheduler.stop();
    finish?.();
    await stopped;

    scheduler.kick();
    await scheduler.whenIdle();
    expect(run.mock.calls.map(([jobId]) => jobId)).toEqual(['job-1']);
  });
});
