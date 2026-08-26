import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';

// 与 Main 侧 VOICE_PROFILE_ID（register-job-provider-features）同值镜像：配音密文按此固定 id 读写。
const VOICE_PROFILE_ID = 'profile-voice-primary';
// 与 packages/model-adapters 的 QWEN_TTS_MODELS 注册表镜像（渲染层不依赖 main 进程包）。
const VOICE_MODELS = [
  { id: 'qwen3-tts-instruct-flash', label: '千问3-TTS-Instruct-Flash' },
] as const;

interface VoiceProviderCardViewProps {
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

export const VoiceProviderCardView = ({
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
}: VoiceProviderCardViewProps) => (
  <details className="script-card model-service-card">
    <summary className="model-service-heading">
      <span aria-hidden="true" className="model-service-mark">
        音
      </span>
      <div>
        <p className="eyebrow">配音模型</p>
        <h2 id="voice-provider-title">阿里云 DashScope</h2>
      </div>
      <span
        className={`model-configuration-status${profile?.configured === true ? ' configured' : ''}`}
      >
        {profile?.configured === true ? '已配置' : '未配置'}
      </span>
      <span className="model-current-summary">
        <small>当前模型</small>
        <strong>{VOICE_MODELS.find((model) => model.id === modelId)?.label ?? modelId}</strong>
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
    <div className="model-service-body" aria-labelledby="voice-provider-title">
      <p>
        用于逐镜头台词配音（Qwen3-TTS）。与文本档共用同一把 DashScope API
        Key——密文按配音档独立保存， 需在此再粘贴一次；完整 Key 不回显、不进入页面长期状态。
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
          {VOICE_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        DashScope API Key
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
        测试仅验证密文可解密读取，不发起计费请求，也不代表模型已开通。若配音提示凭据无效，请检查该
        DashScope API Key 是否有百炼模型调用权限。
      </p>
    </div>
  </details>
);

export const VoiceProviderCard = () => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('qwen3-tts-instruct-flash');
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getProviderClient()
      .getProfile({ profileId: VOICE_PROFILE_ID })
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError(result.error);
        else {
          setProfile(result.data);
          if (VOICE_MODELS.some((model) => model.id === result.data.modelId)) {
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
    <VoiceProviderCardView
      apiKey={apiKey}
      error={error}
      feedback={feedback}
      modelId={modelId}
      onApiKeyChange={setApiKey}
      onDelete={() => {
        if (profile === null || !globalThis.confirm('删除已保存的配音 DashScope 凭据？')) return;
        void apply(
          () =>
            getProviderClient().deleteCredential({
              expectedVersionId: profile.versionId,
              profileId: VOICE_PROFILE_ID,
              requestId: createScriptRequestId('voice-provider-delete'),
            }),
          '凭据已删除',
        );
      }}
      onModelChange={setModelId}
      onModelSave={() => {
        const current = profile ?? {
          enabled: true,
          versionId: VOICE_PROFILE_ID,
          workspaceId: 'dashscope',
        };
        void apply(
          () =>
            getProviderClient().saveProfile({
              enabled: current.enabled,
              expectedVersionId: current.versionId,
              modelId,
              profileId: VOICE_PROFILE_ID,
              requestId: createScriptRequestId('voice-provider-model'),
              workspaceId: current.workspaceId,
            }),
          '配音模型已保存；新任务将使用该模型',
        );
      }}
      onSave={() => {
        const credential = apiKey;
        setApiKey('');
        void apply(
          () =>
            getProviderClient().saveCredential({
              apiKey: credential,
              expectedVersionId: profile?.versionId ?? VOICE_PROFILE_ID,
              profileId: VOICE_PROFILE_ID,
              requestId: createScriptRequestId('voice-provider-key'),
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
              profileId: VOICE_PROFILE_ID,
              requestId: createScriptRequestId('voice-provider-test'),
            }),
          '密文可解密读取',
        );
      }}
      pending={pending}
      profile={profile}
    />
  );
};
