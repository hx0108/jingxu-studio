import type { AppResultDto } from '@jingxu/contracts';

import type {
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptAuditEntry,
  ScriptCommandName,
  ScriptDependency,
  ScriptJobRepositories,
  ScriptUnitOfWorkPort,
  ShotContractVersion,
  StageHead,
  StagedScriptStage,
} from '../ports/script/index';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';
import { computeShotSetHash, type ShotSetHashEntry } from './shot-set-hash';

/** 分镜确认命令输入（stage 固定 SHOT_CONTRACT，episode 级）。 */
export interface StoryboardConfirmInput {
  readonly episodeId: string;
  readonly expectedVersionId: string;
  readonly projectId: string;
  readonly requestId: string;
}

/** 分镜恢复命令输入：versionId 为历史 episode_version id。 */
export interface StoryboardRestoreInput extends StoryboardConfirmInput {
  readonly versionId: string;
}

/** 确认/恢复结果的整集摘要；IPC 层（§5.3）映射为对外 DTO。 */
export interface StoryboardVersionSummary {
  readonly createdAt: string;
  readonly episodeId: string;
  readonly formatProfileId: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly shotCount: number;
  readonly shotSetHash: string;
  readonly status: EpisodeVersion['status'];
  readonly storyBibleVersionId: string;
  readonly targetDurationSec: number;
  readonly versionNo: number;
}

export interface StoryboardVersionServiceDependencies {
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  /** shot_set_hash 与 hashDocument 同源算法（sha256Text(JSON.stringify(...))）。 */
  readonly hashText: (value: string) => string;
  readonly newId: () => string;
  readonly now: () => string;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}

export interface StoryboardVersionService {
  confirmStoryboard(
    input: StoryboardConfirmInput,
    traceId: string,
  ): Promise<AppResultDto<StoryboardVersionSummary>>;
  restoreStoryboard(
    input: StoryboardRestoreInput,
    traceId: string,
  ): Promise<AppResultDto<StoryboardVersionSummary>>;
}

const toSummary = (version: EpisodeVersion, shotCount: number): StoryboardVersionSummary => ({
  createdAt: version.createdAt,
  episodeId: version.episodeId,
  formatProfileId: version.formatProfileId,
  id: version.id,
  parentId: version.parentId,
  shotCount,
  shotSetHash: version.shotSetHash,
  status: version.status,
  storyBibleVersionId: version.storyBibleVersionId,
  targetDurationSec: version.targetDurationSec,
  versionNo: version.versionNo,
});

const headFor = (version: EpisodeVersion, projectId: string, updatedAt: string): StageHead => ({
  currentVersionId: version.id,
  currentVersionType: 'EPISODE_VERSION',
  episodeId: version.episodeId,
  projectId,
  stage: 'SHOT_CONTRACT',
  updatedAt,
});

const commandNameFor = (operation: 'CONFIRM' | 'RESTORE'): ScriptCommandName =>
  operation === 'CONFIRM' ? 'CONFIRM_SCRIPT_VERSION' : 'RESTORE_SCRIPT_VERSION';

/** 确认：每个镜头创建 READY 子版本（D4），镜头当前指针随事务推进。 */
const buildReadyShotVersions = (
  links: readonly EpisodeVersionShot[],
  currentLinksByShotVersion: ReadonlyMap<string, ShotContractVersion>,
  dependencies: StoryboardVersionServiceDependencies,
  episodeVersionId: string,
  at: string,
): Readonly<{
  hashEntries: readonly ShotSetHashEntry[];
  links: readonly EpisodeVersionShot[];
  versions: readonly ShotContractVersion[];
}> => {
  const versions: ShotContractVersion[] = [];
  const newLinks: EpisodeVersionShot[] = [];
  const hashEntries: ShotSetHashEntry[] = [];
  for (const link of links) {
    const version = currentLinksByShotVersion.get(link.shotVersionId);
    if (version === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
    const versionNo = version.versionNo + 1;
    const id = `scv_${dependencies.newId()}_v${String(versionNo)}`;
    // D4：内容同 DRAFT，仅 document 内 status/contract_version/parent_version_id/version_id 同步改写。
    const document = {
      ...(JSON.parse(version.document) as Readonly<Record<string, unknown>>),
      contract_version: versionNo,
      parent_version_id: version.id,
      status: 'READY',
      version_id: id,
    };
    const documentSha256 = dependencies.hashPayload(document);
    versions.push({
      createdAt: at,
      dialogueRenderMode: version.dialogueRenderMode,
      document: JSON.stringify(document),
      documentSha256,
      externalParentVersionId: null,
      formatProfileId: version.formatProfileId,
      id,
      lineageResolutionStatus: 'LOCAL_VERIFIED',
      parentId: version.id,
      sequence: link.sequence,
      shotId: link.shotId,
      sourceInvocationId: version.sourceInvocationId,
      targetDurationSec: version.targetDurationSec,
      versionNo,
      versionStatus: 'READY',
    });
    newLinks.push({
      episodeVersionId,
      sequence: link.sequence,
      shotId: link.shotId,
      shotVersionId: id,
    });
    hashEntries.push({
      documentSha256,
      sequence: link.sequence,
      shotId: link.shotId,
      shotVersionId: id,
    });
  }
  return { hashEntries, links: newLinks, versions };
};

/**
 * D4 版本语义的分镜命令侧：确认创建 READY 镜头集合 + READY 整集版本，恢复将历史
 * 整集快照复制为新 DRAFT。命令回执复用五阶段 CONFIRM/RESTORE 命令名（D6）。
 */
export const createStoryboardVersionService = (
  dependencies: StoryboardVersionServiceDependencies,
): StoryboardVersionService => {
  const mutate = async (
    input: StoryboardConfirmInput | StoryboardRestoreInput,
    operation: 'CONFIRM' | 'RESTORE',
    traceId: string,
  ): Promise<AppResultDto<StoryboardVersionSummary>> => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        const payloadSha256 = dependencies.hashPayload({
          episodeId: input.episodeId,
          expectedVersionId: input.expectedVersionId,
          operation,
          projectId: input.projectId,
          requestId: input.requestId,
          versionId: 'versionId' in input ? input.versionId : null,
        });
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
          const replayed = await repositories.episodeVersions.findById(replayId);
          if (replayed?.episodeId !== input.episodeId) {
            throw new Error('RECEIPT_INVALID');
          }
          const replayLinks = await repositories.episodeVersions.listShotLinks(replayed.id);
          return toSummary(replayed, replayLinks.length);
        }

        const currentHead = await repositories.stageHeads.find(
          input.projectId,
          input.episodeId,
          'SHOT_CONTRACT',
        );
        if (currentHead?.currentVersionId !== input.expectedVersionId) {
          throw new Error('SCRIPT_VERSION_CONFLICT');
        }
        const current = await repositories.episodeVersions.findById(currentHead.currentVersionId);
        if (current?.episodeId !== input.episodeId) {
          throw new Error('SCRIPT_VERSION_NOT_FOUND');
        }
        const currentLinks = await repositories.episodeVersions.listShotLinks(current.id);
        if (currentLinks.length === 0) throw new Error('SCRIPT_VERSION_NOT_FOUND');

        const at = dependencies.now();
        const episodeVersionId = dependencies.newId();
        let next: EpisodeVersion;
        let nextLinks: readonly EpisodeVersionShot[];

        if (operation === 'CONFIRM') {
          const currentVersions = new Map<string, ShotContractVersion>();
          for (const link of currentLinks) {
            const version = await repositories.shotContractVersions.findById(link.shotVersionId);
            if (version === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
            currentVersions.set(link.shotVersionId, version);
          }
          const ready = buildReadyShotVersions(
            currentLinks,
            currentVersions,
            dependencies,
            episodeVersionId,
            at,
          );
          await repositories.shotContractVersions.insertMany(ready.versions);
          await repositories.shots.updateCurrentVersionIds(
            ready.versions.map((version) => ({
              currentVersionId: version.id,
              shotId: version.shotId,
              updatedAt: at,
            })),
          );
          next = {
            createdAt: at,
            episodeId: current.episodeId,
            formatProfileId: current.formatProfileId,
            id: episodeVersionId,
            parentId: current.id,
            shotSetHash: computeShotSetHash(ready.hashEntries, dependencies.hashText),
            storyBibleVersionId: current.storyBibleVersionId,
            status: 'READY',
            targetDurationSec: current.targetDurationSec,
            versionNo: (await repositories.episodeVersions.findMaxVersionNo(input.episodeId)) + 1,
          };
          nextLinks = ready.links;
        } else {
          if (!('versionId' in input)) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          // 恢复复用既有语义：历史整集快照 → 新 DRAFT 整集；同一批 shot 版本引用与
          // shot_set_hash 原样沿用，不创建镜头子版本，也不回拨镜头当前指针（D4）。
          const historical = await repositories.episodeVersions.findById(input.versionId);
          if (historical?.episodeId !== input.episodeId) {
            throw new Error('SCRIPT_VERSION_NOT_FOUND');
          }
          const historicalLinks = await repositories.episodeVersions.listShotLinks(historical.id);
          if (historicalLinks.length === 0) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          next = {
            createdAt: at,
            episodeId: historical.episodeId,
            formatProfileId: historical.formatProfileId,
            id: episodeVersionId,
            parentId: current.id,
            shotSetHash: historical.shotSetHash,
            storyBibleVersionId: historical.storyBibleVersionId,
            status: 'DRAFT',
            targetDurationSec: historical.targetDurationSec,
            versionNo: (await repositories.episodeVersions.findMaxVersionNo(input.episodeId)) + 1,
          };
          nextLinks = historicalLinks.map((link) => ({
            ...link,
            episodeVersionId: episodeVersionId,
          }));
        }

        await repositories.episodeVersions.insert(next);
        await repositories.episodeVersions.insertShotLinks(nextLinks);
        if (
          !(await repositories.stageHeads.upsert(
            headFor(next, input.projectId, dependencies.now()),
            current.id,
          ))
        ) {
          throw new Error('SCRIPT_VERSION_CONFLICT');
        }

        const audit: ScriptAuditEntry = {
          action: operation === 'CONFIRM' ? 'SCRIPT_VERSION_CONFIRM' : 'SCRIPT_VERSION_RESTORE',
          actor: 'USER',
          afterSha256: next.shotSetHash,
          beforeSha256: current.shotSetHash,
          createdAt: dependencies.now(),
          id: dependencies.newId(),
          metadata:
            operation === 'RESTORE' && 'versionId' in input
              ? { restoredFromVersionId: input.versionId }
              : {},
          objectId: 'SHOT_CONTRACT',
          objectType: 'SCRIPT_STAGE',
          objectVersionId: next.id,
          projectId: input.projectId,
          traceId,
        };
        await repositories.audit.record(audit);
        await repositories.receipts.insert({
          commandName: commandNameFor(operation),
          committedAt: dependencies.now(),
          payloadSha256,
          projectId: input.projectId,
          requestId: input.requestId,
          resultRef: { versionId: next.id },
          traceId,
        });
        return toSummary(next, nextLinks.length);
      });
      return { data: result, ok: true };
    } catch (caught: unknown) {
      if (caught instanceof Error) {
        if (caught.message === 'REQUEST_ID_REUSED') {
          return scriptFailure('REQUEST_ID_REUSED', 'requestId 已用于不同命令', traceId);
        }
        if (caught.message === 'SCRIPT_VERSION_CONFLICT') {
          return scriptFailure('SCRIPT_VERSION_CONFLICT', '当前版本已变化，请刷新后重试', traceId);
        }
        if (caught.message === 'SCRIPT_VERSION_NOT_FOUND') {
          return scriptFailure('SCRIPT_VERSION_NOT_FOUND', '指定分镜版本不存在', traceId);
        }
      }
      return scriptPersistenceFailure(traceId);
    }
  };

  return {
    confirmStoryboard: (input, traceId) => mutate(input, 'CONFIRM', traceId),
    restoreStoryboard: (input, traceId) => mutate(input, 'RESTORE', traceId),
  };
};

export interface StoryboardInvalidationInput {
  readonly episodeId: string;
  readonly projectId: string;
  readonly upstreamStage: StagedScriptStage;
  readonly upstreamVersionId: string;
}

/**
 * 上游 READY 变更传播（D4 失效）：只插入一行引用同一批镜头版本快照的
 * STALE_INPUT episode_version 并移动阶段头；不逐镜头创建 STALE 版本。
 * 无分镜阶段头的 Episode 静默跳过（不产生失效行）。
 */
export const invalidateStoryboardHead = async (
  repositories: ScriptJobRepositories,
  dependencies: Pick<StoryboardVersionServiceDependencies, 'newId' | 'now'>,
  input: StoryboardInvalidationInput,
  traceId: string,
): Promise<void> => {
  const head = await repositories.stageHeads.find(
    input.projectId,
    input.episodeId,
    'SHOT_CONTRACT',
  );
  if (head === null) return;
  const current = await repositories.episodeVersions.findById(head.currentVersionId);
  if (current?.episodeId !== input.episodeId) {
    throw new Error('SCRIPT_VERSION_NOT_FOUND');
  }

  const at = dependencies.now();
  const stale: EpisodeVersion = {
    createdAt: at,
    episodeId: current.episodeId,
    formatProfileId: current.formatProfileId,
    id: dependencies.newId(),
    parentId: current.id,
    // 整集快照沿用：hash 与镜头引用不变，仅推进集合状态。
    shotSetHash: current.shotSetHash,
    storyBibleVersionId: current.storyBibleVersionId,
    status: 'STALE_INPUT',
    targetDurationSec: current.targetDurationSec,
    versionNo: (await repositories.episodeVersions.findMaxVersionNo(input.episodeId)) + 1,
  };
  await repositories.episodeVersions.insert(stale);
  const links = await repositories.episodeVersions.listShotLinks(current.id);
  if (links.length > 0) {
    await repositories.episodeVersions.insertShotLinks(
      links.map((link) => ({ ...link, episodeVersionId: stale.id })),
    );
  }
  if (
    !(await repositories.stageHeads.upsert(
      headFor(stale, input.projectId, dependencies.now()),
      current.id,
    ))
  ) {
    throw new Error('SCRIPT_VERSION_CONFLICT');
  }

  const invalidationDependency: ScriptDependency = {
    createdAt: at,
    dependencyType: 'INVALIDATES',
    downstreamId: 'SHOT_CONTRACT',
    downstreamType: 'EPISODE_VERSION',
    downstreamVersionId: stale.id,
    id: dependencies.newId(),
    projectId: input.projectId,
    upstreamId: input.upstreamStage,
    upstreamType: input.upstreamStage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
    upstreamVersionId: input.upstreamVersionId,
  };
  await repositories.dependencies.insertMany([invalidationDependency]);
  const audit: ScriptAuditEntry = {
    action: 'SCRIPT_VERSION_INVALIDATED',
    actor: 'SYSTEM',
    afterSha256: stale.shotSetHash,
    beforeSha256: current.shotSetHash,
    createdAt: dependencies.now(),
    id: dependencies.newId(),
    metadata: {
      reason: 'UPSTREAM_READY_CHANGED',
      source: 'SYSTEM_INVALIDATION',
      upstreamStage: input.upstreamStage,
      upstreamVersionId: input.upstreamVersionId,
    },
    objectId: 'SHOT_CONTRACT',
    objectType: 'SCRIPT_STAGE',
    objectVersionId: stale.id,
    projectId: input.projectId,
    traceId,
  };
  await repositories.audit.record(audit);
};
