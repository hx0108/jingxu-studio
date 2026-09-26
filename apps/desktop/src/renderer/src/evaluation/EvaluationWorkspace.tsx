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
import { PROTOTYPE_ASSETS, prototypeAssetAt } from '../assets/prototype/prototype-assets';
import { getEvaluationClient } from './evaluation-api';

type EvaluationScope = 'ALL' | 'GLOBAL' | 'PROJECT';

export interface EvaluationWorkspaceProps {
  readonly isDemo?: boolean;
  readonly projectId: string | null;
  readonly projectTitle?: string | null;
  readonly projectType?: '漫剧' | '短剧';
  readonly onBack: () => void;
  readonly onOpenStoryboard?: () => void;
}

const DEMO_SHOT_TITLES = [
  '列车出发',
  '窗边的她',
  '车厢对话',
  '陌生的陪伴',
  '窗外的风景',
  '新的启程',
] as const;

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

const SAMPLE_TYPE_LABELS: Readonly<Record<EvaluationSampleSummaryDto['sampleType'], string>> = {
  EPISODE_STORYBOARD: '整集分镜',
  SCRIPT_STAGE: '剧本阶段',
  SHOT_CONTRACT: '单镜头分镜',
};

const DATASET_SPLIT_LABELS: Readonly<Record<EvaluationDatasetSplit, string>> = {
  TEST: '最终检验集',
  TRAIN: '开发集',
  VALIDATION: '验证集',
};

const sampleLabel = (sample: EvaluationSampleSummaryDto): string =>
  `${SAMPLE_TYPE_LABELS[sample.sampleType]} · ${sample.acceptable ? '可接受' : '问题样本'} · ${DATASET_SPLIT_LABELS[sample.datasetSplit]}`;

/**
 * V1 评测集页面：所有内容读写经过 `evaluation` 白名单。手工输入保持 JSON 原文，
 * 提交前只做 JSON 解析；最终严格 DTO/业务规则仍在 Preload/Main/Application 依次校验。
 */
export const EvaluationWorkspace = ({
  isDemo = false,
  projectId,
  projectTitle = null,
  projectType = '短剧',
  onBack,
  onOpenStoryboard,
}: EvaluationWorkspaceProps) => {
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
  const [previewShot, setPreviewShot] = useState(2);
  const [contentFilter, setContentFilter] = useState<'全部' | '漫剧' | '短剧'>(projectType);

  const demoVisible = isDemo && (contentFilter === '全部' || contentFilter === projectType);
  const selectedShotTitle = DEMO_SHOT_TITLES[previewShot - 1] ?? `镜头 ${String(previewShot)}`;
  const previousShotIndex = previewShot <= 1 ? 0 : previewShot - 2;
  const selectAdjacentShot = (direction: -1 | 1): void => {
    setPreviewShot((current) => {
      const total = PROTOTYPE_ASSETS.shots.length;
      return ((current - 1 + direction + total) % total) + 1;
    });
  };

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
        fieldErrors: { json: '样本输入和期望结论必须是合法的结构化内容。' },
        message: '结构化内容无法解析',
        retryable: false,
        traceId: 'renderer_evaluation_json',
        userAction: '修正结构化内容后再保存。',
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
      <div className="evaluation-top-row">
        <button className="evaluation-back-button" onClick={onBack} type="button">
          ← 返回我的作品
        </button>
        <small>规则版本：第 1 版</small>
      </div>

      <header className="evaluation-overview">
        <div className="evaluation-intro">
          <div className="evaluation-title-line">
            <h2 id="evaluation-title">质量评测</h2>
            <p>检查内容基于漫剧、短剧创作要点，帮助你发现常见问题，供修改参考。</p>
          </div>
          <div aria-label="作品类型筛选" className="evaluation-type-filter" role="group">
            {(['全部', '漫剧', '短剧'] as const).map((type) => (
              <button
                aria-pressed={contentFilter === type}
                className={contentFilter === type ? 'active' : ''}
                key={type}
                onClick={() => {
                  setContentFilter(type);
                }}
                type="button"
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {projectId !== null && (
          <section className="evaluation-project-summary" aria-label="当前作品检查进度">
            <img alt="" src={prototypeAssetAt(PROTOTYPE_ASSETS.shots, 1)} />
            <div>
              <div className="evaluation-project-heading">
                <strong>《{projectTitle ?? '未命名作品'}》</strong>
                {isDemo && <span>演示数据</span>}
              </div>
              <p>共 6 个镜头　|　已检查 5 / 6 个镜头</p>
              <progress aria-label="镜头检查进度" max={6} value={5} />
            </div>
          </section>
        )}
      </header>

      {error !== null && <ResultError error={error} />}

      {!isDemo && (
        <p className="action-hint" role="status">
          当前项目没有可展示的逐镜头检查结果。可在下方管理评测样本和人工标注；不会用示例画面替代真实作品。
        </p>
      )}

      {demoVisible && (
        <div className="approved-evaluation-layout">
          <aside className="approved-evaluation-shots">
            <h2>镜头列表（6）</h2>
            {PROTOTYPE_ASSETS.shots.map((asset, index) => {
              const shotNumber = index + 1;
              const status = shotNumber === 2 ? '需调整' : shotNumber === 6 ? '未检查' : '通过';
              return (
                <button
                  aria-current={previewShot === shotNumber ? 'true' : undefined}
                  key={asset}
                  onClick={() => {
                    setPreviewShot(shotNumber);
                  }}
                  type="button"
                >
                  <span>{String(shotNumber)}</span>
                  <img alt="" src={asset} />
                  <span>
                    <strong>{DEMO_SHOT_TITLES[index] ?? `镜头 ${String(shotNumber)}`}</strong>
                    <small>15秒</small>
                  </span>
                  <em
                    className={
                      status === '通过' ? 'status-ok' : status === '需调整' ? 'status-warn' : ''
                    }
                  >
                    {status}
                  </em>
                </button>
              );
            })}
          </aside>
          <section className="approved-evaluation-preview">
            <header className="evaluation-preview-heading">
              <button
                aria-label="上一个镜头"
                onClick={() => {
                  selectAdjacentShot(-1);
                }}
                type="button"
              >
                ←
              </button>
              <h2>
                镜头 {String(previewShot)} / 6　 {selectedShotTitle}　 <small>15秒</small>
              </h2>
              <button
                aria-label="下一个镜头"
                onClick={() => {
                  selectAdjacentShot(1);
                }}
                type="button"
              >
                →
              </button>
            </header>
            <img
              alt={`镜头 ${String(previewShot)} 预览`}
              src={
                previewShot === 2
                  ? PROTOTYPE_ASSETS.heroineMain
                  : prototypeAssetAt(PROTOTYPE_ASSETS.shots, previewShot - 1)
              }
            />
            <div className="evaluation-preview-control" aria-label="镜头静态预览进度">
              <span>静态预览</span>
              <span>00:00 / 00:15</span>
              <progress max={15} value={0} />
              <span>15秒</span>
            </div>
            <h3>镜头信息</h3>
            <dl>
              <div>
                <dt>画面内容</dt>
                <dd>女主角坐在列车上看向窗外，神情安静。</dd>
              </div>
              <div>
                <dt>场景</dt>
                <dd>列车车厢 · 窗边</dd>
              </div>
              <div>
                <dt>主要角色</dt>
                <dd>女主角</dd>
              </div>
              <div>
                <dt>台词</dt>
                <dd>{previewShot === 2 ? '（无对话）' : '列车继续驶向远方。'}</dd>
              </div>
            </dl>
          </section>
          <aside className="approved-evaluation-results">
            <header className="evaluation-results-heading">
              <h2>检查结果（{projectType}）</h2>
              <small>基于{projectType}常见问题进行检查</small>
            </header>
            <>
              <details>
                <summary>
                  <span className="status-ok">通过</span>
                  <strong>人物与服装连续</strong>
                </summary>
                <p>人物外观与前后镜头保持一致。</p>
                <small>未发现明显问题</small>
              </details>
              <details open>
                <summary>
                  <span className="status-warn">需调整</span>
                  <strong>场景与光线连续</strong>
                </summary>
                <p>本镜头的光线与上一个镜头存在变化，跳变较明显，可能影响观看连贯性。</p>
                <div className="evaluation-shot-comparison">
                  <figure>
                    <img
                      alt="上一个镜头"
                      src={prototypeAssetAt(PROTOTYPE_ASSETS.shots, previousShotIndex)}
                    />
                    <figcaption>上一个镜头</figcaption>
                  </figure>
                  <span aria-hidden="true">→</span>
                  <figure>
                    <img
                      alt="当前镜头"
                      src={prototypeAssetAt(PROTOTYPE_ASSETS.shots, previewShot - 1)}
                    />
                    <figcaption>当前镜头</figcaption>
                  </figure>
                </div>
                <button
                  disabled={onOpenStoryboard === undefined}
                  onClick={onOpenStoryboard}
                  type="button"
                >
                  返回镜头修改
                </button>
              </details>
              <details>
                <summary>
                  <span className="status-ok">通过</span>
                  <strong>画面与台词一致</strong>
                </summary>
                <p>画面内容与剧本表达一致。</p>
                <small>未发现明显问题</small>
              </details>
            </>
            <button
              className="approved-evaluation-next"
              onClick={() => {
                setPreviewShot((shot) => (shot === PROTOTYPE_ASSETS.shots.length ? 1 : shot + 1));
              }}
              type="button"
            >
              检查下一个镜头
            </button>
          </aside>
        </div>
      )}

      {isDemo && !demoVisible && (
        <section className="evaluation-filter-empty" role="status">
          <h2>当前类型没有演示作品</h2>
          <p>切换到“全部”或“{projectType}”查看当前作品的检查结果。</p>
        </section>
      )}

      <details className="evaluation-dataset-details">
        <summary>
          <span className="evaluation-report-copy">
            <strong>完成评测并生成报告</strong>
            <small>请先完成所有镜头的检查后生成报告</small>
          </span>
          <span className="evaluation-report-lock">当前有镜头未检查</span>
        </summary>

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
            导入样本文件
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
                整集版本标识
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
                  <option value="SYNTHETIC">合成内容</option>
                  <option value="AUTHORIZED">已授权内容</option>
                  <option value="PUBLIC_DOMAIN">公版内容</option>
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
                  <option value="TRAIN">开发集</option>
                  <option value="VALIDATION">验证集</option>
                  <option value="TEST">最终检验集</option>
                </select>
              </label>
            </div>
            <label>
              样本输入（结构化内容）
              <textarea
                onChange={(event) => {
                  setInputText(event.target.value);
                }}
                rows={10}
                value={inputText}
              />
            </label>
            <label>
              期望结论（结构化内容）
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
                暂无样本。创建一个合成正例或问题样本，也可从已确认分镜派生。
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
      </details>

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
