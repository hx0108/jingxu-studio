import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AppErrorDto,
  AppResultDto,
  CreatorPreparationOperation,
  CreatorPreparationResultDto,
  JobSummaryDto,
  MediaBatchViewDto,
  ScriptVersionDto,
  ScriptWorkspaceDto,
  ShotEditLockSummaryDto,
  StoryboardExportFormat,
  StoryboardVersionSummaryDto,
  ScriptStage,
} from '@jingxu/contracts';

import { ExportDeviationDialog } from './ExportDeviationDialog';
import { OriginalInput } from './OriginalInput';
import { StoryboardPanel } from './StoryboardPanel';
import { ProviderSettings } from './ProviderSettings';
import { DirtyLeaveDialog } from '../project/DirtyLeaveDialog';
import { getTransferClient } from '../project/transfer-api';
import { formatTransferWarnings } from '../project/transfer-copy';
import { getCreatorGuideClient } from '../project/creator-guide-api';
import {
  createScriptRequestId,
  getImageClient,
  getJobClient,
  getScriptClient,
  getStoryboardClient,
  getVideoClient,
  rendererTransportError,
} from './script-api';
import { episodeScopeForStage, isTerminalJob } from './script-ui-policy';
import { useStoryboardImageStates } from './use-storyboard-image-states';
import { useStoryboardVideoStates } from './use-storyboard-video-states';
import { StatusBadge, WorkspaceLayout } from '../ui/WorkspaceLayout';
import { nextScriptStageLabel, workspaceStatusLabel } from '../ui/workspace-status';
import { StageStructuredForm } from './StageStructuredForm';
import { PreparationDialog } from './PreparationDialog';
import { CreatorStageBar, type CreatorStage } from '../ui/CreatorStageBar';
import {
  parseAdvancedStageData,
  pointerToStageFieldId,
  serializeStageData,
  type StageData,
} from './stage-form-contract';

const STAGES = [
  ['CONCEPT', '故事概念'],
  ['STORY_BIBLE', '故事圣经'],
  ['EPISODE_OUTLINE', '单集大纲'],
  ['BEAT_SHEET', '节拍表'],
  ['SCENE_SCRIPT', '场景剧本'],
] as const;
type Stage = (typeof STAGES)[number][0];

const formalScriptPageTitle = (stage: Stage): '故事构思' | '剧本完善' =>
  stage === 'CONCEPT' ? '故事构思' : '剧本完善';

export interface ScriptWorkspaceViewProps {
  readonly isDemo?: boolean;
  readonly projectId: string;
  readonly projectName?: string;
  readonly workType?: '漫剧' | '短剧';
  readonly initialMediaStep?: 'storyboard' | 'image' | 'video' | 'composition' | null;
  readonly initialStage?: Exclude<ScriptStage, 'SHOT_CONTRACT'>;
  readonly onBack?: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCommitted?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenProjectSettings?: () => void;
  readonly onOpenEvaluation?: () => void;
}

export const ScriptWorkspaceView = ({
  isDemo = false,
  projectId,
  projectName = '当前作品',
  workType = '短剧',
  initialMediaStep = null,
  initialStage = 'CONCEPT',
  onBack = () => undefined,
  onDirtyChange,
  onCommitted,
  onOpenSettings = () => undefined,
  onOpenProjectSettings = () => undefined,
  onOpenEvaluation = () => undefined,
}: ScriptWorkspaceViewProps) => {
  const [workspace, setWorkspace] = useState<ScriptWorkspaceDto | null>(null);
  const [selectedStage, setSelectedStage] = useState<Stage>(initialStage);
  const [editorText, setEditorText] = useState('{}');
  const [editorMode, setEditorMode] = useState<'FORM' | 'ADVANCED'>('FORM');
  const [formData, setFormData] = useState<StageData>({});
  const [providerReady, setProviderReady] = useState(false);
  const [job, setJob] = useState<JobSummaryDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingStage, setPendingStage] = useState<Stage | null>(null);
  const [pendingCreatorStage, setPendingCreatorStage] = useState<CreatorStage | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [videoBatchBusy, setVideoBatchBusy] = useState(false);
  const [preparationPending, setPreparationPending] = useState(false);
  const [preparation, setPreparation] = useState<{
    readonly data: CreatorPreparationResultDto;
    readonly operation: CreatorPreparationOperation;
    readonly proceed: () => void;
  } | null>(null);
  const [requestedMediaStep, setRequestedMediaStep] = useState(initialMediaStep);
  // storyboard-export：成功回执通知（不含路径红线）与 Σ 偏离确认弹层状态（D5）。
  // 弹层携带原请求 format：确认重发必须落在用户最初选择的交付物形态上（deliverables D3）。
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  // project-transfer 4.3：项目快照导出/恢复回执（同样只含 Hash/大小/警告，无路径）。
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  const [deviation, setDeviation] = useState<{
    readonly format: StoryboardExportFormat;
    readonly totalDurationSec: string;
  } | null>(null);
  const imageStates = useStoryboardImageStates(projectId);
  const videoStates = useStoryboardVideoStates(projectId);
  const activeCreatorStage: CreatorStage =
    requestedMediaStep ?? (selectedStage === 'CONCEPT' ? 'story' : 'script');

  useEffect(() => {
    document.querySelector<HTMLElement>('.app-content')?.scrollTo({ top: 0 });
  }, [activeCreatorStage]);

  const demoNotice = isDemo ? (
    <p className="demo-result-notice" role="status">
      演示结果 · 全程使用内置示例与模拟生成，不会产生真实费用
    </p>
  ) : null;

  // 整集首帧批次命令（batch-first-frame 5.2）：发起=全量镜头（服务端当前世代跳过，
  // design D3）；取消=仅未建档镜头（D6）；重试失败镜头=失败清单发起新批次（D2）。
  const runBatchCommand = (run: () => Promise<AppResultDto<MediaBatchViewDto>>): void => {
    if (batchBusy) return;
    setBatchBusy(true);
    setError(null);
    void run()
      .then((result) => {
        if (result.ok) return imageStates.refresh();
        setError(result.error);
        return undefined;
      })
      .catch(() => {
        setError(rendererTransportError());
      })
      .finally(() => {
        setBatchBusy(false);
      });
  };

  const openPreparation = async (
    operation: CreatorPreparationOperation,
    proceed: () => void,
  ): Promise<void> => {
    const shotIds = workspace?.storyboard.shots.map((shot) => shot.shotId) ?? [];
    if (workspace === null || shotIds.length === 0) return;
    setPreparationPending(true);
    try {
      const result = await getCreatorGuideClient().getPreparation({
        episodeId: workspace.episode.id,
        operation,
        projectId,
        shotIds,
      });
      if (result.ok) setPreparation({ data: result.data, operation, proceed });
      else setError(result.error);
    } catch {
      setError(rendererTransportError());
    } finally {
      setPreparationPending(false);
    }
  };

  const performGenerateFirstFrames = (): void => {
    const shotIds = workspace?.storyboard.shots.map((shot) => shot.shotId) ?? [];
    if (shotIds.length === 0) return;
    runBatchCommand(() =>
      getImageClient().generateCandidatesForShots({
        projectId,
        requestId: createScriptRequestId('image-batch-create'),
        shotIds,
      }),
    );
  };

  const cancelBatch = (batchId: string): void => {
    runBatchCommand(() =>
      getImageClient().cancelBatch({
        batchId,
        projectId,
        requestId: createScriptRequestId('image-batch-cancel'),
      }),
    );
  };

  const retryFailedShots = (shotIds: readonly string[]): void => {
    if (shotIds.length === 0) return;
    runBatchCommand(() =>
      getImageClient().generateCandidatesForShots({
        projectId,
        requestId: createScriptRequestId('image-batch-retry'),
        shotIds: [...shotIds],
      }),
    );
  };

  const runVideoBatchCommand = (run: () => Promise<AppResultDto<MediaBatchViewDto>>): void => {
    if (videoBatchBusy) return;
    setVideoBatchBusy(true);
    setError(null);
    void run()
      .then((result) => {
        if (result.ok) return videoStates.refresh();
        setError(result.error);
        return undefined;
      })
      .catch(() => {
        setError(rendererTransportError());
      })
      .finally(() => {
        setVideoBatchBusy(false);
      });
  };

  const performGenerateVideos = (): void => {
    const shotIds = workspace?.storyboard.shots.map((shot) => shot.shotId) ?? [];
    if (shotIds.length === 0) return;
    runVideoBatchCommand(() =>
      getVideoClient().generateVideosForShots({
        projectId,
        requestId: createScriptRequestId('video-batch-create'),
        shotIds,
      }),
    );
  };

  const cancelVideoBatch = (batchId: string): void => {
    runVideoBatchCommand(() =>
      getVideoClient().cancelVideoBatch({
        batchId,
        projectId,
        requestId: createScriptRequestId('video-batch-cancel'),
      }),
    );
  };

  const retryFailedVideoShots = (shotIds: readonly string[]): void => {
    if (shotIds.length === 0) return;
    runVideoBatchCommand(() =>
      getVideoClient().generateVideosForShots({
        projectId,
        requestId: createScriptRequestId('video-batch-retry'),
        shotIds: [...shotIds],
      }),
    );
  };

  const updateDirty = (next: boolean): void => {
    setDirty(next);
    onDirtyChange(next);
  };

  const confirmPreparation = async (): Promise<void> => {
    if (preparation === null || workspace === null || preparationPending) return;
    setPreparationPending(true);
    try {
      const result = await getCreatorGuideClient().getPreparation({
        episodeId: workspace.episode.id,
        operation: preparation.operation,
        projectId,
        shotIds: [...preparation.data.shotIds],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.data.canProceed) {
        setPreparation({ ...preparation, data: result.data });
        return;
      }
      const proceed = preparation.proceed;
      setPreparation(null);
      proceed();
    } catch {
      setError(rendererTransportError());
    } finally {
      setPreparationPending(false);
    }
  };

  const selectStage = (stage: Stage, nextWorkspace = workspace): void => {
    const item = nextWorkspace?.stages.find((candidate) => candidate.stage === stage);
    const data = item?.current?.document.data ?? {};
    setSelectedStage(stage);
    setFormData(data);
    setEditorText(serializeStageData(data));
    setEditorMode('FORM');
    updateDirty(false);
  };

  const refresh = useCallback(
    () =>
      getScriptClient()
        .getWorkspace({ projectId })
        .then((result) => {
          if (result.ok) {
            setWorkspace(result.data);
            setJob(result.data.currentJob);
            const data =
              result.data.stages.find((item) => item.stage === selectedStage)?.current?.document
                .data ?? {};
            setFormData(data);
            setEditorText(serializeStageData(data));
            setError(null);
          } else if (result.error.code !== 'SCRIPT_WORKSPACE_NOT_INITIALIZED') {
            setError(result.error);
          }
          setLoading(false);
        })
        .catch(() => {
          setError(rendererTransportError());
          setLoading(false);
        }),
    [projectId, selectedStage],
  );

  useEffect(() => {
    let active = true;
    void getScriptClient()
      .getWorkspace({ projectId })
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setWorkspace(result.data);
          setJob(result.data.currentJob);
          const data =
            result.data.stages.find((item) => item.stage === 'CONCEPT')?.current?.document.data ??
            {};
          setFormData(data);
          setEditorText(serializeStageData(data));
        } else if (result.error.code !== 'SCRIPT_WORKSPACE_NOT_INITIALIZED') {
          setError(result.error);
        }
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError(rendererTransportError());
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const stageWorkspace = workspace?.stages.find((item) => item.stage === selectedStage) ?? null;
  const current = stageWorkspace?.current ?? null;
  useEffect(() => {
    if (job === null || isTerminalJob(job)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 1_000);
        return;
      }
      const result = await getJobClient().get({ jobId: job.id });
      if (!active) return;
      if (result.ok) {
        setJob(result.data);
        if (isTerminalJob(result.data)) {
          if (result.data.status === 'SUCCEEDED') await refresh();
          return;
        }
      } else setError(result.error);
      timer = setTimeout(() => void poll(), 1_000);
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [job, refresh]);

  const stageEpisodeId =
    workspace === null ? null : episodeScopeForStage(selectedStage, workspace.episode.id);
  const expectedInputVersionId = useMemo(() => {
    if (workspace === null) return null;
    if (selectedStage === 'CONCEPT') return workspace.source.id;
    const index = STAGES.findIndex(([stage]) => stage === selectedStage);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const priorStage = STAGES[cursor]?.[0];
      const ready = workspace.stages.find(
        (item) => item.stage === priorStage && item.current?.status === 'READY',
      )?.current;
      if (ready !== undefined && ready !== null) return ready.id;
    }
    return null;
  }, [selectedStage, workspace]);

  // SHOT_CONTRACT 主输入：最近的 SCENE_SCRIPT READY 版本（§3.1 冻结 STORY_BIBLE/EPISODE_OUTLINE/SCENE_SCRIPT）。
  const sceneScriptCurrent =
    workspace?.stages.find((item) => item.stage === 'SCENE_SCRIPT')?.current ?? null;
  const storyboardGenerateHint =
    workspace === null
      ? '剧本工作区尚未加载。'
      : !providerReady
        ? '文本模型尚未就绪，完成设置与验证后可生成分镜。'
        : sceneScriptCurrent?.status !== 'READY'
          ? '前置阶段尚未确认：需先确认场景剧本。'
          : job !== null && !isTerminalJob(job)
            ? '已有任务运行中，完成后可生成分镜。'
            : null;

  const performVersionCommand = async (
    operation: 'confirm' | 'restore',
    version: ScriptVersionDto,
    continueAfterConfirm = false,
  ): Promise<void> => {
    if (current === null || pending) return;
    setPending(true);
    setError(null);
    const input = {
      episodeId: stageEpisodeId,
      expectedVersionId: current.id,
      projectId,
      requestId: createScriptRequestId(`script-${operation}`),
      stage: selectedStage,
      versionId: version.id,
    };
    const result =
      operation === 'confirm'
        ? await getScriptClient().confirmVersion(input)
        : await getScriptClient().restoreVersion(input);
    if (!result.ok) setError(result.error);
    else {
      updateDirty(false);
      await refresh();
      onCommitted?.();
      if (operation === 'confirm' && continueAfterConfirm) {
        if (nextStage !== null) selectStage(nextStage[0]);
        else setRequestedMediaStep('storyboard');
      }
    }
    setPending(false);
  };

  // SHOT_CONTRACT 集级命令（D6）：整集确认/恢复，无手写草稿编辑。
  const performStoryboardCommand = async (
    operation: 'confirm' | 'restore',
    version: StoryboardVersionSummaryDto,
  ): Promise<void> => {
    const currentStoryboard = workspace?.storyboard.current ?? null;
    if (currentStoryboard === null || workspace === null || pending) return;
    setPending(true);
    setError(null);
    const result = await getScriptClient()[
      operation === 'confirm' ? 'confirmVersion' : 'restoreVersion'
    ]({
      episodeId: workspace.episode.id,
      expectedVersionId: currentStoryboard.id,
      projectId,
      requestId: createScriptRequestId(`storyboard-${operation}`),
      stage: 'SHOT_CONTRACT',
      versionId: version.id,
    });
    if (!result.ok) setError(result.error);
    else {
      await refresh();
      onCommitted?.();
    }
    setPending(false);
  };

  // 逐镜头编辑/锁定/解锁（shot-edit-lock）：成功后刷新整集工作区，失败展示稳定错误码。
  const performShotEditLockCommand = async (
    run: () => Promise<AppResultDto<ShotEditLockSummaryDto>>,
    clearDirtyOnSuccess = false,
  ): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.error);
      else {
        if (clearDirtyOnSuccess) updateDirty(false);
        await refresh();
        if (clearDirtyOnSuccess && pendingCreatorStage !== null) {
          applyCreatorStage(pendingCreatorStage);
          setPendingCreatorStage(null);
        }
        onCommitted?.();
      }
    } catch {
      setError(rendererTransportError());
    }
    setPending(false);
  };

  // 整集导出（storyboard-export D5 单命令确认重发）：EXPORT_DURATION_DEVIATION 弹
  // 偏离确认；EXPORT_CANCELLED 静默；成功只展示 exportId 与哈希尾 4 位（路径红线）。
  // 三种交付物形态共用同一命令与弹层（deliverables D1/D3）。
  const performStoryboardExport = async (
    options: Readonly<{
      deviationReason?: string;
      format?: StoryboardExportFormat;
      warnConfirmed?: boolean;
    }>,
  ): Promise<void> => {
    const currentStoryboard = workspace?.storyboard.current ?? null;
    if (workspace === null || currentStoryboard === null || pending) return;
    setPending(true);
    setError(null);
    setExportNotice(null);
    try {
      const result = await getStoryboardClient().exportEpisode({
        deviationReason: options.deviationReason ?? null,
        episodeId: workspace.episode.id,
        expectedVersionId: currentStoryboard.id,
        format: options.format ?? 'EPISODE_JSON',
        projectId,
        requestId: createScriptRequestId('storyboard-export'),
        warnConfirmed: options.warnConfirmed,
      });
      if (result.ok) {
        setExportNotice(
          `导出成功：${result.data.exportId}（sha256 …${result.data.fileSha256.slice(-4)}，${String(
            result.data.byteSize,
          )} 字节）`,
        );
      } else if (result.error.code === 'EXPORT_DURATION_DEVIATION') {
        setDeviation({
          format: options.format ?? 'EPISODE_JSON',
          totalDurationSec: result.error.fieldErrors?.totalDurationSec ?? '',
        });
      } else if (result.error.code !== 'EXPORT_CANCELLED') {
        setError(result.error);
      }
    } catch {
      setError(rendererTransportError());
    }
    setPending(false);
  };

  // 项目快照导出（project-transfer 4.3）：默认拒绝覆盖；refused（retryable=false）
  // 时经 globalThis.confirm 显式确认后以新 requestId 覆盖重试。取消静默。
  const performTransferExport = async (overwriteConfirmed: boolean): Promise<void> => {
    const currentStoryboard = workspace?.storyboard.current ?? null;
    if (workspace === null || currentStoryboard === null || pending) return;
    setPending(true);
    setError(null);
    setSnapshotNotice(null);
    try {
      const result = await getTransferClient().exportProject({
        episodeId: workspace.episode.id,
        expectedVersionId: currentStoryboard.id,
        overwriteConfirmed,
        projectId,
        requestId: createScriptRequestId('transfer-export'),
      });
      if (result.ok) {
        const warnings = formatTransferWarnings(result.data.warningCodes);
        setSnapshotNotice(
          `项目快照已导出：${result.data.exportId}（sha256 …${result.data.fileSha256.slice(-4)}，${String(result.data.byteSize)} 字节）${warnings.length > 0 ? `；${warnings.join('；')}` : ''}`,
        );
      } else if (
        result.error.code === 'TRANSFER_FILE_WRITE_FAILED' &&
        !result.error.retryable &&
        !overwriteConfirmed &&
        globalThis.confirm('目标文件已存在。确认覆盖后重新导出？')
      ) {
        setPending(false);
        await performTransferExport(true);
        return;
      } else if (result.error.code !== 'TRANSFER_FILE_CANCELLED') {
        setError(result.error);
      }
    } catch {
      setError(rendererTransportError());
    }
    setPending(false);
  };

  // 按快照恢复本项目（RETURN_TO_ORIGIN）：追加新版本、不改历史行；取消静默。
  const performTransferRestore = async (): Promise<void> => {
    if (workspace === null || pending) return;
    if (!globalThis.confirm('将按快照恢复本项目：以不可变新版本追加，不修改历史版本。继续？')) {
      return;
    }
    setPending(true);
    setError(null);
    setSnapshotNotice(null);
    try {
      const result = await getTransferClient().importProject({
        importMode: 'RETURN_TO_ORIGIN',
        requestId: createScriptRequestId('transfer-restore'),
      });
      if (result.ok) {
        const warnings = formatTransferWarnings(result.data.warningCodes);
        setSnapshotNotice(
          `已按快照恢复：新增 ${String(result.data.createdObjectCount)} 个对象${warnings.length > 0 ? `；${warnings.join('；')}` : ''}`,
        );
        await refresh();
      } else if (result.error.code !== 'TRANSFER_FILE_CANCELLED') {
        setError(result.error);
      }
    } catch {
      setError(rendererTransportError());
    }
    setPending(false);
  };

  if (loading) return <p aria-live="polite">正在加载剧本工作区…</p>;
  if (workspace === null) {
    return (
      <OriginalInput
        onDirtyChange={updateDirty}
        onInitialized={(initialized) => {
          setWorkspace(initialized);
          updateDirty(false);
          onCommitted?.();
        }}
        projectId={projectId}
      />
    );
  }

  const selectedStageIndex = STAGES.findIndex(([stage]) => stage === selectedStage);
  const nextStage = STAGES[selectedStageIndex + 1] ?? null;
  const applyCreatorStage = (stage: CreatorStage): void => {
    if (stage === 'story') {
      setRequestedMediaStep(null);
      selectStage('CONCEPT');
      return;
    }
    if (stage === 'script') {
      setRequestedMediaStep(null);
      const target = selectedStage === 'CONCEPT' ? 'STORY_BIBLE' : selectedStage;
      selectStage(target);
      return;
    }
    setRequestedMediaStep(stage);
  };
  const selectCreatorStage = (stage: CreatorStage): void => {
    if (dirty) {
      setPendingCreatorStage(stage);
      return;
    }
    applyCreatorStage(stage);
  };

  return (
    <section
      className={`script-workspace creator-workspace-page media-${activeCreatorStage}${
        selectedStage === 'SCENE_SCRIPT' ? ' scene-script-page' : ''
      }`}
    >
      <CreatorStageBar
        activeStage={activeCreatorStage}
        onBack={onBack}
        onOpenEvaluation={onOpenEvaluation}
        onOpenProjectSettings={onOpenProjectSettings}
        onOpenSettings={onOpenSettings}
        onOpenHistory={() => {
          if (dirty) {
            setPendingCreatorStage('script');
            return;
          }
          globalThis.setTimeout(() => {
            const history = document.querySelector<HTMLDetailsElement>(
              requestedMediaStep === null ? '#script-version-history' : '.storyboard-history',
            );
            if (history !== null) {
              history.open = true;
              history.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 0);
        }}
        onSelect={selectCreatorStage}
        projectName={projectName}
        workType={workType}
      />
      {selectedStage === 'CONCEPT' && (
        <div aria-hidden="true" className="provider-readiness-probe">
          <ProviderSettings
            mode="status"
            onOpenSettings={onOpenSettings}
            onReadyChange={setProviderReady}
          />
        </div>
      )}
      {demoNotice}
      {error !== null && (
        <section className="inline-error" role="alert">
          <strong>当前操作未完成</strong>
          <p>
            {error.message}。{error.userAction}
          </p>
          <details className="technical-details">
            <summary>查看错误详情</summary>
            <code>{error.code}</code>
          </details>
        </section>
      )}
      {requestedMediaStep === null && (
        <WorkspaceLayout
          inspector={
            selectedStage === 'CONCEPT' ? (
              <section className="prototype-tip-panel">
                <h2>本步提示</h2>
                <ol>
                  {[
                    ['明确主题', '用一句话说明你最想表达的核心。'],
                    ['突出冲突', '让主角面对一个必须解决的困难。'],
                    ['简洁清晰', '故事梗概不需要太长，用清晰的语言描述主要情节和结局即可。'],
                    ['了解受众', '明确目标观众有助于我们生成更符合调性的剧本与镜头。'],
                  ].map(([title, copy], index) => (
                    <li key={title}>
                      <span>{String(index + 1)}</span>
                      <div>
                        <strong>{title}</strong>
                        <small>{copy}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : (
              <>
                <section className="prototype-next-panel">
                  <h2>下一步</h2>
                  <p>确认当前剧本内容后，继续完成下一环节。</p>
                  <dl className="compact-definition-list">
                    <div>
                      <dt>当前状态</dt>
                      <dd>{workspaceStatusLabel(current?.status)}</dd>
                    </div>
                    <div>
                      <dt>接下来</dt>
                      <dd>{nextScriptStageLabel(selectedStage) ?? '分镜设计'}</dd>
                    </div>
                  </dl>
                </section>
                <details className="technical-details">
                  <summary>服务与高级信息</summary>
                  <ProviderSettings
                    mode="status"
                    onOpenSettings={onOpenSettings}
                    onReadyChange={setProviderReady}
                  />
                  <p>当前环节：{STAGES.find(([stage]) => stage === selectedStage)?.[1]}</p>
                </details>
              </>
            )
          }
        >
          <section className="script-card">
            <header className="script-heading">
              <div>
                <p className="eyebrow">
                  {workType}项目 · 第 {selectedStage === 'CONCEPT' ? '1' : '2'} 步
                </p>
                <h2>
                  {selectedStage === 'CONCEPT'
                    ? '创作故事梗概'
                    : formalScriptPageTitle(selectedStage)}
                </h2>
                <p className="prototype-stage-description">
                  {selectedStage === 'CONCEPT'
                    ? `当前选择“${workType}”，后续会按对应节奏生成剧本与镜头。`
                    : '按人物、情节与场景逐步完善，为后续分镜与画面生成打好基础。'}
                </p>
                <p className="script-substage-label">
                  当前环节：{STAGES.find(([stage]) => stage === selectedStage)?.[1]}
                </p>
              </div>
              <StatusBadge status={current?.status} />
            </header>
            {selectedStage !== 'CONCEPT' && (
              <nav aria-label="剧本完善环节" className="script-substage-toolbar">
                {STAGES.slice(1).map(([stage, label]) => (
                  <button
                    aria-current={selectedStage === stage ? 'step' : undefined}
                    className={selectedStage === stage ? 'active' : ''}
                    key={stage}
                    onClick={() => {
                      if (dirty) setPendingStage(stage);
                      else selectStage(stage);
                    }}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </nav>
            )}
            {!stageWorkspace?.prerequisiteReady && (
              <p className="action-hint">前置阶段尚未确认，完成上一阶段后即可生成当前内容。</p>
            )}
            {current?.status === 'STALE_INPUT' && (
              <p className="field-error">上游已变化，此版本仅供查看；请重新生成后确认。</p>
            )}
            <div className="script-actions">
              <button
                disabled={
                  !providerReady ||
                  stageWorkspace?.prerequisiteReady !== true ||
                  expectedInputVersionId === null ||
                  (job !== null && !isTerminalJob(job))
                }
                onClick={() => {
                  if (expectedInputVersionId === null) return;
                  setError(null);
                  void getJobClient()
                    .create({
                      episodeId: stageEpisodeId,
                      expectedInputVersionId,
                      idempotencyKey: createScriptRequestId('script-job-idempotency'),
                      operationType: 'GENERATE',
                      projectId,
                      requestId: createScriptRequestId('script-job-create'),
                      stage: selectedStage,
                    })
                    .then((result) => {
                      if (result.ok) setJob(result.data);
                      else setError(result.error);
                    });
                }}
                type="button"
              >
                {current === null
                  ? `生成${STAGES[selectedStageIndex]?.[1] ?? '当前阶段'}`
                  : '重新生成'}
              </button>
              {job !== null && !isTerminalJob(job) && (
                <button
                  className="danger-button"
                  onClick={() => {
                    void getJobClient()
                      .cancel({
                        expectedVersionId: job.versionId,
                        jobId: job.id,
                        requestId: createScriptRequestId('script-job-cancel'),
                      })
                      .then((result) => {
                        if (result.ok) setJob(result.data);
                        else setError(result.error);
                      });
                  }}
                  type="button"
                >
                  取消任务
                </button>
              )}
              {job?.status === 'FAILED' && (
                <button
                  onClick={() => {
                    void getJobClient()
                      .retry({
                        expectedVersionId: job.versionId,
                        jobId: job.id,
                        requestId: createScriptRequestId('script-job-retry'),
                      })
                      .then((result) => {
                        if (result.ok) setJob(result.data);
                        else setError(result.error);
                      });
                  }}
                  type="button"
                >
                  重试任务
                </button>
              )}
            </div>
            {job !== null && (
              <p aria-live="polite">
                当前生成：{workspaceStatusLabel(job.status)}
                {job.errorCode === null ? '' : ' · 可在高级信息中查看诊断'}
              </p>
            )}
            <form
              className="script-form"
              id="script-stage-editor"
              onSubmit={(event) => {
                event.preventDefault();
                if (current === null || pending) return;
                const parsed =
                  editorMode === 'FORM'
                    ? { data: formData, ok: true as const }
                    : parseAdvancedStageData(editorText);
                if (!parsed.ok) {
                  setError({
                    code: 'SCRIPT_SCHEMA_INVALID',
                    fieldErrors: { '/data': parsed.message },
                    message: '阶段内容格式无效',
                    retryable: false,
                    traceId: 'renderer_local_validation',
                    userAction: '修正高级内容后重新保存',
                  });
                  return;
                }
                setPending(true);
                void getScriptClient()
                  .saveDraft({
                    data: parsed.data,
                    episodeId: stageEpisodeId,
                    expectedVersionId: current.id,
                    projectId,
                    requestId: createScriptRequestId('script-save'),
                    stage: selectedStage,
                  })
                  .then(async (result) => {
                    if (!result.ok) setError(result.error);
                    else {
                      updateDirty(false);
                      await refresh();
                      if (pendingStage !== null) {
                        selectStage(pendingStage);
                        setPendingStage(null);
                      }
                      if (pendingCreatorStage !== null) {
                        applyCreatorStage(pendingCreatorStage);
                        setPendingCreatorStage(null);
                      }
                      onCommitted?.();
                    }
                  })
                  .finally(() => {
                    setPending(false);
                  });
              }}
            >
              {selectedStage === 'CONCEPT' && (
                <div className="prototype-work-type-field">
                  <strong>作品类型</strong>
                  <div aria-label="当前作品类型" className="segmented-control">
                    <button
                      aria-pressed={workType === '漫剧'}
                      className={workType === '漫剧' ? 'active' : ''}
                      disabled={workType !== '漫剧'}
                      title={workType === '漫剧' ? undefined : '作品类型已在创建项目时确定'}
                      type="button"
                    >
                      漫剧
                    </button>
                    <button
                      aria-pressed={workType === '短剧'}
                      className={workType === '短剧' ? 'active' : ''}
                      disabled={workType !== '短剧'}
                      title={workType === '短剧' ? undefined : '作品类型已在创建项目时确定'}
                      type="button"
                    >
                      短剧
                    </button>
                  </div>
                  <span>作品类型已在创建时记录，确保后续生成与审计口径一致。</span>
                </div>
              )}
              <div aria-label="编辑方式" className="segmented-control">
                <button
                  aria-pressed={editorMode === 'FORM'}
                  className={editorMode === 'FORM' ? 'active' : ''}
                  onClick={() => {
                    const parsed = parseAdvancedStageData(editorText);
                    if (!parsed.ok) {
                      setError({
                        code: 'SCRIPT_SCHEMA_INVALID',
                        fieldErrors: { '/data': parsed.message },
                        message: '高级内容格式无效',
                        retryable: false,
                        traceId: 'renderer_local_validation',
                        userAction: '修正后才能返回表单，当前草稿未被覆盖。',
                      });
                      return;
                    }
                    setFormData(parsed.data);
                    setEditorMode('FORM');
                    setError(null);
                  }}
                  type="button"
                >
                  表单编辑
                </button>
                <button
                  aria-pressed={editorMode === 'ADVANCED'}
                  className={editorMode === 'ADVANCED' ? 'active' : ''}
                  onClick={() => {
                    setEditorText(serializeStageData(formData));
                    setEditorMode('ADVANCED');
                  }}
                  type="button"
                >
                  高级编辑
                </button>
              </div>
              {editorMode === 'FORM' ? (
                <StageStructuredForm
                  data={formData}
                  disabled={current === null}
                  errors={error?.fieldErrors ?? undefined}
                  referenceData={
                    workspace.stages.find((item) => item.stage === 'STORY_BIBLE')?.current?.document
                      .data
                  }
                  onChange={(data) => {
                    setFormData(data);
                    setEditorText(serializeStageData(data));
                    updateDirty(true);
                  }}
                  stage={selectedStage}
                />
              ) : (
                <label>
                  高级内容
                  <textarea
                    aria-describedby="editor-help"
                    disabled={current === null}
                    onChange={(event) => {
                      setEditorText(event.target.value);
                      updateDirty(true);
                    }}
                    rows={18}
                    value={editorText}
                  />
                </label>
              )}
              <small id="editor-help">保存会创建新的草稿；系统字段由镜序维护。</small>
              {error?.fieldErrors !== null &&
                error?.fieldErrors !== undefined &&
                Object.entries(error.fieldErrors).map(([path, message]) => (
                  <p className="field-error" key={path}>
                    {pointerToStageFieldId(path) === null
                      ? '请检查阶段内容'
                      : '请检查表单中的对应字段'}
                    ：{message}
                  </p>
                ))}
              <div className="script-actions">
                <button disabled={current === null || pending} type="submit">
                  暂存
                </button>
                <button
                  disabled={current?.status !== 'DRAFT' || pending}
                  onClick={() => {
                    if (
                      current !== null &&
                      globalThis.confirm('确认后，下游旧内容可能需要重新确认。继续？')
                    ) {
                      void performVersionCommand('confirm', current, true);
                    }
                  }}
                  type="button"
                >
                  保存并继续
                </button>
                {current?.status === 'READY' && (
                  <button
                    className="primary-next-action"
                    onClick={() => {
                      if (nextStage !== null) selectStage(nextStage[0]);
                      else
                        document
                          .querySelector('#storyboard-panel')
                          ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    type="button"
                  >
                    下一步：{nextScriptStageLabel(selectedStage)}
                  </button>
                )}
              </div>
            </form>
            <details className="technical-details" id="script-version-history">
              <summary id="history-title">历史与恢复</summary>
              {stageWorkspace?.history.length === 0 ? (
                <p>暂无历史版本。</p>
              ) : (
                <ul className="version-list">
                  {stageWorkspace?.history.map((item) => (
                    <li key={item.id}>
                      <span>
                        v{String(item.versionNo)} · {workspaceStatusLabel(item.status)}
                      </span>
                      <button
                        className="secondary-button"
                        disabled={current === null || item.id === current.id || pending}
                        onClick={() => {
                          if (
                            globalThis.confirm(`基于 v${String(item.versionNo)} 创建新的 DRAFT？`)
                          ) {
                            void performVersionCommand('restore', item);
                          }
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
        </WorkspaceLayout>
      )}
      {requestedMediaStep !== null && sceneScriptCurrent?.status === 'READY' && (
        <StoryboardPanel
          isDemo={isDemo}
          onDirtyChange={updateDirty}
          onMediaStepChange={setRequestedMediaStep}
          initialMediaStep={requestedMediaStep}
          batchBusy={batchBusy}
          episodeTargetDurationSec={workspace.episode.targetDurationSec}
          exportNotice={exportNotice}
          generateHint={storyboardGenerateHint}
          imageStates={imageStates.states}
          job={job}
          onBatchCancel={cancelBatch}
          onBatchRetryFailed={retryFailedShots}
          onGenerateVideos={performGenerateVideos}
          onPrepareOperation={(operation, proceed) => {
            void openPreparation(operation, proceed);
          }}
          onVideoBatchCancel={cancelVideoBatch}
          onVideoBatchRetryFailed={retryFailedVideoShots}
          onConfirm={() => {
            if (globalThis.confirm('确认当前整集分镜为可用版本？')) {
              const currentStoryboard = workspace.storyboard.current;
              if (currentStoryboard !== null) {
                void performStoryboardCommand('confirm', currentStoryboard);
              }
            }
          }}
          onExportEpisode={(format) => {
            void performStoryboardExport({ format });
          }}
          onExportSnapshot={() => {
            void performTransferExport(false);
          }}
          onRestoreSnapshot={() => {
            void performTransferRestore();
          }}
          snapshotNotice={snapshotNotice}
          onGenerate={() => {
            if (sceneScriptCurrent.status !== 'READY') return;
            setError(null);
            void getJobClient()
              .create({
                episodeId: workspace.episode.id,
                expectedInputVersionId: sceneScriptCurrent.id,
                idempotencyKey: createScriptRequestId('storyboard-job-idempotency'),
                operationType: 'GENERATE',
                projectId,
                requestId: createScriptRequestId('storyboard-job-create'),
                stage: 'SHOT_CONTRACT',
              })
              .then((result) => {
                if (result.ok) setJob(result.data);
                else setError(result.error);
              });
          }}
          onGenerateFirstFrames={performGenerateFirstFrames}
          onEditShot={(input) => {
            void performShotEditLockCommand(() => getStoryboardClient().editShot(input), true);
          }}
          onLockShot={(input) => {
            void performShotEditLockCommand(() => getStoryboardClient().lockShot(input));
          }}
          onUnlockShot={(input) => {
            void performShotEditLockCommand(() => getStoryboardClient().unlockShot(input));
          }}
          onRestore={(version) => {
            if (globalThis.confirm(`基于 v${String(version.versionNo)} 创建新的 DRAFT 整集？`)) {
              void performStoryboardCommand('restore', version);
            }
          }}
          pending={pending}
          projectId={projectId}
          storyboard={workspace.storyboard}
          videoBatchBusy={videoBatchBusy}
          videoStates={videoStates.states}
        />
      )}
      <DirtyLeaveDialog
        onCancel={() => {
          setPendingStage(null);
          setPendingCreatorStage(null);
        }}
        onDiscard={() => {
          const target = pendingStage;
          const creatorTarget = pendingCreatorStage;
          setPendingStage(null);
          setPendingCreatorStage(null);
          updateDirty(false);
          if (target !== null) selectStage(target);
          if (creatorTarget !== null) applyCreatorStage(creatorTarget);
        }}
        onSaveAndLeave={() => {
          document.querySelector<HTMLFormElement>('#script-stage-editor')?.requestSubmit();
        }}
        open={pendingStage !== null || pendingCreatorStage !== null}
        pending={pending}
      />
      {preparation !== null && (
        <PreparationDialog
          onCancel={() => {
            setPreparation(null);
          }}
          onConfirm={() => {
            void confirmPreparation();
          }}
          onFix={(fixAction) => {
            setPreparation(null);
            if (fixAction === 'OPEN_GENERATION_SERVICES') {
              onOpenSettings();
              return;
            }
            if (
              fixAction === 'ADD_CHARACTER_REFERENCE' ||
              fixAction === 'ADD_STYLE_REFERENCE' ||
              fixAction === 'SELECT_IMAGE_CANDIDATE'
            ) {
              setRequestedMediaStep('image');
            } else if (fixAction === 'SELECT_VIDEO_CANDIDATE') {
              setRequestedMediaStep('video');
            } else {
              setRequestedMediaStep('composition');
            }
            document.querySelector('#storyboard-panel')?.scrollIntoView({ behavior: 'smooth' });
          }}
          pending={preparationPending}
          preparation={preparation.data}
        />
      )}
      {deviation !== null && (
        <ExportDeviationDialog
          onCancel={() => {
            setDeviation(null);
          }}
          onConfirm={(reason) => {
            const pendingFormat = deviation.format;
            setDeviation(null);
            void performStoryboardExport({
              deviationReason: reason,
              format: pendingFormat,
              warnConfirmed: true,
            });
          }}
          open
          pending={pending}
          totalDurationSec={deviation.totalDurationSec}
        />
      )}
    </section>
  );
};
