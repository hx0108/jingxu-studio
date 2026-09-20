import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto, VideoProviderSelectionDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';

// 与 Main 侧 VIDEO_CREDENTIAL_ID（register-video-features）同值镜像：视频密文按此固定 id 读写。
const VIDEO_PROFILE_ID = 'profile-video-primary';
const AGNES_VIDEO_PROFILE_ID = 'profile-video-agnes-primary';
const VIDEO_MODELS = [
  { id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance-2.0-mini' },
  { id: 'doubao-seedance-2-0-260128', label: 'Seedance-2.0' },
  { id: 'doubao-seedance-2-5-260628', label: 'Seedance-2.5' },
] as const;
const AGNES_MODELS = [
  { id: 'agnes-video-v2.0', label: 'Agnes Video V2.0' },
  { id: 'agnes-video-2.5-flash', label: 'Agnes Video 2.5 Flash' },
] as const;

/** 卡片变体（low-cost D7）：受限枚举与文案在此冻结（四档：Mock 说明 + 三家真实档）。 */
export interface VideoCardVariant {
  readonly defaultModelId: string;
  readonly intro: string;
  readonly keyLabel: string;
  readonly mark: string;
  readonly models: readonly { readonly id: string; readonly label: string }[];
  readonly mode: 'AGNES' | 'SEEDANCE';
  readonly profileId: string;
  readonly providerName: string;
  readonly subtitle: string;
}

export const SEEDANCE_VIDEO_CARD_VARIANT: VideoCardVariant = {
  defaultModelId: 'doubao-seedance-2-0-mini-260615',
  intro:
    '用于逐镜头视频段生成（Seedance 首帧图生视频）。选择模型后自行保存 ARK API Key；完整 Key 不回显、不进入页面长期状态。',
  keyLabel: 'ARK API Key',
  mark: '视',
  models: VIDEO_MODELS,
  mode: 'SEEDANCE',
  profileId: VIDEO_PROFILE_ID,
  providerName: '火山方舟 ARK',
  subtitle: '视频模型',
};

export const AGNES_VIDEO_CARD_VARIANT: VideoCardVariant = {
  defaultModelId: 'agnes-video-v2.0',
  intro:
    '低价视频档（Agnes 首帧图生视频，固定 5 秒 / 720P）。当前官方 $0/秒促销期（2.5 Flash 为限时免费），免费档约每分钟限 1 个任务；完整 Key 不回显、不进入页面长期状态。',
  keyLabel: 'Agnes API Key',
  mark: '价',
  models: AGNES_MODELS,
  mode: 'AGNES',
  profileId: AGNES_VIDEO_PROFILE_ID,
  providerName: 'Agnes AI',
  subtitle: '视频模型 · 低价档',
};

interface VideoProviderCardViewProps {
  readonly apiKey: string;
  readonly error: AppErrorDto | null;
  readonly feedback: string;
  readonly isCurrentProvider: boolean;
  readonly modelId: string;
  readonly onApiKeyChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly onModelChange: (value: string) => void;
  readonly onModelSave: () => void;
  readonly onSave: () => void;
  readonly onSetCurrent: (() => void) | null;
  readonly onTest: () => void;
  readonly pending: boolean;
  readonly profile: ProviderProfileDto | null;
  readonly variant: VideoCardVariant;
}

export const VideoProviderCardView = ({
  apiKey,
  error,
  feedback,
  isCurrentProvider,
  modelId,
  onApiKeyChange,
  onDelete,
  onModelChange,
  onModelSave,
  onSave,
  onSetCurrent,
  onTest,
  pending,
  profile,
  variant,
}: VideoProviderCardViewProps) => {
  const headingId = `video-provider-title-${variant.mode.toLowerCase()}`;
  return (
    <details className="script-card model-service-card">
      <summary className="model-service-heading">
        <span aria-hidden="true" className="model-service-mark">
          {variant.mark}
        </span>
        <div>
          <p className="eyebrow">{variant.subtitle}</p>
          <h2 id={headingId}>{variant.providerName}</h2>
        </div>
        {isCurrentProvider && <span className="model-current-provider-badge">当前视频档</span>}
        <span
          className={`model-configuration-status${profile?.configured === true ? ' configured' : ''}`}
        >
          {profile?.configured === true ? '已配置' : '未配置'}
        </span>
        <span className="model-current-summary">
          <small>当前模型</small>
          <strong>{variant.models.find((model) => model.id === modelId)?.label ?? modelId}</strong>
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
      <div className="model-service-body" aria-labelledby={headingId}>
        <p>{variant.intro}</p>
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
            {variant.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {variant.keyLabel}
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
          {onSetCurrent !== null && (
            <button disabled={pending || isCurrentProvider} onClick={onSetCurrent} type="button">
              {isCurrentProvider ? '已是当前视频档' : '设为当前视频档'}
            </button>
          )}
        </div>
        <p aria-live="polite">
          {profile?.configured === true
            ? `已配置（末四位 ${profile.last4 ?? '不可用'}）`
            : '未配置'}
          {feedback === '' ? '' : ` · ${feedback}`}
        </p>
        <p className="action-hint">
          {variant.mode === 'AGNES'
            ? '测试仅验证密文可解密读取，不发起计费请求。免费档促销与限流口径以 Agnes 官方公告为准；切换当前视频档后需重启应用生效。'
            : '测试仅验证密文可解密读取，不发起计费请求，也不代表模型已开通。若生成提示模型不可用，请在火山方舟为该 API Key 开通所选模型或配置接入点。切换当前视频档后需重启应用生效。'}
        </p>
      </div>
    </details>
  );
};

export const VideoProviderCard = ({
  variant = SEEDANCE_VIDEO_CARD_VARIANT,
}: {
  readonly variant?: VideoCardVariant;
}) => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [selection, setSelection] = useState<VideoProviderSelectionDto | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState(variant.defaultModelId);
  const [error, setError] = useState<AppErrorDto | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void getProviderClient()
      .getProfile({ profileId: variant.profileId })
      .then((result) => {
        if (!active) return;
        if (!result.ok) setError(result.error);
        else {
          setProfile(result.data);
          if (variant.models.some((model) => model.id === result.data.modelId)) {
            setModelId(result.data.modelId);
          }
        }
      })
      .catch(() => {
        if (active) setError(rendererTransportError());
      });
    void getProviderClient()
      .getVideoProviderSelection({ requestId: createScriptRequestId('video-selection-get') })
      .then((result) => {
        if (active && result.ok) setSelection(result.data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [variant.profileId, variant.models, variant.defaultModelId]);

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

  const isCurrentProvider = selection?.mode === variant.mode;
  const setCurrentProvider = (): void => {
    if (selection === null) return;
    setPending(true);
    setError(null);
    setFeedback('正在处理…');
    void getProviderClient()
      .saveVideoProviderSelection({
        expectedUpdatedAt: selection.updatedAt,
        mode: variant.mode,
        requestId: createScriptRequestId('video-selection-save'),
      })
      .then((result) => {
        if (result.ok) {
          setSelection(result.data);
          setFeedback('已设为当前视频档；重启应用后生效');
        } else {
          setError(result.error);
          setFeedback('');
        }
      })
      .catch(() => {
        setError(rendererTransportError());
        setFeedback('');
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <VideoProviderCardView
      apiKey={apiKey}
      error={error}
      feedback={feedback}
      isCurrentProvider={isCurrentProvider}
      modelId={modelId}
      onApiKeyChange={setApiKey}
      onDelete={() => {
        if (profile === null || !globalThis.confirm(`删除已保存的${variant.providerName}凭据？`))
          return;
        void apply(
          () =>
            getProviderClient().deleteCredential({
              expectedVersionId: profile.versionId,
              profileId: variant.profileId,
              requestId: createScriptRequestId('video-provider-delete'),
            }),
          '凭据已删除',
        );
      }}
      onModelChange={setModelId}
      onModelSave={() => {
        const current = profile ?? {
          enabled: true,
          versionId: variant.profileId,
          workspaceId: variant.mode === 'AGNES' ? 'agnes' : 'ark',
        };
        void apply(
          () =>
            getProviderClient().saveProfile({
              enabled: current.enabled,
              expectedVersionId: current.versionId,
              modelId,
              profileId: variant.profileId,
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
              expectedVersionId: profile?.versionId ?? variant.profileId,
              profileId: variant.profileId,
              requestId: createScriptRequestId('video-provider-key'),
            }),
          '凭据已安全保存，可执行解密测试',
        );
      }}
      onSetCurrent={selection === null ? null : setCurrentProvider}
      onTest={() => {
        if (profile === null) return;
        void apply(
          () =>
            getProviderClient().testCredential({
              expectedVersionId: profile.versionId,
              profileId: variant.profileId,
              requestId: createScriptRequestId('video-provider-test'),
            }),
          '密文可解密读取',
        );
      }}
      pending={pending}
      profile={profile}
      variant={variant}
    />
  );
};

/** Agnes 低价视频档卡片（low-cost D7）：与 Seedance 卡同构、独立 Profile 与密文。 */
export const AgnesVideoProviderCard = () => (
  <VideoProviderCard variant={AGNES_VIDEO_CARD_VARIANT} />
);

/**
 * Mock 联调模拟醒目标记（low-cost D7/6.3）：Mock 是 Main-only 模式（开发/E2E 默认），
 * 不可由页面选择；此提示声明其存在与零网络边界，避免用户误以为三档之外无模拟路径。
 */
export const MockVideoNotice = () => (
  <p className="action-hint" role="note">
    <strong>联调模拟（Mock）</strong>：视频生成在开发与自动化测试下默认走零网络 Mock，
    不调用外部模型、不计费、不读取任何密钥；该模式由 Main 环境变量控制
    （JINGXU_VIDEO_PROVIDER=MOCK），不能在此页面选择或关闭。
  </p>
);
