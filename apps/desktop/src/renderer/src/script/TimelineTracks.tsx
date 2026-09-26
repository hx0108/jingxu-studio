import {
  videoAudioAssetMediaUrl,
  videoCandidateMediaUrl,
  voiceCandidateMediaUrl,
} from '@jingxu/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { PROTOTYPE_ASSETS, prototypeAssetAt } from '../assets/prototype/prototype-assets';
import type { TimelineDraft, TimelineDraftAction } from './timeline-draft';

interface TimelineTracksProps {
  readonly draft: TimelineDraft;
  readonly isDemo?: boolean;
  readonly onAction: (action: TimelineDraftAction) => void;
  readonly overviewAside?: ReactNode;
}

interface TimelineDrag {
  readonly clipId: string;
  readonly kind: 'video' | 'voice';
  readonly laneLeft: number;
  readonly laneWidth: number;
  readonly targetStartMs: number;
}

const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} 秒`;

/** 只编辑内存草稿；版本保存和导出由父组件显式提交。 */
export const TimelineTracks = ({
  draft,
  isDemo = false,
  onAction,
  overviewAside,
}: TimelineTracksProps) => {
  const { current, playheadMs, selectedClipId } = draft;
  const selected = current.items.find((clip) => clip.clipId === selectedClipId);
  const selectedVoice = current.voiceItems.find((clip) => clip.clipId === selectedClipId);
  const [isPlaying, setIsPlaying] = useState(false);
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  const dragRef = useRef<TimelineDrag | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const voiceRef = useRef<HTMLAudioElement>(null);
  const backgroundMusicRef = useRef<HTMLAudioElement>(null);
  const totalMs = Math.max(
    1000,
    ...current.items.map((clip) => clip.targetStartMs + clip.trimOutMs - clip.trimInMs),
    ...current.voiceItems.map((clip) => clip.targetStartMs + clip.trimOutMs - clip.trimInMs),
    current.totalDurationMs,
  );
  const position = (milliseconds: number) =>
    `${String(Math.min(100, (milliseconds / totalMs) * 100))}%`;
  const width = (milliseconds: number) => `${String(Math.max(1, (milliseconds / totalMs) * 100))}%`;
  const activeVideo = useMemo(
    () =>
      current.items.find(
        (clip) =>
          clip.enabled &&
          playheadMs >= clip.targetStartMs &&
          playheadMs < clip.targetStartMs + clip.trimOutMs - clip.trimInMs,
      ) ?? selected,
    [current.items, playheadMs, selected],
  );
  const activeVoice = useMemo(
    () =>
      current.voiceItems.find(
        (clip) =>
          clip.enabled &&
          playheadMs >= clip.targetStartMs &&
          playheadMs < clip.targetStartMs + clip.trimOutMs - clip.trimInMs,
      ),
    [current.voiceItems, playheadMs],
  );
  const demoPreview =
    isDemo && activeVideo !== undefined
      ? activeVideo.position === 1
        ? PROTOTYPE_ASSETS.heroineMain
        : prototypeAssetAt(PROTOTYPE_ASSETS.shots, activeVideo.position)
      : undefined;

  useEffect(() => {
    if (!isPlaying) return undefined;
    const timer = window.setInterval(() => {
      const next = playheadMs + 100;
      if (next >= totalMs) {
        onAction({ type: 'seek', timeMs: totalMs });
        setIsPlaying(false);
      } else onAction({ type: 'seek', timeMs: next });
    }, 100);
    return () => {
      window.clearInterval(timer);
    };
  }, [isPlaying, onAction, playheadMs, totalMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null && activeVideo !== undefined) {
      video.currentTime = Math.max(
        0,
        (activeVideo.trimInMs + playheadMs - activeVideo.targetStartMs) / 1000,
      );
      if (isPlaying) void video.play().catch(() => undefined);
      else video.pause();
    }
    const voice = voiceRef.current;
    if (voice !== null && activeVoice !== undefined) {
      voice.currentTime = Math.max(
        0,
        (activeVoice.trimInMs + playheadMs - activeVoice.targetStartMs) / 1000,
      );
      voice.volume = activeVoice.volume;
      voice.muted = current.voiceTrackMuted;
      if (isPlaying) void voice.play().catch(() => undefined);
      else voice.pause();
    }
    const backgroundMusic = backgroundMusicRef.current;
    if (backgroundMusic !== null) {
      backgroundMusic.currentTime = Math.max(
        0,
        (current.bgmTrimInMs + playheadMs - current.bgmStartMs) / 1000,
      );
      backgroundMusic.volume = current.audioVolume;
      backgroundMusic.muted = current.bgmMuted || playheadMs < current.bgmStartMs;
      if (isPlaying && playheadMs >= current.bgmStartMs)
        void backgroundMusic.play().catch(() => undefined);
      else backgroundMusic.pause();
    }
  }, [
    activeVideo,
    activeVoice,
    current.audioVolume,
    current.bgmMuted,
    current.bgmStartMs,
    current.bgmTrimInMs,
    current.voiceTrackMuted,
    isPlaying,
    playheadMs,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      if (event.code === 'Space') {
        event.preventDefault();
        setIsPlaying((value) => !value);
        return;
      }
      if (event.key === 'Delete' && selectedClipId !== null) {
        event.preventDefault();
        onAction({
          type: selectedVoice === undefined ? 'delete-video' : 'delete-voice',
          clipId: selectedClipId,
        });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        onAction({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        onAction({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onAction, selectedClipId, selectedVoice]);

  const updateDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    clipId: string,
    kind: 'video' | 'voice',
  ) => {
    if (dragRef.current?.clipId !== clipId) return;
    const lane = event.currentTarget.parentElement;
    if (lane === null) return;
    const bounds = lane.getBoundingClientRect();
    const ratio = bounds.width === 0 ? 0 : (event.clientX - bounds.left) / bounds.width;
    const nextDrag: TimelineDrag = {
      clipId,
      kind,
      laneLeft: bounds.left,
      laneWidth: bounds.width,
      targetStartMs: Math.max(0, Math.round((ratio * totalMs) / 100) * 100),
    };
    dragRef.current = nextDrag;
    setDrag(nextDrag);
  };

  const commitDrag = () => {
    const currentDrag = dragRef.current;
    if (currentDrag === null) return;
    onAction({
      type: currentDrag.kind === 'video' ? 'move-video' : 'move-voice',
      clipId: currentDrag.clipId,
      targetStartMs: currentDrag.targetStartMs,
    });
    dragRef.current = null;
    setDrag(null);
  };

  useEffect(() => {
    const moveDrag = (event: PointerEvent) => {
      const currentDrag = dragRef.current;
      if (currentDrag === null) return;
      const ratio =
        currentDrag.laneWidth === 0
          ? 0
          : (event.clientX - currentDrag.laneLeft) / currentDrag.laneWidth;
      const nextDrag: TimelineDrag = {
        ...currentDrag,
        targetStartMs: Math.max(0, Math.round((ratio * totalMs) / 100) * 100),
      };
      dragRef.current = nextDrag;
      setDrag(nextDrag);
    };
    const finishDrag = () => {
      const currentDrag = dragRef.current;
      if (currentDrag === null) return;
      onAction({
        type: currentDrag.kind === 'video' ? 'move-video' : 'move-voice',
        clipId: currentDrag.clipId,
        targetStartMs: currentDrag.targetStartMs,
      });
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', finishDrag);
    return () => {
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', finishDrag);
    };
  }, [onAction, totalMs]);

  return (
    <section aria-label="可剪辑时间线" className="composition-editor">
      <div className="composition-editor-toolbar">
        <strong>剪辑时间线</strong>
        <span>
          工作预览 · {seconds(playheadMs)} / {seconds(totalMs)}
        </span>
        <button
          onClick={() => {
            setIsPlaying((value) => !value);
          }}
          type="button"
        >
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button
          disabled={draft.undo.length === 0}
          onClick={() => {
            onAction({ type: 'undo' });
          }}
          type="button"
        >
          撤销
        </button>
        <button
          disabled={draft.redo.length === 0}
          onClick={() => {
            onAction({ type: 'redo' });
          }}
          type="button"
        >
          重做
        </button>
        {draft.dirty && <span className="composition-dirty">有未保存修改</span>}
      </div>
      <div className="composition-overview">
        <div className="composition-preview-column">
          <div className="composition-work-preview">
            {activeVideo === undefined ? (
              <p>选择画面片段，预览和调整剪辑属性。</p>
            ) : (
              <>
                {demoPreview === undefined ? (
                  <video
                    aria-label="当前片段工作预览"
                    muted
                    ref={videoRef}
                    src={videoCandidateMediaUrl(activeVideo.candidateId)}
                  />
                ) : (
                  <img alt="演示时间线工作预览" src={demoPreview} />
                )}
                {activeVoice !== undefined && (
                  <audio ref={voiceRef} src={voiceCandidateMediaUrl(activeVoice.candidateId)} />
                )}
                {current.audioAsset !== null && (
                  <audio
                    ref={backgroundMusicRef}
                    src={videoAudioAssetMediaUrl(current.audioAsset.id)}
                  />
                )}
                <small>
                  {isDemo
                    ? '演示封面用于剪辑定位；模拟候选、选择记录与时间线版本仍可追溯。'
                    : '工作预览用于剪辑定位；最终音画以保存后的本地合成为准。'}
                </small>
              </>
            )}
          </div>
          <label className="composition-seek">
            播放头
            <input
              aria-label="播放头位置"
              max={totalMs}
              min={0}
              onChange={(event) => {
                onAction({ type: 'seek', timeMs: Number(event.target.value) });
              }}
              step={100}
              type="range"
              value={playheadMs}
            />
          </label>
        </div>
        {overviewAside}
      </div>
      <div className="composition-time-ruler" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index}>{seconds((totalMs * index) / 4)}</span>
        ))}
      </div>
      <div className="composition-track" role="group" aria-label="画面轨">
        <span className="composition-track-label">画面轨</span>
        <div className="composition-track-lane">
          {current.items.map((clip) => (
            <button
              aria-label={`画面片段 ${String(clip.position + 1)}，${seconds(clip.targetStartMs)} 开始`}
              aria-pressed={selectedClipId === clip.clipId}
              className={`composition-clip composition-clip-video${selectedClipId === clip.clipId ? ' is-selected' : ''}`}
              key={clip.clipId}
              onClick={() => {
                onAction({ type: 'select', clipId: clip.clipId });
              }}
              onPointerDown={(event) => {
                const laneBounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (laneBounds === undefined) return;
                const nextDrag: TimelineDrag = {
                  clipId: clip.clipId,
                  kind: 'video',
                  laneLeft: laneBounds.left,
                  laneWidth: laneBounds.width,
                  targetStartMs: clip.targetStartMs,
                };
                dragRef.current = nextDrag;
                setDrag(nextDrag);
              }}
              onPointerMove={(event) => {
                updateDrag(event, clip.clipId, 'video');
              }}
              onPointerUp={commitDrag}
              style={{
                left: position(
                  drag?.clipId === clip.clipId ? drag.targetStartMs : clip.targetStartMs,
                ),
                width: width(clip.trimOutMs - clip.trimInMs),
              }}
              type="button"
            >
              {String(clip.position + 1)} · {seconds(clip.trimOutMs - clip.trimInMs)}
            </button>
          ))}
        </div>
      </div>
      <div className="composition-track" role="group" aria-label="对白轨">
        <span className="composition-track-label">对白轨</span>
        <div className="composition-track-lane">
          {current.voiceItems.map((clip, index) => (
            <button
              aria-label={`对白片段 ${String(index + 1)}，${seconds(clip.targetStartMs)} 开始`}
              aria-pressed={selectedClipId === clip.clipId}
              className={`composition-clip composition-clip-voice${selectedClipId === clip.clipId ? ' is-selected' : ''}`}
              key={clip.clipId}
              onClick={() => {
                onAction({ type: 'select', clipId: clip.clipId });
              }}
              onPointerDown={(event) => {
                const laneBounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (laneBounds === undefined) return;
                const nextDrag: TimelineDrag = {
                  clipId: clip.clipId,
                  kind: 'voice',
                  laneLeft: laneBounds.left,
                  laneWidth: laneBounds.width,
                  targetStartMs: clip.targetStartMs,
                };
                dragRef.current = nextDrag;
                setDrag(nextDrag);
              }}
              onPointerMove={(event) => {
                updateDrag(event, clip.clipId, 'voice');
              }}
              onPointerUp={commitDrag}
              style={{
                left: position(
                  drag?.clipId === clip.clipId ? drag.targetStartMs : clip.targetStartMs,
                ),
                width: width(clip.trimOutMs - clip.trimInMs),
              }}
              type="button"
            >
              对白 {String(index + 1)}
            </button>
          ))}
        </div>
      </div>
      <div className="composition-track" role="group" aria-label="配乐轨">
        <span className="composition-track-label">配乐轨</span>
        <div className="composition-track-lane">
          {current.audioAsset !== null && (
            <span
              className="composition-bgm-clip"
              style={{
                left: position(current.bgmStartMs),
                width: width(Math.max(100, totalMs - current.bgmStartMs)),
              }}
            >
              已导入配乐
            </span>
          )}
        </div>
      </div>
      <div className="composition-inspector">
        {selected !== undefined && (
          <>
            <strong>画面片段属性</strong>
            <label>
              起点（毫秒）
              <input
                min={0}
                onChange={(event) => {
                  onAction({
                    type: 'move-video',
                    clipId: selected.clipId,
                    targetStartMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selected.targetStartMs}
              />
            </label>
            <label>
              素材入点（毫秒）
              <input
                min={0}
                onChange={(event) => {
                  onAction({
                    type: 'trim-video',
                    clipId: selected.clipId,
                    trimInMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selected.trimInMs}
              />
            </label>
            <label>
              素材出点（毫秒）
              <input
                min={100}
                onChange={(event) => {
                  onAction({
                    type: 'trim-video',
                    clipId: selected.clipId,
                    trimOutMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selected.trimOutMs}
              />
            </label>
            <label>
              启用画面
              <input
                checked={selected.enabled}
                onChange={(event) => {
                  onAction({
                    type: 'set-video-enabled',
                    clipId: selected.clipId,
                    enabled: event.target.checked,
                  });
                }}
                type="checkbox"
              />
            </label>
            <button
              onClick={() => {
                onAction({
                  type: 'split-video',
                  clipId: selected.clipId,
                  newClipId: `clip_${crypto.randomUUID()}`,
                  atMs: playheadMs,
                });
              }}
              type="button"
            >
              在播放头处分割
            </button>
            <button
              onClick={() => {
                onAction({
                  type: 'copy-video',
                  clipId: selected.clipId,
                  newClipId: `clip_${crypto.randomUUID()}`,
                  targetStartMs: totalMs,
                });
              }}
              type="button"
            >
              复制到末尾
            </button>
            <button
              onClick={() => {
                onAction({ type: 'delete-video', clipId: selected.clipId });
              }}
              type="button"
            >
              删除片段
            </button>
          </>
        )}
        {selectedVoice !== undefined && (
          <>
            <strong>对白片段属性</strong>
            <label>
              起点（毫秒）
              <input
                min={0}
                onChange={(event) => {
                  onAction({
                    type: 'move-voice',
                    clipId: selectedVoice.clipId,
                    targetStartMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selectedVoice.targetStartMs}
              />
            </label>
            <label>
              素材入点（毫秒）
              <input
                min={0}
                onChange={(event) => {
                  onAction({
                    type: 'trim-voice',
                    clipId: selectedVoice.clipId,
                    trimInMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selectedVoice.trimInMs}
              />
            </label>
            <label>
              素材出点（毫秒）
              <input
                min={100}
                onChange={(event) => {
                  onAction({
                    type: 'trim-voice',
                    clipId: selectedVoice.clipId,
                    trimOutMs: Number(event.target.value),
                  });
                }}
                step={100}
                type="number"
                value={selectedVoice.trimOutMs}
              />
            </label>
            <label>
              音量
              <input
                max={1}
                min={0}
                onChange={(event) => {
                  onAction({
                    type: 'set-voice',
                    clipId: selectedVoice.clipId,
                    patch: { volume: Number(event.target.value) },
                  });
                }}
                step={0.05}
                type="number"
                value={selectedVoice.volume}
              />
            </label>
            <label>
              启用对白
              <input
                checked={selectedVoice.enabled}
                onChange={(event) => {
                  onAction({
                    type: 'set-voice',
                    clipId: selectedVoice.clipId,
                    patch: { enabled: event.target.checked },
                  });
                }}
                type="checkbox"
              />
            </label>
            <button
              onClick={() => {
                onAction({ type: 'delete-voice', clipId: selectedVoice.clipId });
              }}
              type="button"
            >
              删除对白片段
            </button>
          </>
        )}
        <strong>配乐设置</strong>
        <label>
          配乐静音
          <input
            checked={current.bgmMuted}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { bgmMuted: event.target.checked } });
            }}
            type="checkbox"
          />
        </label>
        <label>
          对白轨静音
          <input
            checked={current.voiceTrackMuted}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { voiceTrackMuted: event.target.checked } });
            }}
            type="checkbox"
          />
        </label>
        <label>
          配乐起点（毫秒）
          <input
            min={0}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { bgmStartMs: Number(event.target.value) } });
            }}
            step={100}
            type="number"
            value={current.bgmStartMs}
          />
        </label>
        <label>
          配乐音量
          <input
            max={1}
            min={0}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { audioVolume: Number(event.target.value) } });
            }}
            step={0.05}
            type="number"
            value={current.audioVolume}
          />
        </label>
        <label>
          配乐入点（毫秒）
          <input
            min={0}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { bgmTrimInMs: Number(event.target.value) } });
            }}
            step={100}
            type="number"
            value={current.bgmTrimInMs}
          />
        </label>
        <label>
          配乐出点（毫秒，0 表示跟随成片）
          <input
            min={0}
            onChange={(event) => {
              onAction({
                type: 'set-bgm',
                patch: {
                  bgmTrimOutMs:
                    Number(event.target.value) === 0 ? null : Number(event.target.value),
                },
              });
            }}
            step={100}
            type="number"
            value={current.bgmTrimOutMs ?? 0}
          />
        </label>
        <label>
          淡入（毫秒）
          <input
            min={0}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { bgmFadeInMs: Number(event.target.value) } });
            }}
            step={100}
            type="number"
            value={current.bgmFadeInMs}
          />
        </label>
        <label>
          淡出（毫秒）
          <input
            min={0}
            onChange={(event) => {
              onAction({ type: 'set-bgm', patch: { bgmFadeOutMs: Number(event.target.value) } });
            }}
            step={100}
            type="number"
            value={current.bgmFadeOutMs}
          />
        </label>
      </div>
    </section>
  );
};
