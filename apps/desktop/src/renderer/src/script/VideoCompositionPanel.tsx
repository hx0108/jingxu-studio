import { useEffect, useMemo, useState } from 'react';

import type {
  VideoTimelineItemDto,
  VideoTimelineSummaryDto,
  VideoExportJobDto,
} from '@jingxu/contracts';

import { getVideoClient, createScriptRequestId } from './script-api';
import { workspaceStatusLabel } from '../ui/workspace-status';

interface VideoCompositionPanelProps {
  readonly projectId: string;
  readonly episodeId: string;
  readonly episodeVersionId: string;
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
        <video aria-label="已导出 MP4 预览" controls src={job.mediaUrl} />
      )}
    </>
  );
};

/** 单集时间线编辑：只通过冻结 video IPC 访问，绝不接触本地路径。 */
export const VideoCompositionPanel = ({
  episodeId,
  episodeVersionId,
  projectId,
}: VideoCompositionPanelProps) => {
  const [timeline, setTimeline] = useState<VideoTimelineSummaryDto | null>(null);
  const [items, setItems] = useState<VideoTimelineItemDto[]>([]);
  const [audioAssetId, setAudioAssetId] = useState<string | null>(null);
  const [job, setJob] = useState<VideoExportJobDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getVideoClient()
        .getTimeline({ episodeId, projectId, timelineVersionId: null })
        .then((result) => {
          if (result.ok) {
            setTimeline(result.data);
            setItems(result.data.items);
            setAudioAssetId(result.data.audioAsset?.id ?? null);
          }
        });
    }, 0);
    // 仅随单集切换载入，不监听时间线本身，避免编辑触发覆盖。
    return () => {
      window.clearTimeout(timer);
    };
  }, [episodeId, projectId]);

  const createTimeline = async () => {
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().createTimeline({
      episodeId,
      expectedEpisodeVersionId: episodeVersionId,
      projectId,
      requestId: createScriptRequestId('video-timeline-create'),
    });
    if (result.ok) {
      setTimeline(result.data);
      setItems(result.data.items);
      setAudioAssetId(result.data.audioAsset?.id ?? null);
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  const saveTimeline = async () => {
    if (timeline === null) return;
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().updateTimeline({
      audioAssetId,
      episodeId,
      expectedVersionId: timeline.id,
      items,
      projectId,
      requestId: createScriptRequestId('video-timeline-update'),
    });
    if (result.ok) {
      setTimeline(result.data);
      setItems(result.data.items);
      setAudioAssetId(result.data.audioAsset?.id ?? null);
      setNotice('时间线已保存为新版本。');
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
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

  const startExport = async () => {
    if (timeline === null || enabledCount === 0) return;
    setBusy(true);
    setNotice(null);
    const result = await getVideoClient().startExport({
      episodeId,
      projectId,
      requestId: createScriptRequestId('video-export'),
      timelineVersionId: timeline.id,
    });
    if (result.ok) {
      setJob(result.data);
      setNotice('导出任务已提交。');
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
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
              setNotice(
                result.data.status === 'SUCCEEDED'
                  ? `MP4 导出成功（${String(result.data.byteSize ?? 0)} 字节）。`
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
  }, [job, projectId]);

  const updateItem = (index: number, patch: Partial<VideoTimelineItemDto>) => {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    setItems((current) => {
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return current;
      next.splice(target, 0, moved);
      return next.map((item, position) => ({ ...item, position }));
    });
  };

  return (
    <section aria-labelledby="video-composition-title" className="script-card">
      <header className="script-heading">
        <div>
          <p className="eyebrow">合成导出</p>
          <h3 id="video-composition-title">单集时间线与 MP4 导出</h3>
        </div>
        <span className="status-badge">
          {timeline === null ? '未创建' : `v${String(timeline.versionNo)}`}
        </span>
      </header>
      <p className="action-hint">
        先生成时间线，再调整排序、启停和入点/出点；所有保存均产生不可变时间线版本。
      </p>
      <div className="script-actions">
        <button
          disabled={busy}
          name="create-video-timeline"
          onClick={() => void createTimeline()}
          type="button"
        >
          生成时间线
        </button>
        <button
          disabled={busy || timeline === null}
          name="import-video-background-music"
          onClick={() => void importAudio()}
          type="button"
        >
          导入背景音乐
        </button>
        <button
          disabled={busy || timeline === null}
          name="save-video-timeline"
          onClick={() => void saveTimeline()}
          type="button"
        >
          保存时间线
        </button>
        <button
          disabled={busy || timeline === null || enabledCount === 0}
          name="start-video-export"
          onClick={() => void startExport()}
          type="button"
        >
          导出 MP4
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
                  if (result.ok) setJob(result.data);
                  else setNotice(formatError(result.error.message));
                });
            }}
            type="button"
          >
            取消导出
          </button>
        )}
      </div>
      {audioAssetId !== null && <p className="action-hint">已选择背景音乐（内容哈希资产）。</p>}
      {notice !== null && (
        <p aria-live="polite" className="action-hint">
          {notice}
        </p>
      )}
      <VideoExportJobStatus job={job} />
      {items.length > 0 && (
        <ol aria-label="视频时间线镜头列表" className="shot-card-list">
          {items.map((item, index) => (
            <li key={item.shotId}>
              <div className="shot-card">
                <span>
                  #{String(index + 1)} · {item.shotId}
                </span>
                <label>
                  <input
                    checked={item.enabled}
                    onChange={(event) => {
                      updateItem(index, { enabled: event.target.checked });
                    }}
                    type="checkbox"
                  />
                  启用
                </label>
                <label>
                  入点(ms)
                  <input
                    min={0}
                    onChange={(event) => {
                      updateItem(index, { trimInMs: Number(event.target.value) });
                    }}
                    type="number"
                    value={item.trimInMs}
                  />
                </label>
                <label>
                  出点(ms)
                  <input
                    min={1}
                    onChange={(event) => {
                      updateItem(index, { trimOutMs: Number(event.target.value) });
                    }}
                    type="number"
                    value={item.trimOutMs}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={index === 0}
                  onClick={() => {
                    moveItem(index, -1);
                  }}
                  type="button"
                >
                  上移
                </button>
                <button
                  className="secondary-button"
                  disabled={index === items.length - 1}
                  onClick={() => {
                    moveItem(index, 1);
                  }}
                  type="button"
                >
                  下移
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
