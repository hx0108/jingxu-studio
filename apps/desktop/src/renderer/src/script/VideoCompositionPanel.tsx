import { useCallback, useEffect, useState } from 'react';

import type { VideoExportJobDto, VideoTimelineSummaryDto } from '@jingxu/contracts';

import { getVideoClient, createScriptRequestId } from './script-api';
import { ExportAlignmentSummary } from './ExportAlignmentSummary';
import { workspaceStatusLabel } from '../ui/workspace-status';
import {
  createTimelineDraft,
  reduceTimelineDraft,
  type TimelineDraftAction,
} from './timeline-draft';
import { TimelineTracks } from './TimelineTracks';

interface VideoCompositionPanelProps {
  readonly isDemo?: boolean;
  readonly projectId: string;
  readonly episodeId: string;
  readonly episodeVersionId: string;
  readonly onPrepareExport?: ((proceed: () => void) => void) | undefined;
}

const formatError = (message: string): string => message || '操作失败，请重试。';

/** 可静态验证的导出状态视图；只呈现受限 URL 预览，不泄露本地文件或进程信息。 */
export const VideoExportJobStatus = ({ job }: { readonly job: VideoExportJobDto | null }) => {
  if (job === null) return null;
  return (
    <>
      <p aria-live="polite">导出状态：{workspaceStatusLabel(job.status)}</p>
      {job.status === 'FAILED' && job.errorCode !== null && (
        <div className="inline-error">
          <p>导出失败，请检查时间线和媒体输入后重试。</p>
          <details className="technical-details">
            <summary>查看错误详情</summary>
            <code>{job.errorCode}</code>
          </details>
        </div>
      )}
      {job.status === 'CANCELLED' && <p>导出已取消，可修正时间线后重新导出。</p>}
      {job.status === 'SUCCEEDED' && job.mediaUrl !== null && (
        <video aria-label="已导出成片预览" controls src={job.mediaUrl} />
      )}
    </>
  );
};

/** 导出前检查的 Mock 模拟来源提示（low-cost 6.4）：启用项含模拟视频段时醒目标注。 */
export const VideoExportMockNotice = ({ count }: { readonly count: number }) => {
  if (count <= 0) return null;
  return (
    <p className="field-error" role="note">
      导出前检查：时间线包含 {String(count)} 个模拟视频段，导出成品为联调模拟内容，
      不代表真实服务生成画质。
    </p>
  );
};

const exportRecordTitle = (job: VideoExportJobDto): string => {
  const seconds = Math.round((job.totalDurationMs ?? 0) / 1000);
  return seconds > 0 ? `${String(seconds)} 秒成片` : '成片导出任务';
};

export const VideoExportRecords = ({
  jobs,
  onSelect,
}: {
  readonly jobs: readonly VideoExportJobDto[];
  readonly onSelect: (job: VideoExportJobDto) => void;
}) => (
  <section aria-labelledby="recent-video-exports-title" className="composition-export-records">
    <h4 id="recent-video-exports-title">最近导出记录</h4>
    {jobs.length === 0 ? (
      <p className="action-hint">还没有导出记录。生成成片后，任务状态会在这里留存。</p>
    ) : (
      <div className="composition-export-record-list">
        {jobs.map((entry) => (
          <article className="composition-export-record" key={entry.id}>
            <div>
              <strong>{exportRecordTitle(entry)}</strong>
              <span>{new Date(entry.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
            </div>
            <span className={`status-badge status-${entry.status.toLowerCase()}`}>
              {workspaceStatusLabel(entry.status)}
            </span>
            <button
              className="secondary-button"
              onClick={() => {
                onSelect(entry);
              }}
              type="button"
            >
              {entry.status === 'SUCCEEDED' ? '查看成片' : '查看状态'}
            </button>
          </article>
        ))}
      </div>
    )}
  </section>
);

/** 单集时间线编辑：只通过冻结 video IPC 访问，绝不接触本地路径。 */
export const VideoCompositionPanel = ({
  episodeId,
  episodeVersionId,
  isDemo = false,
  onPrepareExport,
  projectId,
}: VideoCompositionPanelProps) => {
  const [draft, setDraft] = useState<ReturnType<typeof createTimelineDraft> | null>(null);
  const [audioAssetId, setAudioAssetId] = useState<string | null>(null);
  const [job, setJob] = useState<VideoExportJobDto | null>(null);
  const [recentExports, setRecentExports] = useState<readonly VideoExportJobDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportDecisionOpen, setExportDecisionOpen] = useState(false);
  const timeline = draft?.original ?? null;
  const items = draft?.current.items ?? [];
  const voiceItems = draft?.current.voiceItems ?? [];
  const subtitleItems = draft?.current.subtitleItems ?? [];
  const audioVolume = draft?.current.audioVolume ?? 0.2;
  const edit = (action: TimelineDraftAction) => {
    setDraft((current) => (current === null ? null : reduceTimelineDraft(current, action)));
  };

  const enabledCount = items.filter((item) => item.enabled).length;
  // 导出前检查（low-cost 6.4）：时间线启用项含 Mock 模拟视频段时醒目提示。
  const mockEnabledCount = items.filter((item) => item.enabled && item.isMock === true).length;
  const hasUnsavedChanges =
    draft?.dirty === true ||
    (timeline !== null && audioAssetId !== (timeline.audioAsset?.id ?? null));

  const loadRecentExports = useCallback(async () => {
    const result = await getVideoClient().listExports({ episodeId, limit: 5, projectId });
    if (result.ok) setRecentExports(result.data);
  }, [episodeId, projectId]);

  // 载入/新建/保存共用回填：两轨与 BGM 音量随版本数据往返，不再硬编码。
  const applyTimeline = (data: VideoTimelineSummaryDto) => {
    setDraft(createTimelineDraft(data));
    setAudioAssetId(data.audioAsset?.id ?? null);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getVideoClient()
        .getTimeline({ episodeId, projectId, timelineVersionId: null })
        .then((result) => {
          if (result.ok) {
            const data = result.data;
            setDraft(createTimelineDraft(data));
            setAudioAssetId(data.audioAsset?.id ?? null);
          }
        });
    }, 0);
    // 仅随单集切换载入，不监听时间线本身，避免编辑触发覆盖。
    return () => {
      window.clearTimeout(timer);
    };
  }, [episodeId, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecentExports();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadRecentExports]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeave);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeLeave);
    };
  }, [hasUnsavedChanges]);

  const createTimeline = async () => {
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().createTimeline({
      episodeId,
      expectedEpisodeVersionId: episodeVersionId,
      projectId,
      requestId: createScriptRequestId('video-timeline-create'),
    });
    if (result.ok) applyTimeline(result.data);
    else setNotice(formatError(result.error.message));
    setBusy(false);
  };

  const saveTimeline = async (): Promise<VideoTimelineSummaryDto | null> => {
    if (timeline === null || draft === null) return null;
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().updateTimeline({
      audioAssetId,
      audioVolume,
      bgmFadeInMs: draft.current.bgmFadeInMs,
      bgmFadeOutMs: draft.current.bgmFadeOutMs,
      bgmMuted: draft.current.bgmMuted,
      bgmStartMs: draft.current.bgmStartMs,
      bgmTrimInMs: draft.current.bgmTrimInMs,
      bgmTrimOutMs: draft.current.bgmTrimOutMs,
      episodeId,
      expectedVersionId: timeline.id,
      items,
      projectId,
      requestId: createScriptRequestId('video-timeline-update'),
      subtitleItems,
      voiceItems,
      voiceTrackMuted: draft.current.voiceTrackMuted,
    });
    if (result.ok) {
      applyTimeline(result.data);
      setNotice('时间线已保存为新版本。');
      setBusy(false);
      return result.data;
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
    return null;
  };

  const importAudio = async () => {
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().importBackgroundMusic({
      projectId,
      requestId: createScriptRequestId('video-audio-import'),
    });
    if (result.ok) {
      setAudioAssetId(result.data.id);
      setNotice(`已导入背景音乐：${result.data.originalFileName}`);
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  const startExport = async (timelineVersionId: string = timeline?.id ?? '') => {
    if (timelineVersionId.length === 0 || enabledCount === 0) return;
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().startExport({
      episodeId,
      projectId,
      requestId: createScriptRequestId('video-export'),
      timelineVersionId,
    });
    if (result.ok) {
      setJob(result.data);
      setRecentExports((current) => [
        result.data,
        ...current.filter((row) => row.id !== result.data.id),
      ]);
      setNotice('导出任务已提交。');
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  const requestExport = () => {
    if (timeline === null) return;
    if (draft?.dirty || audioAssetId !== (timeline.audioAsset?.id ?? null)) {
      setExportDecisionOpen(true);
      return;
    }
    void startExport(timeline.id);
  };

  useEffect(() => {
    if (job === null || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void getVideoClient()
        .getExportJob({ exportJobId: job.id, projectId })
        .then((result) => {
          if (result.ok) {
            setJob(result.data);
            if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.data.status)) {
              void loadRecentExports();
              setNotice(
                result.data.status === 'SUCCEEDED'
                  ? `成片导出成功（${String(result.data.byteSize ?? 0)} 字节）。`
                  : result.data.status === 'CANCELLED'
                    ? '导出已取消，可调整时间线后重新导出。'
                    : '导出失败，请查看错误详情并检查时间线和媒体输入。',
              );
            }
          }
        });
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [job, loadRecentExports, projectId]);

  return (
    <section aria-labelledby="video-composition-title" className="script-card">
      <header className="script-heading">
        <div>
          <p className="eyebrow">合成导出</p>
          <h3 id="video-composition-title">单集时间线与成片导出</h3>
        </div>
        <span className="status-badge">
          {timeline === null ? '未创建' : `第 ${String(timeline.versionNo)} 版`}
        </span>
      </header>
      <p className="action-hint">
        先生成时间线，再调整排序、启停和入点/出点；所有保存均产生不可变时间线版本。
      </p>
      <VideoExportMockNotice count={mockEnabledCount} />
      {timeline === null && (
        <button
          data-primary-action
          disabled={busy}
          name="create-video-timeline"
          onClick={() => void createTimeline()}
          type="button"
        >
          生成时间线
        </button>
      )}
      {audioAssetId !== null && (
        <>
          <p className="action-hint">已选择背景音乐（内容哈希资产）。</p>
          <label className="action-hint">
            背景音乐音量
            <input
              max={1}
              min={0}
              name="bgm-volume"
              onChange={(event) => {
                edit({ type: 'set-bgm', patch: { audioVolume: Number(event.target.value) } });
              }}
              step={0.05}
              type="number"
              value={audioVolume}
            />
          </label>
        </>
      )}
      {notice !== null && (
        <p aria-live="polite" className="action-hint">
          {notice}
        </p>
      )}
      {exportDecisionOpen && timeline !== null && (
        <div className="dialog-backdrop">
          <section
            aria-labelledby="unsaved-timeline-title"
            aria-modal="true"
            className="dialog-card"
            role="dialog"
          >
            <p className="eyebrow">导出前确认</p>
            <h3 id="unsaved-timeline-title">时间线有未保存修改</h3>
            <p>导出只使用已保存的时间线版本。你可以先保存并继续，也可以放弃本次草稿后导出。</p>
            <div className="dialog-actions">
              <button
                disabled={busy}
                onClick={() => {
                  setExportDecisionOpen(false);
                }}
                type="button"
              >
                取消
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  const savedVersionId = timeline.id;
                  applyTimeline(timeline);
                  setExportDecisionOpen(false);
                  void startExport(savedVersionId);
                }}
                type="button"
              >
                放弃修改并导出
              </button>
              <button
                data-primary-action
                disabled={busy}
                onClick={() => {
                  void saveTimeline().then((saved) => {
                    if (saved === null) return;
                    setExportDecisionOpen(false);
                    void startExport(saved.id);
                  });
                }}
                type="button"
              >
                保存并继续
              </button>
            </div>
          </section>
        </div>
      )}
      {timeline !== null && <ExportAlignmentSummary alignmentItems={timeline.alignmentItems} />}
      {draft !== null && (
        <TimelineTracks
          draft={draft}
          isDemo={isDemo}
          onAction={edit}
          overviewAside={
            <div className="composition-review-grid">
              <section aria-labelledby="composition-check-title" className="composition-check-card">
                <h4 id="composition-check-title">成片检查</h4>
                <ul>
                  <li>
                    <span aria-hidden="true">{enabledCount > 0 ? '✓' : '!'}</span>
                    <div>
                      <strong>画面轨</strong>
                      <small>{String(enabledCount)} 个启用片段</small>
                    </div>
                  </li>
                  <li>
                    <span aria-hidden="true">{voiceItems.length > 0 ? '✓' : '—'}</span>
                    <div>
                      <strong>对白轨</strong>
                      <small>{String(voiceItems.length)} 个对白片段</small>
                    </div>
                  </li>
                  <li>
                    <span aria-hidden="true">{audioAssetId === null ? '—' : '✓'}</span>
                    <div>
                      <strong>配乐轨</strong>
                      <small>{audioAssetId === null ? '尚未添加配乐' : '已绑定内容哈希资产'}</small>
                    </div>
                  </li>
                  <li>
                    <span aria-hidden="true">{hasUnsavedChanges ? '!' : '✓'}</span>
                    <div>
                      <strong>时间线版本</strong>
                      <small>{hasUnsavedChanges ? '存在未保存修改' : '当前修改已保存'}</small>
                    </div>
                  </li>
                </ul>
              </section>
              <section
                aria-labelledby="composition-export-title"
                className="composition-export-card"
              >
                <h4 id="composition-export-title">导出设置</h4>
                <p>使用项目已绑定的画幅、分辨率和帧率。</p>
                <div className="composition-primary-actions">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    name="import-video-background-music"
                    onClick={() => void importAudio()}
                    type="button"
                  >
                    导入背景音乐
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy || !hasUnsavedChanges}
                    name="save-video-timeline"
                    onClick={() => void saveTimeline()}
                    type="button"
                  >
                    保存时间线
                  </button>
                  <button
                    data-primary-action
                    disabled={busy || enabledCount === 0}
                    name="start-video-export"
                    onClick={() => {
                      const proceed = requestExport;
                      if (onPrepareExport === undefined) proceed();
                      else onPrepareExport(proceed);
                    }}
                    type="button"
                  >
                    生成成片
                  </button>
                  {job !== null && ['PREPARING', 'RUNNING', 'VALIDATING'].includes(job.status) && (
                    <button
                      className="danger-button"
                      disabled={busy}
                      name="cancel-video-export"
                      onClick={() => {
                        void getVideoClient()
                          .cancelExport({
                            exportJobId: job.id,
                            projectId,
                            requestId: createScriptRequestId('video-export-cancel'),
                          })
                          .then((result) => {
                            if (result.ok) {
                              setJob(result.data);
                              void loadRecentExports();
                            } else setNotice(formatError(result.error.message));
                          });
                      }}
                      type="button"
                    >
                      取消导出
                    </button>
                  )}
                </div>
                <VideoExportJobStatus job={job} />
              </section>
            </div>
          }
        />
      )}
      <VideoExportRecords jobs={recentExports} onSelect={setJob} />
    </section>
  );
};
