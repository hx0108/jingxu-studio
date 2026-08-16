import { useState } from 'react';

import type {
  JobSummaryDto,
  StoryboardShotSummaryDto,
  StoryboardVersionSummaryDto,
  StoryboardWorkspaceDto,
} from '@jingxu/contracts';

import { FirstFramePanel } from './FirstFramePanel';
import { isTerminalJob } from './script-ui-policy';

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

export interface StoryboardPanelProps {
  readonly episodeTargetDurationSec: number;
  /** 首帧面板按 projectId 定界媒体通道调用。 */
  readonly projectId: string;
  /** null 表示当前可生成；否则为不可生成的原因（同时禁用按钮）。 */
  readonly generateHint: string | null;
  readonly job: JobSummaryDto | null;
  readonly onConfirm: () => void;
  readonly onGenerate: () => void;
  readonly onRestore: (version: StoryboardVersionSummaryDto) => void;
  readonly pending: boolean;
  readonly storyboard: StoryboardWorkspaceDto;
}

export const StoryboardPanel = ({
  episodeTargetDurationSec,
  generateHint,
  job,
  onConfirm,
  onGenerate,
  onRestore,
  pending,
  projectId,
  storyboard,
}: StoryboardPanelProps) => {
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const selectedShot =
    storyboard.shots.find((shot) => shot.shotId === selectedShotId) ?? storyboard.shots[0] ?? null;
  const current = storyboard.current;
  const totalDurationSec = storyboard.totalDurationSec;
  const durationOverLimit = totalDurationSec > episodeTargetDurationSec;
  const jobActive = job !== null && !isTerminalJob(job);

  return (
    <section className="script-card" id="storyboard-panel">
      <header className="script-heading">
        <div>
          <p className="eyebrow">SHOT_CONTRACT</p>
          <h2>分镜工作台</h2>
        </div>
        <span
          className={`status-badge status-${current === null ? 'empty' : current.status.toLowerCase()}`}
        >
          {current === null ? '○ 未生成' : `● ${current.status}`}
        </span>
      </header>
      <p className="action-hint">
        分镜为只读展示：由生成与确认产生整集版本，不支持编辑、拆分、合并、排序或删除。
      </p>
      {current?.status === 'STALE_INPUT' && (
        <p className="field-error">上游已变化，当前分镜仅供查看；请重新生成。</p>
      )}
      <div aria-label="整集时长汇总" className="duration-summary">
        <p>
          镜头时长合计 {String(totalDurationSec)}s / 目标 {String(episodeTargetDurationSec)}s ·{' '}
          {String(storyboard.shots.length)} 个镜头
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
          确认为 READY
        </button>
      </div>
      {generateHint !== null && <p className="action-hint">{generateHint}</p>}
      {job !== null && (
        <p aria-live="polite">
          任务状态：{job.status}
          {job.errorCode === null ? '' : ` · ${job.errorCode}`}
        </p>
      )}
      {job?.status === 'FAILED' && job.errorCode !== null && (
        <p className="field-error">
          {STORYBOARD_JOB_ERROR_COPY[job.errorCode] ?? '分镜任务失败；可重试或重新生成。'}
        </p>
      )}
      {storyboard.shots.length === 0 ? (
        <p>尚未生成分镜。上游场景剧本确认 READY 后可生成整集分镜。</p>
      ) : (
        <ul className="shot-card-list">
          {storyboard.shots.map((shot) => (
            <li key={shot.shotId}>
              <button
                aria-current={selectedShot?.shotId === shot.shotId ? 'true' : undefined}
                className={
                  selectedShot?.shotId === shot.shotId ? 'active-tab shot-card' : 'shot-card'
                }
                onClick={() => {
                  setSelectedShotId(shot.shotId);
                }}
                type="button"
              >
                <span>#{String(shot.sequence)}</span>
                <span>
                  {SHOT_SIZE_LABELS[shot.shotSize]} · {CAMERA_MOTION_LABELS[shot.cameraMotion]}
                </span>
                <span>
                  {String(shot.targetDurationSec)}s ·{' '}
                  {DIALOGUE_RENDER_LABELS[shot.dialogueRenderMode]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedShot !== null && (
        <section aria-labelledby="shot-detail-title" className="shot-detail">
          <h3 id="shot-detail-title">镜头 #{String(selectedShot.sequence)} 详情</h3>
          <dl>
            <div>
              <dt>镜头 ID</dt>
              <dd>{selectedShot.shotId}</dd>
            </div>
            <div>
              <dt>叙事目的</dt>
              <dd>{selectedShot.narrativePurpose}</dd>
            </div>
            <div>
              <dt>景别</dt>
              <dd>
                {SHOT_SIZE_LABELS[selectedShot.shotSize]}（{selectedShot.shotSize}）
              </dd>
            </div>
            <div>
              <dt>运机</dt>
              <dd>
                {CAMERA_MOTION_LABELS[selectedShot.cameraMotion]}（{selectedShot.cameraMotion}）
              </dd>
            </div>
            <div>
              <dt>台词渲染</dt>
              <dd>
                {DIALOGUE_RENDER_LABELS[selectedShot.dialogueRenderMode]}（
                {selectedShot.dialogueRenderMode}）
              </dd>
            </div>
            <div>
              <dt>目标时长</dt>
              <dd>{String(selectedShot.targetDurationSec)}s</dd>
            </div>
            <div>
              <dt>镜头版本</dt>
              <dd>{selectedShot.versionId}</dd>
            </div>
          </dl>
          <FirstFramePanel
            key={selectedShot.shotId}
            projectId={projectId}
            shot={selectedShot}
            storyboardStatus={current?.status ?? null}
          />
        </section>
      )}
      <section aria-labelledby="storyboard-history-title">
        <h3 id="storyboard-history-title">分镜历史</h3>
        {storyboard.history.length === 0 ? (
          <p>暂无历史整集版本。</p>
        ) : (
          <ul className="version-list">
            {storyboard.history.map((entry) => (
              <li key={entry.id}>
                <span>
                  v{String(entry.versionNo)} · {entry.status} · {String(entry.shotCount)} 个镜头
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
      </section>
    </section>
  );
};
