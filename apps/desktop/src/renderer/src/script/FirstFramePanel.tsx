import { useEffect, useRef, useState } from 'react';

import type {
  AppErrorDto,
  ImageCandidateViewDto,
  MediaTaskViewDto,
  StaleAffectedShotDto,
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
} from '@jingxu/contracts';

import { describeProjectError } from '../project/project-error';
import {
  CANDIDATE_STATUS_LABELS,
  candidateImageSrc,
  groupCandidatesByGeneration,
  isSelectableCandidate,
  isTerminalMediaTaskPhase,
  validateReferenceFile,
} from './first-frame-policy';
import { createScriptRequestId, getImageClient, rendererTransportError } from './script-api';

/**
 * 分镜工作区逐镜头首帧面板（shot-first-frame-image-generation 任务 5.3）。
 *
 * 按输入世代分组展示候选、当前世代内比较与人工选择/切换、历史世代 STALE 只读
 * 追溯、资产参考图上传与受影响镜头清单。图片仅经 jingxu://media 受限协议引用；
 * 错误只按稳定 code 映射文案，不展示基础设施 message。
 */

export interface FirstFramePanelProps {
  readonly projectId: string;
  readonly shot: StoryboardShotSummaryDto;
  /** 分镜当前整集状态；仅 READY 集合内的镜头可发起生成。 */
  readonly storyboardStatus: StoryboardVersionSummaryDto['status'] | null;
}

/** 世代分组的候选看板（纯展示，供静态标记测试）。 */
export interface FirstFrameBoardProps {
  readonly busy: boolean;
  readonly candidates: readonly ImageCandidateViewDto[];
  readonly onSelect: (candidate: ImageCandidateViewDto) => void;
  readonly pendingCandidateId: string | null;
}

export const FirstFrameBoard = ({
  busy,
  candidates,
  onSelect,
  pendingCandidateId,
}: FirstFrameBoardProps) => {
  const groups = groupCandidatesByGeneration(candidates);
  if (candidates.length === 0) {
    return <p className="action-hint">该镜头尚未生成首帧候选。</p>;
  }
  return (
    <>
      {groups.map((group) => (
        <section
          aria-label={
            group.stale
              ? `历史输入世代 ${group.generationInputHash.slice(0, 8)}`
              : `当前输入世代 ${group.generationInputHash.slice(0, 8)}`
          }
          className="candidate-generation"
          key={group.generationInputHash}
        >
          <h4>
            {group.stale ? '历史输入世代（输入已变化，仅供追溯）' : '当前输入世代'} · 世代{' '}
            {group.generationInputHash.slice(0, 8)} · 第{' '}
            {group.rounds.map((round) => String(round)).join('、')} 轮
          </h4>
          <ul className="candidate-grid">
            {group.candidates.map((candidate) => {
              const imageSrc = candidateImageSrc(candidate);
              const selectable = !group.stale && isSelectableCandidate(candidate);
              return (
                <li
                  className={group.stale ? 'candidate-card candidate-stale' : 'candidate-card'}
                  key={candidate.id}
                >
                  {imageSrc === null ? (
                    <div className="candidate-placeholder">尚未出图</div>
                  ) : (
                    <img alt={`候选 ${candidate.id} 首帧图`} src={imageSrc} />
                  )}
                  <span className={`status-badge status-${candidate.status.toLowerCase()}`}>
                    {CANDIDATE_STATUS_LABELS[candidate.status]}
                    {candidate.status === 'FAILED' && candidate.errorCode !== null
                      ? ` · ${candidate.errorCode}`
                      : ''}
                  </span>
                  <small>
                    第 {String(candidate.roundNo)} 轮 · 第 {String(candidate.indexInRound + 1)} 张 ·{' '}
                    {candidate.byteSize === null ? '—' : `${String(candidate.byteSize)} 字节`}
                  </small>
                  {candidate.selectedAt !== null && (
                    <span className="selection-badge">
                      {group.stale ? '当前选择（已失效）' : '当前首帧'}
                    </span>
                  )}
                  {selectable && candidate.selectedAt === null && (
                    <button
                      className="secondary-button"
                      disabled={busy || pendingCandidateId !== null}
                      name={`select-candidate-${candidate.id}`}
                      onClick={() => {
                        onSelect(candidate);
                      }}
                      type="button"
                    >
                      {pendingCandidateId === candidate.id ? '切换中…' : '设为当前首帧'}
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

export interface ReferenceUploadInput {
  readonly assetType: 'CHARACTER' | 'SCENE';
  readonly bibleRefId: string;
  readonly displayName: string;
  readonly file: File;
}

/** 资产参考图上传表单（纯展示，供静态标记测试）。 */
export interface FirstFrameUploadFormProps {
  readonly busy: boolean;
  readonly onSubmit: (input: ReferenceUploadInput) => void;
}

export const FirstFrameUploadForm = ({ busy, onSubmit }: FirstFrameUploadFormProps) => {
  const [assetType, setAssetType] = useState<'CHARACTER' | 'SCENE'>('SCENE');
  const [bibleRefId, setBibleRefId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <form
      className="script-form"
      id="reference-upload-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || file === null) return;
        const picked = fileInput.current?.files?.[0] ?? file;
        const invalid = validateReferenceFile(picked);
        if (invalid !== null) {
          setFileError(invalid);
          return;
        }
        setFileError(null);
        onSubmit({
          assetType,
          bibleRefId: bibleRefId.trim(),
          displayName: displayName.trim(),
          file: picked,
        });
      }}
    >
      <label>
        资产类型
        <select
          onChange={(event) => {
            setAssetType(event.target.value === 'CHARACTER' ? 'CHARACTER' : 'SCENE');
          }}
          value={assetType}
        >
          <option value="SCENE">场景</option>
          <option value="CHARACTER">角色</option>
        </select>
      </label>
      <label>
        圣经引用 ID（char_*/scene_*）
        <input
          onChange={(event) => {
            setBibleRefId(event.target.value);
          }}
          placeholder="scene_train"
          value={bibleRefId}
        />
      </label>
      <label>
        资产显示名称
        <input
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
          placeholder="午夜列车"
          value={displayName}
        />
      </label>
      <label>
        参考图（≤20MB PNG/JPEG/WebP）
        <input
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setFileError(null);
          }}
          ref={fileInput}
          type="file"
        />
      </label>
      {fileError !== null && <p className="field-error">{fileError}</p>}
      <div className="script-actions">
        <button disabled={busy || file === null} type="submit">
          {busy ? '上传中…' : '上传参考图'}
        </button>
      </div>
    </form>
  );
};

export const FirstFramePanel = ({ projectId, shot, storyboardStatus }: FirstFramePanelProps) => {
  const [candidates, setCandidates] = useState<readonly ImageCandidateViewDto[] | null>(null);
  const [task, setTask] = useState<MediaTaskViewDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadOutcome, setUploadOutcome] = useState<{
    affectedShots: readonly StaleAffectedShotDto[];
    versionNo: number;
  } | null>(null);

  const loadCandidates = (): Promise<void> =>
    getImageClient()
      .listCandidates({ projectId, shotId: shot.shotId })
      .then((result) => {
        if (result.ok) {
          setCandidates(result.data);
          setError(null);
        } else setError(result.error);
      })
      .catch(() => {
        setError(rendererTransportError());
      });

  // 挂载即加载候选；切换镜头由父级以 key 重挂载整面板，状态天然归零。
  useEffect(() => {
    void loadCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskActive = task !== null && !isTerminalMediaTaskPhase(task.phase);

  // 媒体任务轮询：终态即刷新候选（沿用剧本任务轮询节奏与可见性守卫）。
  useEffect(() => {
    if (task === null || isTerminalMediaTaskPhase(task.phase)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void poll(), 1_000);
        return;
      }
      const result = await getImageClient().getMediaTask({ projectId, taskId: task.id });
      if (!active) return;
      if (result.ok) {
        setTask(result.data);
        if (isTerminalMediaTaskPhase(result.data.phase)) {
          await loadCandidates();
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

  const generate = (): void => {
    if (taskActive) return;
    setError(null);
    void getImageClient()
      .generateCandidates({
        projectId,
        requestId: createScriptRequestId('image-generate'),
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

  const select = (candidate: ImageCandidateViewDto): void => {
    if (pendingCandidateId !== null) return;
    setPendingCandidateId(candidate.id);
    setError(null);
    void getImageClient()
      .selectCandidate({
        candidateId: candidate.id,
        projectId,
        requestId: createScriptRequestId('image-select'),
      })
      .then((result) => {
        if (result.ok) {
          setCandidates(result.data);
          setError(null);
        } else setError(result.error);
      })
      .catch(() => {
        setError(rendererTransportError());
      })
      .finally(() => {
        setPendingCandidateId(null);
      });
  };

  const upload = (input: ReferenceUploadInput): void => {
    setUploadBusy(true);
    setError(null);
    void input.file
      .arrayBuffer()
      .then((buffer) =>
        getImageClient().uploadAssetReference({
          assetType: input.assetType,
          bibleRefId: input.bibleRefId,
          byteSize: input.file.size,
          bytes: new Uint8Array(buffer),
          description: null,
          displayName: input.displayName,
          mimeType: input.file.type as 'image/png' | 'image/jpeg' | 'image/webp',
          projectId,
          requestId: createScriptRequestId('image-upload'),
        }),
      )
      .then((result) => {
        if (result.ok) {
          setUploadOutcome({
            affectedShots: result.data.affectedShots,
            versionNo: result.data.version.versionNo,
          });
          return loadCandidates();
        }
        setError(result.error);
        return undefined;
      })
      .catch(() => {
        setError(rendererTransportError());
      })
      .finally(() => {
        setUploadBusy(false);
      });
  };

  const generateDisabled = storyboardStatus !== 'READY' || taskActive;
  const generateHint =
    storyboardStatus === null
      ? '分镜尚未生成；生成整集分镜并确认 READY 后可生成首帧。'
      : storyboardStatus !== 'READY'
        ? '分镜整集未确认 READY；确认后才能为镜头生成首帧。'
        : taskActive
          ? '媒体任务运行中，完成后可再次生成新一轮。'
          : null;
  const errorView = error === null ? null : describeProjectError(error);

  return (
    <section
      aria-labelledby="first-frame-title"
      className="first-frame-panel"
      id="first-frame-panel"
    >
      <h3 id="first-frame-title">首帧候选 · 镜头 #{String(shot.sequence)}</h3>
      {errorView !== null && (
        <p className="field-error" role="alert">
          {errorView.summary}。{errorView.nextAction}
        </p>
      )}
      <div className="script-actions">
        <button
          disabled={generateDisabled}
          name="generate-first-frame"
          onClick={generate}
          type="button"
        >
          生成首帧候选
        </button>
      </div>
      {generateHint !== null && <p className="action-hint">{generateHint}</p>}
      {task !== null && (
        <p aria-live="polite">
          任务状态：{task.phase}
          {task.errorCode === null ? '' : ` · ${task.errorCode}`}
        </p>
      )}
      {candidates === null ? (
        <p aria-live="polite">正在加载首帧候选…</p>
      ) : (
        <FirstFrameBoard
          busy={taskActive}
          candidates={candidates}
          onSelect={select}
          pendingCandidateId={pendingCandidateId}
        />
      )}
      <section aria-labelledby="reference-upload-title">
        <h4 id="reference-upload-title">资产参考图上传（升版将使旧输入世代候选失效）</h4>
        <FirstFrameUploadForm busy={uploadBusy} onSubmit={upload} />
        {uploadOutcome !== null && (
          <div aria-live="polite" className="upload-outcome">
            <p>参考图已上传为版本 v{String(uploadOutcome.versionNo)}。</p>
            {uploadOutcome.affectedShots.length === 0 ? (
              <p>本次升版未影响任何镜头的既有候选。</p>
            ) : (
              <>
                <p>受影响镜头（候选已标记失效，需重新生成）：</p>
                <ul className="affected-shot-list">
                  {uploadOutcome.affectedShots.map((affected) => (
                    <li key={affected.shotId}>
                      {affected.shotId}（{String(affected.candidateCount)} 张候选）
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    </section>
  );
};
