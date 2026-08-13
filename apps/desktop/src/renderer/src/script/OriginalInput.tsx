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
  const [creativeText, setCreativeText] = useState('');
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [pending, setPending] = useState(false);
  const characterCount = useMemo(() => countUnicodeCharacters(creativeText), [creativeText]);
  const valid = isOriginalCreativeValid(creativeText);

  return (
    <form
      className="script-card script-form"
      id="script-stage-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !consented || pending) return;
        setPending(true);
        setError(null);
        void getScriptClient()
          .initializeOriginal({
            creativeText,
            dataProcessingConsent: true,
            projectId,
            requestId: createScriptRequestId('script-initialize'),
          })
          .then((result) => {
            if (!result.ok) setError(result.error);
            else {
              onDirtyChange(false);
              onInitialized(result.data);
            }
          })
          .catch(() => {
            setError(rendererTransportError());
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <p className="eyebrow">AI ORIGINAL</p>
      <h2>输入原创创意</h2>
      <p>首轮仅支持 AI 原创。文件导入、授权改编和 AI 优化尚未开放。</p>
      <label>
        创意内容
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
        {characterCount}/2,000 个 Unicode 字符（最少 20 个）
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
        我确认将以上内容发送给已配置的第三方 Qwen Provider 处理。
      </label>
      {error !== null && (
        <p className="field-error" role="alert">
          {error.code}：{error.message}。{error.userAction}
        </p>
      )}
      <button disabled={!valid || !consented || pending} type="submit">
        {pending ? '正在初始化…' : '创建剧本工作区'}
      </button>
    </form>
  );
};
