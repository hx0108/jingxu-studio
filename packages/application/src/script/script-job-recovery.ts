import { executeCandidateContract } from '../jobs/index';
import type { CandidateContractDependencies, JobCommitHandler } from '../jobs/index';
import type { ModelInvocation, ScriptStageJob } from '../ports/persistence/job/index';
import type { ScriptJobRepositories, ScriptUnitOfWorkPort } from '../ports/script/index';

export interface ScriptRecoveryDependencies {
  readonly buildContract: (
    job: ScriptStageJob,
    invocationId: string,
  ) => Omit<CandidateContractDependencies, 'commit' | 'repair'>;
  readonly commitHandler: JobCommitHandler<ScriptJobRepositories>;
  readonly now: () => string;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

/** Revalidates persisted complete evidence without any Provider call and commits idempotently. */
export const createScriptRecoveryRevalidator =
  (dependencies: ScriptRecoveryDependencies) =>
  async (job: ScriptStageJob, invocation: ModelInvocation): Promise<void> => {
    if (invocation.rawResponse === null) throw new Error('RECOVERY_RESPONSE_MISSING');
    const contract = dependencies.buildContract(job, invocation.id);
    const result = await executeCandidateContract(
      new TextDecoder().decode(invocation.rawResponse),
      {
        ...contract,
        commit: (value) =>
          dependencies.unitOfWork.run(async (repositories) => {
            const latest = await repositories.jobs.findById(job.id);
            if (latest?.status !== 'VALIDATING') return;
            await dependencies.commitHandler.commit(repositories, value, latest);
            const transitioned = await repositories.jobs.transition({
              errorCode: null,
              errorJson: null,
              expectedStatus: 'VALIDATING',
              finishedAt: dependencies.now(),
              jobId: latest.id,
              nextStatus: 'SUCCEEDED',
              structureRepairAttempts: latest.structureRepairAttempts,
              transportAttempts: latest.transportAttempts,
            });
            if (!transitioned) throw new Error('RECOVERY_CONCURRENT_WRITE');
          }),
      },
    );
    if (result.status !== 'SUCCEEDED') throw new Error(result.errorCode);
  };
