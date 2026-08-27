import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';

// 与 Main 侧 VIDEO_CREDENTIAL_ID（register-video-features）同值镜像：视频密文按此固定 id 读写。
const VIDEO_PROFILE_ID = 'profile-video-primary';
const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance-2.0-mini' },
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance-2.0' },
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance-2.5' },
] as const;

interface VideoProviderCardViewProps {
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

export const VideoProviderCardView = ({
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
}: VideoProviderCardViewProps) => (
  <details className="script-card model-service-card">
    <summary className="model-service-heading">
      <span aria-hidden="true" className="model-service-mark">
        视
      </span>
      <div>
        <p className="eyebrow">视频模型</p>
        <h2 id="video-provider-title">火山方舟 ARK</h2>
      </div>
      <span
        className={`model-configuration-status${profile?.configured === true ? ' configured' : ''}`}
      >
        {profile?.configured === true ? '已配置' : '未配置'}
      </span>
      <span className="model-current-summary">
        <small>当前模型</small>
        <strong>{VIDEO_MODELS.find((model) => model.id === modelId)?.label ?? modelId}</strong>
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
    <div className="model-service-body" aria-labelledby="video-provider-title">
      <p>
        用于逐镜头视频段生成（Seedance 首帧图生视频）。选择模型后自行保存 ARK API Key；完整 Key
        不回显、不进入页面长期状态。
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
          {VIDEO_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        ARK API Key
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
          disabled={pending || profile?.modelId === modelId}
          onClick={onModelSave}
          type="button"
        >
          保存模型选择
        </button>
        <button disabled={pending || apiKey === ''} onClick={onSave} type="button">
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
        测试仅验证密文可解密读取，不发起计费请求，也不代表模型已开通。若生成提示模型不可用，请在火山方舟为该
        API Key 开通所选模型或配置接入点。
      </p>
    </div>
  </details>
);

export const VideoProviderCard = () => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('doubao-seedance-2-0-260128');
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getProviderClient()
      .getProfile({ profileId: VIDEO_PROFILE_ID })
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError(result.error);
        else {
          setProfile(result.data);
          if (VIDEO_MODELS.some((model) => model.id === result.data.modelId)) {
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
    <VideoProviderCardView
      apiKey={apiKey}
      error={error}
      feedback={feedback}
      modelId={modelId}
      onApiKeyChange={setApiKey}
      onDelete={() => {
        if (profile === null || !globalThis.confirm('删除已保存的视频 ARK 凭据？')) return;
        void apply(
          () =>
            getProviderClient().deleteCredential({
              expectedVersionId: profile.versionId,
              profileId: VIDEO_PROFILE_ID,
              requestId: createScriptRequestId('video-provider-delete'),
            }),
          '凭据已删除',
        );
      }}
      onModelChange={setModelId}
      onModelSave={() => {
        const current = profile ?? {
          enabled: true,
          versionId: VIDEO_PROFILE_ID,
          workspaceId: 'ark',
        };
        void apply(
          () =>
            getProviderClient().saveProfile({
              enabled: current.enabled,
              expectedVersionId: current.versionId,
              modelId,
              profileId: VIDEO_PROFILE_ID,
              requestId: createScriptRequestId('video-provider-model'),
              workspaceId: current.workspaceId,
            }),
          '视频模型已保存；新任务将使用该模型',
        );
      }}
      onSave={() => {
        const credential = apiKey;
        setApiKey('');
        void apply(
          () =>
            getProviderClient().saveCredential({
              apiKey: credential,
              expectedVersionId: profile?.versionId ?? VIDEO_PROFILE_ID,
              profileId: VIDEO_PROFILE_ID,
              requestId: createScriptRequestId('video-provider-key'),
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
              profileId: VIDEO_PROFILE_ID,
              requestId: createScriptRequestId('video-provider-test'),
            }),
          '密文可解密读取',
        );
      }}
      pending={pending}
      profile={profile}
    />
  );
};
