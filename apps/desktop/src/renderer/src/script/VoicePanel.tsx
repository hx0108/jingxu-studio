import { useEffect, useState } from 'react';

import type {
  VoiceCandidateViewDto,
  VoiceEpisodeBatchViewDto,
  VoiceMappingDto,
} from '@jingxu/contracts';

import { createScriptRequestId, getScriptClient, getVoiceClient } from './script-api';
import { SKIP_REASON_LABELS, speakerLabel } from './video-timeline-ui';

interface VoicePanelProps {
  readonly episodeId: string;
  readonly projectId: string;
}

const formatError = (message: string): string => message || '操作失败，请重试。';

const candidateStatusBadge = (status: VoiceCandidateViewDto['status']): string | null => {
  if (status === 'STALE_INPUT') return '已过期（源分镜已变更）';
  if (status === 'FAILED') return '生成失败';
  if (status === 'PENDING') return '生成中';
  return null;
};

/**
 * 配音工作台（v2 §7.1）：音色映射编辑、整集批量生成、逐镜头候选选择与
 * 受限 URL 试听。全部经冻结 voice/script IPC；Renderer 不接触本地路径。
 */
export const VoicePanel = ({ episodeId, projectId }: VoicePanelProps) => {
  const [mappings, setMappings] = useState<VoiceMappingDto[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [shotIds, setShotIds] = useState<string[]>([]);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<VoiceCandidateViewDto[]>([]);
  const [batch, setBatch] = useState<VoiceEpisodeBatchViewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getVoiceClient()
        .getMappings({ projectId })
        .then((result) => {
          if (result.ok) {
            setMappings(result.data);
            setDrafts(Object.fromEntries(result.data.map((row) => [row.speakerId, row.voiceId])));
          }
        });
      void getScriptClient()
        .getWorkspace({ projectId })
        .then((snapshot) => {
          if (snapshot.ok && snapshot.data.storyboard.current !== null) {
            setShotIds(snapshot.data.storyboard.shots.map((shot) => shot.shotId));
          }
        });
    }, 0);
    // 仅随单集切换载入，避免批量结果被轮询覆盖。
    return () => {
      window.clearTimeout(timer);
    };
  }, [episodeId, projectId]);

  const openShot = async (shotId: string) => {
    setSelectedShotId(shotId);
    setNotice(null);
    const result = await getVoiceClient().getGenerations({ projectId, shotId });
    if (result.ok) setCandidates(result.data);
    else setNotice(formatError(result.error.message));
  };

  const saveMappings = async () => {
    setBusy(true);
    setNotice(null);
    const entries = Object.entries(drafts)
      .filter(([speakerId]) => mappings.some((row) => row.speakerId === speakerId))
      .map(([speakerId, voiceId]) => ({ speakerId, voiceId: voiceId.trim() }));
    const result = await getVoiceClient().saveMapping({
      mappings: entries,
      projectId,
      requestId: createScriptRequestId('voice-mapping-save'),
    });
    if (result.ok) {
      setMappings(result.data);
      setNotice('音色映射已保存。');
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  const generateEpisodeBatch = async () => {
    if (shotIds.length === 0) return;
    setBusy(true);
    setNotice(null);
    const result = await getVoiceClient().generateForEpisode({
      episodeId,
      projectId,
      requestId: createScriptRequestId('voice-batch-generate'),
      shotIds,
    });
    if (result.ok) {
      setBatch(result.data);
      setNotice(
        `整集配音批次已提交：目标 ${String(result.data.targetShotIds.length)} 个镜头，跳过 ${String(result.data.skippedShots.length)} 个。`,
      );
      if (selectedShotId !== null) await openShot(selectedShotId);
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  const chooseCandidate = async (candidateId: string) => {
    setBusy(true);
    setNotice(null);
    const result = await getVoiceClient().selectCandidate({
      candidateId,
      projectId,
      requestId: createScriptRequestId('voice-candidate-select'),
    });
    if (result.ok) {
      setCandidates(result.data);
      setNotice('已选择该配音候选。');
    } else {
      setNotice(formatError(result.error.message));
    }
    setBusy(false);
  };

  return (
    <section aria-labelledby="voice-panel-title" className="script-card">
      <header className="script-heading">
        <div>
          <p className="eyebrow">配音工作台</p>
          <h3 id="voice-panel-title">音色映射与台词音频</h3>
        </div>
      </header>
      <p className="action-hint">
        先保存角色音色映射，再发起整集批量生成；候选试听与选择按镜头进行，音色白名单在服务层校验。
      </p>
      {mappings.length > 0 && (
        <div aria-label="音色映射列表">
          {mappings.map((row) => (
            <div className="shot-card" key={row.speakerId}>
              <span>{speakerLabel(row.speakerId)}</span>
              <label>
                音色 ID
                <input
                  name={`voice-id-${row.speakerId}`}
                  onChange={(event) => {
                    setDrafts((current) => ({
                      ...current,
                      [row.speakerId]: event.target.value,
                    }));
                  }}
                  type="text"
                  value={drafts[row.speakerId] ?? row.voiceId}
                />
              </label>
            </div>
          ))}
          <div className="script-actions">
            <button
              disabled={busy}
              name="save-voice-mappings"
              onClick={() => void saveMappings()}
              type="button"
            >
              保存音色映射
            </button>
          </div>
        </div>
      )}
      <div className="script-actions">
        <button
          disabled={busy || shotIds.length === 0}
          name="generate-voice-batch"
          onClick={() => void generateEpisodeBatch()}
          type="button"
        >
          整集批量生成配音
        </button>
      </div>
      {batch !== null && (
        <p aria-live="polite" className="action-hint">
          批次 {batch.batchId}：目标镜头 {batch.targetShotIds.join('、') || '（无）'}
          {batch.skippedShots.map((skip) => (
            <span key={skip.shotId}>
              {' '}
              · 跳过 {skip.shotId}（{SKIP_REASON_LABELS[skip.reason] ?? skip.reason}）
            </span>
          ))}
        </p>
      )}
      {shotIds.length > 0 && (
        <label className="action-hint">
          选择镜头查看候选
          <select
            name="voice-shot-select"
            onChange={(event) => {
              const shotId = event.target.value;
              if (shotId !== '') void openShot(shotId);
            }}
            value={selectedShotId ?? ''}
          >
            <option value="">（选择镜头）</option>
            {shotIds.map((shotId) => (
              <option key={shotId} value={shotId}>
                {shotId}
              </option>
            ))}
          </select>
        </label>
      )}
      {notice !== null && (
        <p aria-live="polite" className="action-hint">
          {notice}
        </p>
      )}
      {candidates.length > 0 && (
        <ol aria-label="配音候选列表" className="shot-card-list">
          {candidates.map((candidate) => {
            const badge = candidateStatusBadge(candidate.status);
            return (
              <li key={candidate.id}>
                <div className="shot-card">
                  <span>
                    R{String(candidate.roundNo)}·#{String(candidate.indexInRound)} ·{' '}
                    {candidate.voiceId}
                    {badge !== null && <b>（{badge}）</b>}
                  </span>
                  {candidate.durationMs !== null && <span>{String(candidate.durationMs)} ms</span>}
                  {candidate.mediaUrl !== null && (
                    <audio
                      controls
                      src={candidate.mediaUrl}
                      aria-label={`候选 ${candidate.id} 试听`}
                    />
                  )}
                  <button
                    disabled={
                      busy || candidate.status !== 'SUCCEEDED' || candidate.selectedAt !== null
                    }
                    name={`select-voice-${candidate.id}`}
                    onClick={() => {
                      void chooseCandidate(candidate.id);
                    }}
                    type="button"
                  >
                    {candidate.selectedAt !== null ? '当前候选' : '选择'}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
};
