import type { JobUnitOfWorkPort, ScriptStageJob } from '../../ports/persistence/job/index';

export interface ClaimNextJobCommand {
  readonly deadlineAt: string;
  readonly leaseExpiresAt: string;
  readonly leaseToken: string;
  /** Mock 与真实调用显式共用相同门；该字段仅用于审计调用意图，不改变门规则。 */
  readonly runnerKind: 'mock' | 'real';
  readonly startedAt: string;
}

/**
 * 在同一短事务中执行全局单 RUNNING、同项目串行与条件领取。
 * 返回 null 时调用方不得创建 Invocation 或调用 Provider。
 */
export const claimNextEligibleJob = (
  unitOfWork: JobUnitOfWorkPort,
  command: ClaimNextJobCommand,
): Promise<ScriptStageJob | null> =>
  unitOfWork.run(async ({ jobs }) => {
    void command.runnerKind;
    const running = await jobs.listByStatuses(['RUNNING'], 1);
    if (running.length > 0) return null;

    const validating = await jobs.listByStatuses(['VALIDATING'], 100);
    const busyProjects = new Set(validating.map((item) => item.projectId));
    const queued = await jobs.listByStatuses(['QUEUED'], 100);
    const candidate = queued.find((item) => !busyProjects.has(item.projectId));
    if (candidate === undefined) return null;

    const claimed = await jobs.claimQueued({
      deadlineAt: command.deadlineAt,
      jobId: candidate.id,
      leaseExpiresAt: command.leaseExpiresAt,
      leaseToken: command.leaseToken,
      startedAt: command.startedAt,
    });
    return claimed ? candidate : null;
  });
