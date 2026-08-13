import type { JobRepositoryPort } from './job-repository-port';
import type { ModelInvocationRepositoryPort } from './model-invocation-repository-port';

export interface JobRepositories {
  readonly jobs: JobRepositoryPort;
  readonly invocations: ModelInvocationRepositoryPort;
}

/** Runs one short `BEGIN IMMEDIATE` transaction; callers must never await Provider or file I/O. */
export interface JobUnitOfWorkPort {
  run<T>(work: (repositories: JobRepositories) => Promise<T>): Promise<T>;
}
