import type { JobStatus } from './job-types';

const NEXT_STATUSES: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  DRAFT: ['QUEUED'],
  QUEUED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['RUNNING', 'VALIDATING', 'FAILED', 'CANCELLED'],
  VALIDATING: ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export class JobInvariantError extends Error {
  public readonly code = 'JOB_INVARIANT_VIOLATION';

  public constructor() {
    super('JOB_INVARIANT_VIOLATION');
    this.name = 'JobInvariantError';
  }
}

/** Application-level companion to SQLite CHECK constraints and terminal-state protection. */
export const assertJobTransition = (
  current: JobStatus,
  next: JobStatus,
  transportAttempts: number,
  structureRepairAttempts: number,
): void => {
  const validCounts =
    Number.isInteger(transportAttempts) &&
    transportAttempts >= 0 &&
    transportAttempts <= 3 &&
    Number.isInteger(structureRepairAttempts) &&
    structureRepairAttempts >= 0 &&
    structureRepairAttempts <= 1;
  if (!validCounts || !NEXT_STATUSES[current].includes(next)) throw new JobInvariantError();
  if (current === 'RUNNING' && next === 'RUNNING' && transportAttempts < 1) {
    throw new JobInvariantError();
  }
  if (current === 'VALIDATING' && next === 'RUNNING' && structureRepairAttempts !== 1) {
    throw new JobInvariantError();
  }
};
