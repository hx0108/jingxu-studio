import type { JobRepositories } from '../persistence/job';
import type { ScriptRepositories } from './script-repositories';

/** Script business repositories and Job evidence share one short transaction. */
export interface ScriptJobRepositories extends JobRepositories, ScriptRepositories {}

/**
 * Runs one short transaction for Script state and Job terminal evidence.
 * Callers must not perform Provider, file-system, or other long-running I/O inside `work`.
 */
export interface ScriptUnitOfWorkPort {
  run<T>(work: (repositories: ScriptJobRepositories) => Promise<T>): Promise<T>;
}
