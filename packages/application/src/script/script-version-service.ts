import type {
  AppResultDto,
  ConfirmScriptVersionInputDto,
  RestoreScriptVersionInputDto,
  SaveScriptDraftInputDto,
  ScriptVersionDto,
} from '@jingxu/contracts';

import type {
  ScriptAuditEntry,
  ScriptCommandName,
  ScriptCommandReceipt,
  ScriptDependency,
  ScriptJobRepositories,
  ScriptUnitOfWorkPort,
  ScriptVersion,
  StageHead,
  StagedScriptStage,
  StoryBibleVersion,
} from '../ports/script/index';
import { isProjectStage, listInvalidatedStages } from './script-dependency-graph';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';

type Version = ScriptVersion | StoryBibleVersion;

export interface ScriptVersionServiceDependencies {
  readonly unitOfWork: ScriptUnitOfWorkPort;
  readonly newId: () => string;
  readonly now: () => string;
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly validateDocument: (document: Readonly<Record<string, unknown>>) => boolean;
}

export interface ScriptVersionService {
  saveDraft(
    input: SaveScriptDraftInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptVersionDto>>;
  confirmVersion(
    input: ConfirmScriptVersionInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptVersionDto>>;
  restoreVersion(
    input: RestoreScriptVersionInputDto,
    traceId: string,
  ): Promise<AppResultDto<ScriptVersionDto>>;
}

const readVersion = async (
  repositories: ScriptJobRepositories,
  stage: StagedScriptStage,
  id: string,
): Promise<Version | null> =>
  stage === 'STORY_BIBLE'
    ? repositories.storyBibleVersions.findById(id)
    : repositories.scriptVersions.findById(id);

const parseDocument = (version: Version): Readonly<Record<string, unknown>> =>
  JSON.parse(version.document) as Readonly<Record<string, unknown>>;

const toDto = (version: Version): ScriptVersionDto => ({
  createdAt: version.createdAt,
  document: parseDocument(version) as ScriptVersionDto['document'],
  documentHash: version.documentSha256,
  id: version.id,
  parentId: version.parentId,
  projectId: version.projectId,
  source: version.source,
  status: version.status,
  versionNo: version.versionNo,
});

const assertScope = (
  version: Version,
  projectId: string,
  episodeId: string | null,
  stage: StagedScriptStage,
): boolean => {
  if (version.projectId !== projectId) return false;
  if (stage === 'STORY_BIBLE') return episodeId === null;
  return 'stage' in version && version.stage === stage && version.episodeId === episodeId;
};

const createVersion = async (
  repositories: ScriptJobRepositories,
  dependencies: ScriptVersionServiceDependencies,
  input: {
    readonly document: Readonly<Record<string, unknown>>;
    readonly episodeId: string | null;
    readonly parentId: string;
    readonly projectId: string;
    readonly source: Version['source'];
    readonly sourceInputId: string | null;
    readonly sourceInvocationId: string | null;
    readonly stage: StagedScriptStage;
    readonly status: Version['status'];
  },
): Promise<Version> => {
  const at = dependencies.now();
  const document = JSON.stringify(input.document);
  const common = {
    createdAt: at,
    document,
    documentSha256: dependencies.hashPayload(input.document),
    id: dependencies.newId(),
    parentId: input.parentId,
    projectId: input.projectId,
    source: input.source,
    sourceInvocationId: input.sourceInvocationId,
    status: input.status,
  } as const;
  if (input.stage === 'STORY_BIBLE') {
    const version: StoryBibleVersion = {
      ...common,
      versionNo: (await repositories.storyBibleVersions.findMaxVersionNo(input.projectId)) + 1,
    };
    await repositories.storyBibleVersions.insert(version);
    return version;
  }
  const stage = input.stage;
  const version: ScriptVersion = {
    ...common,
    changeSummary: null,
    episodeId: input.episodeId,
    sourceInputId: input.sourceInputId,
    stage,
    versionNo:
      (await repositories.scriptVersions.findMaxVersionNo(
        input.projectId,
        input.episodeId,
        stage,
      )) + 1,
  };
  await repositories.scriptVersions.insert(version);
  return version;
};

const headFor = (
  version: Version,
  episodeId: string | null,
  stage: StagedScriptStage,
  updatedAt: string,
): StageHead => ({
  currentVersionId: version.id,
  currentVersionType: stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
  episodeId,
  projectId: version.projectId,
  stage,
  updatedAt,
});

const commandNameFor = (operation: 'SAVE' | 'CONFIRM' | 'RESTORE'): ScriptCommandName =>
  operation === 'SAVE'
    ? 'SAVE_SCRIPT_DRAFT'
    : operation === 'CONFIRM'
      ? 'CONFIRM_SCRIPT_VERSION'
      : 'RESTORE_SCRIPT_VERSION';

export const createScriptVersionService = (
  dependencies: ScriptVersionServiceDependencies,
): ScriptVersionService => {
  const mutate = async (
    input: SaveScriptDraftInputDto | ConfirmScriptVersionInputDto,
    operation: 'SAVE' | 'CONFIRM' | 'RESTORE',
    traceId: string,
  ): Promise<AppResultDto<ScriptVersionDto>> => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        const payloadSha256 = dependencies.hashPayload(input);
        const priorReceipt = await repositories.receipts.findByRequestId(input.requestId);
        if (priorReceipt !== null) {
          if (
            priorReceipt.commandName !== commandNameFor(operation) ||
            priorReceipt.projectId !== input.projectId ||
            priorReceipt.payloadSha256 !== payloadSha256
          ) {
            throw new Error('REQUEST_ID_REUSED');
          }
          const replayId = priorReceipt.resultRef.versionId;
          if (typeof replayId !== 'string') throw new Error('RECEIPT_INVALID');
          const replayed = await readVersion(repositories, input.stage, replayId);
          if (replayed === null) throw new Error('RECEIPT_INVALID');
          return replayed;
        }

        const currentHead = await repositories.stageHeads.find(
          input.projectId,
          input.episodeId,
          input.stage,
        );
        if (currentHead?.currentVersionId !== input.expectedVersionId) {
          throw new Error('SCRIPT_VERSION_CONFLICT');
        }
        const current = await readVersion(repositories, input.stage, currentHead.currentVersionId);
        if (
          current === null ||
          !assertScope(current, input.projectId, input.episodeId, input.stage)
        ) {
          throw new Error('SCRIPT_VERSION_NOT_FOUND');
        }

        let selected = current;
        if (operation === 'RESTORE') {
          if (!('versionId' in input)) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const historical = await readVersion(repositories, input.stage, input.versionId);
          if (
            historical === null ||
            !assertScope(historical, input.projectId, input.episodeId, input.stage)
          ) {
            throw new Error('SCRIPT_VERSION_NOT_FOUND');
          }
          selected = historical;
        }

        const currentDocument = parseDocument(current);
        const document =
          operation === 'SAVE' && 'data' in input
            ? {
                data: input.data,
                episode_id: input.episodeId,
                project_id: input.projectId,
                schema_version: '1.0.0',
                source_invocation_id: currentDocument.source_invocation_id,
                stage: input.stage,
              }
            : parseDocument(selected);
        if (!dependencies.validateDocument(document)) throw new Error('SCRIPT_SCHEMA_INVALID');

        const next = await createVersion(repositories, dependencies, {
          document,
          episodeId: input.episodeId,
          parentId: current.id,
          projectId: input.projectId,
          source: operation === 'CONFIRM' ? 'USER' : operation === 'RESTORE' ? 'USER' : 'USER',
          sourceInputId: 'sourceInputId' in current ? current.sourceInputId : null,
          sourceInvocationId: null,
          stage: input.stage,
          status: operation === 'CONFIRM' ? 'READY' : 'DRAFT',
        });
        const moved = await repositories.stageHeads.upsert(
          headFor(next, input.episodeId, input.stage, dependencies.now()),
          current.id,
        );
        if (!moved) throw new Error('SCRIPT_VERSION_CONFLICT');

        if (operation === 'CONFIRM') {
          for (const downstreamStage of listInvalidatedStages(input.stage)) {
            const downstreamHeads = isProjectStage(downstreamStage)
              ? [await repositories.stageHeads.find(input.projectId, null, downstreamStage)].filter(
                  (head): head is StageHead => head !== null,
                )
              : input.episodeId !== null
                ? [
                    await repositories.stageHeads.find(
                      input.projectId,
                      input.episodeId,
                      downstreamStage,
                    ),
                  ].filter((head): head is StageHead => head !== null)
                : (await repositories.stageHeads.listByProjectId(input.projectId)).filter(
                    (head) => head.stage === downstreamStage && head.episodeId !== null,
                  );
            for (const downstreamHead of downstreamHeads) {
              const downstreamEpisodeId = downstreamHead.episodeId;
              const downstream = await readVersion(
                repositories,
                downstreamStage,
                downstreamHead.currentVersionId,
              );
              if (
                downstream === null ||
                !assertScope(downstream, input.projectId, downstreamEpisodeId, downstreamStage)
              ) {
                throw new Error('SCRIPT_VERSION_NOT_FOUND');
              }
              const stale = await createVersion(repositories, dependencies, {
                document: parseDocument(downstream),
                episodeId: downstreamEpisodeId,
                parentId: downstream.id,
                projectId: input.projectId,
                source: 'SYSTEM_INVALIDATION',
                sourceInputId: 'sourceInputId' in downstream ? downstream.sourceInputId : null,
                sourceInvocationId: null,
                stage: downstreamStage,
                status: 'STALE_INPUT',
              });
              if (
                !(await repositories.stageHeads.upsert(
                  headFor(stale, downstreamEpisodeId, downstreamStage, dependencies.now()),
                  downstream.id,
                ))
              ) {
                throw new Error('SCRIPT_VERSION_CONFLICT');
              }
              const invalidationDependency: ScriptDependency = {
                createdAt: dependencies.now(),
                dependencyType: 'INVALIDATES',
                downstreamId: downstreamStage,
                downstreamType:
                  downstreamStage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
                downstreamVersionId: stale.id,
                id: dependencies.newId(),
                projectId: input.projectId,
                upstreamId: input.stage,
                upstreamType:
                  input.stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
                upstreamVersionId: next.id,
              };
              await repositories.dependencies.insertMany([invalidationDependency]);
              await repositories.audit.record({
                action: 'SCRIPT_VERSION_INVALIDATED',
                actor: 'SYSTEM',
                afterSha256: stale.documentSha256,
                beforeSha256: downstream.documentSha256,
                createdAt: dependencies.now(),
                id: dependencies.newId(),
                metadata: {
                  reason: 'UPSTREAM_READY_CHANGED',
                  source: 'SYSTEM_INVALIDATION',
                  upstreamStage: input.stage,
                  upstreamVersionId: next.id,
                },
                objectId: downstreamStage,
                objectType: 'SCRIPT_STAGE',
                objectVersionId: stale.id,
                projectId: input.projectId,
                traceId,
              });
            }
          }
        }

        const audit: ScriptAuditEntry = {
          action: `SCRIPT_VERSION_${operation}`,
          actor: 'USER',
          afterSha256: next.documentSha256,
          beforeSha256: current.documentSha256,
          createdAt: dependencies.now(),
          id: dependencies.newId(),
          metadata:
            operation === 'RESTORE' && 'versionId' in input
              ? { restoredFromVersionId: input.versionId }
              : {},
          objectId: input.stage,
          objectType: 'SCRIPT_STAGE',
          objectVersionId: next.id,
          projectId: input.projectId,
          traceId,
        };
        await repositories.audit.record(audit);
        const receipt: ScriptCommandReceipt = {
          commandName: commandNameFor(operation),
          committedAt: dependencies.now(),
          payloadSha256,
          projectId: input.projectId,
          requestId: input.requestId,
          resultRef: { versionId: next.id },
          traceId,
        };
        await repositories.receipts.insert(receipt);
        return next;
      });
      return { data: toDto(result), ok: true };
    } catch (caught: unknown) {
      if (caught instanceof Error) {
        if (caught.message === 'REQUEST_ID_REUSED') {
          return scriptFailure('REQUEST_ID_REUSED', 'requestId 已用于不同命令', traceId);
        }
        if (caught.message === 'SCRIPT_VERSION_CONFLICT') {
          return scriptFailure('SCRIPT_VERSION_CONFLICT', '当前版本已变化，请刷新后重试', traceId);
        }
        if (caught.message === 'SCRIPT_VERSION_NOT_FOUND') {
          return scriptFailure('SCRIPT_VERSION_NOT_FOUND', '指定剧本版本不存在', traceId);
        }
        if (caught.message === 'SCRIPT_SCHEMA_INVALID') {
          return scriptFailure('SCRIPT_SCHEMA_INVALID', '剧本内容不符合当前阶段契约', traceId);
        }
      }
      return scriptPersistenceFailure(traceId);
    }
  };

  return {
    confirmVersion: (input, traceId) => mutate(input, 'CONFIRM', traceId),
    restoreVersion: (input, traceId) => mutate(input, 'RESTORE', traceId),
    saveDraft: (input, traceId) => mutate(input, 'SAVE', traceId),
  };
};
