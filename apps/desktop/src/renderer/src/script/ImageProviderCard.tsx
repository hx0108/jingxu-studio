import { useEffect, useState } from 'react';

import type { AppErrorDto, ProviderProfileDto } from '@jingxu/contracts';

import { createScriptRequestId, getProviderClient, rendererTransportError } from './script-api';

// 与 Main 侧 IMAGE_CREDENTIAL_ID（register-image-features）同值镜像：图片密文按此固定 id 读写。
const IMAGE_PROFILE_ID = 'profile-image-primary';

interface ImageProviderCardViewProps {
  readonly apiKey: string;
  readonly error: AppErrorDto | null;
  readonly feedback: string;
  readonly onApiKeyChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly onSave: () => void;
  readonly onTest: () => void;
  readonly pending: boolean;
  readonly profile: ProviderProfileDto | null;
}

export const ImageProviderCardView = ({
  apiKey,
  error,
  feedback,
  onApiKeyChange,
  onDelete,
  onSave,
  onTest,
  pending,
  profile,
}: ImageProviderCardViewProps) => (
  <section className="script-card" aria-labelledby="image-provider-title">
    <h2 id="image-provider-title">图片模型服务（火山方舟 ARK）</h2>
    <p>
      用于首帧图片生成。模型与端点固定，仅需保存 ARK API Key；完整 Key 不回显、不进入页面长期状态。
    </p>
    {error !== null && (
      <p className="field-error" role="alert">
        {error.code}：{error.message}
      </p>
    )}
    <label>
      模型
      <input readOnly value={profile?.modelId ?? ''} />
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
    </p>
  </section>
);

export const ImageProviderCard = () => {
  const [profile, setProfile] = useState<ProviderProfileDto | null>(null);
  const [apiKey, setApiKey] = useState('');
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
        else setProfile(result.data);
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
      onApiKeyChange={setApiKey}
      onDelete={() => {
        if (profile === null || !globalThis.confirm('删除已保存的 ARK 凭据？')) return;
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
