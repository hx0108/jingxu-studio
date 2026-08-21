import { useEffect, useRef, useState } from 'react';

import type {
  AppErrorDto,
  ImageCandidateViewDto,
  MediaTaskViewDto,
  ShotVideoStateDto,
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
  VideoCandidateViewDto,
} from '@jingxu/contracts';

import { describeProjectError } from '../project/project-error';
import { candidateImageSrc, isTerminalMediaTaskPhase } from './first-frame-policy';
import {
  candidateVideoSrc,
  groupVideoCandidatesByGeneration,
  isSelectableVideoCandidate,
  VIDEO_CANDIDATE_STATUS_LABELS,
} from './video-panel-policy';
import {
  createScriptRequestId,
  getImageClient,
  getVideoClient,
  rendererTransportError,
} from './script-api';
import { shotVideoGenerationBusy } from './storyboard-video-state-policy';

/** 视频候选比较板：当前输入世代可选择，STALE 世代仅供播放追溯。 */
export interface VideoBoardProps {
  readonly busy: boolean;
  readonly candidates: readonly VideoCandidateViewDto[];
  readonly onSelect: (candidate: VideoCandidateViewDto) => void;
  readonly pendingCandidateId: string | null;
}

export const VideoBoard = ({ busy, candidates, onSelect, pendingCandidateId }: VideoBoardProps) => {
  const groups = groupVideoCandidatesByGeneration(candidates);
  if (candidates.length === 0) return <p className="action-hint">该镜头尚未生成视频候选。</p>;
  return (
    <>
      {groups.map((group) => (
        <section
          aria-label={
            group.stale
              ? `历史视频输入世代 ${group.generationInputHash.slice(0, 8)}`
              : `当前视频输入世代 ${group.generationInputHash.slice(0, 8)}`
          }
          className="candidate-generation"
          key={group.generationInputHash}
        >
          <h4>
            {group.stale ? '历史视频输入世代（输入已变化，仅供追溯）' : '当前视频输入世代'} · 世代{' '}
            {group.generationInputHash.slice(0, 8)} · 第{' '}
            {group.rounds.map((round) => String(round)).join('、')} 轮
          </h4>
          <ul className="candidate-grid">
            {group.candidates.map((candidate) => {
              const videoSrc = candidateVideoSrc(candidate);
              const selectable = !group.stale && isSelectableVideoCandidate(candidate);
              return (
                <li
                  className={group.stale ? 'candidate-card candidate-stale' : 'candidate-card'}
                  key={candidate.id}
                >
                  {videoSrc === null ? (
                    <div className="candidate-placeholder">尚未出视频</div>
                  ) : (
                    <video
                      aria-label={`候选 ${candidate.id} 视频段`}
                      controls
                      preload="metadata"
                      src={videoSrc}
                    />
                  )}
                  <span className={`status-badge status-${candidate.status.toLowerCase()}`}>
                    {VIDEO_CANDIDATE_STATUS_LABELS[candidate.status]}
                    {candidate.status === 'FAILED' && candidate.errorCode !== null
                      ? ` · ${candidate.errorCode}`
                      : ''}
                  </span>
                  <small>
                    第 {String(candidate.roundNo)} 轮 · 候选 {String(candidate.indexInRound + 1)} ·
                    请求 {String(candidate.requestedDurationSec)}s · 实际{' '}
                    {candidate.actualDurationSec === null
                      ? '未回报'
                      : `${String(candidate.actualDurationSec)}s`}
                  </small>
                  {candidate.selectedAt !== null && (
                    <span className="selection-badge">
                      {group.stale ? '当前选择（已失效）' : '当前视频段'}
                    </span>
                  )}
                  {selectable && candidate.selectedAt === null && (
                    <button
                      className="secondary-button"
                      disabled={busy || pendingCandidateId !== null}
                      name={`select-video-candidate-${candidate.id}`}
                      onClick={() => {
                        onSelect(candidate);
                      }}
                      type="button"
                    >
                      {pendingCandidateId === candidate.id ? '切换中…' : '设为当前视频段'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
};

export interface VideoPanelProps {
  readonly projectId: string;
  readonly shot: StoryboardShotSummaryDto;
  readonly storyboardStatus: StoryboardVersionSummaryDto['status'] | null;
  readonly videoState: ShotVideoStateDto | null;
}

/**
 * 逐镜头视频面板：仅将已选首帧作为图生视频输入锚点；首帧与视频均使用
 * jingxu://media 受限 URL，Renderer 不取得路径、mp4 字节或 Provider 原始响应。
 */
export const VideoPanel = ({ projectId, shot, storyboardStatus, videoState }: VideoPanelProps) => {
  const [candidates, setCandidates] = useState<readonly VideoCandidateViewDto[] | null>(null);
  const [selectedFirstFrame, setSelectedFirstFrame] = useState<ImageCandidateViewDto | null>(null);
  const [task, setTask] = useState<MediaTaskViewDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(null);

  const load = (): Promise<void> =>
    Promise.all([
      getVideoClient().listVideoCandidates({ projectId, shotId: shot.shotId }),
      getImageClient().listCandidates({ projectId, shotId: shot.shotId }),
    ])
      .then(([videoResult, imageResult]) => {
        if (!videoResult.ok) {
          setError(videoResult.error);
          return;
        }
        if (!imageResult.ok) {
          setError(imageResult.error);
          return;
        }
        setCandidates(videoResult.data);
        setSelectedFirstFrame(
          imageResult.data.find((candidate) => candidate.selectedAt !== null) ?? null,
        );
        setError(null);
      })
      .catch(() => {
        setError(rendererTransportError());
      });

  useEffect(() => {
    void load();
    // 父级以 shotId 作为 key 重挂载，切镜头时局部状态自然归零。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskActive = task !== null && !isTerminalMediaTaskPhase(task.phase);
  const videoBusy = taskActive || shotVideoGenerationBusy(videoState);
  useEffect(() => {
    if (task === null || isTerminalMediaTaskPhase(task.phase)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 1_000);
        return;
      }
      const result = await getVideoClient().getVideoTask({ projectId, taskId: task.id });
      if (!active) return;
      if (result.ok) {
        setTask(result.data);
        if (isTerminalMediaTaskPhase(result.data.phase)) {
          await load();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, task]);

  const succeededSeen = useRef<number | null>(null);
  useEffect(() => {
    const succeededCount = videoState?.currentGenSucceededCount ?? null;
    if (
      succeededCount !== null &&
      succeededSeen.current !== null &&
      succeededCount > succeededSeen.current
    ) {
      void load();
    }
    succeededSeen.current = succeededCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoState?.currentGenSucceededCount]);

  const generate = (): void => {
    if (videoBusy || selectedFirstFrame === null) return;
    setError(null);
    void getVideoClient()
      .generateVideoCandidates({
        projectId,
        requestId: createScriptRequestId('video-generate'),
        shotId: shot.shotId,
      })
      .then((result) => {
        if (result.ok) setTask(result.data);
        else setError(result.error);
      })
      .catch(() => {
        setError(rendererTransportError());
      });
  };

  const select = (candidate: VideoCandidateViewDto): void => {
    if (pendingCandidateId !== null) return;
    setPendingCandidateId(candidate.id);
    setError(null);
    void getVideoClient()
      .selectVideoCandidate({
        candidateId: candidate.id,
        projectId,
        requestId: createScriptRequestId('video-select'),
      })
      .then((result) => {
        if (result.ok) setCandidates(result.data);
        else setError(result.error);
      })
      .catch(() => {
        setError(rendererTransportError());
      })
      .finally(() => {
        setPendingCandidateId(null);
      });
  };

  const disabled = storyboardStatus !== 'READY' || selectedFirstFrame === null || videoBusy;
  const hint =
    storyboardStatus === null
      ? '分镜尚未生成；确认 READY 后可生成视频段。'
      : storyboardStatus !== 'READY'
        ? '分镜整集未确认 READY；确认后才能生成视频段。'
        : selectedFirstFrame === null
          ? '请先在首帧候选中选择一张当前首帧，再发起图生视频。'
          : videoState?.queuedInBatchId !== null
            ? '该镜头已在视频批次队列中，将按顺序自动生成。'
            : videoBusy
              ? '视频任务运行中，完成后可再次生成新一轮。'
              : null;
  const errorView = error === null ? null : describeProjectError(error);

  return (
    <section aria-labelledby="video-panel-title" className="video-panel" id="video-panel">
      <h3 id="video-panel-title">视频候选 · 镜头 #{String(shot.sequence)}</h3>
      {errorView !== null && (
        <p className="field-error" role="alert">
          {errorView.summary}。{errorView.nextAction}
        </p>
      )}
      <div className="selected-first-frame-preview">
        <h4>图生视频首帧</h4>
        {selectedFirstFrame === null ? (
          <p className="action-hint">尚未选择首帧。</p>
        ) : (
          <img alt="已选首帧缩略图" src={candidateImageSrc(selectedFirstFrame) ?? undefined} />
        )}
      </div>
      <div className="script-actions">
        <button disabled={disabled} name="generate-video" onClick={generate} type="button">
          生成视频候选
        </button>
      </div>
      {hint !== null && <p className="action-hint">{hint}</p>}
      {task !== null && (
        <p aria-live="polite">
          视频任务状态：{task.phase}
          {task.errorCode === null ? '' : ` · ${task.errorCode}`}
        </p>
      )}
      {candidates === null ? (
        <p aria-live="polite">正在加载视频候选…</p>
      ) : (
        <VideoBoard
          busy={taskActive}
          candidates={candidates}
          onSelect={select}
          pendingCandidateId={pendingCandidateId}
        />
      )}
    </section>
  );
};
