import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  EVALUATION_GUIDELINE_VERSION,
  type AppErrorDto,
  type EvaluationAnnotationLabelDto,
  type EvaluationAuthorization,
  type EvaluationDatasetSplit,
  type EvaluationExpectedDto,
  type EvaluationSampleDetailDto,
  type EvaluationSampleInputDto,
  type EvaluationSampleSummaryDto,
} from '@jingxu/contracts';

import { createRequestId } from '../project/project-api';
import { describeProjectError } from '../project/project-error';
import { getEvaluationClient } from './evaluation-api';

type EvaluationScope = 'ALL' | 'GLOBAL' | 'PROJECT';

export interface EvaluationWorkspaceProps {
  readonly projectId: string | null;
  readonly onBack: () => void;
}

const EMPTY_INPUT =
  '{\n  "candidate": { "kind": "SHOT_CONTRACT", "document": {} },\n  "context": {}\n}';
const EMPTY_EXPECTED =
  '{\n  "acceptable": false,\n  "expectedIssueCodes": [],\n  "referenceContract": null\n}';

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const ResultError = ({ error }: { readonly error: AppErrorDto }) => {
  const copy = describeProjectError(error);
  return (
    <section className="notice error-notice" role="alert">
      <h2>{copy.summary}</h2>
      <p>{copy.nextAction}</p>
      <small>追踪号：{copy.traceId}</small>
    </section>
  );
};

const sampleLabel = (sample: EvaluationSampleSummaryDto): string =>
  `${sample.sampleType} · ${sample.acceptable ? '可接受' : '问题样本'} · ${sample.datasetSplit}`;

/**
 * V1 评测集页面：所有内容读写经过 `evaluation` 白名单。手工输入保持 JSON 原文，
 * 提交前只做 JSON 解析；最终严格 DTO/业务规则仍在 Preload/Main/Application 依次校验。
 */
export const EvaluationWorkspace = ({ projectId, onBack }: EvaluationWorkspaceProps) => {
  const [scope, setScope] = useState<EvaluationScope>(projectId === null ? 'ALL' : 'PROJECT');
  const [samples, setSamples] = useState<readonly EvaluationSampleSummaryDto[]>([]);
  const [detail, setDetail] = useState<EvaluationSampleDetailDto | null>(null);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [dedupKey, setDedupKey] = useState('manual-sample-001');
  const [inputText, setInputText] = useState(EMPTY_INPUT);
  const [expectedText, setExpectedText] = useState(EMPTY_EXPECTED);
  const [authorization, setAuthorization] = useState<EvaluationAuthorization>('SYNTHETIC');
  const [datasetSplit, setDatasetSplit] = useState<EvaluationDatasetSplit>('TRAIN');
  const [deriveVersionId, setDeriveVersionId] = useState('');
  const [annotationRationale, setAnnotationRationale] = useState('');
  const [annotationVerdict, setAnnotationVerdict] =
    useState<EvaluationAnnotationLabelDto['verdict']>('PROBLEM');
  const [confirmDelete, setConfirmDelete] = useState<EvaluationSampleSummaryDto | null>(null);

  const filter = useMemo(
    () => ({
      scope,
      ...(scope === 'PROJECT' && projectId !== null ? { projectId } : {}),
    }),
    [projectId, scope],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await getEvaluationClient().listSamples(filter);
    if (result.ok) {
      setSamples(result.data.samples);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const showDetail = async (sampleId: string): Promise<void> => {
    setBusy(true);
    const result = await getEvaluationClient().getSample({ sampleId });
    if (result.ok) {
      setDetail(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  const createSample = async (): Promise<void> => {
    const input = safeJson(inputText) as EvaluationSampleInputDto | null;
    const expected = safeJson(expectedText) as EvaluationExpectedDto | null;
    if (input === null || expected === null) {
      setError({
        code: 'EVALUATION_SAMPLE_INVALID',
        fieldErrors: { json: '样本输入和期望结论必须是合法 JSON。' },
        message: 'JSON 无法解析',
        retryable: false,
        traceId: 'renderer_evaluation_json',
        userAction: '修正 JSON 后再保存。',
      });
      return;
    }
    setBusy(true);
    const result = await getEvaluationClient().createSample({
      authorization,
      datasetSplit,
      dedupKey,
      expected,
      input,
      ...(projectId === null ? {} : { projectId }),
    });
    if (result.ok) {
      setShowCreate(false);
      setError(null);
      await refresh();
      await showDetail(result.data.sampleId);
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  const deriveFromEpisode = async (): Promise<void> => {
    if (projectId === null || deriveVersionId.trim() === '') return;
    setBusy(true);
    const result = await getEvaluationClient().createFromEpisode({
      authorization,
      datasetSplit,
      expectedVersionId: deriveVersionId.trim(),
      projectId,
      requestId: createRequestId('evaluation-derive'),
    });
    if (result.ok) {
      setError(null);
      await refresh();
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  const importBatch = async (): Promise<void> => {
    setBusy(true);
    const result = await getEvaluationClient().importBatch({
      requestId: createRequestId('evaluation-import'),
    });
    if (result.ok) {
      setError(null);
      await refresh();
    } else if (result.error.code !== 'TRANSFER_FILE_CANCELLED') {
      setError(result.error);
    }
    setBusy(false);
  };

  const deleteSample = async (): Promise<void> => {
    if (confirmDelete === null) return;
    setBusy(true);
    const result = await getEvaluationClient().deleteSample({
      requestId: createRequestId('evaluation-delete'),
      sampleId: confirmDelete.sampleId,
    });
    if (result.ok) {
      if (detail?.sampleId === result.data.sampleId) setDetail(null);
      setConfirmDelete(null);
      setError(null);
      await refresh();
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  const addAnnotation = async (): Promise<void> => {
    if (detail === null || annotationRationale.trim() === '') return;
    setBusy(true);
    const result = await getEvaluationClient().addAnnotation({
      annotator: 'USER',
      guidelineVersion: EVALUATION_GUIDELINE_VERSION,
      label: { issueCodes: detail.hitCodes, severity: null, verdict: annotationVerdict },
      rationale: annotationRationale.trim(),
      requestId: createRequestId('evaluation-annotate'),
      sampleId: detail.sampleId,
    });
    if (result.ok) {
      setDetail({ ...detail, annotations: [...result.data.annotations] });
      setAnnotationRationale('');
      setError(null);
      await refresh();
    } else {
      setError(result.error);
    }
    setBusy(false);
  };

  return (
    <section className="evaluation-workspace" aria-labelledby="evaluation-title">
      <header className="script-heading">
        <div>
          <p className="eyebrow">EVALUATION SET</p>
          <h2 id="evaluation-title">结构化分镜评测集</h2>
          <p>规则版本：{EVALUATION_GUIDELINE_VERSION}。样本必须注明授权状态；种子包含正反例。</p>
        </div>
        <button className="secondary-button" onClick={onBack} type="button">
          返回项目
        </button>
      </header>

      {error !== null && <ResultError error={error} />}

      <div className="evaluation-toolbar" role="group" aria-label="评测集范围">
        {(['ALL', 'GLOBAL', 'PROJECT'] as const).map((candidate) => (
          <button
            className={scope === candidate ? 'active-tab' : 'secondary-button'}
            disabled={candidate === 'PROJECT' && projectId === null}
            key={candidate}
            onClick={() => {
              setScope(candidate);
              setDetail(null);
            }}
            type="button"
          >
            {candidate === 'ALL' ? '全部样本' : candidate === 'GLOBAL' ? '全局样本' : '当前项目'}
          </button>
        ))}
        <button disabled={busy} onClick={() => void importBatch()} type="button">
          导入 JSON 样本
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setShowCreate((visible) => !visible);
          }}
          type="button"
        >
          {showCreate ? '收起手工创建' : '创建样本'}
        </button>
      </div>

      {projectId !== null && (
        <section className="script-card" aria-labelledby="derive-title">
          <h3 id="derive-title">从当前已确认分镜派生</h3>
          <p>输入剧本工作区显示的当前整集版本标识；未确认或版本已变化会被主进程拒绝。</p>
          <div className="form-actions">
            <label>
              整集版本 ID
              <input
                onChange={(event) => {
                  setDeriveVersionId(event.target.value);
                }}
                value={deriveVersionId}
              />
            </label>
            <button
              disabled={busy || deriveVersionId.trim() === ''}
              onClick={() => void deriveFromEpisode()}
              type="button"
            >
              派生当前项目样本
            </button>
          </div>
        </section>
      )}

      {showCreate && (
        <section
          className="script-card evaluation-create"
          aria-labelledby="evaluation-create-title"
        >
          <h3 id="evaluation-create-title">手工创建评测样本</h3>
          <div className="form-grid">
            <label>
              去重键
              <input
                onChange={(event) => {
                  setDedupKey(event.target.value);
                }}
                value={dedupKey}
              />
            </label>
            <label>
              授权状态
              <select
                onChange={(event) => {
                  setAuthorization(event.target.value as EvaluationAuthorization);
                }}
                value={authorization}
              >
                <option value="SYNTHETIC">SYNTHETIC（合成）</option>
                <option value="AUTHORIZED">AUTHORIZED（已授权）</option>
                <option value="PUBLIC_DOMAIN">PUBLIC_DOMAIN（公版）</option>
              </select>
            </label>
            <label>
              数据拆分
              <select
                onChange={(event) => {
                  setDatasetSplit(event.target.value as EvaluationDatasetSplit);
                }}
                value={datasetSplit}
              >
                <option value="TRAIN">Development</option>
                <option value="VALIDATION">Validation</option>
                <option value="TEST">Holdout</option>
              </select>
            </label>
          </div>
          <label>
            样本输入 JSON
            <textarea
              onChange={(event) => {
                setInputText(event.target.value);
              }}
              rows={10}
              value={inputText}
            />
          </label>
          <label>
            期望结论 JSON
            <textarea
              onChange={(event) => {
                setExpectedText(event.target.value);
              }}
              rows={8}
              value={expectedText}
            />
          </label>
          <button disabled={busy} onClick={() => void createSample()} type="button">
            保存并运行确定性规则
          </button>
        </section>
      )}

      <div className="evaluation-layout">
        <section className="script-card" aria-labelledby="evaluation-list-title">
          <h3 id="evaluation-list-title">样本列表（{String(samples.length)}）</h3>
          {loading ? (
            <p aria-live="polite">正在加载评测样本…</p>
          ) : samples.length === 0 ? (
            <p className="action-hint">
              暂无样本。创建一个合成正例或问题样本，也可从 READY 分镜派生。
            </p>
          ) : (
            <ul className="version-list evaluation-list">
              {samples.map((sample) => (
                <li key={sample.sampleId}>
                  <button onClick={() => void showDetail(sample.sampleId)} type="button">
                    {sampleLabel(sample)}
                  </button>
                  <small>
                    {sample.hitCodes.length === 0 ? '规则无命中' : sample.hitCodes.join('、')}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="script-card" aria-labelledby="evaluation-detail-title">
          <h3 id="evaluation-detail-title">样本详情</h3>
          {detail === null ? (
            <p className="action-hint">选择一个样本查看规则命中和不可变标注历史。</p>
          ) : (
            <>
              <p>{sampleLabel(detail)}</p>
              <p>规则：{detail.ruleVersion}</p>
              <ul className="evaluation-hits">
                {detail.hits.length === 0 ? (
                  <li>无规则命中</li>
                ) : (
                  detail.hits.map((hit) => (
                    <li key={`${hit.code}:${hit.path ?? ''}`}>
                      {hit.code}：{hit.detail}
                    </li>
                  ))
                )}
              </ul>
              <h4>人工标注历史</h4>
              <ul className="evaluation-hits">
                {detail.annotations.length === 0 ? (
                  <li>尚无人工标注</li>
                ) : (
                  detail.annotations.map((annotation) => (
                    <li key={annotation.id}>
                      {annotation.label.verdict} · {annotation.annotator} · {annotation.rationale}
                    </li>
                  ))
                )}
              </ul>
              <label>
                标注结论
                <select
                  onChange={(event) => {
                    setAnnotationVerdict(
                      event.target.value as EvaluationAnnotationLabelDto['verdict'],
                    );
                  }}
                  value={annotationVerdict}
                >
                  <option value="PROBLEM">问题</option>
                  <option value="ACCEPTABLE">可接受</option>
                </select>
              </label>
              <label>
                标注依据
                <textarea
                  onChange={(event) => {
                    setAnnotationRationale(event.target.value);
                  }}
                  placeholder="说明判断依据（必填）"
                  rows={4}
                  value={annotationRationale}
                />
              </label>
              <div className="form-actions">
                <button
                  disabled={busy || annotationRationale.trim() === ''}
                  onClick={() => void addAnnotation()}
                  type="button"
                >
                  追加标注
                </button>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDelete(detail);
                  }}
                  type="button"
                >
                  删除样本
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {confirmDelete !== null && (
        <section
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="evaluation-delete-title"
        >
          <div className="confirmation-dialog">
            <h2 id="evaluation-delete-title">确认删除评测样本？</h2>
            <p>此操作会删除样本及其标注历史，并写入审计记录；该操作不可撤销。</p>
            <div className="dialog-actions">
              <button
                onClick={() => {
                  setConfirmDelete(null);
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void deleteSample()}
                type="button"
              >
                确认删除
              </button>
            </div>
          </div>
        </section>
      )}
    </section>
  );
};
