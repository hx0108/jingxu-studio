import { describe, expect, it } from 'vitest';

import type { MediaUnitOfWorkPort } from '../ports/media/media-repository';
import type {
  EpisodeVersion,
  ScriptWorkspaceSnapshot,
  ShotContractVersion,
  StoryboardShotSnapshot,
} from '../ports/script/script-types';
import type { ScriptWorkspaceQueryPort } from '../ports/script/script-workspace-query-port';
import { InMemoryMediaInvocationRepository } from './in-memory-media-invocation-repository';
import { InMemoryMediaRepository } from './in-memory-media-repository';
import { InMemoryVideoMediaRepository } from './in-memory-video-media-repository';
import {
  buildVideoParametersFingerprint,
  computeVideoGenerationInputHash,
} from './video-generation-input';
import { createVideoGenerationService } from './video-generation-service';
import type { VideoGenerationService } from './video-generation-service';

const NOW = '2026-08-16T00:00:00.000Z';
const MODEL_ID = 'doubao-seedance-1-0-lite-i2v-250428';
const IMAGE_MODEL_ID = 'doubao-seedream-5-0-lite-260128';
const hash64 = (seed: string): string => `${seed}_${'.'.repeat(64)}`.slice(0, 64);
/** 首帧文件内容哈希（64 位十六进制形态，与 SQL 行 CHECK 同口径）。 */
const IMG_SHA_1 = '1'.repeat(64);
const IMG_SHA_2 = '2'.repeat(64);
/** 首帧落列口径 1440x2560 → 视频档位 1080x1920（resolveVideoSize 金样锁定）。 */
const VIDEO_SIZE = { height: 1920, width: 1080 };

const shotVersionOf = (versionId: string, targetDurationSec = 8): ShotContractVersion => ({
  createdAt: NOW,
  dialogueRenderMode: 'NARRATION_FIRST',
  document: JSON.stringify({
    cinematography: { camera_angle: 'EYE_LEVEL', camera_motion: 'DOLLY', shot_size: 'MEDIUM' },
    content: { action: '少女撑伞走过雨巷', character_ids: [], emotion: '怅惘', scene_id: null },
    continuity: { continuity_mode: 'SCENE_CHANGE' },
    narrative_purpose: '建立雨巷氛围',
  }),
  documentSha256: hash64(`doc_${versionId}`),
  externalParentVersionId: null,
  formatProfileId: 'fp_1',
  id: versionId,
  lineageResolutionStatus: 'LOCAL_VERIFIED',
  parentId: null,
  sequence: 1,
  shotId: 'shot_1',
  sourceInvocationId: null,
  targetDurationSec,
  versionNo: 1,
  versionStatus: 'READY',
});

const shotOf = (
  shotId: string,
  versionId: string,
  targetDurationSec = 8,
): StoryboardShotSnapshot => ({
  sequence: 1,
  shotId,
  version: shotVersionOf(versionId, targetDurationSec),
});

const workspaceOf = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
): ScriptWorkspaceSnapshot => ({
  episode: null,
  projectId: 'project_1',
  sourceInput: null,
  stages: [],
  storyboard: {
    current: {
      createdAt: NOW,
      episodeId: 'episode_1',
      formatProfileId: 'fp_1',
      id: 'ev_1',
      parentId: null,
      shotSetHash: hash64('set'),
      status,
      storyBibleVersionId: 'sbv_1',
      targetDurationSec: 90,
      versionNo: 1,
    },
    currentShots: shots,
    history: [],
    historyTruncated: false,
  },
});

const hashPayload = (value: Readonly<Record<string, unknown>>): string =>
  hash64(JSON.stringify(value));

/** 独立复算当前世代哈希（不经过被测服务，锁描述符字段集与取值）。 */
const expectedGenerationHash = (firstFrameSha: string, shotVersionId: string): string =>
  computeVideoGenerationInputHash(
    {
      firstFrameFileSha256: firstFrameSha,
      modelId: MODEL_ID,
      parametersFingerprint: buildVideoParametersFingerprint({
        durationSec: 8,
        firstFrameFileSha256: firstFrameSha,
        modelId: MODEL_ID,
        size: VIDEO_SIZE,
      }),
      shotContentHash: hash64(`doc_${shotVersionId}`),
      shotVersionId,
    },
    hashPayload,
  );

interface Fixture {
  readonly repository: InMemoryMediaRepository;
  readonly service: VideoGenerationService;
  readonly videoRepository: InMemoryVideoMediaRepository;
  readonly workspaceQuery: { snapshot: ScriptWorkspaceSnapshot | null };
}

const fixture = (
  shots: readonly StoryboardShotSnapshot[],
  status: EpisodeVersion['status'] = 'READY',
  assertCredentialReady?: () => Promise<void>,
): Fixture => {
  const repository = new InMemoryMediaRepository();
  // 视频仓以 image 候选数组为 lens（同事务可见）：首帧改选 STALE 判定读取最新选择指针。
  const videoRepository = new InMemoryVideoMediaRepository(repository.candidates);
  const unitOfWork: MediaUnitOfWorkPort = {
    run: (work) =>
      work({
        invocations: new InMemoryMediaInvocationRepository(),
        media: repository,
        video: videoRepository,
      }),
  };
  const workspaceQuery: ScriptWorkspaceQueryPort & {
    snapshot: ScriptWorkspaceSnapshot | null;
  } = {
    snapshot: workspaceOf(shots, status),
    getWorkspace: () => Promise.resolve(workspaceQuery.snapshot),
    getVersionDocument: () => Promise.resolve(null),
  };
  const service = createVideoGenerationService({
    // 未注入即 Mock 档形态（无凭据闸）；注入后未通过/通过两态在用例内分别验证。
    ...(assertCredentialReady === undefined ? {} : { assertCredentialReady }),
    candidateCount: 2,
    durationRange: { maxSec: 10, minSec: 5 },
    hashPayload,
    mediaUnitOfWork: unitOfWork,
    modelId: MODEL_ID,
    newId: (() => {
      let counter = 0;
      return () => `id_${String((counter += 1))}`;
    })(),
    workspaceQuery,
  });
  return { repository, service, videoRepository, workspaceQuery };
};

/** 落一枚 SUCCEEDED 首帧候选并（可选）设为该镜头的选择指针。 */
const seedFirstFrame = async (
  repository: InMemoryMediaRepository,
  shotId: string,
  shotVersionId: string,
  candidateId: string,
  fileSha256: string,
  selected: boolean,
): Promise<void> => {
  await repository.insertCandidates({
    candidateIds: [candidateId],
    generationInputHash: hash64(`img_${candidateId}`),
    modelId: IMAGE_MODEL_ID,
    projectId: 'project_1',
    roundNo: 1,
    shotId,
    shotVersionId,
  });
  await repository.completeCandidateSucceeded(candidateId, {
    byteSize: 2048,
    fileSha256,
    height: 2560,
    invocationEvidenceRef: `inv_${candidateId}`,
    mimeType: 'image/png',
    storageRelPath: `projects/project_1/images/ab/${fileSha256}.png`,
    width: 1440,
  });
  if (selected) await repository.selectCandidate(shotId, candidateId);
};

describe('VideoGenerationService.generateVideoCandidates', () => {
  it('已选首帧齐全—建任务与 2 个 PENDING 候选—首帧锚点/时长档位/世代哈希独立复算一致', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    const result = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      candidateCount: 2,
      generationInputHash: expectedGenerationHash(IMG_SHA_1, 'scv_1'),
      idempotencyKey: 'req_1',
      phase: 'SUBMITTED',
      providerTaskId: null,
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    expect(videoRepository.tasks).toHaveLength(1);
    const candidates = videoRepository.candidates.filter(
      (candidate) => candidate.shotId === 'shot_1',
    );
    expect(candidates).toHaveLength(2);
    for (const [index, candidate] of candidates.entries()) {
      expect(candidate).toMatchObject({
        firstFrameCandidateId: 'img_1',
        firstFrameFileSha256: IMG_SHA_1,
        generationInputHash: expectedGenerationHash(IMG_SHA_1, 'scv_1'),
        indexInRound: index,
        modelId: MODEL_ID,
        requestedDurationSec: 8,
        roundNo: 1,
        selectedAt: null,
        shotVersionId: 'scv_1',
        status: 'PENDING',
      });
    }
  });

  it('无已选首帧—MEDIA_FIRST_FRAME_NOT_SELECTED 且不落任何任务/候选行', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    // 多枚 SUCCEEDED 首帧候选但无人选择——门禁必须拒绝且零建档（spec 场景）。
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, false);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_2', IMG_SHA_2, false);
    const result = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result).toMatchObject({
      error: { code: 'MEDIA_FIRST_FRAME_NOT_SELECTED' },
      ok: false,
    });
    expect(videoRepository.tasks).toHaveLength(0);
    expect(videoRepository.candidates).toHaveLength(0);
  });

  it('凭据闸未通过—MODEL_CREDENTIAL_INVALID 指向视频配置入口且先于建档；通过时不影响建档', async () => {
    const reject = fixture([shotOf('shot_1', 'scv_1')], 'READY', () =>
      Promise.reject(new Error('decrypt failed')),
    );
    const rejected = await reject.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(rejected).toMatchObject({
      error: {
        code: 'MODEL_CREDENTIAL_INVALID',
        retryable: false,
        userAction: '在剧本工作区「Provider 设置」的视频卡片中保存 ARK API Key 后重试。',
      },
      ok: false,
    });
    expect(reject.videoRepository.tasks).toHaveLength(0);
    // 闸通过（真实凭据档形态）与未注入闸（Mock 档形态）同一路径——建档正常。
    const pass = fixture([shotOf('shot_1', 'scv_1')], 'READY', () => Promise.resolve());
    await seedFirstFrame(pass.repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    const created = await pass.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(created.ok).toBe(true);
    expect(pass.videoRepository.candidates).toHaveLength(2);
  });

  it('幂等重放返回既有任务不产生第二轮；requestId 复用于异镜头 REQUEST_ID_REUSED', async () => {
    const { repository, service, videoRepository } = fixture([
      shotOf('shot_1', 'scv_1'),
      shotOf('shot_2', 'scv_2'),
    ]);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    const first = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_2',
    );
    expect(replay).toMatchObject({ data: { id: first.data.id }, ok: true });
    expect(videoRepository.tasks).toHaveLength(1);
    expect(videoRepository.candidates).toHaveLength(2);
    // 同一 requestId 打到不同镜头——幂等键语义冲突，稳定拒绝。
    const mismatched = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_2' },
      'trace_3',
    );
    expect(mismatched).toMatchObject({ error: { code: 'REQUEST_ID_REUSED' }, ok: false });
  });

  it('时长档位就近映射—target 3 落最小档 5；target 15 压最大档 10（不续写不拆镜）', async () => {
    const { repository, service, videoRepository } = fixture([
      shotOf('shot_3', 'scv_3', 3),
      shotOf('shot_4', 'scv_4', 15),
    ]);
    await seedFirstFrame(repository, 'shot_3', 'scv_3', 'img_3', IMG_SHA_1, true);
    await seedFirstFrame(repository, 'shot_4', 'scv_4', 'img_4', IMG_SHA_2, true);
    await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_3', shotId: 'shot_3' },
      'trace_1',
    );
    await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_4', shotId: 'shot_4' },
      'trace_2',
    );
    const durations = new Map(
      videoRepository.candidates.map((candidate) => [candidate.shotId, candidate]),
    );
    // requested_duration_sec 如实落列（超档压最大档由 Renderer 对比 target 派生提示）。
    expect(durations.get('shot_3')?.requestedDurationSec).toBe(5);
    expect(durations.get('shot_4')?.requestedDurationSec).toBe(10);
  });

  it('分镜未 READY / 镜头不在 READY 集合—稳定拒绝且不建档', async () => {
    const notReady = fixture([shotOf('shot_1', 'scv_1')], 'DRAFT');
    await seedFirstFrame(notReady.repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    const storyboardResult = await notReady.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(storyboardResult).toMatchObject({
      error: { code: 'MEDIA_STORYBOARD_NOT_READY' },
      ok: false,
    });
    const missingShot = fixture([shotOf('shot_1', 'scv_1')]);
    await seedFirstFrame(missingShot.repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    const shotResult = await missingShot.service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_unknown' },
      'trace_2',
    );
    expect(shotResult).toMatchObject({
      error: { code: 'MEDIA_SHOT_NOT_IN_READY_SET' },
      ok: false,
    });
    expect(missingShot.videoRepository.tasks).toHaveLength(0);
  });

  it('已选首帧口径异常（尺寸/文件 sha 缺失）—按数据异常稳定失败不建档', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    // SUCCEEDED 但 Provider 未回报尺寸——无法冻结分辨率参数，不臆造默认。
    await repository.insertCandidates({
      candidateIds: ['img_bad'],
      generationInputHash: hash64('img_bad'),
      modelId: IMAGE_MODEL_ID,
      projectId: 'project_1',
      roundNo: 1,
      shotId: 'shot_1',
      shotVersionId: 'scv_1',
    });
    await repository.completeCandidateSucceeded('img_bad', {
      byteSize: 2048,
      fileSha256: IMG_SHA_1,
      height: null,
      invocationEvidenceRef: 'inv_bad',
      mimeType: 'image/png',
      storageRelPath: `projects/project_1/images/ab/${IMG_SHA_1}.png`,
      width: null,
    });
    await repository.selectCandidate('shot_1', 'img_bad');
    const result = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    expect(result).toMatchObject({
      error: { code: 'MEDIA_PERSISTENCE_FAILED' },
      ok: false,
    });
    expect(videoRepository.tasks).toHaveLength(0);
    expect(videoRepository.candidates).toHaveLength(0);
  });
});

describe('VideoGenerationService STALE 双传播', () => {
  it('镜头升版—旧版本视频候选 STALE、返回受影响镜头摘要、重放幂等且不自动重发', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    const affected = await service.propagateStaleForShotVersion('scv_1', 'trace_2');
    expect(affected).toMatchObject({
      data: [{ candidateCount: 2, shotId: 'shot_1' }],
      ok: true,
    });
    expect(
      videoRepository.candidates
        .filter((candidate) => candidate.shotId === 'shot_1')
        .every((candidate) => candidate.status === 'STALE_INPUT'),
    ).toBe(true);
    // 仅列受影响镜头、不自动重发：任务行数不变；再传播（已 STALE）返回空清单。
    expect(videoRepository.tasks).toHaveLength(1);
    const replay = await service.propagateStaleForShotVersion('scv_1', 'trace_3');
    expect(replay).toMatchObject({ data: [], ok: true });
  });

  it('首帧改选—旧锚点候选 STALE、新锚点轮不受影响；世代哈希随锚点切换成新轮', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_2', IMG_SHA_2, false);
    await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    // 首帧选择从 F1（sha1）改为 F2（sha2）——旧锚点视频候选全部 STALE（spec 场景）。
    await repository.selectCandidate('shot_1', 'img_2');
    const affected = await service.propagateStaleForFirstFrameChange(
      { shotId: 'shot_1' },
      'trace_2',
    );
    expect(affected).toMatchObject({
      data: [{ candidateCount: 2, shotId: 'shot_1' }],
      ok: true,
    });
    // 改选后新发起：锚点 img_2、新一轮（round 2），世代哈希随首帧 sha 变化。
    const second = await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_2', shotId: 'shot_1' },
      'trace_3',
    );
    expect(second).toMatchObject({
      data: { generationInputHash: expectedGenerationHash(IMG_SHA_2, 'scv_1'), roundNo: 2 },
      ok: true,
    });
    const roundTwo = videoRepository.candidates.filter((candidate) => candidate.roundNo === 2);
    expect(roundTwo).toHaveLength(2);
    for (const candidate of roundTwo) {
      expect(candidate).toMatchObject({
        firstFrameCandidateId: 'img_2',
        firstFrameFileSha256: IMG_SHA_2,
        status: 'PENDING',
      });
    }
    // 新锚点与当前选中首帧一致——再传播不误伤（旧轮已 STALE 不重复计）。
    const replay = await service.propagateStaleForFirstFrameChange({ shotId: 'shot_1' }, 'trace_4');
    expect(replay).toMatchObject({ data: [], ok: true });
    expect(roundTwo.every((candidate) => candidate.status === 'PENDING')).toBe(true);
  });
});

describe('VideoGenerationService.selectCandidate', () => {
  it('仅 SUCCEEDED 可选—PENDING 拒绝、未知/跨项目 NOT_FOUND、切换先清后设并返回全量', async () => {
    const { repository, service, videoRepository } = fixture([shotOf('shot_1', 'scv_1')]);
    await seedFirstFrame(repository, 'shot_1', 'scv_1', 'img_1', IMG_SHA_1, true);
    await service.generateVideoCandidates(
      { projectId: 'project_1', requestId: 'req_1', shotId: 'shot_1' },
      'trace_1',
    );
    // 候选 id 由注入 newId 派生：任务 id_1，候选 id_2 / id_3。
    const pending = await service.selectCandidate(
      { candidateId: 'id_2', projectId: 'project_1', requestId: 'req_2' },
      'trace_2',
    );
    expect(pending).toMatchObject({
      error: { code: 'MEDIA_CANDIDATE_NOT_SELECTABLE' },
      ok: false,
    });
    const unknown = await service.selectCandidate(
      { candidateId: 'missing', projectId: 'project_1', requestId: 'req_3' },
      'trace_3',
    );
    expect(unknown).toMatchObject({
      error: { code: 'MEDIA_CANDIDATE_NOT_FOUND' },
      ok: false,
    });
    const crossProject = await service.selectCandidate(
      { candidateId: 'id_2', projectId: 'project_2', requestId: 'req_4' },
      'trace_4',
    );
    expect(crossProject).toMatchObject({
      error: { code: 'MEDIA_CANDIDATE_NOT_FOUND' },
      ok: false,
    });
    // 两候选成功后先后选择——指针原子切换（先清后设），返回全量候选。
    for (const candidateId of ['id_2', 'id_3']) {
      await videoRepository.completeCandidateSucceeded(candidateId, {
        byteSize: 4096,
        fileSha256: hash64(candidateId),
        height: 1920,
        invocationEvidenceRef: `inv_${candidateId}`,
        mimeType: 'video/mp4',
        storageRelPath: `projects/project_1/videos/ab/${hash64(candidateId)}.mp4`,
        width: 1080,
      });
    }
    const first = await service.selectCandidate(
      { candidateId: 'id_3', projectId: 'project_1', requestId: 'req_5' },
      'trace_5',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toHaveLength(2);
    expect(first.data.find((candidate) => candidate.id === 'id_3')?.selectedAt).not.toBeNull();
    const second = await service.selectCandidate(
      { candidateId: 'id_2', projectId: 'project_1', requestId: 'req_6' },
      'trace_6',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.find((candidate) => candidate.id === 'id_2')?.selectedAt).not.toBeNull();
    expect(second.data.find((candidate) => candidate.id === 'id_3')?.selectedAt).toBeNull();
  });
});
