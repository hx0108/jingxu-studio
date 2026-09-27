import { useEffect, useState } from 'react';

import type {
  CreatorPreparationOperation,
  JobSummaryDto,
  ConsistencyPreflightDto,
  StoryboardEditShotInputDto,
  StoryboardExportFormat,
  StoryboardImageStatesDto,
  StoryboardVideoStatesDto,
  StoryboardLockShotInputDto,
  StoryboardShotSummaryDto,
  StoryboardUnlockShotInputDto,
  StoryboardVersionSummaryDto,
  StoryboardWorkspaceDto,
} from '@jingxu/contracts';

import { FirstFramePanel } from './FirstFramePanel';
import { ShotStructuredFields } from './ShotStructuredFields';
import { VoicePanel } from './VoicePanel';
import { describeErrorCode } from '../project/project-error';
import { VideoPanel } from './VideoPanel';
import { VideoCompositionPanel } from './VideoCompositionPanel';
import { createScriptRequestId, getImageClient } from './script-api';
import { isTerminalJob } from './script-ui-policy';
import {
  MEDIA_BATCH_STATUS_LABELS,
  batchProgressOf,
  shotFirstFrameBadge,
} from './storyboard-image-state-policy';
import { shotVideoBadge } from './storyboard-video-state-policy';
import { StatusBadge } from '../ui/WorkspaceLayout';
import { workspaceStatusLabel } from '../ui/workspace-status';
import { PROTOTYPE_ASSETS, prototypeAssetAt } from '../assets/prototype/prototype-assets';

export type MediaWorkspaceStep = 'storyboard' | 'image' | 'video' | 'composition';

const MEDIA_PAGE_COPY: Readonly<
  Record<MediaWorkspaceStep, { readonly description: string; readonly title: string }>
> = {
  composition: {
    description: '拖动、裁剪并对齐画面、对白与配乐，再生成完整成片。',
    title: '合成导出',
  },
  image: {
    description: '选择画面候选，保持角色、服装和场景连续。',
    title: '画面生成',
  },
  storyboard: {
    description: '逐镜头确认画面、人物、台词和镜头运动。',
    title: '分镜设计',
  },
  video: {
    description: '让选中的画面自然运动，并保持前后镜头连贯。',
    title: '视频生成',
  },
};

const SHOT_SIZE_LABELS: Record<StoryboardShotSummaryDto['shotSize'], string> = {
  CLOSE_UP: '近景',
  EXTREME_CLOSE_UP: '特写',
  EXTREME_LONG: '大远景',
  FULL: '全景',
  LONG: '远景',
  MEDIUM: '中景',
};

const CAMERA_MOTION_LABELS: Record<StoryboardShotSummaryDto['cameraMotion'], string> = {
  DOLLY: '推拉',
  HANDHELD: '手持',
  OTHER: '其他',
  PAN: '横摇',
  STATIC: '固定',
  TILT: '纵摇',
  TRACK: '跟踪',
  ZOOM: '变焦',
};

const DIALOGUE_RENDER_LABELS: Record<StoryboardShotSummaryDto['dialogueRenderMode'], string> = {
  NARRATION_FIRST: '旁白优先',
  PRECISE_LIP_SYNC: '精确口型同步',
  SUBTITLE_ONLY: '仅字幕',
  WEAK_LIP_SYNC: '弱口型同步',
};

// 脱敏失败文案：JobSummaryDto 只携带稳定 errorCode；字段级明细仅存 main 侧 error_json，
// 绝不进入 Renderer，也不展示模型原始输出。
const STORYBOARD_JOB_ERROR_COPY: Readonly<Record<string, string>> = {
  CONTRACT_VALIDATION_FAILED:
    '分镜候选未通过结构或集合校验（镜头序号/引用、时长合计或角色场景引用不匹配）。可重试任务或重新生成。',
  STRUCTURE_REPAIR_FAILED: '分镜候选结构修复后仍未通过校验。可重试任务或重新生成。',
};

/** D3 七根级锁标签：UI 锁定入口只挂七个一级根；解锁按实际有效路径逐条。 */
const LOCKABLE_ROOT_LABELS: Readonly<Record<string, string>> = {
  acceptance: '验收标准',
  cinematography: '摄影设计',
  content: '内容',
  continuity: '连贯性',
  dialogue: '台词',
  generation_constraints: '生成约束',
  narrative_purpose: '叙事目的',
};
const LOCKABLE_ROOTS = Object.keys(LOCKABLE_ROOT_LABELS);

export interface StoryboardPanelProps {
  readonly isDemo?: boolean;
  readonly onMediaStepChange?: (step: MediaWorkspaceStep) => void;
  readonly initialMediaStep?: MediaWorkspaceStep;
  readonly episodeTargetDurationSec: number;
  /** 列表级首帧状态底座（design D5）；null 表示尚未载入，不渲染徽标。 */
  readonly imageStates: StoryboardImageStatesDto | null;
  /** 视频列表状态与首帧状态分域轮询，避免图片终态影响视频刷新。 */
  readonly videoStates?: StoryboardVideoStatesDto | null;
  /** 首帧面板按 projectId 定界媒体通道调用。 */
  readonly projectId: string;
  /** null 表示当前可生成；否则为不可生成的原因（同时禁用按钮）。 */
  readonly generateHint: string | null;
  readonly job: JobSummaryDto | null;
  /** 批次命令（发起/取消/重试）在飞时禁用相关入口。 */
  readonly batchBusy: boolean;
  readonly videoBatchBusy?: boolean;
  readonly onBatchCancel: (batchId: string) => void;
  readonly onBatchRetryFailed: (shotIds: readonly string[]) => void;
  readonly onVideoBatchCancel?: (batchId: string) => void;
  readonly onVideoBatchRetryFailed?: (shotIds: readonly string[]) => void;
  readonly onConfirm: () => void;
  /** 逐镜头编辑/锁定/解锁命令（shot-edit-lock D1/D3）；面板组装完整 DTO 输入。 */
  readonly onEditShot: (input: StoryboardEditShotInputDto) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** storyboard-export：READY 整集三导出入口（deliverables D3；非 READY 不渲染）。 */
  readonly onExportEpisode: (format: StoryboardExportFormat) => void;
  readonly exportNotice: string | null;
  /** project-transfer 4.3：项目快照导出（CURRENT_ONLY）与按快照恢复本项目（RTO）。 */
  readonly onExportSnapshot?: () => void;
  readonly onRestoreSnapshot?: () => void;
  readonly snapshotNotice?: string | null;
  readonly onGenerate: () => void;
  readonly onGenerateFirstFrames: () => void;
  readonly onGenerateVideos?: () => void;
  readonly onPrepareOperation?: (
    operation: CreatorPreparationOperation,
    proceed: () => void,
  ) => void;
  readonly onLockShot: (input: StoryboardLockShotInputDto) => void;
  readonly onRestore: (version: StoryboardVersionSummaryDto) => void;
  readonly onUnlockShot: (input: StoryboardUnlockShotInputDto) => void;
  readonly pending: boolean;
  readonly storyboard: StoryboardWorkspaceDto;
}

export const StoryboardPanel = ({
  isDemo = false,
  onMediaStepChange,
  batchBusy,
  episodeTargetDurationSec,
  generateHint,
  imageStates,
  initialMediaStep = 'storyboard',
  job,
  onBatchCancel,
  onBatchRetryFailed,
  onGenerateVideos,
  onVideoBatchCancel,
  onVideoBatchRetryFailed,
  onConfirm,
  onDirtyChange,
  onEditShot,
  onExportEpisode,
  exportNotice,
  onExportSnapshot,
  onRestoreSnapshot,
  snapshotNotice = null,
  onGenerate,
  onGenerateFirstFrames,
  onPrepareOperation,
  onLockShot,
  onRestore,
  onUnlockShot,
  pending,
  projectId,
  storyboard,
  videoBatchBusy = false,
  videoStates = null,
}: StoryboardPanelProps) => {
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [shotEditorText, setShotEditorText] = useState('');
  const [shotEditorError, setShotEditorError] = useState<string | null>(null);
  const [shotFieldsDirty, setShotFieldsDirty] = useState(false);
  const [syncedShotVersionId, setSyncedShotVersionId] = useState<string | null>(null);
  const [activeMediaStep, setActiveMediaStep] = useState<MediaWorkspaceStep>(initialMediaStep);
  const [syncedInitialStep, setSyncedInitialStep] = useState(initialMediaStep);
  // 续作路由带来的步骤变化在渲染期同步（React 官方「根据 props 调整 state」模式）。
  if (syncedInitialStep !== initialMediaStep) {
    setSyncedInitialStep(initialMediaStep);
    setActiveMediaStep(initialMediaStep);
  }

  const [consistency, setConsistency] = useState<ConsistencyPreflightDto | null>(null);
  const selectedShot =
    storyboard.shots.find((shot) => shot.shotId === selectedShotId) ??
    (isDemo ? storyboard.shots[1] : undefined) ??
    storyboard.shots[0] ??
    null;
  if (syncedShotVersionId !== (selectedShot?.versionId ?? null)) {
    setSyncedShotVersionId(selectedShot?.versionId ?? null);
    setShotFieldsDirty(false);
    setEditing(false);
    setShotEditorError(null);
  }
  const current = storyboard.current;
  const totalDurationSec = storyboard.totalDurationSec;
  const durationOverLimit = totalDurationSec > episodeTargetDurationSec;
  const jobActive = job !== null && !isTerminalJob(job);
  // 编辑/锁定入口仅对当前 ACTIVE 集合开放；STALE_INPUT 整集仅供查看（spec）。
  const shotCommandsEnabled =
    current !== null && current.status !== 'STALE_INPUT' && selectedShot !== null && !pending;

  const commandTarget = (jsonPointer?: string) => ({
    episodeId: current?.episodeId ?? '',
    expectedVersionId: current?.id ?? '',
    projectId,
    requestId: createScriptRequestId(jsonPointer === undefined ? 'shot-edit' : 'shot-lock'),
    shotId: selectedShot?.shotId ?? '',
  });

  // 批次视图派生：RUNNING 批次优先展示，否则回落到最近批次（进度与重试入口）。
  const runningBatch = imageStates?.batches.find((batch) => batch.status === 'RUNNING') ?? null;
  const latestBatch = runningBatch ?? imageStates?.batches[0] ?? null;
  const latestProgress = latestBatch === null ? null : batchProgressOf(latestBatch);
  const shotStates = new Map((imageStates?.shots ?? []).map((state) => [state.shotId, state]));
  const batchReady = current?.status === 'READY' && storyboard.shots.length > 0;
  const consistencyKey = storyboard.shots.map((shot) => shot.shotId).join('|');
  useEffect(() => {
    if (!batchReady) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (): void => {
      void getImageClient()
        .getConsistencyPreflight({
          projectId,
          shotIds: storyboard.shots.map((shot) => shot.shotId),
        })
        .then((result) => {
          if (!active || !result.ok) return;
          setConsistency(result.data);
          // 未就绪时说明用户正被门禁拦住：资产上传后需自动复检恢复入口。
          if (!result.data.ready) {
            timer = setTimeout(refresh, 1_500);
          }
        })
        .catch(() => undefined);
    };
    refresh();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [batchReady, consistencyKey, projectId, storyboard.shots]);
  const runningVideoBatch =
    videoStates?.batches.find((batch) => batch.status === 'RUNNING') ?? null;
  const latestVideoBatch = runningVideoBatch ?? videoStates?.batches[0] ?? null;
  const latestVideoProgress = latestVideoBatch === null ? null : batchProgressOf(latestVideoBatch);
  const shotVideoStates = new Map((videoStates?.shots ?? []).map((state) => [state.shotId, state]));

  return (
    <section
      className={`script-card media-workspace media-step-${activeMediaStep}`}
      id="storyboard-panel"
    >
      <header className="script-heading">
        <div>
          <p className="eyebrow">分镜工作台 · 单集生产</p>
          <h2>分镜工作台</h2>
          <h1 className="media-page-title">{MEDIA_PAGE_COPY[activeMediaStep].title}</h1>
          <p className="media-page-description">{MEDIA_PAGE_COPY[activeMediaStep].description}</p>
        </div>
        <StatusBadge status={current?.status} />
      </header>
      <nav aria-label="单集生产阶段" className="production-stage-tabs">
        {(
          [
            ['storyboard', '分镜设计'],
            ['image', '画面生成'],
            ['video', '视频生成'],
            ['composition', '合成导出'],
          ] as const
        ).map(([step, label]) => (
          <button
            aria-current={activeMediaStep === step ? 'step' : undefined}
            className={activeMediaStep === step ? 'active' : ''}
            key={step}
            onClick={() => {
              setActiveMediaStep(step);
              onMediaStepChange?.(step);
            }}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
      <p className="action-hint">
        先确认整集分镜，再逐镜头补画面、视频与配音；需要精细调整时可打开镜头编辑。
      </p>
      {current?.status === 'STALE_INPUT' && (
        <p className="field-error">上游已变化，当前分镜仅供查看；请重新生成。</p>
      )}
      <aside aria-label="单集操作与状态" className="media-context-panel">
        <h2>下一步</h2>
        <p>
          {activeMediaStep === 'storyboard'
            ? current?.status === 'DRAFT'
              ? '分镜草稿已生成。确认可用后即可进入画面生成。'
              : '根据当前剧本生成并确认整集分镜。'
            : activeMediaStep === 'image'
              ? '生成并挑选最合适的画面候选。'
              : activeMediaStep === 'video'
                ? '根据动态要求生成本镜头视频。'
                : '保存剪辑后生成完整成片。'}
        </p>
        {activeMediaStep === 'storyboard' && current?.status === 'DRAFT' && (
          <>
            <button
              className="media-primary-action"
              disabled={jobActive || pending}
              onClick={onConfirm}
              type="button"
            >
              确认为可用
            </button>
            <button
              className="secondary-button"
              disabled={generateHint !== null || jobActive || pending}
              onClick={onGenerate}
              type="button"
            >
              重新生成整集分镜
            </button>
          </>
        )}
        {activeMediaStep === 'storyboard' && current?.status !== 'DRAFT' && (
          <button
            className="media-primary-action"
            disabled={generateHint !== null || jobActive || pending}
            onClick={onGenerate}
            type="button"
          >
            生成整集分镜
          </button>
        )}
        {activeMediaStep === 'image' && (
          <button
            className="media-primary-action"
            disabled={!batchReady || runningBatch !== null || batchBusy}
            onClick={() => {
              if (onPrepareOperation === undefined) onGenerateFirstFrames();
              else onPrepareOperation('IMAGE', onGenerateFirstFrames);
            }}
            type="button"
          >
            生成画面候选
          </button>
        )}
        {activeMediaStep === 'video' && (
          <button
            className="media-primary-action"
            disabled={!batchReady || runningVideoBatch !== null || videoBatchBusy}
            onClick={() => {
              if (onGenerateVideos === undefined) return;
              if (onPrepareOperation === undefined) onGenerateVideos();
              else onPrepareOperation('VIDEO', onGenerateVideos);
            }}
            type="button"
          >
            生成本镜头视频
          </button>
        )}
        <button
          className="secondary-button"
          disabled={
            activeMediaStep === 'composition' ||
            (activeMediaStep === 'video' && onGenerateVideos === undefined)
          }
          onClick={() => {
            if (activeMediaStep === 'storyboard') onGenerate();
            else if (activeMediaStep === 'image') {
              if (onPrepareOperation === undefined) onGenerateFirstFrames();
              else onPrepareOperation('IMAGE', onGenerateFirstFrames);
            } else if (onGenerateVideos !== undefined) {
              if (onPrepareOperation === undefined) onGenerateVideos();
              else onPrepareOperation('VIDEO', onGenerateVideos);
            }
          }}
          title={activeMediaStep === 'composition' ? '请在剪辑区使用生成成片操作' : undefined}
          type="button"
        >
          重新生成
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            setActiveMediaStep('storyboard');
            onMediaStepChange?.('storyboard');
          }}
          type="button"
        >
          稍后处理
        </button>
        {job?.status === 'FAILED' &&
          (() => {
            const failureView = job.errorCode === null ? null : describeErrorCode(job.errorCode);
            return (
              <p className="field-error" role="alert">
                {failureView === null
                  ? '上次生成失败，请重试。'
                  : `上次生成失败：${failureView.summary}；${failureView.nextAction}`}
              </p>
            );
          })()}
        <details className="media-advanced-actions">
          <summary>更多操作与真实状态</summary>
          <div>
            <div aria-label="整集时长汇总" className="duration-summary">
              <p>
                镜头时长合计 {String(totalDurationSec)}s / 目标 {String(episodeTargetDurationSec)}s
                · {String(storyboard.shots.length)} 个镜头
              </p>
              <div className="duration-bar" role="presentation">
                <div
                  className={durationOverLimit ? 'duration-fill duration-over' : 'duration-fill'}
                  style={{
                    width: `${String(Math.min(100, (totalDurationSec / episodeTargetDurationSec) * 100))}%`,
                  }}
                />
              </div>
              {durationOverLimit && (
                <p className="field-error">镜头总时长已超过单集目标时长，请重新生成分镜。</p>
              )}
            </div>
            <div className="script-actions">
              <button
                disabled={generateHint !== null || jobActive || pending}
                onClick={onGenerate}
                type="button"
              >
                生成整集分镜
              </button>
              <button
                disabled={current?.status !== 'DRAFT' || jobActive || pending}
                onClick={onConfirm}
                type="button"
              >
                确认为可用
              </button>
              {/* 整集首帧（batch-first-frame 5.2）：READY 才可用；发起全量镜头，服务端按当前世代跳过。 */}
              <button
                disabled={
                  !batchReady ||
                  runningBatch !== null ||
                  batchBusy ||
                  (consistency !== null && !consistency.ready)
                }
                name="generate-first-frames-batch"
                onClick={() => {
                  if (onPrepareOperation === undefined) {
                    onGenerateFirstFrames();
                    return;
                  }
                  onPrepareOperation('IMAGE', onGenerateFirstFrames);
                }}
                type="button"
              >
                为整集生成首帧
              </button>
              {consistency !== null && !consistency.ready && (
                <div className="consistency-status" role="status">
                  <p>整集一致性预检未通过，请先补齐：</p>
                  <ul>
                    {consistency.missingItems.map((item) => (
                      <li key={`${item.kind}:${item.bibleRefId}`}>
                        {item.kind === 'STYLE' ? '画风锚点' : '角色参考图'} · {item.displayName}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                disabled={!batchReady || runningVideoBatch !== null || videoBatchBusy}
                name="generate-videos-batch"
                onClick={() => {
                  if (onGenerateVideos === undefined) return;
                  if (onPrepareOperation === undefined) {
                    onGenerateVideos();
                    return;
                  }
                  onPrepareOperation('VIDEO', onGenerateVideos);
                }}
                type="button"
              >
                为整集生成视频
              </button>
              {/* storyboard-export：READY 才渲染三导出入口（spec：非 READY 不渲染）。 */}
              {current?.status === 'READY' && (
                <>
                  <button
                    disabled={pending}
                    name="export-episode"
                    onClick={() => {
                      onExportEpisode('EPISODE_JSON');
                    }}
                    type="button"
                  >
                    导出整集
                  </button>
                  <button
                    disabled={pending}
                    name="export-episode-markdown"
                    onClick={() => {
                      onExportEpisode('MARKDOWN_TABLE');
                    }}
                    type="button"
                  >
                    导出分镜表
                  </button>
                  <button
                    disabled={pending}
                    name="export-episode-report"
                    onClick={() => {
                      onExportEpisode('PRODUCIBILITY_REPORT');
                    }}
                    type="button"
                  >
                    导出报告
                  </button>
                  {/* project-transfer 4.3：项目快照（CURRENT_ONLY）导出与 RTO 恢复同门禁。 */}
                  {onExportSnapshot !== undefined && (
                    <button
                      disabled={pending}
                      name="export-project-snapshot"
                      onClick={onExportSnapshot}
                      type="button"
                    >
                      导出项目快照
                    </button>
                  )}
                  {onRestoreSnapshot !== undefined && (
                    <button
                      disabled={pending}
                      name="restore-project-snapshot"
                      onClick={onRestoreSnapshot}
                      type="button"
                    >
                      从快照恢复本项目
                    </button>
                  )}
                </>
              )}
            </div>
            {exportNotice !== null && (
              <p className="action-hint" role="status">
                {exportNotice}
              </p>
            )}
            {snapshotNotice != null && snapshotNotice !== '' && (
              <p className="action-hint" role="status">
                {snapshotNotice}
              </p>
            )}
            {generateHint !== null && <p className="action-hint">{generateHint}</p>}
            {current !== null && current.status !== 'READY' && (
              <p className="action-hint">分镜整集确认可用后，可为整集批量生成首帧。</p>
            )}
            {latestBatch !== null && latestProgress !== null && (
              <div aria-live="polite" className="batch-progress" id="batch-progress">
                <p>
                  首帧批次{MEDIA_BATCH_STATUS_LABELS[latestBatch.status]} · 进度{' '}
                  {String(latestProgress.settled)}/{String(latestProgress.total)}
                  {latestProgress.failedShotIds.length > 0
                    ? ` · 失败 ${String(latestProgress.failedShotIds.length)}`
                    : ''}
                  {latestBatch.skippedShotIds.length > 0
                    ? ` · 跳过 ${String(latestBatch.skippedShotIds.length)}（当前世代已有首帧）`
                    : ''}
                  {latestBatch.errorCode === null ? '' : ` · ${latestBatch.errorCode}`}
                </p>
                {runningBatch !== null ? (
                  <button
                    className="danger-button"
                    disabled={batchBusy}
                    name="cancel-batch"
                    onClick={() => {
                      onBatchCancel(latestBatch.batchId);
                    }}
                    type="button"
                  >
                    取消剩余镜头
                  </button>
                ) : (
                  latestProgress.failedShotIds.length > 0 && (
                    <button
                      disabled={batchBusy}
                      name="retry-failed-shots"
                      onClick={() => {
                        onBatchRetryFailed(latestProgress.failedShotIds);
                      }}
                      type="button"
                    >
                      重试失败镜头（新批次）
                    </button>
                  )
                )}
              </div>
            )}
            {latestVideoBatch !== null && latestVideoProgress !== null && (
              <div aria-live="polite" className="batch-progress" id="video-batch-progress">
                <p>
                  视频批次{MEDIA_BATCH_STATUS_LABELS[latestVideoBatch.status]} · 进度{' '}
                  {String(latestVideoProgress.settled)}/{String(latestVideoProgress.total)}
                  {latestVideoProgress.failedShotIds.length > 0
                    ? ` · 失败 ${String(latestVideoProgress.failedShotIds.length)}`
                    : ''}
                  {latestVideoBatch.skippedShotIds.length > 0
                    ? ` · 跳过 ${String(latestVideoBatch.skippedShotIds.length)}（无首帧或当前世代已有视频）`
                    : ''}
                  {latestVideoBatch.errorCode === null ? '' : ` · ${latestVideoBatch.errorCode}`}
                </p>
                {runningVideoBatch !== null ? (
                  <button
                    className="danger-button"
                    disabled={videoBatchBusy}
                    name="cancel-video-batch"
                    onClick={() => {
                      onVideoBatchCancel?.(latestVideoBatch.batchId);
                    }}
                    type="button"
                  >
                    取消剩余视频镜头
                  </button>
                ) : (
                  latestVideoProgress.failedShotIds.length > 0 && (
                    <button
                      disabled={videoBatchBusy}
                      name="retry-failed-video-shots"
                      onClick={() => {
                        onVideoBatchRetryFailed?.(latestVideoProgress.failedShotIds);
                      }}
                      type="button"
                    >
                      重试失败视频镜头（新批次）
                    </button>
                  )
                )}
              </div>
            )}
            {job !== null && (
              <p aria-live="polite">
                任务状态：{workspaceStatusLabel(job.status)}
                {job.errorCode === null ? '' : ' · 查看失败详情'}
              </p>
            )}
            {job?.status === 'FAILED' && job.errorCode !== null && (
              <div className="inline-error">
                <p>
                  {STORYBOARD_JOB_ERROR_COPY[job.errorCode] ?? '分镜任务失败；可重试或重新生成。'}
                </p>
                <details className="technical-details">
                  <summary>查看错误详情</summary>
                  <code>{job.errorCode}</code>
                </details>
              </div>
            )}
          </div>
        </details>
      </aside>
      {storyboard.shots.length === 0 ? (
        <p>尚未生成分镜。上游场景剧本确认可用后可生成整集分镜。</p>
      ) : (
        <ul className="shot-card-list" aria-label="镜头列表">
          {storyboard.shots.map((shot, index) => {
            const imageState = shotStates.get(shot.shotId) ?? null;
            const videoState = shotVideoStates.get(shot.shotId) ?? null;
            const badge = imageState === null ? null : shotFirstFrameBadge(imageState);
            const videoBadge = videoState === null ? null : shotVideoBadge(videoState);
            // 缩略图真相优先（2026-09-27）：真实项目用已选首帧，未选择时不冒充原型图；
            // 演示项目保持原型资产。
            const realPreview = isDemo ? null : (imageState?.selectedPreviewMediaUrl ?? null);
            const fallbackVisual = prototypeAssetAt(PROTOTYPE_ASSETS.shots, index);
            const visualSrc = isDemo ? fallbackVisual : realPreview;
            return (
              <li key={shot.shotId}>
                <button
                  aria-current={selectedShot?.shotId === shot.shotId ? 'true' : undefined}
                  className={
                    selectedShot?.shotId === shot.shotId ? 'active-tab shot-card' : 'shot-card'
                  }
                  onClick={() => {
                    if (
                      shotFieldsDirty &&
                      !globalThis.confirm('当前镜头有未保存修改。放弃修改并切换镜头？')
                    ) {
                      return;
                    }
                    setShotFieldsDirty(false);
                    onDirtyChange?.(false);
                    setSelectedShotId(shot.shotId);
                  }}
                  type="button"
                >
                  {visualSrc === null ? (
                    <span aria-hidden="true" className="shot-card-visual shot-card-visual-empty" />
                  ) : (
                    <img alt="" aria-hidden="true" className="shot-card-visual" src={visualSrc} />
                  )}
                  <span>#{String(shot.sequence)}</span>
                  <span>
                    {SHOT_SIZE_LABELS[shot.shotSize]} · {CAMERA_MOTION_LABELS[shot.cameraMotion]}
                  </span>
                  <span>
                    {String(shot.targetDurationSec)}s ·{' '}
                    {DIALOGUE_RENDER_LABELS[shot.dialogueRenderMode]}
                  </span>
                  {shot.lockedPaths.length > 0 && (
                    <span className="status-badge status-locked">
                      🔒 {String(shot.lockedPaths.length)}
                    </span>
                  )}
                  {badge !== null && (
                    <span className={`shot-first-frame-badge status-badge ${badge.className}`}>
                      {badge.label}
                    </span>
                  )}
                  {videoBadge !== null && (
                    <span className={`shot-video-badge status-badge ${videoBadge.className}`}>
                      {videoBadge.label}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selectedShot !== null && (
        <section aria-labelledby="shot-detail-title" className="shot-detail">
          <div className="shot-detail-heading">
            <div className="shot-detail-title-block">
              <p className="eyebrow">当前镜头</p>
              <div className="shot-detail-title-row">
                <h3
                  aria-label={`镜头 #${String(selectedShot.sequence)} 详情`}
                  id="shot-detail-title"
                >
                  镜头 {String(selectedShot.sequence)}
                </h3>
                <span>时长 {String(selectedShot.targetDurationSec)} 秒</span>
              </div>
            </div>
            {(() => {
              // 详情预览与顶部镜头条同源（2026-09-27）：真实项目用已选首帧，不冒充原型图。
              const realPreview = isDemo
                ? null
                : (shotStates.get(selectedShot.shotId)?.selectedPreviewMediaUrl ?? null);
              const demoSrc =
                selectedShot.sequence === 2
                  ? PROTOTYPE_ASSETS.heroineMain
                  : prototypeAssetAt(PROTOTYPE_ASSETS.shots, selectedShot.sequence - 1);
              const detailSrc = isDemo ? demoSrc : realPreview;
              return detailSrc === null ? (
                <span
                  aria-hidden="true"
                  className="shot-detail-preview shot-detail-preview-empty"
                />
              ) : (
                <img
                  alt={`镜头 ${String(selectedShot.sequence)} 已选首帧预览`}
                  className="shot-detail-preview"
                  src={detailSrc}
                />
              );
            })()}
            <div aria-label="镜头时长预览" className="shot-preview-ruler">
              <span aria-hidden="true">▶</span>
              <span>00:00 / 00:{String(selectedShot.targetDurationSec).padStart(2, '0')}</span>
              <span aria-hidden="true" className="shot-preview-ruler-track">
                <i />
              </span>
              <span aria-hidden="true">全屏</span>
            </div>
          </div>
          <dl className="shot-core-details">
            <div>
              <dt>叙事目的</dt>
              <dd>{selectedShot.narrativePurpose}</dd>
            </div>
            <div>
              <dt>景别</dt>
              <dd>{SHOT_SIZE_LABELS[selectedShot.shotSize]}</dd>
            </div>
            <div>
              <dt>运机</dt>
              <dd>{CAMERA_MOTION_LABELS[selectedShot.cameraMotion]}</dd>
            </div>
            <div>
              <dt>台词渲染</dt>
              <dd>{DIALOGUE_RENDER_LABELS[selectedShot.dialogueRenderMode]}</dd>
            </div>
            <div>
              <dt>目标时长</dt>
              <dd>{String(selectedShot.targetDurationSec)}s</dd>
            </div>
          </dl>
          {activeMediaStep === 'storyboard' && !editing && (
            <ShotStructuredFields
              disabled={!shotCommandsEnabled}
              document={selectedShot.document}
              key={selectedShot.versionId}
              onDirtyChange={(nextDirty) => {
                setShotFieldsDirty(nextDirty);
                onDirtyChange?.(nextDirty);
              }}
              onSave={(document) => {
                onEditShot({
                  ...commandTarget(),
                  document,
                  requestId: createScriptRequestId('shot-edit'),
                  shotVersionId: selectedShot.versionId,
                });
              }}
            />
          )}
          <details className="technical-details shot-lock-panel">
            <summary>高级信息与镜头保护</summary>
            <p>这里可以保护已确认的镜头信息，避免后续调整意外覆盖。</p>
            <dl className="shot-technical-details">
              <div>
                <dt>镜头版本</dt>
                <dd>{selectedShot.versionId}</dd>
              </div>
            </dl>
            <h4>字段锁定</h4>
            {selectedShot.lockedPaths.length > 0 ? (
              <ul aria-label="有效锁列表" className="version-list">
                {selectedShot.lockedPaths.map((path) => (
                  <li key={path}>
                    <span>🔒 {path}</span>
                    <button
                      className="secondary-button"
                      disabled={!shotCommandsEnabled || shotFieldsDirty}
                      name="unlock-shot"
                      onClick={() => {
                        onUnlockShot({
                          ...commandTarget(path),
                          jsonPointer: path,
                          requestId: createScriptRequestId('shot-unlock'),
                        });
                      }}
                      type="button"
                    >
                      解锁
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>当前镜头没有有效锁。</p>
            )}
            <div aria-label="七根级锁定入口" className="script-actions">
              {LOCKABLE_ROOTS.map((root) => {
                const rootPointer = `/${root}`;
                const covered = selectedShot.lockedPaths.some(
                  (path) => path === rootPointer || path.startsWith(`${rootPointer}/`),
                );
                return (
                  <button
                    className="secondary-button"
                    disabled={!shotCommandsEnabled || shotFieldsDirty || covered}
                    key={root}
                    name={`lock-shot-${root}`}
                    onClick={() => {
                      onLockShot({
                        ...commandTarget(rootPointer),
                        jsonPointer: rootPointer,
                        note: null,
                        requestId: createScriptRequestId('shot-lock'),
                      });
                    }}
                    type="button"
                  >
                    {covered
                      ? `🔒 已锁 ${String(LOCKABLE_ROOT_LABELS[root])}`
                      : `锁定 ${String(LOCKABLE_ROOT_LABELS[root])}`}
                  </button>
                );
              })}
            </div>
          </details>
          <div className="shot-editor-area">
            {editing ? (
              <form
                className="script-form"
                id="script-stage-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!shotCommandsEnabled) return;
                  let document_: Record<string, unknown>;
                  try {
                    document_ = JSON.parse(shotEditorText) as Record<string, unknown>;
                  } catch {
                    setShotEditorError('必须是有效的结构化对象');
                    return;
                  }
                  setShotEditorError(null);
                  onEditShot({
                    ...commandTarget(),
                    document: document_,
                    requestId: createScriptRequestId('shot-edit'),
                    shotVersionId: selectedShot.versionId,
                  });
                }}
              >
                <label>
                  镜头结构化内容
                  <textarea
                    aria-describedby="shot-editor-help"
                    name="shot-editor-text"
                    onChange={(changeEvent) => {
                      setShotEditorText(changeEvent.target.value);
                      setShotFieldsDirty(true);
                      onDirtyChange?.(true);
                    }}
                    rows={18}
                    value={shotEditorText}
                  />
                </label>
                <small id="shot-editor-help">
                  系统字段（版本、状态与来源关系）由系统重写；保存后会创建新的草稿版本并重算整集快照。
                </small>
                {shotEditorError !== null && (
                  <p className="field-error" role="alert">
                    {shotEditorError}
                  </p>
                )}
                <div className="script-actions">
                  <button disabled={!shotCommandsEnabled} name="save-shot-edit" type="submit">
                    保存镜头编辑
                  </button>
                  <button
                    className="secondary-button"
                    name="cancel-shot-edit"
                    onClick={() => {
                      setEditing(false);
                      setShotEditorError(null);
                      setShotFieldsDirty(false);
                      onDirtyChange?.(false);
                    }}
                    type="button"
                  >
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <div className="script-actions">
                <button
                  disabled={!shotCommandsEnabled}
                  name="open-shot-editor"
                  onClick={() => {
                    if (
                      shotFieldsDirty &&
                      !globalThis.confirm('当前镜头有未保存修改。放弃修改并打开高级编辑？')
                    ) {
                      return;
                    }
                    setShotFieldsDirty(false);
                    onDirtyChange?.(false);
                    setShotEditorText(JSON.stringify(selectedShot.document, null, 2));
                    setShotEditorError(null);
                    setEditing(true);
                  }}
                  type="button"
                >
                  高级编辑镜头
                </button>
              </div>
            )}
          </div>
          <div className="media-stage-content" hidden={activeMediaStep !== 'image'}>
            <FirstFramePanel
              imageState={shotStates.get(selectedShot.shotId) ?? null}
              isDemo={isDemo}
              key={selectedShot.shotId}
              projectId={projectId}
              shot={selectedShot}
              storyboardStatus={current?.status ?? null}
            />
          </div>
          <div className="media-stage-content" hidden={activeMediaStep !== 'video'}>
            <VideoPanel
              isDemo={isDemo}
              key={`video-${selectedShot.shotId}`}
              projectId={projectId}
              shot={selectedShot}
              storyboardStatus={current?.status ?? null}
              videoState={shotVideoStates.get(selectedShot.shotId) ?? null}
            />
          </div>
        </section>
      )}
      <div className="composition-stage-content" hidden={activeMediaStep !== 'composition'}>
        {current?.status === 'READY' ? (
          <>
            <VideoCompositionPanel
              episodeId={current.episodeId}
              episodeVersionId={current.id}
              isDemo={isDemo}
              onPrepareExport={
                onPrepareOperation === undefined
                  ? undefined
                  : (proceed) => {
                      onPrepareOperation('EXPORT', proceed);
                    }
              }
              projectId={projectId}
            />
            <details className="composition-voice-advanced">
              <summary>配音与音色设置</summary>
              <VoicePanel
                episodeId={current.episodeId}
                onPrepare={
                  onPrepareOperation === undefined
                    ? undefined
                    : (proceed) => {
                        onPrepareOperation('VOICE', proceed);
                      }
                }
                projectId={projectId}
              />
            </details>
          </>
        ) : (
          <section className="empty-state-panel">
            <h3>合成导出尚不可用</h3>
            <p>请先生成并确认整集分镜，再为镜头选择可用视频。</p>
          </section>
        )}
      </div>
      <details className="storyboard-history technical-details">
        <summary id="storyboard-history-title">分镜历史与高级信息</summary>
        {storyboard.history.length === 0 ? (
          <p>暂无历史整集版本。</p>
        ) : (
          <ul className="version-list">
            {storyboard.history.map((entry) => (
              <li key={entry.id}>
                <span>
                  v{String(entry.versionNo)} · {workspaceStatusLabel(entry.status)} ·{' '}
                  {String(entry.shotCount)} 个镜头
                </span>
                <button
                  className="secondary-button"
                  disabled={current === null || entry.id === current.id || pending}
                  onClick={() => {
                    onRestore(entry);
                  }}
                  type="button"
                >
                  恢复为新草稿
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
};
