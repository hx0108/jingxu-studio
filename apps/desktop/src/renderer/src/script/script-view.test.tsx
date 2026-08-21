import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ShotImageStateDto,
  StoryboardImageStatesDto,
  StoryboardVideoStatesDto,
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
  StoryboardWorkspaceDto,
} from '@jingxu/contracts';

import { ExportDeviationDialog } from './ExportDeviationDialog';
import { OriginalInput } from './OriginalInput';
import { ProviderSettings } from './ProviderSettings';
import { StoryboardPanel } from './StoryboardPanel';

describe('Staged Script Renderer 可观察基线', () => {
  it('原创初始化—显示字符边界、数据处理确认与明确非目标', () => {
    const html = renderToStaticMarkup(
      <OriginalInput
        onDirtyChange={vi.fn()}
        onInitialized={vi.fn()}
        projectId="project_12345678"
      />,
    );
    expect(html).toContain('0/2,000 个 Unicode 字符');
    expect(html).toContain('最少 20 个');
    expect(html).toContain('第三方 Qwen Provider');
    expect(html).toContain('文件导入、授权改编和 AI 优化尚未开放');
    expect(html).toContain('disabled=""');
  });

  it('Provider 设置—首次加载不回显 Key 或伪装已验证', () => {
    const html = renderToStaticMarkup(<ProviderSettings onReadyChange={vi.fn()} />);
    expect(html).toContain('正在加载 Qwen 设置');
    expect(html).not.toContain('sk-');
    expect(html).not.toContain('已验证');
  });
});

const storyboardVersion = (overrides: {
  readonly id: string;
  readonly shotCount: number;
  readonly status: StoryboardVersionSummaryDto['status'];
  readonly versionNo: number;
}): StoryboardVersionSummaryDto => ({
  createdAt: '2026-08-14T00:00:00.000Z',
  episodeId: 'episode_12345678',
  formatProfileId: 'format_12345678',
  id: overrides.id,
  parentId: null,
  shotCount: overrides.shotCount,
  shotSetHash: 'b'.repeat(64),
  status: overrides.status,
  storyBibleVersionId: 'version_12345678',
  targetDurationSec: 90,
  versionNo: overrides.versionNo,
});

const shotSummary = (overrides: {
  readonly narrativePurpose: string;
  readonly sequence: number;
  readonly shotId: string;
  readonly targetDurationSec: number;
}): StoryboardShotSummaryDto => ({
  cameraMotion: overrides.sequence === 1 ? 'STATIC' : 'PAN',
  dialogueRenderMode: overrides.sequence === 1 ? 'NARRATION_FIRST' : 'SUBTITLE_ONLY',
  document: {
    cinematography: { camera_motion: 'STATIC', shot_size: 'MEDIUM' },
    locked_paths: [],
    narrative_purpose: overrides.narrativePurpose,
    target_duration_sec: overrides.targetDurationSec,
  },
  lockedPaths: [],
  narrativePurpose: overrides.narrativePurpose,
  sequence: overrides.sequence,
  shotId: overrides.shotId,
  shotSize: overrides.sequence === 1 ? 'EXTREME_LONG' : 'CLOSE_UP',
  targetDurationSec: overrides.targetDurationSec,
  versionId: `shotver_00${String(overrides.sequence)}`,
});

describe('Storyboard Panel 可观察基线（shot-contract-generation §5.4）', () => {
  it('存在 DRAFT 整集与镜头集合—展示徽标、卡片、时长汇总与默认详情，只读声明可见', () => {
    const storyboard: StoryboardWorkspaceDto = {
      current: storyboardVersion({
        id: 'episodever_0001',
        shotCount: 2,
        status: 'DRAFT',
        versionNo: 2,
      }),
      history: [
        storyboardVersion({ id: 'episodever_0002', shotCount: 2, status: 'READY', versionNo: 1 }),
      ],
      shots: [
        shotSummary({
          narrativePurpose: '雨夜车厢大远景开场',
          sequence: 1,
          shotId: 'shot_00000001',
          targetDurationSec: 12,
        }),
        shotSummary({
          narrativePurpose: '林夜攥紧怀表起身',
          sequence: 2,
          shotId: 'shot_00000002',
          targetDurationSec: 8,
        }),
      ],
      totalDurationSec: 20,
    };
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        imageStates={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        generateHint={null}
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={storyboard}
      />,
    );
    expect(html).toContain('分镜工作台');
    expect(html).toContain('● DRAFT');
    expect(html).toContain('合计 20s / 目标 90s');
    expect(html).toContain('2 个镜头');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('大远景');
    expect(html).toContain('固定');
    expect(html).toContain('横摇');
    expect(html).toContain('旁白优先');
    expect(html).toContain('仅字幕');
    // 默认详情：首个镜头的摘要字段全量展示（含枚举原码便于排障）。
    expect(html).toContain('镜头 #1 详情');
    expect(html).toContain('雨夜车厢大远景开场');
    expect(html).toContain('shot_00000001');
    expect(html).toContain('12s');
    expect(html).toContain('EXTREME_LONG');
    // 逐镜头首帧面板挂载在详情内：DRAFT 整集下生成首帧按钮禁用并给出提示。
    expect(html).toContain('首帧候选 · 镜头 #1');
    expect(html).toContain('分镜整集未确认 READY；确认后才能为镜头生成首帧。');
    expect(html).toContain('正在加载首帧候选…');
    // 分镜自身操作可执行（首帧按钮的 disabled 属预期，不在此断言）。
    expect(html).toContain('<button type="button">生成整集分镜</button>');
    // 编辑/锁定入口（shot-edit-lock D1/D3）与历史恢复入口。
    expect(html).toContain('编辑镜头');
    expect(html).toContain('字段锁定');
    expect(html).toContain('锁定 台词');
    expect(html).toContain('七类根字段加锁');
    expect(html).toContain('v1 · READY · 2 个镜头');
    expect(html).toContain('恢复为新草稿');
    // storyboard-export：非 READY 整集不渲染任何导出入口（spec 工作台入口场景）。
    expect(html).not.toContain('导出整集');
    expect(html).not.toContain('导出分镜表');
    expect(html).not.toContain('导出报告');
  });

  it('READY 整集—渲染三导出入口（deliverables D3）并展示不含路径的成功回执通知', () => {
    const storyboard: StoryboardWorkspaceDto = {
      current: storyboardVersion({
        id: 'episodever_0001',
        shotCount: 2,
        status: 'READY',
        versionNo: 3,
      }),
      history: [],
      shots: [
        shotSummary({
          narrativePurpose: '雨夜车厢大远景开场',
          sequence: 1,
          shotId: 'shot_00000001',
          targetDurationSec: 12,
        }),
        shotSummary({
          narrativePurpose: '林夜攥紧怀表起身',
          sequence: 2,
          shotId: 'shot_00000002',
          targetDurationSec: 8,
        }),
      ],
      totalDurationSec: 20,
    };
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        exportNotice="导出成功：export_abc123（sha256 …a1b2，1024 字节）"
        generateHint={null}
        imageStates={null}
        job={null}
        onBatchCancel={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onConfirm={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        onGenerate={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        onLockShot={vi.fn()}
        onRestore={vi.fn()}
        onUnlockShot={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={storyboard}
      />,
    );
    expect(html).toContain('name="export-episode"');
    expect(html).toContain('导出整集');
    // deliverables D3：分镜表与报告两个并列入口同 READY 条件渲染。
    expect(html).toContain('name="export-episode-markdown"');
    expect(html).toContain('导出分镜表');
    expect(html).toContain('name="export-episode-report"');
    expect(html).toContain('导出报告');
    // 成功通知只含 exportId 与哈希尾 4 位，绝不含文件路径（路径红线）。
    expect(html).toContain('导出成功：export_abc123（sha256 …a1b2，1024 字节）');
    expect(html).not.toContain('.json');
    expect(html).not.toContain('文件路径');
  });

  it('尚未生成分镜—空态提示、未生成徽标且无镜头卡片', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        imageStates={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        generateHint="前置阶段尚未确认 READY：需先确认场景剧本。"
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={{ current: null, history: [], shots: [], totalDurationSec: 0 }}
      />,
    );
    expect(html).toContain('○ 未生成');
    expect(html).toContain('尚未生成分镜');
    expect(html).toContain('需先确认场景剧本');
    expect(html).toContain('生成整集分镜');
    expect(html).not.toContain('#1');
  });

  it('任务 FAILED（集合校验）—展示脱敏稳定文案，不出现明细或模型输出通道', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        imageStates={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        generateHint={null}
        job={{
          errorCode: 'CONTRACT_VALIDATION_FAILED',
          id: 'job_00000001',
          projectId: 'project_12345678',
          status: 'FAILED',
          versionId: 'jobver_0000001',
        }}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={{ current: null, history: [], shots: [], totalDurationSec: 0 }}
      />,
    );
    expect(html).toContain('任务状态：FAILED · CONTRACT_VALIDATION_FAILED');
    expect(html).toContain('结构或集合校验');
    // 脱敏红线：JSON Pointer 明细与模型原文永不进入 Renderer。
    expect(html).not.toContain('/shots/0');
    expect(html).not.toContain('details');
  });

  it('镜头总时长超出单集目标—汇总条越限告警可见', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        imageStates={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        generateHint={null}
        job={null}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={{
          current: storyboardVersion({
            id: 'episodever_0003',
            shotCount: 5,
            status: 'DRAFT',
            versionNo: 1,
          }),
          history: [],
          shots: [1, 2, 3, 4, 5].map((sequence) =>
            shotSummary({
              narrativePurpose: `超限镜头 ${String(sequence)}`,
              sequence,
              shotId: `shot_0000000${String(sequence)}`,
              targetDurationSec: 20,
            }),
          ),
          totalDurationSec: 100,
        }}
      />,
    );
    expect(html).toContain('合计 100s / 目标 90s');
    expect(html).toContain('已超过单集目标时长');
    expect(html).toContain('duration-over');
  });
});

const NOW = '2026-08-18T00:00:00.000Z';

const shotImageState = (overrides: Partial<ShotImageStateDto>): ShotImageStateDto => ({
  activeTaskPhase: null,
  currentGenSucceededCount: 0,
  latestTaskErrorCode: null,
  queuedInBatchId: null,
  shotId: 'shot_00000001',
  ...overrides,
});

const shotVideoState = (overrides: Partial<StoryboardVideoStatesDto['shots'][number]>) => ({
  activeTaskPhase: null,
  currentGenSucceededCount: 0,
  latestTaskErrorCode: null,
  queuedInBatchId: null,
  shotId: 'shot_00000001',
  ...overrides,
});

describe('Storyboard Panel 批次视图（batch-first-frame §5.2/§5.3）', () => {
  const storyboardReady: StoryboardWorkspaceDto = {
    current: storyboardVersion({
      id: 'episodever_0004',
      shotCount: 3,
      status: 'READY',
      versionNo: 3,
    }),
    history: [],
    shots: [1, 2, 3].map((sequence) =>
      shotSummary({
        narrativePurpose: `批次镜头 ${String(sequence)}`,
        sequence,
        shotId: `shot_0000000${String(sequence)}`,
        targetDurationSec: 10,
      }),
    ),
    totalDurationSec: 30,
  };

  /** RUNNING 用例：完成/在飞/排队各一（惰性串行下的真实中间态）；PARTIAL 用例：完成/失败/排队。 */
  const statesWith = (
    batchStatus: 'RUNNING' | 'PARTIAL_COMPLETED',
    shots: readonly ShotImageStateDto[],
  ): StoryboardImageStatesDto => {
    const failedMember = {
      errorCode: 'MODEL_TIMEOUT' as const,
      phase: 'FAILED' as const,
      shotId: 'shot_00000002',
      taskId: 'task_00000002',
    };
    const activeMember = {
      errorCode: null,
      phase: 'SUBMITTED' as const,
      shotId: 'shot_00000002',
      taskId: 'task_00000002',
    };
    return {
      batches: [
        {
          batchId: 'batch_00000001',
          createdAt: NOW,
          errorCode: null,
          members: [
            {
              errorCode: null,
              phase: 'COMPLETED',
              shotId: 'shot_00000001',
              taskId: 'task_00000001',
            },
            batchStatus === 'RUNNING' ? activeMember : failedMember,
            { errorCode: null, phase: null, shotId: 'shot_00000003', taskId: null },
          ],
          skippedShotIds: [],
          status: batchStatus,
          updatedAt: NOW,
        },
      ],
      shots: [...shots],
    };
  };

  it('READY + RUNNING 批次—镜头徽标分档、整集首帧禁用、进度行含取消入口', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        generateHint={null}
        imageStates={statesWith('RUNNING', [
          shotImageState({ currentGenSucceededCount: 4, shotId: 'shot_00000001' }),
          shotImageState({
            activeTaskPhase: 'SUBMITTED',
            shotId: 'shot_00000002',
          }),
          shotImageState({ queuedInBatchId: 'batch_00000001', shotId: 'shot_00000003' }),
        ])}
        job={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={storyboardReady}
      />,
    );
    // 徽标分档：就绪 / 生成中 / 排队。
    expect(html).toContain('首帧就绪 4 张');
    expect(html).toContain('首帧生成中');
    expect(html).toContain('首帧排队中');
    // 批次运行中：整集入口禁用，进度行给出取消。
    expect(html).toContain('为整集生成首帧');
    const batchButton = /<button[^>]*name="generate-first-frames-batch"[^>]*>/.exec(html)?.[0];
    expect(batchButton).toContain('disabled=""');
    expect(html).toContain('首帧批次进行中 · 进度 1/3');
    expect(html).not.toContain('失败 1');
    expect(html).toContain('取消剩余镜头');
    expect(html).not.toContain('重试失败镜头');
    // 默认选中首个镜头（已就绪）：单镜头面板照旧渲染。
    expect(html).toContain('首帧候选 · 镜头 #1');
  });

  it('READY + 部分完成批次—重试失败镜头入口可见、整集首帧恢复可用', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        generateHint={null}
        imageStates={statesWith('PARTIAL_COMPLETED', [
          shotImageState({ currentGenSucceededCount: 4, shotId: 'shot_00000001' }),
          shotImageState({ latestTaskErrorCode: 'MODEL_TIMEOUT', shotId: 'shot_00000002' }),
          shotImageState({ shotId: 'shot_00000003' }),
        ])}
        job={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={storyboardReady}
      />,
    );
    expect(html).toContain('首帧批次部分完成 · 进度 2/3 · 失败 1');
    expect(html).toContain('重试失败镜头（新批次）');
    expect(html).not.toContain('取消剩余镜头');
    // 失败镜头徽标（无可用首帧时失败才顶替）与空档徽标。
    expect(html).toContain('首帧失败');
    expect(html).toContain('未生成首帧');
    // 无 RUNNING 批次：整集按钮不再因批次禁用（READY 下的禁用项见上一用例）。
    const batchButton = /<button[^>]*name="generate-first-frames-batch"[^>]*>/.exec(html)?.[0];
    expect(batchButton).toBeDefined();
    expect(batchButton?.includes('disabled=""')).toBe(false);
  });

  it('DRAFT 整集 + 已载入状态—整集首帧禁用并给 READY 提示', () => {
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        generateHint={null}
        imageStates={{ batches: [], shots: [] }}
        job={null}
        onBatchCancel={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        exportNotice={null}
        onLockShot={vi.fn()}
        onUnlockShot={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onConfirm={vi.fn()}
        onGenerate={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        onRestore={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={{
          ...storyboardReady,
          current: storyboardVersion({
            id: 'episodever_0005',
            shotCount: 3,
            status: 'DRAFT',
            versionNo: 4,
          }),
        }}
      />,
    );
    expect(html).toContain('为整集生成首帧');
    expect(html).toContain('分镜整集确认 READY 后可为整集批量生成首帧。');
    expect(html).not.toContain('batch-progress');
  });
});

describe('Storyboard Panel 视频批次视图（shot-video-generation §5.2）', () => {
  const storyboardReady: StoryboardWorkspaceDto = {
    current: storyboardVersion({
      id: 'episodever_video',
      shotCount: 2,
      status: 'READY',
      versionNo: 1,
    }),
    history: [],
    shots: [1, 2].map((sequence) =>
      shotSummary({
        narrativePurpose: `视频镜头 ${String(sequence)}`,
        sequence,
        shotId: `shot_video0000${String(sequence)}`,
        targetDurationSec: 5,
      }),
    ),
    totalDurationSec: 10,
  };

  it('RUNNING 视频批次—展示视频徽标、禁用批量入口并提供取消', () => {
    const videoStates: StoryboardVideoStatesDto = {
      batches: [
        {
          batchId: 'batch_video00001',
          createdAt: NOW,
          errorCode: null,
          members: [
            {
              errorCode: null,
              phase: 'COMPLETED',
              shotId: 'shot_video00001',
              taskId: 'task_video00001',
            },
            {
              errorCode: null,
              phase: 'POLLING',
              shotId: 'shot_video00002',
              taskId: 'task_video00002',
            },
          ],
          skippedShotIds: [],
          status: 'RUNNING',
          updatedAt: NOW,
        },
      ],
      shots: [
        shotVideoState({ currentGenSucceededCount: 2, shotId: 'shot_video00001' }),
        shotVideoState({ activeTaskPhase: 'POLLING', shotId: 'shot_video00002' }),
      ],
    };
    const html = renderToStaticMarkup(
      <StoryboardPanel
        batchBusy={false}
        episodeTargetDurationSec={90}
        exportNotice={null}
        generateHint={null}
        imageStates={{ batches: [], shots: [] }}
        job={null}
        onBatchCancel={vi.fn()}
        onBatchRetryFailed={vi.fn()}
        onConfirm={vi.fn()}
        onEditShot={vi.fn()}
        onExportEpisode={vi.fn()}
        onGenerate={vi.fn()}
        onGenerateFirstFrames={vi.fn()}
        onGenerateVideos={vi.fn()}
        onLockShot={vi.fn()}
        onRestore={vi.fn()}
        onUnlockShot={vi.fn()}
        onVideoBatchCancel={vi.fn()}
        onVideoBatchRetryFailed={vi.fn()}
        pending={false}
        projectId="project_12345678"
        storyboard={storyboardReady}
        videoBatchBusy={false}
        videoStates={videoStates}
      />,
    );
    expect(html).toContain('视频就绪 2 段');
    expect(html).toContain('视频生成中');
    expect(html).toContain('视频批次进行中 · 进度 1/2');
    expect(html).toContain('取消剩余视频镜头');
    const button = /<button[^>]*name="generate-videos-batch"[^>]*>/.exec(html)?.[0];
    expect(button).toContain('disabled=""');
  });
});

describe('ExportDeviationDialog 可观察基线（storyboard-export D5）', () => {
  it('打开时展示实际 Σ 与必填原因输入，未填原因时确认按钮禁用', () => {
    const html = renderToStaticMarkup(
      <ExportDeviationDialog
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        pending={false}
        totalDurationSec="48"
      />,
    );
    expect(html).toContain('整集时长偏离目标区间');
    expect(html).toContain('当前镜头时长合计 48s');
    expect(html).toContain('偏离 60–120 秒目标区间');
    expect(html).toContain('id="export-deviation-reason"');
    // 初始原因为空：确认按钮禁用（唯一 disabled 出自确认按钮），防止无原因越带导出。
    expect(html).toContain('name="export-deviation-confirm"');
    expect(html).toContain('disabled=""');
  });

  it('关闭时不渲染任何内容', () => {
    const html = renderToStaticMarkup(
      <ExportDeviationDialog
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open={false}
        pending={false}
        totalDurationSec="48"
      />,
    );
    expect(html).toBe('');
  });
});
