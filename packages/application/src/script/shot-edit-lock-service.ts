/**
 * 分镜逐镜头编辑与锁定命令（shot-edit-lock design 定案）。
 *
 * editShot：单事务完成 ShotContract 1.1.0 校验（注入校验器）→ 写集推导 → 锁复检
 * （父/子/相等冲突全阻断）→ EDIT_INVARIANT（整集集合校验，复用生成管线校验器）
 * → 新 scv DRAFT（系统字段重写、有效锁复制）→ 新整集快照 + shotSetHash 复算 →
 * 镜头指针推进 → stage_head → 回执（D6：复用 SAVE_SCRIPT_DRAFT 命令名）。
 * lock/unlock：scv 不可变触发器 + 不变量 13 决定必须版本化——新 scv 仅变
 * locked_paths，lock_records 同事务写（唯一可写事实源）；无回执，同状态重入为
 * 天然幂等 no-op 成功。
 */

import type { AppResultDto, ProjectErrorCode } from '@jingxu/contracts';

import type {
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptJobRepositories,
  ShotContractVersion,
  ShotLockRecord,
} from '../ports/script/index';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';
import {
  changedEditableRoots,
  parseLockPointer,
  pointerTokensConflict,
  validateLockPointer,
} from './shot-lock-policy';
import {
  extractShotCollectionBibleKeys,
  validateShotSetCollection,
} from './shot-collection-validator';
import { deriveDialogueFlags } from './shot-system-fields';
import { computeShotSetHash } from './shot-set-hash';
import {
  headFor,
  toSummary,
  type StoryboardVersionServiceDependencies,
  type StoryboardVersionSummary,
} from './storyboard-version-service';

export interface ShotEditInput {
  /** 编辑后的完整镜头文档（用户提交全文；系统字段以系统重写为准）。 */
  readonly document: Readonly<Record<string, unknown>>;
  readonly episodeId: string;
  readonly expectedVersionId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly shotId: string;
  /** 编辑基线镜头版本 id；与当前集合引用不一致视为并发冲突。 */
  readonly shotVersionId: string;
}

export interface ShotLockTargetInput {
  readonly episodeId: string;
  readonly expectedVersionId: string;
  readonly jsonPointer: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly shotId: string;
}

export interface ShotLockInput extends ShotLockTargetInput {
  readonly note: string | null;
}

export interface ShotEditLockSummary {
  readonly episode: StoryboardVersionSummary;
  /** 操作后镜头当前版本 id（no-op 时为既有版本）。 */
  readonly shotVersionId: string;
  /** 操作后有效锁路径投影（恒等于 lock_records 有效集合，不变量 13）。 */
  readonly lockedPaths: readonly string[];
}

export interface ShotEditLockService {
  editShot(input: ShotEditInput, traceId: string): Promise<AppResultDto<ShotEditLockSummary>>;
  lockShot(input: ShotLockInput, traceId: string): Promise<AppResultDto<ShotEditLockSummary>>;
  unlockShot(
    input: ShotLockTargetInput,
    traceId: string,
  ): Promise<AppResultDto<ShotEditLockSummary>>;
}

export interface ShotEditLockServiceDependencies extends Pick<
  StoryboardVersionServiceDependencies,
  'hashPayload' | 'hashText' | 'newId' | 'now' | 'unitOfWork'
> {
  /** ShotContract 1.1.0 正式校验（注入 registry.validate；details 为结构元数据）。 */
  readonly validateShotDocument: (
    document: unknown,
  ) =>
    | Readonly<{ valid: true }>
    | Readonly<{ code: string; details?: readonly string[]; valid: false }>;
}

/** 带结构化 fieldErrors 的命令失败（catch 层统一映射为 AppResultDto）。 */
interface ShotEditLockFailurePayload {
  readonly code: ProjectErrorCode;
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  readonly message: string;
}

class ShotEditLockServiceError extends Error {
  public constructor(public readonly payload: ShotEditLockFailurePayload) {
    super(payload.code);
  }
}

const DETAIL_LIMIT = 10;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseStoredDocument = (document: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(document);
    if (isRecord(parsed)) return { ...parsed };
  } catch {
    // 落到下方统一失败
  }
  throw new Error('SHOT_DOCUMENT_CORRUPT');
};

interface ResolvedTarget {
  readonly activeLocks: readonly ShotLockRecord[];
  readonly current: EpisodeVersion;
  readonly currentDocument: Readonly<Record<string, unknown>>;
  readonly currentLinks: readonly EpisodeVersionShot[];
  readonly link: EpisodeVersionShot;
  readonly shotVersion: ShotContractVersion;
}

/** 定位编辑/锁定目标：head 乐观并发校验 + 集合镜头定位 + 当前文档与有效锁。 */
const resolveTarget = async (
  repositories: ScriptJobRepositories,
  input: Readonly<{
    episodeId: string;
    expectedVersionId: string;
    projectId: string;
    shotId: string;
  }>,
): Promise<ResolvedTarget> => {
  const head = await repositories.stageHeads.find(
    input.projectId,
    input.episodeId,
    'SHOT_CONTRACT',
  );
  if (head?.currentVersionId !== input.expectedVersionId) {
    throw new Error('SCRIPT_VERSION_CONFLICT');
  }
  const current = await repositories.episodeVersions.findById(head.currentVersionId);
  if (current?.episodeId !== input.episodeId) {
    throw new Error('SCRIPT_VERSION_NOT_FOUND');
  }
  const currentLinks = await repositories.episodeVersions.listShotLinks(current.id);
  const link = currentLinks.find((candidate) => candidate.shotId === input.shotId);
  if (link === undefined) {
    throw new Error('SCRIPT_VERSION_NOT_FOUND');
  }
  const shotVersion = await repositories.shotContractVersions.findById(link.shotVersionId);
  if (shotVersion === null) {
    throw new Error('SCRIPT_VERSION_NOT_FOUND');
  }
  const activeLocks = await repositories.locks.listActive(input.projectId, input.shotId);
  return {
    activeLocks,
    current,
    currentDocument: parseStoredDocument(shotVersion.document),
    currentLinks,
    link,
    shotVersion,
  };
};

/** no-op 路径摘要：不创建版本，返回当前集合状态（锁命令幂等重放收敛点）。 */
const noOpSummary = async (
  repositories: ScriptJobRepositories,
  input: Readonly<{ episodeId: string; projectId: string; shotId: string }>,
  lockedPaths: readonly string[],
): Promise<ShotEditLockSummary> => {
  const head = await repositories.stageHeads.find(
    input.projectId,
    input.episodeId,
    'SHOT_CONTRACT',
  );
  if (head === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
  const current = await repositories.episodeVersions.findById(head.currentVersionId);
  if (current?.episodeId !== input.episodeId) throw new Error('SCRIPT_VERSION_NOT_FOUND');
  const links = await repositories.episodeVersions.listShotLinks(current.id);
  const link = links.find((candidate) => candidate.shotId === input.shotId);
  if (link === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
  return {
    episode: toSummary(current, links.length),
    lockedPaths,
    shotVersionId: link.shotVersionId,
  };
};

/**
 * 新 scv + 新整集快照 + 指针推进 + stage_head（编辑/锁定/解锁共用落库尾段）。
 * document 为已完成系统字段重写的最终文档；newLinks 为完整集合快照。
 */
const commitShotVersion = async (
  repositories: ScriptJobRepositories,
  dependencies: ShotEditLockServiceDependencies,
  input: Readonly<{ episodeId: string; projectId: string }>,
  target: ResolvedTarget,
  document: Readonly<Record<string, unknown>>,
  versionStatus: ShotContractVersion['versionStatus'],
  episodeStatus: EpisodeVersion['status'],
  traceId: string,
  audit: (
    shotVersionId: string,
  ) => Readonly<{ action: string; metadata: Readonly<Record<string, unknown>> }>,
): Promise<{
  episodeVersion: EpisodeVersion;
  links: readonly EpisodeVersionShot[];
  shotVersionId: string;
}> => {
  const at = dependencies.now();
  const versionNo = target.shotVersion.versionNo + 1;
  const shotVersionId = `scv_${dependencies.newId()}_v${String(versionNo)}`;
  const dialogue = isRecord(document.dialogue) ? document.dialogue : {};
  const duration = document.target_duration_sec;
  const renderMode = dialogue.dialogue_render_mode;
  const finalDocument = {
    ...document,
    contract_version: versionNo,
    format_profile_id: target.shotVersion.formatProfileId,
    parent_version_id: target.shotVersion.id,
    sequence: target.link.sequence,
    shot_id: target.link.shotId,
    version_id: shotVersionId,
  };
  const documentSha256 = dependencies.hashPayload(finalDocument);
  await repositories.shotContractVersions.insertMany([
    {
      createdAt: at,
      dialogueRenderMode: renderMode as ShotContractVersion['dialogueRenderMode'],
      document: JSON.stringify(finalDocument),
      documentSha256,
      externalParentVersionId: null,
      formatProfileId: target.shotVersion.formatProfileId,
      id: shotVersionId,
      lineageResolutionStatus: 'LOCAL_VERIFIED',
      parentId: target.shotVersion.id,
      sequence: target.link.sequence,
      shotId: target.link.shotId,
      sourceInvocationId: target.shotVersion.sourceInvocationId,
      targetDurationSec:
        typeof duration === 'number' ? duration : target.shotVersion.targetDurationSec,
      versionNo,
      versionStatus,
    },
  ]);
  await repositories.shots.updateCurrentVersionIds([
    { currentVersionId: shotVersionId, updatedAt: at, shotId: target.link.shotId },
  ]);

  const episodeVersionId = dependencies.newId();
  const hashEntries: {
    documentSha256: string;
    sequence: number;
    shotId: string;
    shotVersionId: string;
  }[] = target.currentLinks.map((entry) =>
    entry.shotId === target.link.shotId
      ? { documentSha256, sequence: entry.sequence, shotId: entry.shotId, shotVersionId }
      : {
          documentSha256: '',
          sequence: entry.sequence,
          shotId: entry.shotId,
          shotVersionId: entry.shotVersionId,
        },
  );
  // 兄弟镜头的 documentSha256 需真实值：逐个回填（数量 ≤ 20，V1 上限）。
  for (const entry of hashEntries) {
    if (entry.documentSha256 !== '') continue;
    const sibling = await repositories.shotContractVersions.findById(entry.shotVersionId);
    if (sibling === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
    entry.documentSha256 = sibling.documentSha256;
  }
  const nextEpisode: EpisodeVersion = {
    createdAt: at,
    episodeId: target.current.episodeId,
    formatProfileId: target.current.formatProfileId,
    id: episodeVersionId,
    parentId: target.current.id,
    shotSetHash: computeShotSetHash(hashEntries, dependencies.hashText),
    storyBibleVersionId: target.current.storyBibleVersionId,
    status: episodeStatus,
    targetDurationSec: target.current.targetDurationSec,
    versionNo: (await repositories.episodeVersions.findMaxVersionNo(input.episodeId)) + 1,
  };
  const links = hashEntries.map((entry) => ({
    episodeVersionId,
    sequence: entry.sequence,
    shotId: entry.shotId,
    shotVersionId: entry.shotVersionId,
  }));
  await repositories.episodeVersions.insert(nextEpisode);
  await repositories.episodeVersions.insertShotLinks(links);
  if (
    !(await repositories.stageHeads.upsert(
      headFor(nextEpisode, input.projectId, dependencies.now()),
      target.current.id,
    ))
  ) {
    throw new Error('SCRIPT_VERSION_CONFLICT');
  }
  await repositories.audit.record({
    ...audit(shotVersionId),
    actor: 'USER',
    afterSha256: nextEpisode.shotSetHash,
    beforeSha256: target.current.shotSetHash,
    createdAt: dependencies.now(),
    id: dependencies.newId(),
    objectId: target.link.shotId,
    objectType: 'SHOT_CONTRACT',
    objectVersionId: shotVersionId,
    projectId: input.projectId,
    traceId,
  });
  return { episodeVersion: nextEpisode, links, shotVersionId };
};

/** 编辑器系统字段重写：标识/版本/溯源常量与 allOf 派生值不信任编辑器输入。 */
const buildEditedDocument = (
  editedDocument: Readonly<Record<string, unknown>>,
  target: ResolvedTarget,
  lockedPaths: readonly string[],
): Record<string, unknown> => {
  const continuity = isRecord(editedDocument.continuity) ? editedDocument.continuity : {};
  const dialogue = isRecord(editedDocument.dialogue) ? editedDocument.dialogue : {};
  const content = isRecord(editedDocument.content) ? editedDocument.content : {};
  const currentContinuity = isRecord(target.currentDocument.continuity)
    ? target.currentDocument.continuity
    : {};
  const currentProvenance = isRecord(target.currentDocument.provenance)
    ? target.currentDocument.provenance
    : {};
  const spoken = typeof content.spoken_text === 'string' && content.spoken_text.length > 0;
  const flags = deriveDialogueFlags({
    renderMode: dialogue.dialogue_render_mode,
    spokenText: content.spoken_text,
  });
  // previous_shot_id 系统派生：CONTINUOUS_ACTION 指向 sequence-1 镜头（与生成注入同族）。
  const previousShotId =
    continuity.continuity_mode === 'CONTINUOUS_ACTION'
      ? (target.currentLinks.find((candidate) => candidate.sequence === target.link.sequence - 1)
          ?.shotId ?? null)
      : null;
  return {
    ...editedDocument,
    continuity: {
      ...continuity,
      asset_version_ids: currentContinuity.asset_version_ids ?? [],
      previous_shot_id: previousShotId,
    },
    dialogue: {
      ...dialogue,
      audio_required: flags?.audioRequired ?? dialogue.audio_required,
      estimated_speech_duration_sec: spoken ? dialogue.estimated_speech_duration_sec : 0,
      lip_sync_required: flags?.lipSyncRequired ?? dialogue.lip_sync_required,
      // Schema allO 强制：无台词恒 null；NARRATION_FIRST 有台词恒 narrator。
      speaker_id: spoken
        ? dialogue.dialogue_render_mode === 'NARRATION_FIRST'
          ? 'narrator'
          : dialogue.speaker_id
        : null,
    },
    derived_from_shot_ids: target.currentDocument.derived_from_shot_ids ?? [],
    locked_paths: lockedPaths,
    provenance: { ...currentProvenance, last_edit_source: 'HUMAN' },
    schema_version: '1.1.0',
    status: 'DRAFT',
  };
};

export const createShotEditLockService = (
  dependencies: ShotEditLockServiceDependencies,
): ShotEditLockService => {
  const editShot = async (
    input: ShotEditInput,
    traceId: string,
  ): Promise<AppResultDto<ShotEditLockSummary>> => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        const payloadSha256 = dependencies.hashPayload({
          document: input.document,
          episodeId: input.episodeId,
          expectedVersionId: input.expectedVersionId,
          operation: 'EDIT_SHOT',
          projectId: input.projectId,
          requestId: input.requestId,
          shotId: input.shotId,
          shotVersionId: input.shotVersionId,
        });
        const priorReceipt = await repositories.receipts.findByRequestId(input.requestId);
        if (priorReceipt !== null) {
          if (
            priorReceipt.commandName !== 'SAVE_SCRIPT_DRAFT' ||
            priorReceipt.projectId !== input.projectId ||
            priorReceipt.payloadSha256 !== payloadSha256
          ) {
            throw new Error('REQUEST_ID_REUSED');
          }
          const replayEpisodeId = priorReceipt.resultRef.episodeVersionId;
          const replayShotId = priorReceipt.resultRef.shotVersionId;
          if (typeof replayEpisodeId !== 'string' || typeof replayShotId !== 'string') {
            throw new Error('RECEIPT_INVALID');
          }
          const replayed = await repositories.episodeVersions.findById(replayEpisodeId);
          if (replayed?.episodeId !== input.episodeId) {
            throw new Error('RECEIPT_INVALID');
          }
          const replayLinks = await repositories.episodeVersions.listShotLinks(replayed.id);
          const replayLink = replayLinks.find((candidate) => candidate.shotId === input.shotId);
          return {
            episode: toSummary(replayed, replayLinks.length),
            lockedPaths: (await repositories.locks.listActive(input.projectId, input.shotId)).map(
              (lock) => lock.jsonPointer,
            ),
            shotVersionId: replayLink?.shotVersionId ?? replayShotId,
          } satisfies ShotEditLockSummary;
        }

        const target = await resolveTarget(repositories, input);
        if (target.link.shotVersionId !== input.shotVersionId) {
          throw new Error('SCRIPT_VERSION_CONFLICT');
        }

        const changedRoots = changedEditableRoots(target.currentDocument, input.document);
        if (changedRoots.length === 0) {
          throw new ShotEditLockServiceError({
            code: 'SHOT_EDIT_NO_CHANGE',
            fieldErrors: null,
            message: '本次编辑未改变任何创意字段',
          });
        }

        // 锁复检：写集根与任一有效锁 token 前缀冲突（父/子/相等）即整体阻断。
        const conflicts: string[] = [];
        for (const lock of target.activeLocks) {
          const lockTokens = parseLockPointer(lock.jsonPointer);
          if (lockTokens === null) throw new Error('LOCK_RECORD_CORRUPT');
          if (changedRoots.some((root) => pointerTokensConflict(lockTokens, [root]))) {
            conflicts.push(lock.jsonPointer);
          }
        }
        if (conflicts.length > 0) {
          throw new ShotEditLockServiceError({
            code: 'SHOT_LOCK_CONFLICT',
            fieldErrors: { lockedPaths: conflicts.slice(0, DETAIL_LIMIT).join(', ') },
            message: '编辑路径已被锁定，请先解锁后再编辑',
          });
        }

        const lockedPaths = target.activeLocks.map((lock) => lock.jsonPointer);
        const editedDocument = buildEditedDocument(input.document, target, lockedPaths);
        const schemaResult = dependencies.validateShotDocument(editedDocument);
        if (!schemaResult.valid) {
          throw new ShotEditLockServiceError({
            code: 'SCRIPT_SCHEMA_INVALID',
            fieldErrors: {
              details: (schemaResult.details ?? [schemaResult.code])
                .slice(0, DETAIL_LIMIT)
                .join('; '),
            },
            message: '编辑后的镜头文档不符合 ShotContract 1.1.0',
          });
        }

        // EDIT_INVARIANT：整集 ACTIVE 集合（含新版本）通过集合校验。
        const bible = await repositories.storyBibleVersions.findById(
          target.current.storyBibleVersionId,
        );
        const bibleKeys =
          bible === null ? null : extractShotCollectionBibleKeys(safeParse(bible.document));
        if (bibleKeys === null) throw new Error('STALE_INPUT');
        const documents = await Promise.all(
          target.currentLinks.map(async (entry) => {
            if (entry.shotId === target.link.shotId) return editedDocument;
            const sibling = await repositories.shotContractVersions.findById(entry.shotVersionId);
            if (sibling === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
            return safeParse(sibling.document);
          }),
        );
        const collection = validateShotSetCollection(documents, bibleKeys);
        if (!collection.valid) {
          throw new ShotEditLockServiceError({
            code: 'SCRIPT_SCHEMA_INVALID',
            fieldErrors: {
              details: [collection.code, ...collection.details].slice(0, DETAIL_LIMIT).join('; '),
            },
            message: '编辑将破坏整集分镜不变量，已整体拒绝',
          });
        }

        const committed = await commitShotVersion(
          repositories,
          dependencies,
          input,
          target,
          editedDocument,
          'DRAFT',
          'DRAFT',
          traceId,
          (shotVersionId) => ({
            action: 'SHOT_EDITED',
            metadata: { changedRoots, shotId: target.link.shotId, shotVersionId },
          }),
        );
        // 审计 metadata 需要 shotVersionId，而 id 在 commit 内生成：改为先构造后写。
        await repositories.receipts.insert({
          commandName: 'SAVE_SCRIPT_DRAFT',
          committedAt: dependencies.now(),
          payloadSha256,
          projectId: input.projectId,
          requestId: input.requestId,
          resultRef: {
            episodeVersionId: committed.episodeVersion.id,
            shotVersionId: committed.shotVersionId,
          },
          traceId,
        });
        return {
          episode: toSummary(committed.episodeVersion, committed.links.length),
          lockedPaths,
          shotVersionId: committed.shotVersionId,
        } satisfies ShotEditLockSummary;
      });
      return { data: result, ok: true };
    } catch (caught: unknown) {
      return mapFailure(caught, traceId);
    }
  };

  const lockShot = async (
    input: ShotLockInput,
    traceId: string,
  ): Promise<AppResultDto<ShotEditLockSummary>> => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        // 天然幂等收敛：指针已处于有效锁定状态 → no-op 成功（无回执前提下的重放语义）。
        const active = await repositories.locks.listActive(input.projectId, input.shotId);
        if (active.some((lock) => lock.jsonPointer === input.jsonPointer)) {
          return noOpSummary(
            repositories,
            input,
            active.map((lock) => lock.jsonPointer),
          );
        }
        const target = await resolveTarget(repositories, input);
        const check = validateLockPointer(input.jsonPointer, target.currentDocument);
        if (!check.ok) {
          throw new ShotEditLockServiceError({
            code: 'SHOT_LOCK_POINTER_INVALID',
            fieldErrors: { jsonPointer: `${check.code}:${check.detail}` },
            message: '锁定路径非法（不在七根白名单 / 含数组下标 / 非法转义 / 不存在）',
          });
        }
        const lockedPaths = [...active.map((lock) => lock.jsonPointer), input.jsonPointer];
        const document = { ...target.currentDocument, locked_paths: lockedPaths };
        const schemaResult = dependencies.validateShotDocument(document);
        if (!schemaResult.valid) {
          throw new ShotEditLockServiceError({
            code: 'SCRIPT_SCHEMA_INVALID',
            fieldErrors: {
              details: (schemaResult.details ?? [schemaResult.code])
                .slice(0, DETAIL_LIMIT)
                .join('; '),
            },
            message: '当前镜头文档无法通过 ShotContract 1.1.0 校验',
          });
        }
        const committed = await commitShotVersion(
          repositories,
          dependencies,
          input,
          target,
          document,
          target.shotVersion.versionStatus,
          target.current.status,
          traceId,
          () => ({ action: 'SHOT_LOCKED', metadata: { jsonPointer: input.jsonPointer } }),
        );
        await repositories.locks.insert({
          id: dependencies.newId(),
          jsonPointer: input.jsonPointer,
          lockedAt: dependencies.now(),
          lockedBy: 'USER',
          note: input.note,
          objectId: target.link.shotId,
          objectType: 'SHOT_CONTRACT',
          objectVersionId: committed.shotVersionId,
          projectId: input.projectId,
          unlockedAt: null,
        });
        return {
          episode: toSummary(committed.episodeVersion, committed.links.length),
          lockedPaths,
          shotVersionId: committed.shotVersionId,
        } satisfies ShotEditLockSummary;
      });
      return { data: result, ok: true };
    } catch (caught: unknown) {
      return mapFailure(caught, traceId);
    }
  };

  const unlockShot = async (
    input: ShotLockTargetInput,
    traceId: string,
  ): Promise<AppResultDto<ShotEditLockSummary>> => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        const active = await repositories.locks.listActive(input.projectId, input.shotId);
        const record = active.find((lock) => lock.jsonPointer === input.jsonPointer);
        if (record === undefined) {
          return noOpSummary(
            repositories,
            input,
            active.map((lock) => lock.jsonPointer),
          );
        }
        const target = await resolveTarget(repositories, input);
        if (!(await repositories.locks.unlock(record.id, dependencies.now()))) {
          throw new Error('SCRIPT_VERSION_CONFLICT');
        }
        const lockedPaths = active
          .map((lock) => lock.jsonPointer)
          .filter((pointer) => pointer !== input.jsonPointer);
        const document = { ...target.currentDocument, locked_paths: lockedPaths };
        const committed = await commitShotVersion(
          repositories,
          dependencies,
          input,
          target,
          document,
          target.shotVersion.versionStatus,
          target.current.status,
          traceId,
          () => ({ action: 'SHOT_UNLOCKED', metadata: { jsonPointer: input.jsonPointer } }),
        );
        return {
          episode: toSummary(committed.episodeVersion, committed.links.length),
          lockedPaths,
          shotVersionId: committed.shotVersionId,
        } satisfies ShotEditLockSummary;
      });
      return { data: result, ok: true };
    } catch (caught: unknown) {
      return mapFailure(caught, traceId);
    }
  };

  return { editShot, lockShot, unlockShot };
};

const safeParse = (document: string): unknown => {
  try {
    return JSON.parse(document);
  } catch {
    return null;
  }
};

const mapFailure = <T>(caught: unknown, traceId: string): AppResultDto<T> => {
  if (caught instanceof ShotEditLockServiceError) {
    return scriptFailure(
      caught.payload.code,
      caught.payload.message,
      traceId,
      caught.payload.fieldErrors,
    );
  }
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
    if (caught.message === 'STALE_INPUT') {
      return scriptFailure('STALE_INPUT', '分镜引用的故事圣经不可用，请重新生成分镜', traceId);
    }
  }
  return scriptPersistenceFailure(traceId);
};
