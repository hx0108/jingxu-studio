import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AppErrorDto,
  AppResultDto,
  JobSummaryDto,
  MediaBatchViewDto,
  ScriptVersionDto,
  ScriptWorkspaceDto,
  ShotEditLockSummaryDto,
  StoryboardExportFormat,
  StoryboardVersionSummaryDto,
} from '@jingxu/contracts';

import { ExportDeviationDialog } from './ExportDeviationDialog';
import { OriginalInput } from './OriginalInput';
import { StoryboardPanel } from './StoryboardPanel';
import { ProviderSettings } from './ProviderSettings';
import { DirtyLeaveDialog } from '../project/DirtyLeaveDialog';
import { getTransferClient } from '../project/transfer-api';
import { formatTransferWarnings } from '../project/transfer-copy';
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

const STAGES = [
  ['CONCEPT', '故事概念'],
  ['STORY_BIBLE', '故事圣经'],
  ['EPISODE_OUTLINE', '单集大纲'],
  ['BEAT_SHEET', '节拍表'],
  ['SCENE_SCRIPT', '场景剧本'],
] as const;
type Stage = (typeof STAGES)[number][0];

export interface ScriptWorkspaceViewProps {
  readonly projectId: string;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCommitted?: () => void;
}

export const ScriptWorkspaceView = ({
  projectId,
  onDirtyChange,
  onCommitted,
}: ScriptWorkspaceViewProps) => {
  const [workspace, setWorkspace] = useState<ScriptWorkspaceDto | null>(null);
  const [selectedStage, setSelectedStage] = useState<Stage>('CONCEPT');
  const [editorText, setEditorText] = useState('{}');
  const [providerReady, setProviderReady] = useState(false);
  const [job, setJob] = useState<JobSummaryDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingStage, setPendingStage] = useState<Stage | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [videoBatchBusy, setVideoBatchBusy] = useState(false);
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

  const generateFirstFrames = (): void => {
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

  const generateVideos = (): void => {
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

  const selectStage = (stage: Stage, nextWorkspace = workspace): void => {
    const item = nextWorkspace?.stages.find((candidate) => candidate.stage === stage);
    setSelectedStage(stage);
    setEditorText(JSON.stringify(item?.current?.document.data ?? {}, null, 2));
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
            setEditorText(
              JSON.stringify(
                result.data.stages.find((item) => item.stage === selectedStage)?.current?.document
                  .data ?? {},
                null,
                2,
              ),
            );
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
          setEditorText(
            JSON.stringify(
              result.data.stages.find((item) => item.stage === 'CONCEPT')?.current?.document.data ??
                {},
              null,
              2,
            ),
          );
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
        ? 'Provider 尚未就绪，完成设置与验证后可生成分镜。'
        : sceneScriptCurrent?.status !== 'READY'
          ? '前置阶段尚未确认 READY：需先确认场景剧本。'
          : job !== null && !isTerminalJob(job)
            ? '已有任务运行中，完成后可生成分镜。'
            : null;

  const performVersionCommand = async (
    operation: 'confirm' | 'restore',
    version: ScriptVersionDto,
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
  ): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await run();
      if (!result.ok) setError(result.error);
      else {
        await refresh();
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

  return (
    <section className="script-workspace">
      <ProviderSettings onReadyChange={setProviderReady} />
      {error !== null && (
        <p className="field-error script-card" role="alert">
          {error.code}：{error.message}。{error.userAction}
        </p>
      )}
      <nav aria-label="五阶段剧本" className="stage-navigation">
        {STAGES.map(([stage, label]) => {
          const item = workspace.stages.find((candidate) => candidate.stage === stage);
          return (
            <button
              aria-current={selectedStage === stage ? 'step' : undefined}
              className={selectedStage === stage ? 'active-tab' : 'secondary-button'}
              key={stage}
              onClick={() => {
                if (dirty) setPendingStage(stage);
                else selectStage(stage);
              }}
              type="button"
            >
              {label} · {item?.current?.status ?? '未生成'}
            </button>
          );
        })}
      </nav>
      <section className="script-card">
        <header className="script-heading">
          <div>
            <p className="eyebrow">{selectedStage}</p>
            <h2>{STAGES.find(([stage]) => stage === selectedStage)?.[1]}</h2>
          </div>
          <span className={`status-badge status-${current?.status.toLowerCase() ?? 'empty'}`}>
            {current === null ? '○ 未生成' : `● ${current.status}`}
          </span>
        </header>
        {!stageWorkspace?.prerequisiteReady && (
          <p className="action-hint">前置阶段尚未确认 READY，当前阶段不能生成。</p>
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
            生成本阶段
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
            任务状态：{job.status}
            {job.errorCode === null ? '' : ` · ${job.errorCode}`}
          </p>
        )}
        <form
          className="script-form"
          id="script-stage-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (current === null || pending) return;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(editorText) as Record<string, unknown>;
            } catch {
              setError({
                code: 'SCRIPT_SCHEMA_INVALID',
                fieldErrors: { '/data': '必须是有效 JSON 对象' },
                message: '阶段内容格式无效',
                retryable: false,
                traceId: 'renderer_local_validation',
                userAction: '修正 JSON 后重新保存',
              });
              return;
            }
            setPending(true);
            void getScriptClient()
              .saveDraft({
                data,
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
                  onCommitted?.();
                }
              })
              .finally(() => {
                setPending(false);
              });
          }}
        >
          <label>
            结构化阶段内容
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
          <small id="editor-help">
            字段错误使用 JSON Pointer 显示；保存会创建新的不可变 DRAFT。
          </small>
          {error?.fieldErrors !== null &&
            error?.fieldErrors !== undefined &&
            Object.entries(error.fieldErrors).map(([path, message]) => (
              <p className="field-error" key={path}>
                {path}：{message}
              </p>
            ))}
          <div className="script-actions">
            <button disabled={current === null || pending} type="submit">
              保存为新 DRAFT
            </button>
            <button
              disabled={current?.status !== 'DRAFT' || pending}
              onClick={() => {
                if (
                  current !== null &&
                  globalThis.confirm('确认后下游旧版本可能变为 STALE_INPUT，继续？')
                ) {
                  void performVersionCommand('confirm', current);
                }
              }}
              type="button"
            >
              确认为 READY
            </button>
          </div>
        </form>
        <section aria-labelledby="history-title">
          <h3 id="history-title">版本历史</h3>
          {stageWorkspace?.history.length === 0 ? (
            <p>暂无历史版本。</p>
          ) : (
            <ul className="version-list">
              {stageWorkspace?.history.map((item) => (
                <li key={item.id}>
                  <span>
                    v{String(item.versionNo)} · {item.status} · {item.source}
                  </span>
                  <button
                    className="secondary-button"
                    disabled={current === null || item.id === current.id || pending}
                    onClick={() => {
                      if (globalThis.confirm(`基于 v${String(item.versionNo)} 创建新的 DRAFT？`)) {
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
        </section>
      </section>
      <StoryboardPanel
        batchBusy={batchBusy}
        episodeTargetDurationSec={workspace.episode.targetDurationSec}
        exportNotice={exportNotice}
        generateHint={storyboardGenerateHint}
        imageStates={imageStates.states}
        job={job}
        onBatchCancel={cancelBatch}
        onBatchRetryFailed={retryFailedShots}
        onGenerateVideos={generateVideos}
        onVideoBatchCancel={cancelVideoBatch}
        onVideoBatchRetryFailed={retryFailedVideoShots}
        onConfirm={() => {
          if (globalThis.confirm('确认当前整集分镜为 READY？')) {
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
          if (sceneScriptCurrent?.status !== 'READY') return;
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
        onGenerateFirstFrames={generateFirstFrames}
        onEditShot={(input) => {
          void performShotEditLockCommand(() => getStoryboardClient().editShot(input));
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
      <DirtyLeaveDialog
        onCancel={() => {
          setPendingStage(null);
        }}
        onDiscard={() => {
          const target = pendingStage;
          setPendingStage(null);
          if (target !== null) selectStage(target);
        }}
        onSaveAndLeave={() => {
          document.querySelector<HTMLFormElement>('#script-stage-editor')?.requestSubmit();
        }}
        open={pendingStage !== null}
        pending={pending}
      />
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
