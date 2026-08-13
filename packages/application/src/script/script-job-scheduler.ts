import type { JobRunner } from '../jobs/index';
import type { ScriptUnitOfWorkPort } from '../ports/script/index';

export interface ScriptJobScheduler {
  kick(): void;
  whenIdle(): Promise<void>;
}

/** Singleflight persisted-queue drain. Page navigation has no effect on this scheduler. */
export const createScriptJobScheduler = (
  unitOfWork: ScriptUnitOfWorkPort,
  runner: JobRunner,
): ScriptJobScheduler => {
  let active: Promise<void> | null = null;
  const drain = async (): Promise<void> => {
    for (;;) {
      const queued = await unitOfWork.run(({ jobs }) => jobs.listByStatuses(['QUEUED'], 1));
      const next = queued[0];
      if (next === undefined) return;
      const outcome = await runner.run(next.id);
      if (outcome.status === 'NOT_CLAIMED') return;
    }
  };
  const kick = (): void => {
    if (active !== null) return;
    active = drain().finally(() => {
      active = null;
    });
  };
  return {
    kick,
    whenIdle: () => active ?? Promise.resolve(),
  };
};
