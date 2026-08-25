import { useMemo, useState } from 'react';

import type { AppErrorDto, ScriptWorkspaceDto } from '@jingxu/contracts';

import { createScriptRequestId, getScriptClient, rendererTransportError } from './script-api';
import { countUnicodeCharacters, isOriginalCreativeValid } from './script-ui-policy';

export interface OriginalInputProps {
  readonly projectId: string;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onInitialized: (workspace: ScriptWorkspaceDto) => void;
}

export const OriginalInput = ({ projectId, onDirtyChange, onInitialized }: OriginalInputProps) => {
  const [inputMode, setInputMode] = useState<'original' | 'existing'>('original');
  const [creativeText, setCreativeText] = useState('');
  const [creationMode, setCreationMode] = useState<'AI_OPTIMIZATION' | 'AUTHORIZED_ADAPTATION'>(
    'AI_OPTIMIZATION',
  );
  const [authorizationSource, setAuthorizationSource] = useState('');
  const [authorizationStatement, setAuthorizationStatement] = useState('');
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [pending, setPending] = useState(false);
  const characterCount = useMemo(() => countUnicodeCharacters(creativeText), [creativeText]);
  const valid =
    inputMode === 'original'
      ? isOriginalCreativeValid(creativeText)
      : characterCount >= 1 && characterCount <= 30_000 && creativeText.trim().length > 0;
  const authorizationReady =
    creationMode !== 'AUTHORIZED_ADAPTATION' ||
    (authorizationSource.trim() !== '' && authorizationStatement.trim() !== '');
  const submitHint = pending
    ? null
    : !valid
      ? inputMode === 'original'
        ? characterCount < 20
          ? `还需输入 ${String(20 - characterCount)} 个 Unicode 字符。`
          : '创意内容不能超过 2,000 个 Unicode 字符，且不能只有空白。'
        : characterCount === 0
          ? '请粘贴已有剧本，或使用系统文件选择器导入。'
          : '已有剧本不能超过 30,000 个 Unicode 字符，且不能只有空白。'
      : !consented
        ? '请先确认数据处理说明。'
        : !authorizationReady
          ? '授权改编必须填写授权来源和授权声明。'
          : null;

  const finish = (
    result: Awaited<ReturnType<ReturnType<typeof getScriptClient>['initializeInput']>>,
  ): void => {
    if (!result.ok) setError(result.error);
    else {
      onDirtyChange(false);
      onInitialized(result.data);
    }
  };

  return (
    <form
      className="script-card script-form"
      id="script-stage-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !consented || !authorizationReady || pending) return;
        setPending(true);
        setError(null);
        const request =
          inputMode === 'original'
            ? getScriptClient().initializeOriginal({
                creativeText,
                dataProcessingConsent: true,
                projectId,
                requestId: createScriptRequestId('script-initialize'),
              })
            : getScriptClient().initializeInput({
                authorizationSource:
                  creationMode === 'AUTHORIZED_ADAPTATION' ? authorizationSource.trim() : null,
                authorizationStatement:
                  creationMode === 'AUTHORIZED_ADAPTATION' ? authorizationStatement.trim() : null,
                content: creativeText,
                creationMode,
                dataProcessingConsent: true,
                fileName: null,
                inputKind: 'TXT',
                projectId,
                requestId: createScriptRequestId('script-initialize-existing'),
              });
        void request
          .then(finish)
          .catch(() => {
            setError(rendererTransportError());
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <p className="eyebrow">创作输入</p>
      <h2>{inputMode === 'original' ? '输入原创创意' : '导入已有剧本'}</h2>
      <div aria-label="输入方式" className="segmented-control">
        <button
          aria-pressed={inputMode === 'original'}
          className={inputMode === 'original' ? 'active' : ''}
          onClick={() => {
            setInputMode('original');
          }}
          type="button"
        >
          原创创意
        </button>
        <button
          aria-pressed={inputMode === 'existing'}
          className={inputMode === 'existing' ? 'active' : ''}
          onClick={() => {
            setInputMode('existing');
          }}
          type="button"
        >
          已有剧本
        </button>
      </div>
      <p>
        {inputMode === 'original'
          ? '用一句完整创意开始，系统将按阶段生成可编辑剧本。'
          : '可粘贴文本，或通过系统文件选择器导入 UTF-8 编码的 .txt/.md 文件。'}
      </p>
      {inputMode === 'existing' && (
        <>
          <label>
            使用方式
            <select
              onChange={(event) => {
                setCreationMode(event.target.value as typeof creationMode);
              }}
              value={creationMode}
            >
              <option value="AI_OPTIMIZATION">AI 优化</option>
              <option value="AUTHORIZED_ADAPTATION">授权改编</option>
            </select>
          </label>
          {creationMode === 'AUTHORIZED_ADAPTATION' && (
            <div className="form-grid">
              <label>
                授权来源
                <input
                  onChange={(event) => {
                    setAuthorizationSource(event.target.value);
                  }}
                  value={authorizationSource}
                />
              </label>
              <label>
                授权声明
                <textarea
                  onChange={(event) => {
                    setAuthorizationStatement(event.target.value);
                  }}
                  rows={3}
                  value={authorizationStatement}
                />
              </label>
            </div>
          )}
          <button
            className="secondary-button"
            disabled={!consented || !authorizationReady || pending}
            name="import-existing-script"
            onClick={() => {
              setPending(true);
              setError(null);
              void getScriptClient()
                .importInput({
                  authorizationSource:
                    creationMode === 'AUTHORIZED_ADAPTATION' ? authorizationSource.trim() : null,
                  authorizationStatement:
                    creationMode === 'AUTHORIZED_ADAPTATION' ? authorizationStatement.trim() : null,
                  creationMode,
                  dataProcessingConsent: true,
                  projectId,
                  requestId: createScriptRequestId('script-import-existing'),
                })
                .then(finish)
                .catch(() => {
                  setError(rendererTransportError());
                })
                .finally(() => {
                  setPending(false);
                });
            }}
            type="button"
          >
            选择 .txt/.md 文件
          </button>
        </>
      )}
      <label>
        {inputMode === 'original' ? '创意内容' : '剧本文本'}
        <textarea
          aria-describedby="creative-count"
          aria-invalid={!valid && creativeText !== ''}
          onChange={(event) => {
            setCreativeText(event.target.value);
            onDirtyChange(true);
          }}
          rows={10}
          value={creativeText}
        />
      </label>
      <p className={valid ? 'success-text' : 'action-hint'} id="creative-count">
        {characterCount}/{inputMode === 'original' ? '2,000（最少 20）' : '30,000'} 个 Unicode 字符
      </p>
      <label className="consent-row">
        <input
          checked={consented}
          onChange={(event) => {
            setConsented(event.target.checked);
            onDirtyChange(true);
          }}
          type="checkbox"
        />
        我确认将以上内容发送给已配置的第三方 Qwen 模型服务处理，并已阅读数据处理说明。
      </label>
      {error !== null && (
        <p className="field-error" role="alert">
          {error.code}：{error.message}。{error.userAction}
        </p>
      )}
      {submitHint !== null && (
        <p className="action-hint" id="creative-submit-hint" role="status">
          {submitHint}
        </p>
      )}
      <button
        aria-describedby={submitHint === null ? undefined : 'creative-submit-hint'}
        disabled={!valid || !consented || !authorizationReady || pending}
        title={submitHint ?? undefined}
        type="submit"
      >
        {pending ? '正在创建…' : '创建剧本工作区'}
      </button>
    </form>
  );
};
