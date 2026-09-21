import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';

// 与 Main 侧 IMAGE_CREDENTIAL_ID（register-image-features）同值镜像：图片密文按此固定 id 读写。
const IMAGE_PROFILE_ID = 'profile-image-agnes-primary';
// 与 Main 侧 IMAGE_SELECTABLE_MODELS（register-job-provider-features）同源镜像。
const IMAGE_MODELS = [
  { id: 'agnes-image-2.5-flash', label: 'Agnes Image 2.5 Flash' },
  { id: 'agnes-image-2.1-flash', label: 'Agnes Image 2.1 Flash' },
] as const;
const DEFAULT_IMAGE_MODEL_ID = 'agnes-image-2.5-flash';

interface ImageProviderCardViewProps {
  readonly apiKey: string;
  readonly error: AppErrorDto | null;
  readonly feedback: string;
  readonly modelId: string;
  readonly onApiKeyChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly onModelChange: (value: string) => void;
  readonly onModelSave: () => void;
  readonly onSave: () => void;
  readonly onTest: () => void;
  readonly pending: boolean;
  readonly profile: ProviderProfileDto | null;
}

export const ImageProviderCardView = ({
  apiKey,
  error,
  feedback,
  modelId,
  onApiKeyChange,
  onDelete,
  onModelChange,
  onModelSave,
  onSave,
  onTest,
  pending,
  profile,
}: ImageProviderCardViewProps) => (
  <details className="script-card model-service-card">
    <summary className="model-service-heading">
      <span aria-hidden="true" className="model-service-mark">
        图
      </span>
      <div>
        <p className="eyebrow">图片模型</p>
        <h2 id="image-provider-title">Agnes AI</h2>
      </div>
      <span
        className={`model-configuration-status${profile?.configured === true ? ' configured' : ''}`}
      >
        {profile?.configured === true ? '已配置' : '未配置'}
      </span>
      <span className="model-current-summary">
        <small>当前模型</small>
        <strong>{profile?.modelId ?? 'Agnes Image 2.5 Flash'}</strong>
      </span>
      <span className="model-credential-summary">
        <small>凭据</small>
        <strong>
          {profile?.configured === true
            ? `已安全保存 · 末四位 ${profile.last4 ?? '不可用'}`
            : '尚未保存'}
        </strong>
      </span>
      <span className="model-manage-label">管理配置</span>
    </summary>
    <div className="model-service-body" aria-labelledby="image-provider-title">
      <p>
        用于首帧图片生成（2026-09-21 起由火山方舟 Seedream 切换至 Agnes Image）。 保存 Agnes API Key
        并选择模型；完整 Key 不回显、不进入页面长期状态。
      </p>
      {error !== null && (
        <p className="field-error" role="alert">
          {error.code}：{error.message}
        </p>
      )}
      <label>
        模型
        <select
          disabled={pending}
          onChange={(event) => {
            onModelChange(event.target.value);
          }}
          value={modelId}
        >
          {IMAGE_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Agnes API Key
        <input
          autoComplete="new-password"
          onChange={(event) => {
            onApiKeyChange(event.target.value);
          }}
          type="password"
          value={apiKey}
        />
      </label>
      <div className="script-actions">
        <button
          disabled={pending || profile === null || modelId === profile.modelId}
          onClick={onModelSave}
          type="button"
        >
          保存模型选择
        </button>
        <button
          disabled={pending || profile === null || apiKey === ''}
          onClick={onSave}
          type="button"
        >
          保存凭据
        </button>
        <button disabled={pending || profile?.configured !== true} onClick={onTest} type="button">
          测试凭据
        </button>
        <button
          className="danger-button"
          disabled={pending || profile?.configured !== true}
          onClick={onDelete}
          type="button"
        >
          删除凭据
        </button>
      </div>
      <p aria-live="polite">
        {profile?.configured === true ? `已配置（末四位 ${profile.last4 ?? '不可用'}）` : '未配置'}
        {feedback === '' ? '' : ` · ${feedback}`}
      </p>
      <p className="action-hint">
        测试仅验证密文可解密读取，不发起计费请求；未配置时生成首帧会前置失败并提示。
        切换模型只影响新任务，在飞候选沿用建档时冻结的模型。
      </p>
    </div>
  </details>
);

export const ImageProviderCard = () => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState<string>(DEFAULT_IMAGE_MODEL_ID);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getProviderClient()
      .getProfile({ profileId: IMAGE_PROFILE_ID })
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError(result.error);
        else {
          setProfile(result.data);
          if (result.data.modelId !== '') {
            setModelId(result.data.modelId);
          }
        }
      })
      .catch(() => {
        if (active) setError(rendererTransportError());
      });
    return () => {
      active = false;
    };
  }, []);

  const apply = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    setPending(true);
    setError(null);
    setFeedback('正在处理…');
    try {
      const result = (await operation()) as
        | { readonly ok: true; readonly data: ProviderProfileDto }
        | { readonly ok: false; readonly error: AppErrorDto };
      if (!result.ok) {
        setError(result.error);
        setFeedback('');
        return false;
      }
      setProfile(result.data);
      setFeedback(success);
      return true;
    } catch {
      setError(rendererTransportError());
      setFeedback('');
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <ImageProviderCardView
      apiKey={apiKey}
      error={error}
      feedback={feedback}
      modelId={modelId}
      onApiKeyChange={setApiKey}
      onDelete={() => {
        if (profile === null || !globalThis.confirm('删除已保存的 Agnes 凭据？')) return;
        void apply(
          () =>
            getProviderClient().deleteCredential({
              expectedVersionId: profile.versionId,
              profileId: IMAGE_PROFILE_ID,
              requestId: createScriptRequestId('image-provider-delete'),
            }),
          '凭据已删除',
        );
      }}
      onModelChange={setModelId}
      onModelSave={() => {
        if (profile === null) return;
        void apply(
          () =>
            getProviderClient().saveProfile({
              enabled: profile.enabled,
              expectedVersionId: profile.versionId,
              modelId,
              profileId: IMAGE_PROFILE_ID,
              requestId: createScriptRequestId('image-provider-model'),
              workspaceId: profile.workspaceId,
            }),
          '图片模型已保存；新任务将使用该模型',
        );
      }}
      onSave={() => {
        if (profile === null) return;
        const credential = apiKey;
        setApiKey('');
        void apply(
          () =>
            getProviderClient().saveCredential({
              apiKey: credential,
              expectedVersionId: profile.versionId,
              profileId: IMAGE_PROFILE_ID,
              requestId: createScriptRequestId('image-provider-key'),
            }),
          '凭据已安全保存，可执行解密测试',
        );
      }}
      onTest={() => {
        if (profile === null) return;
        void apply(
          () =>
            getProviderClient().testCredential({
              expectedVersionId: profile.versionId,
              profileId: IMAGE_PROFILE_ID,
              requestId: createScriptRequestId('image-provider-test'),
            }),
          '密文可解密读取',
        );
      }}
      pending={pending}
      profile={profile}
    />
  );
};
