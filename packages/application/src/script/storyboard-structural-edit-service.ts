import type { AppResultDto } from '@jingxu/contracts';

import type {
  EpisodeVersion,
  EpisodeVersionShot,
  ScriptUnitOfWorkPort,
  Shot,
  ShotContractVersion,
  ShotDerivation,
} from '../ports/script/index';
import { scriptFailure, scriptPersistenceFailure } from './script-service-error';
import { computeShotSetHash } from './shot-set-hash';
import { toSummary } from './storyboard-version-service';
import type { ShotEditLockSummary } from './shot-edit-lock-service';

interface BaseInput {
  readonly episodeId: string;
  readonly expectedVersionId: string;
  readonly projectId: string;
  readonly requestId: string;
}
export type StructuralInput = BaseInput &
  (
    | { readonly operation: 'SPLIT' | 'COPY' | 'DELETE'; readonly shotId: string }
    | { readonly operation: 'MERGE'; readonly shotIds: readonly [string, string] }
    | { readonly operation: 'REORDER'; readonly orderedShotIds: readonly string[] }
    | { readonly operation: 'RESTORE'; readonly shotId: string; readonly fromVersionId: string }
  );
export interface StructuralDependencies {
  readonly hashPayload: (value: Readonly<Record<string, unknown>>) => string;
  readonly hashText: (value: string) => string;
  readonly newId: () => string;
  readonly now: () => string;
  readonly unitOfWork: ScriptUnitOfWorkPort;
}
export interface StructuralService {
  mutate(input: StructuralInput, traceId: string): Promise<AppResultDto<ShotEditLockSummary>>;
}

const copyDocument = (
  source: ShotContractVersion,
  shotId: string,
  versionId: string,
  sequence: number,
  at: string,
  hashPayload: StructuralDependencies['hashPayload'],
): ShotContractVersion => {
  const document = {
    ...(JSON.parse(source.document) as Record<string, unknown>),
    shot_id: shotId,
    version_id: versionId,
    contract_version: 1,
    parent_version_id: null,
    sequence,
    status: 'DRAFT',
    derived_from_shot_ids: [source.shotId],
  };
  return {
    ...source,
    id: versionId,
    shotId,
    versionNo: 1,
    parentId: null,
    externalParentVersionId: null,
    lineageResolutionStatus: 'ROOT',
    sequence,
    versionStatus: 'DRAFT',
    document: JSON.stringify(document),
    documentSha256: hashPayload(document),
    sourceInvocationId: null,
    createdAt: at,
  };
};

export const createStoryboardStructuralEditService = (
  dependencies: StructuralDependencies,
): StructuralService => ({
  mutate: async (input, traceId) => {
    try {
      const result = await dependencies.unitOfWork.run(async (repositories) => {
        const head = await repositories.stageHeads.find(
          input.projectId,
          input.episodeId,
          'SHOT_CONTRACT',
        );
        if (head?.currentVersionId !== input.expectedVersionId)
          throw new Error('SCRIPT_VERSION_CONFLICT');
        const current = await repositories.episodeVersions.findById(input.expectedVersionId);
        if (current?.episodeId !== input.episodeId) throw new Error('SCRIPT_VERSION_NOT_FOUND');
        const links = [...(await repositories.episodeVersions.listShotLinks(current.id))];
        if (links.length === 0) throw new Error('SCRIPT_VERSION_NOT_FOUND');
        const versions = new Map<string, ShotContractVersion>();
        for (const link of links) {
          const version = await repositories.shotContractVersions.findById(link.shotVersionId);
          if (version === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          versions.set(link.shotId, version);
        }
        const at = dependencies.now();
        const derivations: ShotDerivation[] = [];
        const lifecycle: {
          shotId: string;
          status: Shot['lifecycleStatus'];
          updatedAt: string;
          deletedAt: string | null;
        }[] = [];
        let nextLinks: EpisodeVersionShot[] = links;
        let resultShotId =
          input.operation === 'MERGE'
            ? input.shotIds[0]
            : 'shotId' in input
              ? input.shotId
              : (links[0]?.shotId ?? '');
        if (
          input.operation === 'COPY' ||
          input.operation === 'SPLIT' ||
          input.operation === 'MERGE'
        ) {
          const sourceIds = input.operation === 'MERGE' ? input.shotIds : [input.shotId];
          const sourceLinks = links.filter((link) => sourceIds.includes(link.shotId));
          if (sourceLinks.length !== sourceIds.length) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const created: Shot[] = [];
          const createdLinks: EpisodeVersionShot[] = [];
          const createdVersions: ShotContractVersion[] = [];
          const count = input.operation === 'SPLIT' ? 2 : 1;
          const firstSourceLink = sourceLinks[0];
          if (firstSourceLink === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const source = versions.get(firstSourceLink.shotId);
          if (source === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          for (let index = 0; index < count; index += 1) {
            const id = `shot_${dependencies.newId()}`;
            const sequence =
              firstSourceLink.sequence + index + (input.operation === 'COPY' ? 1 : 0);
            const version = copyDocument(
              source,
              id,
              `scv_${dependencies.newId()}_v1`,
              sequence,
              at,
              dependencies.hashPayload,
            );
            createdVersions.push(version);
            created.push({
              id,
              episodeId: input.episodeId,
              lifecycleStatus: 'ACTIVE',
              currentVersionId: version.id,
              createdAt: at,
              updatedAt: at,
              deletedAt: null,
            });
            createdLinks.push({
              episodeVersionId: current.id,
              shotId: id,
              shotVersionId: version.id,
              sequence,
            });
            for (const sourceId of sourceIds)
              derivations.push({
                createdAt: at,
                newShotId: id,
                operation: input.operation,
                sourceShotId: sourceId,
              });
            resultShotId = id;
          }
          await repositories.shots.insertMany(created);
          await repositories.shotContractVersions.insertMany(createdVersions);
          if (input.operation !== 'COPY')
            for (const sourceId of sourceIds)
              lifecycle.push({
                shotId: sourceId,
                status: 'SUPERSEDED',
                updatedAt: at,
                deletedAt: null,
              });
          // COPY 保留源镜头，并把新镜头插入它之后；SPLIT/MERGE 才以新镜头替换来源。
          const remove = input.operation === 'COPY' ? new Set<string>() : new Set(sourceIds);
          nextLinks = links.filter((link) => !remove.has(link.shotId));
          const insertAt = Math.max(
            0,
            input.operation === 'COPY' ? firstSourceLink.sequence : firstSourceLink.sequence - 1,
          );
          nextLinks.splice(insertAt, 0, ...createdLinks);
        } else if (input.operation === 'REORDER') {
          if (
            new Set(input.orderedShotIds).size !== links.length ||
            input.orderedShotIds.some((id) => !versions.has(id))
          )
            throw new Error('SCRIPT_COLLECTION_INVALID');
          nextLinks = input.orderedShotIds.map((shotId, index) => {
            const link = links.find((candidate) => candidate.shotId === shotId);
            if (link === undefined) throw new Error('SCRIPT_COLLECTION_INVALID');
            return { ...link, sequence: index + 1 };
          });
        } else if (input.operation === 'DELETE') {
          if (!versions.has(input.shotId)) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          lifecycle.push({ shotId: input.shotId, status: 'DELETED', updatedAt: at, deletedAt: at });
          nextLinks = links.filter((link) => link.shotId !== input.shotId);
          const remaining = nextLinks[0];
          if (remaining === undefined) throw new Error('SCRIPT_COLLECTION_INVALID');
          // 删除的镜头不再属于新集合；响应必须引用新集合内仍然有效的版本。
          resultShotId = remaining.shotId;
        } else {
          if (!('fromVersionId' in input)) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const historical = await repositories.episodeVersions.findById(input.fromVersionId);
          if (historical === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const historicalLinks = await repositories.episodeVersions.listShotLinks(historical.id);
          const historicalLink = historicalLinks.find((link) => link.shotId === input.shotId);
          if (historicalLink === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const source = await repositories.shotContractVersions.findById(
            historicalLink.shotVersionId,
          );
          if (source === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
          const id = `shot_${dependencies.newId()}`;
          const restored = copyDocument(
            source,
            id,
            `scv_${dependencies.newId()}_v1`,
            links.length + 1,
            at,
            dependencies.hashPayload,
          );
          await repositories.shots.insertMany([
            {
              id,
              episodeId: input.episodeId,
              lifecycleStatus: 'ACTIVE',
              currentVersionId: restored.id,
              createdAt: at,
              updatedAt: at,
              deletedAt: null,
            },
          ]);
          await repositories.shotContractVersions.insertMany([restored]);
          derivations.push({
            createdAt: at,
            newShotId: id,
            operation: 'COPY',
            sourceShotId: input.shotId,
          });
          nextLinks = [
            ...links,
            {
              episodeVersionId: current.id,
              shotId: id,
              shotVersionId: restored.id,
              sequence: links.length + 1,
            },
          ];
          resultShotId = id;
        }
        if (repositories.shots.updateLifecycleStatuses !== undefined && lifecycle.length > 0)
          await repositories.shots.updateLifecycleStatuses(lifecycle);
        if (repositories.derivations !== undefined && derivations.length > 0)
          await repositories.derivations.insertMany(derivations);
        nextLinks = nextLinks.map((link, index) => ({ ...link, sequence: index + 1 }));
        const resultLink = nextLinks.find((link) => link.shotId === resultShotId);
        if (resultLink === undefined) throw new Error('SCRIPT_VERSION_NOT_FOUND');
        const versionId = `epv_${dependencies.newId()}`;
        const entries = await Promise.all(
          nextLinks.map(async (link) => {
            const v = await repositories.shotContractVersions.findById(link.shotVersionId);
            if (v === null) throw new Error('SCRIPT_VERSION_NOT_FOUND');
            return {
              documentSha256: v.documentSha256,
              sequence: link.sequence,
              shotId: link.shotId,
              shotVersionId: link.shotVersionId,
            };
          }),
        );
        const next: EpisodeVersion = {
          ...current,
          id: versionId,
          parentId: current.id,
          versionNo: (await repositories.episodeVersions.findMaxVersionNo(input.episodeId)) + 1,
          shotSetHash: computeShotSetHash(entries, dependencies.hashText),
          status: 'DRAFT',
          createdAt: at,
        };
        await repositories.episodeVersions.insert(next);
        await repositories.episodeVersions.insertShotLinks(
          nextLinks.map((link) => ({ ...link, episodeVersionId: versionId })),
        );
        if (
          !(await repositories.stageHeads.upsert(
            {
              currentVersionId: versionId,
              currentVersionType: 'EPISODE_VERSION',
              episodeId: input.episodeId,
              projectId: input.projectId,
              stage: 'SHOT_CONTRACT',
              updatedAt: at,
            },
            current.id,
          ))
        )
          throw new Error('SCRIPT_VERSION_CONFLICT');
        await repositories.audit.record({
          action: `SHOT_${input.operation}`,
          actor: 'USER',
          afterSha256: next.shotSetHash,
          beforeSha256: current.shotSetHash,
          createdAt: at,
          id: `audit_${dependencies.newId()}`,
          metadata: { operation: input.operation, shotId: resultShotId },
          objectId: resultShotId,
          objectType: 'SHOT_CONTRACT',
          objectVersionId: versionId,
          projectId: input.projectId,
          traceId,
        });
        return {
          episode: toSummary(next, nextLinks.length),
          lockedPaths: [],
          shotVersionId: resultLink.shotVersionId,
        };
      });
      return { data: result, ok: true };
    } catch (caught: unknown) {
      if (caught instanceof Error && caught.message === 'SCRIPT_VERSION_CONFLICT')
        return scriptFailure(
          'SCRIPT_VERSION_CONFLICT',
          '当前分镜版本已变化，请刷新后重试',
          traceId,
        );
      if (caught instanceof Error && caught.message === 'SCRIPT_COLLECTION_INVALID')
        return scriptFailure('EXPORT_COLLECTION_INVALID', '镜头集合不满足结构约束', traceId);
      if (caught instanceof Error && caught.message === 'SCRIPT_VERSION_NOT_FOUND')
        return scriptFailure('SCRIPT_VERSION_NOT_FOUND', '指定分镜版本不存在', traceId);
      return scriptPersistenceFailure(traceId);
    }
  },
});
