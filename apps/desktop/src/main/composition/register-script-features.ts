import { createHash, randomUUID } from 'node:crypto';

import {
  createOriginalInitializationService,
  createExistingScriptInitializationService,
  createScriptService,
  createScriptVersionService,
  createStoryboardVersionService,
} from '@jingxu/application';
import type {
  CompiledSchemaRegistry,
  JobRepositoryPort,
  ProjectUnitOfWorkPort,
  ScriptUnitOfWorkPort,
  ScriptWorkspaceQueryPort,
  ScriptInputFilePort,
} from '@jingxu/application';
import type { AppResultDto, JobSummaryDto } from '@jingxu/contracts';

import {
  registerScriptIpc,
  type ScriptIpcRegistrar,
  type ScriptIpcService,
  type ScriptIpcTraceIds,
} from '../ipc/script-ipc';
import type { DesktopPersistenceRuntime } from './create-persistence-runtime';

export interface ScriptRuntimeHandles {
  readonly jobs: JobRepositoryPort;
  readonly projects: ProjectUnitOfWorkPort;
  readonly registry: CompiledSchemaRegistry;
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly workspaceQuery: ScriptWorkspaceQueryPort;
}

export interface RegisterScriptFeaturesOptions {
  readonly createService: (handles: ScriptRuntimeHandles) => ScriptIpcService;
  readonly ipcRegistrar: ScriptIpcRegistrar;
  readonly newTraceId?: ScriptIpcTraceIds['newTraceId'];
  readonly persistenceRuntime: DesktopPersistenceRuntime;
  readonly inputFile?: ScriptInputFilePort;
  readonly trustedUrl: string;
}

export interface ScriptFeatureRegistration {
  /** Registers the five Script-only IPC channels exactly once after persistence is writable. */
  ensureRegistered(): boolean;
}

const SCRIPT_STAGE_OUTPUT_SCHEMA_ID = 'https://jingxu.studio/schemas/script-stage-output/1.0.0';
const DEFAULT_EPISODE_DURATION_SEC = 90;
const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING', 'VALIDATING'] as const;

const hashText = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hashText(JSON.stringify(value));

const toJobSummary = (
  job: Awaited<ReturnType<JobRepositoryPort['findById']>>,
): JobSummaryDto | null =>
  job === null
    ? null
    : {
        errorCode: job.errorCode,
        id: job.id,
        projectId: job.projectId,
        status: job.status,
        versionId: job.id,
      };

/** Creates the production CRUD service without constructing Provider or JobRunner infrastructure. */
export const createProductionScriptService = (handles: ScriptRuntimeHandles): ScriptIpcService => {
  const now = (): string => new Date().toISOString();
  const getProjectDefaults = async (
    projectId: string,
  ): Promise<Readonly<{ targetDurationSec: number }> | null> => {
    const activeProject = await handles.projects.run(({ projects }) =>
      projects.findById(projectId, 'ACTIVE'),
    );
    if (activeProject === null) return null;
    const currentProfile = await handles.unitOfWork.run(({ formatProfiles }) =>
      formatProfiles.findCurrent(projectId),
    );
    if (currentProfile === null) return null;
    // V1 does not persist a duration field on FormatProfile. One initialized Episode therefore
    // uses the PRD normal target midpoint; no database or public contract is expanded here.
    return { targetDurationSec: DEFAULT_EPISODE_DURATION_SEC };
  };
  const initialization = createOriginalInitializationService({
    getProjectDefaults,
    hashPayload,
    hashText,
    newId: randomUUID,
    now,
    unitOfWork: handles.unitOfWork,
    workspaceQuery: handles.workspaceQuery,
  });
  const existingInitialization = createExistingScriptInitializationService({
    getProjectDefaults,
    hashPayload,
    hashText,
    newId: randomUUID,
    now,
    unitOfWork: handles.unitOfWork,
    workspaceQuery: handles.workspaceQuery,
  });
  const versions = createScriptVersionService({
    hashPayload,
    newId: randomUUID,
    now,
    unitOfWork: handles.unitOfWork,
    validateDocument: (document) =>
      handles.registry.validate(SCRIPT_STAGE_OUTPUT_SCHEMA_ID, document).valid,
  });
  const storyboard = createStoryboardVersionService({
    hashPayload,
    hashText,
    newId: randomUUID,
    now,
    unitOfWork: handles.unitOfWork,
  });
  return createScriptService({
    findCurrentJob: async (projectId) => {
      const jobs = await handles.jobs.listByStatuses(ACTIVE_JOB_STATUSES, 100);
      return toJobSummary(jobs.find((job) => job.projectId === projectId) ?? null);
    },
    initialization,
    existingInitialization,
    storyboard,
    versions,
    workspaceQuery: handles.workspaceQuery,
  });
};

/**
 * Pure Script composition boundary. It deliberately does not register or wrap Job/Provider channels;
 * the main owner must pass the same persistence runtime and call this after startup reaches READY.
 */
export const createScriptFeatureRegistration = ({
  createService,
  ipcRegistrar,
  newTraceId,
  persistenceRuntime,
  inputFile,
  trustedUrl,
}: RegisterScriptFeaturesOptions): ScriptFeatureRegistration => {
  let registered = false;
  let activeService: ScriptIpcService | null = null;
  const blocked = (): Promise<AppResultDto<never>> =>
    Promise.resolve({
      error: {
        code: 'STARTUP_WRITE_BLOCKED',
        fieldErrors: null,
        message: '应用尚未进入可写状态。',
        retryable: true,
        traceId: 'trace_startup_gate',
        userAction: '请先处理启动故障后重试。',
      },
      ok: false,
    });
  const facade: ScriptIpcService = {
    confirmVersion: (input, traceId) => activeService?.confirmVersion(input, traceId) ?? blocked(),
    getWorkspace: (input, traceId) => activeService?.getWorkspace(input, traceId) ?? blocked(),
    initializeOriginal: (input, traceId) =>
      activeService?.initializeOriginal(input, traceId) ?? blocked(),
    initializeInput: (input, traceId) =>
      activeService?.initializeInput?.(input, traceId) ?? blocked(),
    importInput: async (input, traceId) => {
      const selected = inputFile === undefined ? null : await inputFile.readSelectedText();
      if (selected === null) {
        return {
          error: {
            code: 'SCRIPT_INPUT_FILE_CANCELLED',
            fieldErrors: null,
            message: '已取消文件导入。',
            retryable: false,
            traceId,
            userAction: '选择 .txt 或 .md 文件后重试。',
          },
          ok: false,
        };
      }
      return activeService?.importInput?.({ ...input, ...selected }, traceId) ?? blocked();
    },
    lockPath: (input, traceId) => activeService?.lockPath(input, traceId) ?? blocked(),
    listLocks: (input, traceId) => activeService?.listLocks(input, traceId) ?? blocked(),
    rewriteSelection: (input, traceId) =>
      activeService?.rewriteSelection?.(input, traceId) ?? blocked(),
    restoreVersion: (input, traceId) => activeService?.restoreVersion(input, traceId) ?? blocked(),
    saveDraft: (input, traceId) => activeService?.saveDraft(input, traceId) ?? blocked(),
  };
  registerScriptIpc(
    ipcRegistrar,
    facade,
    { isWriteReady: () => persistenceRuntime.startupService.getStatus().writeEnabled },
    trustedUrl,
    ...(newTraceId === undefined ? [] : [{ newTraceId }]),
  );
  return {
    ensureRegistered: () => {
      if (registered || !persistenceRuntime.startupService.getStatus().writeEnabled) return false;
      const unitOfWork = persistenceRuntime.getScriptUnitOfWork();
      const workspaceQuery = persistenceRuntime.getScriptWorkspaceQuery();
      const jobs = persistenceRuntime.getJobRepository();
      const projects = persistenceRuntime.getProjectUnitOfWork();
      const registry = persistenceRuntime.getSchemaRegistry();
      if (
        unitOfWork === null ||
        workspaceQuery === null ||
        jobs === null ||
        projects === null ||
        registry === null
      )
        return false;
      activeService = createService({ jobs, projects, registry, unitOfWork, workspaceQuery });
      registered = true;
      return true;
    },
  };
};
