import type { CreationMode, DialogueRenderMode, FormatProfile, Project } from '@jingxu/domain';

import type { TransferJson, TransferRepositories } from '../ports/transfer';
import type {
  Episode,
  EpisodeVersion,
  ScriptDependency,
  Shot,
  ShotContractVersion,
  StageHead,
} from '../ports/script';
import { computeShotSetHash, type ShotSetHashEntry } from '../script/shot-set-hash';
import { isProjectStage } from '../script/script-dependency-graph';
import { stableTransferJson } from './transfer-bundle';
import {
  buildTransferIdMapping,
  collectTransferSourceIds,
  rewriteTransferReferences,
  TransferValidationError,
  validateTransferReferences,
  type TransferValidationErrorCode,
} from './transfer-staging';

/** STAGE_ORDER 线性链（CONCEPT→STORY_BIBLE→EPISODE_OUTLINE→BEAT_SHEET→SCENE_SCRIPT）。 */
const IMPORT_STAGE_CHAIN = [
  'CONCEPT',
  'STORY_BIBLE',
  'EPISODE_OUTLINE',
  'BEAT_SHEET',
  'SCENE_SCRIPT',
] as const;

export interface TransferImportWriterDependencies {
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (text: string) => string;
  readonly newId: () => string;
  readonly now: () => string;
}

export interface TransferImportWriteOutcome {
  readonly createdObjectCount: number;
  readonly idMapping: TransferJson;
  readonly projectId: string;
}

const isRecord = (value: unknown): value is TransferJson =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// 函数声明（非 const 箭头）：显式 never 返回类型使调用点之后获得类型收窄。
function conflict(code: TransferValidationErrorCode = 'TRANSFER_PROJECT_CONFLICT'): never {
  throw new TransferValidationError(code);
}

const stringField = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const numberField = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toStatus = (value: unknown): 'DRAFT' | 'READY' | 'STALE_INPUT' =>
  value === 'DRAFT' || value === 'STALE_INPUT' ? value : 'READY';

/** Bundle 输出文档的稳定哈希（行 document_sha256 与 shot_set_hash 同源）。 */
const documentSha256 = (
  dependencies: TransferImportWriterDependencies,
  document: TransferJson,
): string => dependencies.hashPayload(document);

const formatProfileSpecFrom = (storyboard: TransferJson) => {
  const formatProfile = storyboard.format_profile;
  if (!isRecord(formatProfile)) conflict('TRANSFER_BUNDLE_INVALID');
  const area = formatProfile.subtitle_safe_area;
  if (
    stringField(formatProfile.aspect_ratio) !== '9:16' &&
    stringField(formatProfile.aspect_ratio) !== '16:9'
  ) {
    conflict('TRANSFER_BUNDLE_INVALID');
  }
  const aspectRatio = stringField(formatProfile.aspect_ratio) as '9:16' | '16:9';
  const safe = isRecord(area)
    ? {
        bottom: numberField(area.bottom_pct) ?? 0,
        left: numberField(area.left_pct) ?? 0,
        right: numberField(area.right_pct) ?? 0,
        top: numberField(area.top_pct) ?? 0,
      }
    : { bottom: 0, left: 0, right: 0, top: 0 };
  return {
    aspectRatio,
    fps: numberField(formatProfile.fps) ?? 30,
    height: numberField(formatProfile.height) ?? (aspectRatio === '9:16' ? 1920 : 1080),
    language: stringField(formatProfile.language) ?? 'zh-CN',
    subtitleSafeArea: safe,
    width: numberField(formatProfile.width) ?? (aspectRatio === '9:16' ? 1080 : 1920),
  };
};

const dialogueRenderModeFrom = (shot: TransferJson, fallback: string): DialogueRenderMode => {
  const dialogue = shot.dialogue;
  const mode = isRecord(dialogue) ? stringField(dialogue.dialogue_render_mode) : null;
  if (
    mode === 'NARRATION_FIRST' ||
    mode === 'WEAK_LIP_SYNC' ||
    mode === 'PRECISE_LIP_SYNC' ||
    mode === 'SUBTITLE_ONLY'
  ) {
    return mode;
  }
  return fallback as DialogueRenderMode;
};

/** 生成 GENERATED_FROM 线性链 + 整集版本对圣经的 REFERENCES 边（unique 约束安全：全新版本 id）。 */
const writeDependencyChain = async (
  repositories: TransferRepositories,
  dependencies: TransferImportWriterDependencies,
  at: string,
  versionIdsByStage: ReadonlyMap<string, string>,
  episodeVersion: { readonly id: string; readonly bibleVersionId: string },
  projectId: string,
): Promise<number> => {
  const edges: ScriptDependency[] = [];
  let upstreamStage: (typeof IMPORT_STAGE_CHAIN)[number] | null = null;
  for (const stage of IMPORT_STAGE_CHAIN) {
    if (upstreamStage !== null) {
      const upstreamVersionId = versionIdsByStage.get(upstreamStage);
      const downstreamVersionId = versionIdsByStage.get(stage);
      if (upstreamVersionId !== undefined && downstreamVersionId !== undefined) {
        edges.push({
          createdAt: at,
          dependencyType: 'GENERATED_FROM',
          downstreamId: stage,
          downstreamType: stage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
          downstreamVersionId,
          id: `dep_${dependencies.newId()}`,
          projectId,
          upstreamId: upstreamStage,
          upstreamType: upstreamStage === 'STORY_BIBLE' ? 'STORY_BIBLE_VERSION' : 'SCRIPT_VERSION',
          upstreamVersionId,
        });
      }
    }
    upstreamStage = stage;
  }
  edges.push({
    createdAt: at,
    dependencyType: 'REFERENCES',
    downstreamId: 'SHOT_CONTRACT',
    downstreamType: 'EPISODE_VERSION',
    downstreamVersionId: episodeVersion.id,
    id: `dep_${dependencies.newId()}`,
    projectId,
    upstreamId: 'STORY_BIBLE',
    upstreamType: 'STORY_BIBLE_VERSION',
    upstreamVersionId: episodeVersion.bibleVersionId,
  });
  await repositories.dependencies.insertMany(edges);
  return edges.length;
};

/**
 * NEW_PROJECT 正式写入（任务 2.3）：新 Project/FormatProfile/Episode + 圣经/四阶段/
 * 整集/镜头版本 + 阶段头 + 依赖 + 审计，同一事务；不创建 SourceInput/ConsentRecord
 * → 项目自然处于 IMPORTED_SNAPSHOT（无原始输入，重新生成前须用户补充确认）。
 */
export const writeNewProjectFromBundle = async (
  repositories: TransferRepositories,
  dependencies: TransferImportWriterDependencies,
  bundle: TransferJson,
  traceId: string,
): Promise<TransferImportWriteOutcome> => {
  const at = dependencies.now();
  const sourceIds = collectTransferSourceIds(bundle);
  const mapping = buildTransferIdMapping(sourceIds, (kind) => `${kind}_${dependencies.newId()}`);
  const rewritten = rewriteTransferReferences(bundle, mapping);
  // 重写后完整性：引用仍需自洽（阶段/归属/镜头集合）。
  validateTransferReferences(rewritten);

  const snapshot = rewritten.project_snapshot as TransferJson;
  const storyboard = rewritten.episode_storyboard as TransferJson;
  const bible = rewritten.story_bible as TransferJson;
  const stages = rewritten.script_stage_outputs as unknown[];
  const shotContracts = storyboard.shot_contracts as unknown[];

  const newProjectId = mapping[sourceIds.projectId] ?? sourceIds.projectId;
  const newEpisodeId = mapping[sourceIds.episodeId] ?? sourceIds.episodeId;
  const newFormatProfileId = mapping[sourceIds.formatProfileId] ?? sourceIds.formatProfileId;
  const newBibleVersionId = mapping[sourceIds.storyBibleVersionId] ?? sourceIds.storyBibleVersionId;

  const project: Project = {
    createdAt: at,
    creationMode: String(snapshot.creation_mode) as CreationMode,
    dialogueRenderMode: String(snapshot.dialogue_render_mode) as DialogueRenderMode,
    deletedAt: null,
    deploymentMode: 'LOCAL_DEMO',
    genre: null,
    id: newProjectId,
    name: String(snapshot.name),
    style: null,
    updatedAt: at,
  };
  await repositories.projects.insert(project);

  const formatProfile: FormatProfile = {
    createdAt: at,
    id: newFormatProfileId,
    isCurrent: true,
    parentId: null,
    projectId: newProjectId,
    spec: formatProfileSpecFrom(storyboard),
    versionNo: (await repositories.formatProfiles.findMaxVersionNo(newProjectId)) + 1,
  };
  await repositories.formatProfiles.insert(formatProfile);

  const episode: Episode = {
    createdAt: at,
    currentVersionId: null,
    deletedAt: null,
    id: newEpisodeId,
    projectId: newProjectId,
    targetDurationSec: numberField(storyboard.target_duration_sec) ?? 60,
    title: '第 1 集',
    updatedAt: at,
  };
  await repositories.episodes.insert(episode);

  // 圣经 + 四阶段版本（versionNo=1，source=IMPORT，READY；不伪造 SourceInput）。
  const bibleOutput = bible.output as TransferJson;
  const bibleVersion = {
    createdAt: at,
    document: JSON.stringify(bibleOutput),
    documentSha256: documentSha256(dependencies, bibleOutput),
    id: newBibleVersionId,
    parentId: null,
    projectId: newProjectId,
    source: 'IMPORT' as const,
    sourceInvocationId: null,
    status: 'READY' as const,
    versionNo: (await repositories.storyBibleVersions.findMaxVersionNo(newProjectId)) + 1,
  };
  await repositories.storyBibleVersions.insert(bibleVersion);

  const versionIdsByStage = new Map<string, string>([['STORY_BIBLE', newBibleVersionId]]);
  for (const entry of stages) {
    if (!isRecord(entry)) conflict('TRANSFER_BUNDLE_INVALID');
    const output = entry.output as TransferJson;
    const stage = String(output.stage);
    const versionId = stringField(entry.version_id) ?? dependencies.newId();
    await repositories.scriptVersions.insert({
      changeSummary: null,
      createdAt: at,
      document: JSON.stringify(output),
      documentSha256: documentSha256(dependencies, output),
      episodeId: isProjectStage(stage as never) ? null : newEpisodeId,
      id: versionId,
      parentId: null,
      projectId: newProjectId,
      source: 'IMPORT',
      sourceInputId: null,
      sourceInvocationId: null,
      stage: stage as 'CONCEPT' | 'EPISODE_OUTLINE' | 'BEAT_SHEET' | 'SCENE_SCRIPT',
      status: 'READY',
      versionNo:
        (await repositories.scriptVersions.findMaxVersionNo(
          newProjectId,
          isProjectStage(stage as never) ? null : newEpisodeId,
          stage as 'CONCEPT',
        )) + 1,
    });
    versionIdsByStage.set(stage, versionId);
  }

  // 镜头行 + 不可变镜头契约版本（重写后文档；行级 lineage 对 bundle 外父版本EXTERNAL_UNRESOLVED）。
  const hashEntries: ShotSetHashEntry[] = [];
  const shotRows: Shot[] = [];
  const shotVersionRows: ShotContractVersion[] = [];
  for (const shot of shotContracts) {
    if (!isRecord(shot)) conflict('TRANSFER_BUNDLE_INVALID');
    const shotId = String(shot.shot_id);
    const shotVersionId = String(shot.version_id);
    const documentSha = documentSha256(dependencies, shot);
    shotRows.push({
      createdAt: at,
      currentVersionId: shotVersionId,
      deletedAt: null,
      episodeId: newEpisodeId,
      id: shotId,
      lifecycleStatus: 'ACTIVE',
      updatedAt: at,
    });
    const parentVersionId = stringField(shot.parent_version_id);
    shotVersionRows.push({
      createdAt: at,
      dialogueRenderMode: dialogueRenderModeFrom(shot, String(snapshot.dialogue_render_mode)),
      document: JSON.stringify(shot),
      documentSha256: documentSha,
      // Bundle 外父版本：文档保留原 parent_version_id，行记录同一外部引用（EXTERNAL_UNRESOLVED
      // 分支要求 external_parent_version_id 非空且与文档一致）。
      externalParentVersionId: parentVersionId,
      formatProfileId: newFormatProfileId,
      id: shotVersionId,
      lineageResolutionStatus: parentVersionId === null ? 'ROOT' : 'EXTERNAL_UNRESOLVED',
      parentId: null,
      sequence: numberField(shot.sequence) ?? 0,
      shotId,
      sourceInvocationId: null,
      targetDurationSec: numberField(shot.target_duration_sec) ?? 60,
      versionNo: Math.max(1, Math.trunc(numberField(shot.contract_version) ?? 1)),
      versionStatus: toStatus(shot.status),
    });
    hashEntries.push({
      documentSha256: documentSha,
      sequence: numberField(shot.sequence) ?? 0,
      shotId,
      shotVersionId,
    });
  }
  await repositories.shots.insertMany(shotRows);
  await repositories.shotContractVersions.insertMany(shotVersionRows);

  // 整集快照版本 + 关联 + SHOT_CONTRACT 头。
  const episodeVersionId = `ev_${dependencies.newId()}`;
  const shotSetHash = computeShotSetHash(hashEntries, dependencies.hashText);
  const episodeVersion: EpisodeVersion = {
    createdAt: at,
    episodeId: newEpisodeId,
    formatProfileId: newFormatProfileId,
    id: episodeVersionId,
    parentId: null,
    shotSetHash,
    status: 'READY',
    storyBibleVersionId: newBibleVersionId,
    targetDurationSec: episode.targetDurationSec,
    versionNo: (await repositories.episodeVersions.findMaxVersionNo(newEpisodeId)) + 1,
  };
  await repositories.episodeVersions.insert(episodeVersion);
  await repositories.episodeVersions.insertShotLinks(
    hashEntries.map((entry) => ({
      episodeVersionId,
      sequence: entry.sequence,
      shotId: entry.shotId,
      shotVersionId: entry.shotVersionId,
    })),
  );

  // 阶段头 ×6（首次创建，expectedVersionId=null）。
  const headAt = dependencies.now();
  const heads: StageHead[] = [
    ...IMPORT_STAGE_CHAIN.map((stage) => ({
      currentVersionId: versionIdsByStage.get(stage) ?? '',
      currentVersionType:
        stage === 'STORY_BIBLE' ? ('STORY_BIBLE_VERSION' as const) : ('SCRIPT_VERSION' as const),
      episodeId: isProjectStage(stage) ? null : newEpisodeId,
      projectId: newProjectId,
      stage,
      updatedAt: headAt,
    })),
    {
      currentVersionId: episodeVersionId,
      currentVersionType: 'EPISODE_VERSION' as const,
      episodeId: newEpisodeId,
      projectId: newProjectId,
      stage: 'SHOT_CONTRACT' as const,
      updatedAt: headAt,
    },
  ];
  for (const head of heads) {
    if (!(await repositories.stageHeads.upsert(head, null))) {
      conflict('TRANSFER_PROJECT_CONFLICT');
    }
  }

  // 依赖链 + 审计。
  const edgeCount = await writeDependencyChain(
    repositories,
    dependencies,
    at,
    versionIdsByStage,
    { bibleVersionId: newBibleVersionId, id: episodeVersionId },
    newProjectId,
  );
  await repositories.audit.record({
    action: 'PROJECT_IMPORTED',
    actor: 'USER',
    afterSha256: shotSetHash,
    beforeSha256: null,
    createdAt: at,
    id: `audit_${dependencies.newId()}`,
    metadata: { importMode: 'NEW_PROJECT', sourceProjectId: sourceIds.projectId },
    objectId: newProjectId,
    objectType: 'PROJECT',
    objectVersionId: episodeVersionId,
    projectId: newProjectId,
    traceId,
  });

  const createdObjectCount =
    4 + stages.length + shotRows.length + shotVersionRows.length + heads.length + edgeCount + 1;
  return { createdObjectCount, idMapping: mapping, projectId: newProjectId };
};

/**
 * RETURN_TO_ORIGIN 正式写入（任务 2.4）：保留聚合身份，为圣经/四阶段/整集/镜头插入
 * 新的不可变当前版本；阶段头以 expectedVersionId 乐观推进（并发变化 → 全量回滚）；
 * 基线校验 = Bundle 原始 shot 集合哈希与目标当前整集 shot_set_hash 一致 + 项目名一致。
 */
export const restoreOriginProjectFromBundle = async (
  repositories: TransferRepositories,
  dependencies: TransferImportWriterDependencies,
  bundle: TransferJson,
  traceId: string,
): Promise<TransferImportWriteOutcome> => {
  const at = dependencies.now();
  validateTransferReferences(bundle);
  const snapshot = bundle.project_snapshot as TransferJson;
  const storyboard = bundle.episode_storyboard as TransferJson;
  const bible = bundle.story_bible as TransferJson;
  const stages = bundle.script_stage_outputs as unknown[];
  const shotContracts = storyboard.shot_contracts as unknown[];
  const sourceProjectId = String(snapshot.project_id);
  const episodeId = String(storyboard.episode_id);

  const project = await repositories.projects.findById(sourceProjectId, 'ACTIVE');
  if (project === null) conflict('TRANSFER_PROJECT_CONFLICT');
  if (project.name !== String(snapshot.name)) conflict('TRANSFER_PROJECT_CONFLICT');
  const episode = await repositories.episodes.findActiveByProjectId(sourceProjectId);
  if (episode?.id !== episodeId) conflict('TRANSFER_PROJECT_CONFLICT');
  const storyboardHead = await repositories.stageHeads.find(
    sourceProjectId,
    episodeId,
    'SHOT_CONTRACT',
  );
  if (storyboardHead === null) conflict('TRANSFER_PROJECT_CONFLICT');
  const currentEpisodeVersion = await repositories.episodeVersions.findById(
    storyboardHead.currentVersionId,
  );
  if (currentEpisodeVersion === null) conflict('TRANSFER_PROJECT_CONFLICT');

  // 基线校验：Bundle 镜头集合须就是目标当前整集版本。文档与库内对应版本按键序无关的
  // 规范化形式逐字比对（Bundle 落盘经 stableTransferJson 排键，重哈希会因键序分歧误判），
  // 集合哈希取行 document_sha256——确认时 shot_set_hash 即由行哈希计算。
  const baselineEntries: ShotSetHashEntry[] = [];
  for (const shot of shotContracts) {
    if (!isRecord(shot)) conflict('TRANSFER_BUNDLE_INVALID');
    const shotVersionId = String(shot.version_id);
    const storedVersion = await repositories.shotContractVersions.findById(shotVersionId);
    if (storedVersion === null) conflict('TRANSFER_PROJECT_CONFLICT');
    let storedDocument: unknown;
    try {
      storedDocument = JSON.parse(storedVersion.document);
    } catch {
      conflict('TRANSFER_PROJECT_CONFLICT');
    }
    if (stableTransferJson(storedDocument) !== stableTransferJson(shot)) {
      conflict('TRANSFER_PROJECT_CONFLICT');
    }
    baselineEntries.push({
      documentSha256: storedVersion.documentSha256,
      sequence: numberField(shot.sequence) ?? 0,
      shotId: String(shot.shot_id),
      shotVersionId,
    });
  }
  if (
    computeShotSetHash(baselineEntries, dependencies.hashText) !== currentEpisodeVersion.shotSetHash
  ) {
    conflict('TRANSFER_PROJECT_CONFLICT');
  }

  const idMapping: Record<string, string> = {};
  const versionIdsByStage = new Map<string, string>();

  // 圣经新版本（保留身份：projectId/episodeId 不变）。
  const bibleHead = await repositories.stageHeads.find(sourceProjectId, null, 'STORY_BIBLE');
  const bibleOutput = bible.output as TransferJson;
  const newBibleVersionId = `sbv_${dependencies.newId()}`;
  await repositories.storyBibleVersions.insert({
    createdAt: at,
    document: JSON.stringify(bibleOutput),
    documentSha256: documentSha256(dependencies, bibleOutput),
    id: newBibleVersionId,
    parentId: bibleHead?.currentVersionId ?? null,
    projectId: sourceProjectId,
    source: 'IMPORT',
    sourceInvocationId: null,
    status: 'READY',
    versionNo: (await repositories.storyBibleVersions.findMaxVersionNo(sourceProjectId)) + 1,
  });
  if (bibleHead !== null) idMapping[bibleHead.currentVersionId] = newBibleVersionId;
  idMapping[String(bible.version_id)] = newBibleVersionId;
  versionIdsByStage.set('STORY_BIBLE', newBibleVersionId);

  // 四阶段新版本（文档内的 project/episode 引用不变——身份保留）。
  for (const entry of stages) {
    if (!isRecord(entry)) conflict('TRANSFER_BUNDLE_INVALID');
    const output = entry.output as TransferJson;
    const stage = String(output.stage);
    const episodeScope = isProjectStage(stage as never) ? null : episodeId;
    const head = await repositories.stageHeads.find(sourceProjectId, episodeScope, stage as never);
    const versionId = `scv_${dependencies.newId()}`;
    await repositories.scriptVersions.insert({
      changeSummary: null,
      createdAt: at,
      document: JSON.stringify(output),
      documentSha256: documentSha256(dependencies, output),
      episodeId: episodeScope,
      id: versionId,
      parentId: head?.currentVersionId ?? null,
      projectId: sourceProjectId,
      source: 'IMPORT',
      sourceInputId: null,
      sourceInvocationId: null,
      stage: stage as 'CONCEPT',
      status: 'READY',
      versionNo:
        (await repositories.scriptVersions.findMaxVersionNo(
          sourceProjectId,
          episodeScope,
          stage as 'CONCEPT',
        )) + 1,
    });
    if (head !== null) idMapping[head.currentVersionId] = versionId;
    idMapping[String(entry.version_id)] = versionId;
    versionIdsByStage.set(stage, versionId);
  }

  // 镜头：既有镜头插新版本并推进指针；缺失镜头补生命周期行。文档改写 version_id/
  // parent_version_id/contract_version/status（对齐 buildReadyShotVersions 语义）。
  const hashEntries: ShotSetHashEntry[] = [];
  const newShotVersions: ShotContractVersion[] = [];
  const newShots: Shot[] = [];
  const pointerUpdates: { shotId: string; currentVersionId: string; updatedAt: string }[] = [];
  for (const shot of shotContracts) {
    if (!isRecord(shot)) conflict('TRANSFER_BUNDLE_INVALID');
    const shotId = String(shot.shot_id);
    const existing = await repositories.shots.findById(shotId);
    const previousVersionId = existing?.currentVersionId ?? null;
    const previousVersion =
      previousVersionId === null
        ? null
        : await repositories.shotContractVersions.findById(previousVersionId);
    const versionNo =
      previousVersion === null
        ? Math.max(1, Math.trunc(numberField(shot.contract_version) ?? 1))
        : previousVersion.versionNo + 1;
    const shotVersionId = `scv_${dependencies.newId()}_v${String(versionNo)}`;
    const document = {
      ...shot,
      contract_version: versionNo,
      parent_version_id: previousVersionId,
      status: 'READY',
      version_id: shotVersionId,
    };
    const documentSha = documentSha256(dependencies, document);
    const formatProfileId = currentEpisodeVersion.formatProfileId;
    newShotVersions.push({
      createdAt: at,
      dialogueRenderMode: dialogueRenderModeFrom(shot, project.dialogueRenderMode),
      document: JSON.stringify(document),
      documentSha256: documentSha,
      externalParentVersionId: null,
      formatProfileId,
      id: shotVersionId,
      lineageResolutionStatus: previousVersionId === null ? 'ROOT' : 'LOCAL_VERIFIED',
      parentId: previousVersionId,
      sequence: numberField(shot.sequence) ?? 0,
      shotId,
      sourceInvocationId: null,
      targetDurationSec: numberField(shot.target_duration_sec) ?? 60,
      versionNo,
      versionStatus: 'READY',
    });
    if (existing === null) {
      newShots.push({
        createdAt: at,
        currentVersionId: shotVersionId,
        deletedAt: null,
        episodeId,
        id: shotId,
        lifecycleStatus: 'ACTIVE',
        updatedAt: at,
      });
    } else {
      pointerUpdates.push({ currentVersionId: shotVersionId, shotId, updatedAt: at });
    }
    idMapping[String(shot.version_id)] = shotVersionId;
    hashEntries.push({
      documentSha256: documentSha,
      sequence: numberField(shot.sequence) ?? 0,
      shotId,
      shotVersionId,
    });
  }
  if (newShots.length > 0) await repositories.shots.insertMany(newShots);
  await repositories.shotContractVersions.insertMany(newShotVersions);
  if (pointerUpdates.length > 0) {
    await repositories.shots.updateCurrentVersionIds(pointerUpdates);
  }

  // 新整集版本 + 关联（versionNo=findMax+1，parentId=当前整集）。
  const episodeVersionId = `ev_${dependencies.newId()}`;
  const shotSetHash = computeShotSetHash(hashEntries, dependencies.hashText);
  await repositories.episodeVersions.insert({
    createdAt: at,
    episodeId,
    formatProfileId: currentEpisodeVersion.formatProfileId,
    id: episodeVersionId,
    parentId: currentEpisodeVersion.id,
    shotSetHash,
    status: 'READY',
    storyBibleVersionId: newBibleVersionId,
    targetDurationSec:
      numberField(storyboard.target_duration_sec) ?? currentEpisodeVersion.targetDurationSec,
    versionNo: (await repositories.episodeVersions.findMaxVersionNo(episodeId)) + 1,
  });
  await repositories.episodeVersions.insertShotLinks(
    hashEntries.map((entry) => ({
      episodeVersionId,
      sequence: entry.sequence,
      shotId: entry.shotId,
      shotVersionId: entry.shotVersionId,
    })),
  );

  // 阶段头推进（expected=当前值；false → 并发冲突，整体回滚）。
  for (const stage of IMPORT_STAGE_CHAIN) {
    const episodeScope = isProjectStage(stage) ? null : episodeId;
    const head = await repositories.stageHeads.find(sourceProjectId, episodeScope, stage);
    const moved = await repositories.stageHeads.upsert(
      {
        currentVersionId: versionIdsByStage.get(stage) ?? '',
        currentVersionType:
          stage === 'STORY_BIBLE' ? ('STORY_BIBLE_VERSION' as const) : ('SCRIPT_VERSION' as const),
        episodeId: episodeScope,
        projectId: sourceProjectId,
        stage,
        updatedAt: dependencies.now(),
      },
      head?.currentVersionId ?? null,
    );
    if (!moved) conflict('TRANSFER_PROJECT_CONFLICT');
  }
  const storyboardMoved = await repositories.stageHeads.upsert(
    {
      currentVersionId: episodeVersionId,
      currentVersionType: 'EPISODE_VERSION' as const,
      episodeId,
      projectId: sourceProjectId,
      stage: 'SHOT_CONTRACT' as const,
      updatedAt: dependencies.now(),
    },
    storyboardHead.currentVersionId,
  );
  if (!storyboardMoved) conflict('TRANSFER_PROJECT_CONFLICT');

  const edgeCount = await writeDependencyChain(
    repositories,
    dependencies,
    at,
    versionIdsByStage,
    { bibleVersionId: newBibleVersionId, id: episodeVersionId },
    sourceProjectId,
  );
  await repositories.audit.record({
    action: 'PROJECT_RESTORED_FROM_BUNDLE',
    actor: 'USER',
    afterSha256: shotSetHash,
    beforeSha256: currentEpisodeVersion.shotSetHash,
    createdAt: at,
    id: `audit_${dependencies.newId()}`,
    metadata: { importMode: 'RETURN_TO_ORIGIN', sourceEpisodeVersionId: currentEpisodeVersion.id },
    objectId: sourceProjectId,
    objectType: 'PROJECT',
    objectVersionId: episodeVersionId,
    projectId: sourceProjectId,
    traceId,
  });

  const createdObjectCount =
    2 +
    stages.length +
    newShotVersions.length +
    newShots.length +
    IMPORT_STAGE_CHAIN.length +
    1 +
    edgeCount +
    1;
  return { createdObjectCount, idMapping, projectId: sourceProjectId };
};
