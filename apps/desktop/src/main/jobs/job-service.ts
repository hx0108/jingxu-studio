import type { JobRepositoryPort, JobRunner, ScriptStageJob } from '@jingxu/application';
import type {
  AppErrorDto,
  AppResultDto,
  JobCreateInputDto,
  JobListInputDto,
  JobSummaryDto,
  ProjectErrorCode,
} from '@jingxu/contracts';

/**
 * #6/#7 业务 seam：装配剧本阶段业务输入（inputVersionsJson/writeSetJson/
 * lockSnapshotHash/promptTemplateId 等）并落一条 QUEUED Job。本 Change（#5）只定义
 * 接口，由后续 Change 注入真实实现；IPC 层据此做幂等去重与 DTO 投影，不触碰业务输入。
 */
export interface JobSubmissionPort {
  submit(input: JobCreateInputDto, traceId: string): Promise<ScriptStageJob>;
  /** 以原输入重新入队一条 FAILED Job。 */
  requeue(jobId: string, traceId: string): Promise<ScriptStageJob>;
}

export interface JobServiceDependencies {
  readonly jobs: JobRepositoryPort;
  readonly runner: JobRunner;
  readonly submission: JobSubmissionPort;
}

const ALL_STATUSES = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

/**
 * `jobSummarySchema.versionId` 在 #5 通用基座内等价于 Job id；真实乐观版本由 #6/#7 的
 * 业务提交在 writeSet/lockSnapshot 上提供。
 */
const toSummary = (job: ScriptStageJob): JobSummaryDto => ({
  errorCode: job.errorCode,
  id: job.id,
  projectId: job.projectId,
  status: job.status,
  versionId: job.id,
});

const ok = <T>(data: T): AppResultDto<T> => ({ data, ok: true });

const err = <T>(
  code: ProjectErrorCode,
  traceId: string,
  message: string,
  retryable: boolean,
  userAction: string | null,
): AppResultDto<T> => ({
  error: { code, fieldErrors: null, message, retryable, traceId, userAction } satisfies AppErrorDto,
  ok: false,
});

/** Application 用例表面：Job 生命周期读路径与取消；创建/重试经 submission seam。 */
export class JobService {
  readonly #dependencies: JobServiceDependencies;
  public constructor(dependencies: JobServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /** `(projectId, idempotencyKey)` 命中既有 Job 直接回放，不重复入队。 */
  public async create(
    input: JobCreateInputDto,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> {
    let existing: ScriptStageJob | null;
    try {
      existing = await this.#dependencies.jobs.findByIdempotencyKey(
        input.projectId,
        input.idempotencyKey,
      );
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务查询失败，请重试。', true, null);
    }
    if (existing !== null) return ok(toSummary(existing));
    try {
      const job = await this.#dependencies.submission.submit(input, traceId);
      return ok(toSummary(job));
    } catch {
      return err('JOB_SUBMISSION_UNAVAILABLE', traceId, '任务暂不可创建，请稍后重试。', true, null);
    }
  }

  public async get(jobId: string, traceId: string): Promise<AppResultDto<JobSummaryDto>> {
    try {
      const job = await this.#dependencies.jobs.findById(jobId);
      return job === null
        ? err('JOB_NOT_FOUND', traceId, '未找到任务。', false, null)
        : ok(toSummary(job));
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务查询失败，请重试。', true, null);
    }
  }

  public async list(
    input: JobListInputDto,
    traceId: string,
  ): Promise<AppResultDto<readonly JobSummaryDto[]>> {
    try {
      const rows = await this.#dependencies.jobs.listByStatuses(ALL_STATUSES, input.limit);
      const summaries = rows.filter((job) => job.projectId === input.projectId).map(toSummary);
      return ok(summaries);
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务列表查询失败，请重试。', true, null);
    }
  }

  public async cancel(
    jobId: string,
    expectedVersionId: string,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> {
    let job: ScriptStageJob | null;
    try {
      job = await this.#dependencies.jobs.findById(jobId);
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务查询失败，请重试。', true, null);
    }
    if (job === null) return err('JOB_NOT_FOUND', traceId, '未找到任务。', false, null);
    if (job.id !== expectedVersionId) {
      return err('JOB_VERSION_CONFLICT', traceId, '任务版本已变更，请刷新后重试。', false, null);
    }
    try {
      const result = await this.#dependencies.runner.cancel(jobId);
      if (result.status === 'NOT_CANCELLED') {
        return err('JOB_NOT_CANCELLABLE', traceId, '当前任务状态不可取消。', false, null);
      }
      const updated = await this.#dependencies.jobs.findById(jobId);
      return updated === null
        ? err('JOB_NOT_FOUND', traceId, '未找到任务。', false, null)
        : ok(toSummary(updated));
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务取消失败，请重试。', true, null);
    }
  }

  public async retry(
    jobId: string,
    expectedVersionId: string,
    traceId: string,
  ): Promise<AppResultDto<JobSummaryDto>> {
    let job: ScriptStageJob | null;
    try {
      job = await this.#dependencies.jobs.findById(jobId);
    } catch {
      return err('JOB_PERSISTENCE_FAILED', traceId, '任务查询失败，请重试。', true, null);
    }
    if (job === null) return err('JOB_NOT_FOUND', traceId, '未找到任务。', false, null);
    if (job.id !== expectedVersionId) {
      return err('JOB_VERSION_CONFLICT', traceId, '任务版本已变更，请刷新后重试。', false, null);
    }
    try {
      const requeued = await this.#dependencies.submission.requeue(jobId, traceId);
      return ok(toSummary(requeued));
    } catch {
      return err('JOB_SUBMISSION_UNAVAILABLE', traceId, '任务暂不可重试，请稍后重试。', true, null);
    }
  }
}
